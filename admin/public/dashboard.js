// 仪表盘前端逻辑：图表渲染（原生 SVG，无图表库）、悬停提示、时间范围筛选、
// 手动/自动刷新与加载态。数据来自 window.__BOOT__.dash（首屏，服务端算好）
// 或 /api/manage/dashboard（刷新），两处口径完全一致，渲染函数共用。
// 由 admin.js 在页面初始化时调用 initDashboard / stopDashboard。

const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
const fmt = (n) => Number(n ?? 0).toLocaleString('zh-CN');
const pct1 = (n) => String(Math.round((Number(n) || 0) * 10) / 10);

// 图表配色（与陶土主题协调，暗色下同样可读）。
const PALETTE = ['#b4643c', '#4e8bb0', '#5a9e6f', '#c9a227', '#8a6bb5', '#7f8187', '#c07a86', '#5f9ea0'];

// —— 浮动提示条（全页共用一个） ——
function tipEl() {
  let el = document.getElementById('dash-tip');
  if (!el) {
    el = document.createElement('div');
    el.id = 'dash-tip';
    el.className = 'dash-tip';
    el.hidden = true;
    document.body.append(el);
  }
  return el;
}

function showTip(html, x, y) {
  const el = tipEl();
  el.innerHTML = html;
  el.hidden = false;
  // 先摆到鼠标右下再校正：靠近右/下边缘时翻到左侧/上方，避免出屏。
  const pad = 14;
  el.style.left = '0px';
  el.style.top = '0px';
  const { offsetWidth: w, offsetHeight: h } = el;
  const left = x + w + pad > window.innerWidth ? x - w - pad : x + pad;
  const top = y + h + pad > window.innerHeight ? y - h - pad : y + pad;
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

const hideTip = () => {
  const el = document.getElementById('dash-tip');
  if (el) el.hidden = true;
};

// —— 数字滚动（仅首次渲染播放；刷新时直接落值） ——
function countUp(el) {
  if (!firstPaint) return;
  const raw = el.textContent.trim();
  const m = raw.replace(/,/g, '').match(/^(\d+)(.*)$/);
  if (!m) return;
  const target = Number(m[1]);
  if (!Number.isFinite(target) || target === 0) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const suffix = m[2];
  const started = performance.now();
  const step = (now) => {
    const p = Math.min(1, (now - started) / 600);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = `${Math.round(target * eased).toLocaleString('zh-CN')}${suffix}`;
    if (p < 1) requestAnimationFrame(step);
    else el.textContent = raw;
  };
  requestAnimationFrame(step);
}

// —— 同比/环比小箭头 ——
// 箭头只显示幅度，比较基准（较昨日等）放悬浮提示——放在卡里会把标签挤没。
function deltaChip(cur, prev, label) {
  const c = Number(cur) || 0;
  const p = Number(prev) || 0;
  if (p === 0) {
    return c === 0
      ? `<span class="delta delta--flat" title="${esc(label)}"><i>—</i></span>`
      : `<span class="delta delta--up" title="${esc(label)}"><i>新增</i></span>`;
  }
  const pct = Math.round(((c - p) / p) * 1000) / 10;
  const cls = pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat';
  const arrow = pct > 0 ? '▲' : pct < 0 ? '▼' : '—';
  return `<span class="delta delta--${cls}" title="${esc(label)}"><i>${arrow} ${Math.abs(pct)}%</i></span>`;
}

// ============ 趋势图（平滑曲线 + 无缝跟随的悬浮窗） ============
// 交互从头设计：曲线为 Catmull-Rom 平滑样条；高亮圆点沿曲线连续滑动
// （按平滑后的光标位置在样条上求值，不逐点跳变）；悬浮窗进入图表时渐显、
// 离开时淡出，悬停期间始终可见并逐帧平滑趋近光标（指数趋近，时间常数约
// 55ms），四边柔性贴边不翻面、不跳位。不设竖向引导线。
function renderTrend(container, points) {
  if (!container) return;
  container._trendStop?.(); // 重渲染（切换范围）前停掉旧的动画循环
  const usable = points.some((p) => (p.value || 0) > 0 || (p.uv || 0) > 0);
  if (!points.length || !usable) {
    container.innerHTML = '<p class="empty">暂无数据，有访问后这里会出现趋势曲线。</p>';
    return;
  }
  const W = 720;
  const H = 240;
  const padL = 44;
  const padR = 14;
  const padT = 18;
  const padB = 30;
  const hasUv = points.some((p) => p.uv != null);
  const max = Math.max(1, ...points.map((p) => Math.max(p.value || 0, p.uv || 0)));
  const n = points.length;
  const xAt = (i) => (n === 1 ? (padL + W - padR) / 2 : padL + (i * (W - padL - padR)) / (n - 1));
  const yAt = (v) => padT + (H - padT - padB) * (1 - v / max);
  const clampY = (y) => Math.min(H - padB, Math.max(padT, y));

  // —— Catmull-Rom 样条 ——
  // 相邻点之间以三次贝塞尔平滑过渡；控制点一并保存，供光标位置在曲线上
  // 精确求值（圆点永远贴着曲线滑）。控制点纵向钳制在绘图区内。
  const buildSpline = (values) => {
    const pts = values.map((y, i) => [xAt(i), y]);
    if (pts.length < 2) return { path: '', segs: [] };
    const segs = [];
    let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] || pts[i];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[i + 2] || p2;
      const c1 = [p1[0] + (p2[0] - p0[0]) / 6, clampY(p1[1] + (p2[1] - p0[1]) / 6)];
      const c2 = [p2[0] - (p3[0] - p1[0]) / 6, clampY(p2[1] - (p3[1] - p1[1]) / 6)];
      segs.push([p1, c1, c2, p2]);
      d += ` C${c1[0].toFixed(1)},${c1[1].toFixed(1)} ${c2[0].toFixed(1)},${c2[1].toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
    }
    return { path: d, segs };
  };

  // 求样条上横坐标为 x 的点（贝塞尔按段求值）。
  const pointOn = (spline, x) => {
    const segs = spline.segs;
    if (!segs.length) return [xAt(0), yAt(points[0]?.value || 0)];
    const minX = segs[0][0][0];
    const maxX = segs[segs.length - 1][3][0];
    const mx = Math.min(Math.max(x, minX), maxX);
    let seg = segs[segs.length - 1];
    for (const s of segs) {
      if (mx <= s[3][0]) {
        seg = s;
        break;
      }
    }
    const [p1, c1, c2, p2] = seg;
    const t = Math.min(1, Math.max(0, (mx - p1[0]) / Math.max(1e-6, p2[0] - p1[0])));
    const u = 1 - t;
    const bez = (a, b, c, d2) => u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d2;
    return [bez(p1[0], c1[0], c2[0], p2[0]), bez(p1[1], c1[1], c2[1], p2[1])];
  };

  // 横向网格与刻度。
  let grid = '';
  for (let g = 0; g <= 3; g++) {
    const v = Math.round((max / 3) * g);
    const y = yAt(v);
    grid += `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}" class="chart-grid" />
      <text x="${padL - 8}" y="${(y + 4).toFixed(1)}" class="chart-axis" text-anchor="end">${v}</text>`;
  }

  const pvSpline = buildSpline(points.map((p) => yAt(p.value || 0)));
  // 无访客序列时（如「近 12 月」视图）给空样条而不是 null，渲染与求值统一处理。
  const uvSpline = hasUv ? buildSpline(points.map((p) => yAt(p.uv || 0))) : { path: '', segs: [] };
  const pvArea = pvSpline.path ? `${pvSpline.path} L${xAt(n - 1).toFixed(1)},${yAt(0)} L${xAt(0).toFixed(1)},${yAt(0)} Z` : '';
  const staticDots = [
    ...points.map((p, i) => `<circle cx="${xAt(i).toFixed(1)}" cy="${yAt(p.value || 0).toFixed(1)}" r="2.6" class="chart-dot chart-dot--pv" />`),
    ...(hasUv ? points.map((p, i) => `<circle cx="${xAt(i).toFixed(1)}" cy="${yAt(p.uv || 0).toFixed(1)}" r="2" class="chart-dot chart-dot--uv" />`) : []),
  ].join('');

  // 横轴标签：最多 8 个，均匀抽样，避免挤成一团。
  const step = Math.max(1, Math.ceil(n / 8));
  let xLabels = '';
  for (let i = 0; i < n; i += step) {
    xLabels += `<text x="${xAt(i).toFixed(1)}" y="${H - 8}" class="chart-axis" text-anchor="middle">${esc(points[i].label)}</text>`;
  }

  container.innerHTML = `
    <div class="chart-legend">
      <span><i></i>访问量</span>
      ${hasUv ? '<span><i class="chart-legend__uv"></i>访客量</span>' : ''}
    </div>
    <div class="chart-plot">
      <svg viewBox="0 0 ${W} ${H}" class="chart-svg" role="img" aria-label="访问趋势图">
        <defs>
          <linearGradient id="trend-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" class="chart-area-grad-start" />
            <stop offset="1" class="chart-area-grad-end" />
          </linearGradient>
        </defs>
        ${grid}
        ${pvArea ? `<path d="${pvArea}" class="chart-area" />` : ''}
        ${uvSpline.path ? `<path d="${uvSpline.path}" class="chart-line chart-line--uv" />` : ''}
        ${pvSpline.path ? `<path d="${pvSpline.path}" class="chart-line chart-line--pv" />` : ''}
        ${staticDots}
        ${xLabels}
        <g class="chart-cursor chart-cursor--pv"><circle r="11" class="chart-halo" /><circle r="4.4" class="chart-active-dot chart-active-dot--pv" /></g>
        ${hasUv ? '<g class="chart-cursor chart-cursor--uv"><circle r="3.8" class="chart-active-dot chart-active-dot--uv" /></g>' : ''}
      </svg>
      <div class="chart-tip">
        <div class="chart-tip__date" data-tip-date></div>
        <div class="chart-tip__row"><i class="chart-tip__dot"></i>访问量<b data-tip-pv>0</b></div>
        ${hasUv ? '<div class="chart-tip__row"><i class="chart-tip__dot chart-tip__dot--uv"></i>访客量<b data-tip-uv>0</b></div>' : ''}
      </div>
    </div>`;

  const svg = container.querySelector('svg');
  const plot = container.querySelector('.chart-plot');
  const tip = container.querySelector('.chart-tip');
  const pvCursor = svg.querySelector('.chart-cursor--pv');
  const uvCursor = svg.querySelector('.chart-cursor--uv');
  const tipDate = tip.querySelector('[data-tip-date]');
  const tipPv = tip.querySelector('[data-tip-pv]');
  const tipUv = tip.querySelector('[data-tip-uv]');
  const cursorEls = [pvCursor, uvCursor].filter(Boolean);

  // —— 无缝跟随 ——
  // 光标事件绑定在整个绘图区（不是内部矩形）：在图表内移动时悬浮窗绝不
  // 闪没。内容按最近数据点即时更新；位置（圆点沿曲线 + 悬浮窗）由动画
  // 循环逐帧指数趋近光标（时间常数约 55ms，帧率无关，跟手又不生硬）。
  let raf = 0;
  let running = false;
  let started = false;
  let lastT = 0;
  let rawX = 0;
  let rawY = 0;
  let curX = 0;
  let curY = 0;
  let scale = 1;
  let plotW = 0;
  let plotH = 0;
  let activeIdx = -1;

  // 内容即时更新：位置平滑归位置，文字不拖泥带水。
  const updateContent = (svgX) => {
    const span = Math.max(1e-6, (xAt(n - 1) - xAt(0)) / Math.max(1, n - 1));
    const idx = Math.min(n - 1, Math.max(0, Math.round((svgX - xAt(0)) / span)));
    if (idx === activeIdx) return;
    activeIdx = idx;
    const p = points[idx];
    tipDate.textContent = p.fullLabel || p.label;
    tipPv.textContent = fmt(p.value);
    if (tipUv) tipUv.textContent = p.uv != null ? fmt(p.uv) : '—';
  };

  const frame = (now) => {
    if (!running) return;
    const dt = Math.min(64, now - lastT);
    lastT = now;
    const k = 1 - Math.exp(-dt / 55);
    curX += (rawX - curX) * k;
    curY += (rawY - curY) * k;

    // 高亮圆点沿曲线滑动：x 取平滑光标并夹在数据范围内，y 由样条求值。
    const svgX = curX / scale;
    const [px1, py1] = pointOn(pvSpline, svgX);
    pvCursor.style.transform = `translate(${px1.toFixed(2)}px, ${py1.toFixed(2)}px)`;
    if (uvCursor) {
      const [px2, py2] = pointOn(uvSpline, svgX);
      uvCursor.style.transform = `translate(${px2.toFixed(2)}px, ${py2.toFixed(2)}px)`;
    }

    // 悬浮窗贴在平滑光标右上方；只做柔性贴边（连续），不翻面跳位。
    const tipW = tip.offsetWidth;
    const tipH = tip.offsetHeight;
    const tx = Math.min(Math.max(curX + 16, 0), Math.max(0, plotW - tipW));
    const ty = Math.min(Math.max(curY - tipH - 14, 0), Math.max(0, plotH - tipH));
    tip.style.transform = `translate(${tx.toFixed(1)}px, ${ty.toFixed(1)}px)`;
    raf = requestAnimationFrame(frame);
  };

  plot.addEventListener('mousemove', (e) => {
    const rect = plot.getBoundingClientRect();
    scale = rect.width / W || 1;
    plotW = rect.width;
    plotH = rect.height;
    rawX = e.clientX - rect.left;
    rawY = e.clientY - rect.top;
    if (!started) {
      // 首帧直接落位：渐显从当前光标处出现，绝不从别处飞入。
      started = true;
      curX = rawX;
      curY = rawY;
      tip.classList.add('is-on');
      plot.classList.add('is-on');
    }
    updateContent(rawX / scale);
    if (!running) {
      running = true;
      lastT = performance.now();
      raf = requestAnimationFrame(frame);
    }
  });

  plot.addEventListener('mouseleave', () => {
    started = false;
    running = false;
    tip.classList.remove('is-on');
    plot.classList.remove('is-on');
    if (raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
  });

  container._trendStop = () => {
    running = false;
    started = false;
    if (raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
  };
}

// ============ 环形图（来源/设备分布） ============
function renderDonut(chartEl, legendEl, items, centerTitle) {
  if (!chartEl || !legendEl) return;
  const list = (items || []).filter((d) => d.count > 0);
  const total = list.reduce((s, d) => s + d.count, 0);
  if (!total) {
    chartEl.innerHTML = '<p class="empty">暂无数据。</p>';
    legendEl.innerHTML = '';
    return;
  }
  const R = 70;
  const C = 2 * Math.PI * R;
  let offset = 0;
  const segments = list
    .map((d, i) => {
      const frac = d.count / total;
      const seg = `<circle cx="100" cy="100" r="${R}" fill="none"
        stroke="${PALETTE[i % PALETTE.length]}" stroke-width="26"
        stroke-dasharray="${(frac * C).toFixed(2)} ${(C - frac * C).toFixed(2)}"
        stroke-dashoffset="${(-offset * C).toFixed(2)}"
        class="donut-seg" data-i="${i}" />`;
      offset += frac;
      return seg;
    })
    .join('');

  chartEl.innerHTML = `
    <svg viewBox="0 0 200 200" class="chart-svg donut" role="img" aria-label="${esc(centerTitle)}">
      <circle cx="100" cy="100" r="${R}" fill="none" class="donut-track" stroke-width="26" />
      ${segments}
      <text x="100" y="96" class="donut-center-value" id="donut-center-value">${fmt(total)}</text>
      <text x="100" y="118" class="donut-center-label" id="donut-center-label">${esc(centerTitle)}</text>
    </svg>`;

  legendEl.innerHTML = list
    .map(
      (d, i) => `<li class="donut-legend__item" data-i="${i}">
        <span class="donut-legend__dot" style="background:${PALETTE[i % PALETTE.length]}"></span>
        <span class="donut-legend__name">${esc(d.key)}</span>
        <span class="donut-legend__value">${fmt(d.count)}</span>
        <span class="donut-legend__pct">${pct1((d.count / total) * 100)}%</span>
      </li>`,
    )
    .join('');

  // 悬停联动：扇区 ↔ 图例行，中心文字切换为该项明细。
  const centerValue = chartEl.querySelector('#donut-center-value');
  const centerLabel = chartEl.querySelector('#donut-center-label');
  const segs = chartEl.querySelectorAll('.donut-seg');
  const rows = legendEl.querySelectorAll('.donut-legend__item');
  const highlight = (i, evt) => {
    segs.forEach((s) => s.classList.toggle('is-dim', i != null && Number(s.dataset.i) !== i));
    rows.forEach((r) => r.classList.toggle('is-active', i != null && Number(r.dataset.i) === i));
    if (i == null) {
      centerValue.textContent = fmt(total);
      centerLabel.textContent = centerTitle;
      hideTip();
      return;
    }
    const d = list[i];
    centerValue.textContent = fmt(d.count);
    centerLabel.textContent = d.key;
    if (evt) {
      showTip(`<strong>${esc(d.key)}</strong><br/>${fmt(d.count)} 次 · ${pct1((d.count / total) * 100)}%`, evt.clientX, evt.clientY);
    }
  };
  segs.forEach((s) => {
    s.addEventListener('mousemove', (e) => highlight(Number(s.dataset.i), e));
    s.addEventListener('mouseleave', () => highlight(null));
  });
  rows.forEach((r) => {
    r.addEventListener('mousemove', (e) => highlight(Number(r.dataset.i), e));
    r.addEventListener('mouseleave', () => highlight(null));
  });
}

// ============ 迷你柱状图（评论趋势） ============
function renderMiniBars(container, items) {
  if (!container) return;
  if (!items.length || items.every((d) => !d.count)) {
    container.innerHTML = '<p class="empty">近 30 天暂无新增评论。</p>';
    return;
  }
  const W = 720;
  const H = 90;
  const max = Math.max(1, ...items.map((d) => d.count));
  const bw = (W - 4) / items.length;
  const bars = items
    .map((d, i) => {
      const h = Math.max(d.count > 0 ? 3 : 1, ((H - 12) * d.count) / max);
      return `<rect x="${(2 + i * bw).toFixed(1)}" y="${(H - h).toFixed(1)}" width="${Math.max(2, bw - 4).toFixed(1)}" height="${h.toFixed(1)}" rx="2" class="mini-bar" />`;
    })
    .join('');
  container.innerHTML = `<svg viewBox="0 0 ${W} ${H}" class="chart-svg" role="img" aria-label="评论趋势图">${bars}
    <rect x="0" y="0" width="${W}" height="${H}" fill="transparent" class="chart-hit" /></svg>`;

  const svg = container.querySelector('svg');
  svg.querySelector('.chart-hit').addEventListener('mousemove', (e) => {
    const rect = svg.getBoundingClientRect();
    const relX = ((e.clientX - rect.left) / rect.width) * W;
    const idx = Math.min(items.length - 1, Math.max(0, Math.floor((relX / W) * items.length)));
    const d = items[idx];
    showTip(`<strong>${esc(d.date)}</strong><br/>新增评论 ${fmt(d.count)} 条`, e.clientX, e.clientY);
  });
  svg.querySelector('.chart-hit').addEventListener('mouseleave', hideTip);
}

// ============ 横条排行 ============
function rankRows(items, { showSub = false, unit = '次' } = {}) {
  const list = items || [];
  if (!list.length) return '<p class="empty">暂无数据。</p>';
  const max = Math.max(1, ...list.map((d) => d.count));
  return list
    .map(
      (d, i) => `<div class="rank__row">
        ${d.rank ? `<span class="rank__no">${i + 1}</span>` : ''}
        <span class="rank__label">
          <span class="rank__name" title="${esc(d.title || d.key)}">${esc(d.title || d.key)}</span>
          ${showSub && d.key ? `<code class="rank__sub">${esc(d.key)}</code>` : ''}
        </span>
        <span class="rank__track"><span class="rank__fill" style="width:${Math.max(2, Math.round((d.count / max) * 100))}%"></span></span>
        <span class="rank__value">${fmt(d.count)}${unit}</span>
      </div>`,
    )
    .join('');
}

// ============ 各区块渲染 ============
function renderVisitStats(data) {
  const el = document.getElementById('dash-visit-stats');
  if (!el) return;
  const v = data.visits;
  const cards = [
    { label: '总访问量', value: fmt(v.total), chip: deltaChip(v.thisMonth, v.lastMonth, '较上月'), sub: `本月 ${fmt(v.thisMonth)} 次` },
    { label: '今日访问', value: fmt(v.today), chip: deltaChip(v.today, v.yesterday, '较昨日'), sub: `访客 ${fmt(v.uv.today)} 人` },
    { label: '昨日访问', value: fmt(v.yesterday), chip: deltaChip(v.yesterday, v.dayBefore, '较前日'), sub: `访客 ${fmt(v.uv.yesterday)} 人` },
    { label: '近 7 天', value: fmt(v.week), chip: deltaChip(v.week, v.prevWeek, '较前 7 天'), sub: `访客 ${fmt(v.uv.week)} 人` },
    { label: '近 30 天', value: fmt(v.month), chip: deltaChip(v.month, v.prevMonth, '较前 30 天'), sub: `访客 ${fmt(v.uv.month)} 人` },
    { label: '今年访问', value: fmt(v.year), chip: '', sub: '自然年累计' },
  ];
  el.innerHTML = cards
    .map(
      (c) => `<div class="stat">
        <span class="stat__label">${esc(c.label)}</span>
        <div class="stat__row"><span class="stat__value">${c.value}</span>${c.chip}</div>
        <span class="stat__sub" title="${esc(c.sub)}">${esc(c.sub)}</span>
      </div>`,
    )
    .join('');
  el.querySelectorAll('.stat__value').forEach(countUp);
}

function renderContentStats(data) {
  const el = document.getElementById('dash-content-stats');
  if (!el) return;
  const c = data.content;
  const p = c.posts;
  const totalPosts = Math.max(1, p.total + p.trash);
  // 评论总数不在这里重复展示（「评论」卡片里有完整拆分）。
  const cards = [
    { label: '文章总数', value: fmt(p.total), sub: `已发布 ${p.published} · 草稿 ${p.drafts}` },
    { label: '已发布', value: fmt(p.published), sub: `占比 ${pct1((p.published / totalPosts) * 100)}%` },
    { label: '草稿', value: fmt(p.drafts), sub: `占比 ${pct1((p.drafts / totalPosts) * 100)}%` },
    { label: '回收站', value: fmt(p.trash), sub: `占比 ${pct1((p.trash / totalPosts) * 100)}%` },
    { label: '随笔', value: fmt(c.notes.total), sub: `已发布 ${c.notes.published} · 草稿 ${c.notes.drafts}` },
    { label: '媒体文件', value: fmt(c.media), sub: '上传目录文件' },
  ];
  el.innerHTML = cards
    .map(
      (x) => `<div class="stat">
        <span class="stat__label">${esc(x.label)}</span>
        <div class="stat__row"><span class="stat__value">${x.value}</span></div>
        <span class="stat__sub" title="${esc(x.sub)}">${esc(x.sub)}</span>
      </div>`,
    )
    .join('');
  el.querySelectorAll('.stat__value').forEach(countUp);
}

function renderServerStats(data) {
  const el = document.getElementById('dash-server-stats');
  if (!el) return;
  const s = data.server;
  // 监控采样尚未就绪（首屏缓存冷启动）：先显示占位，后台补拉后自动填充。
  if (s.pending || !s.cpu) {
    el.innerHTML = '<p class="empty">服务器指标采集中，稍后自动填充…</p>';
    return;
  }
  const t = s.thresholds || {};
  const level = (percent, warn, danger) => (percent >= danger ? 'danger' : percent >= warn ? 'warn' : 'ok');
  const latencyValue = data.rttMs != null ? `${Math.round(data.rttMs)} ms` : `${s.latency.meanMs} ms`;
  const disks = s.disk || [];
  const worstDisk = disks.reduce((a, b) => (b.percent > (a?.percent ?? -1) ? b : a), null);

  const cards = [
    {
      label: '响应延迟',
      value: latencyValue,
      text: true,
      level: s.latency.p99Ms >= t.latencyDanger ? 'danger' : s.latency.p99Ms >= t.latencyWarn ? 'warn' : 'ok',
      sub: `事件循环峰值 ${s.latency.p99Ms} ms`,
      title: `接口往返 ${data.rttMs != null ? Math.round(data.rttMs) : '—'} ms · 事件循环均值 ${s.latency.meanMs} ms · 峰值 ${s.latency.p99Ms} ms`,
    },
    {
      label: 'CPU 使用率',
      value: `${s.cpu.percent}%`,
      level: level(s.cpu.percent, t.cpuWarn, t.cpuDanger),
      bar: s.cpu.percent,
      sub: `${s.cpu.cores} 核 · 负载 ${s.cpu.load1}/${s.cpu.load5}/${s.cpu.load15}`,
    },
    {
      label: '内存占用',
      value: `${s.mem.percent}%`,
      level: level(s.mem.percent, t.memWarn, t.memDanger),
      bar: s.mem.percent,
      sub: `${(s.mem.used / 1073741824).toFixed(1)} / ${(s.mem.total / 1073741824).toFixed(1)} GB`,
    },
    {
      label: '磁盘使用',
      value: worstDisk ? `${worstDisk.percent}%` : '—',
      level: worstDisk ? level(worstDisk.percent, t.diskWarn, t.diskDanger) : 'ok',
      bar: worstDisk?.percent ?? 0,
      sub: worstDisk ? `${worstDisk.mount} 剩 ${fmt(Math.round(worstDisk.free / 1073741824))} GB` : '不支持',
    },
    {
      label: '网络带宽',
      value: s.net.supported ? `↓ ${s.net.rxRateText}` : '不支持',
      text: true,
      level: 'ok',
      sub: s.net.supported ? `↑ ${s.net.txRateText}` : '当前系统未提供网卡流量接口',
      title: s.net.supported ? `累计收 ${s.net.rxTotalText} · 发 ${s.net.txTotalText}` : '',
    },
  ];

  el.innerHTML = cards
    .map(
      (c) => `<div class="stat stat--meter stat--${c.level}">
        <span class="stat__label">${esc(c.label)}</span>
        <div class="stat__row"><span class="stat__value${c.text ? ' stat__value--text' : ''}">${esc(c.value)}</span></div>
        ${c.bar != null ? `<span class="meter"><span class="meter__fill" style="width:${Math.min(100, c.bar)}%"></span></span>` : ''}
        <span class="stat__sub" title="${esc(c.title || c.sub)}">${esc(c.sub)}</span>
      </div>`,
    )
    .join('');
  el.querySelectorAll('.stat__value').forEach(countUp);
}

function renderServerDetail(data) {
  const gauges = document.getElementById('dash-server-gauges');
  const kv = document.getElementById('dash-server-kv');
  const s = data.server;
  if (s.pending || !s.cpu) {
    if (gauges) gauges.innerHTML = '<p class="empty">采集中…</p>';
    return;
  }
  const t = s.thresholds || {};
  if (gauges) {
    const rows = [
      { name: 'CPU', percent: s.cpu.percent, foot: `${s.cpu.cores} 核 · ${esc(s.cpu.model || '—')}`, warn: t.cpuWarn, danger: t.cpuDanger },
      { name: '内存', percent: s.mem.percent, foot: `进程占用 ${Math.round(s.mem.processRss / 1048576)} MB`, warn: t.memWarn, danger: t.memDanger },
      ...(s.disk || []).map((d) => ({ name: `磁盘 ${d.mount}`, percent: d.percent, foot: `已用 ${Math.round(d.used / 1073741824)} GB / 共 ${Math.round(d.total / 1073741824)} GB`, warn: t.diskWarn, danger: t.diskDanger })),
    ];
    gauges.innerHTML = rows
      .map((g) => {
        const level = g.percent >= g.danger ? 'danger' : g.percent >= g.warn ? 'warn' : 'ok';
        return `<div class="gauge gauge--${level}">
          <div class="gauge__head"><span>${esc(g.name)}</span><strong>${g.percent}%</strong></div>
          <div class="gauge__track"><span class="gauge__fill" style="width:${Math.min(100, g.percent)}%"></span></div>
          <div class="gauge__foot" title="${g.foot}">${g.foot}</div>
        </div>`;
      })
      .join('');
  }
  if (kv) {
    const rows = [
      ['系统运行时间', s.uptime.systemText],
      ['后台服务运行', s.uptime.processText],
      ['操作系统', s.platform.os],
      ['架构 / Node', `${s.platform.arch} · ${s.platform.node}`],
      ['事件循环延迟', `均值 ${s.latency.meanMs} ms · 峰值 ${s.latency.p99Ms} ms`],
      ['采集耗时', `${s.latency.sampleMs} ms`],
    ];
    kv.innerHTML = rows.map(([k, v]) => `<div><span>${esc(k)}</span><strong>${esc(v)}</strong></div>`).join('');
  }
}

function renderAlerts(data) {
  const el = document.getElementById('dash-alerts');
  if (!el) return;
  const alerts = data.server?.alerts || [];
  if (!alerts.length) {
    el.hidden = true;
    el.innerHTML = '';
    return;
  }
  el.hidden = false;
  el.innerHTML = alerts
    .map(
      (a) => `<div class="alert alert--${a.level === 'danger' ? 'error' : 'warn'}">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-6h2v6z"/></svg>
        <span>${esc(a.text)}</span>
      </div>`,
    )
    .join('');
}

function renderBuild(data) {
  const state = document.getElementById('dash-build-state');
  const time = document.getElementById('dash-build-time');
  const release = document.getElementById('dash-build-release');
  if (state) state.textContent = data.build?.status || '尚未构建';
  if (time) time.textContent = data.build?.finishedAt ? new Date(data.build.finishedAt).toLocaleString('zh-CN') : '—';
  if (release) release.textContent = data.build?.release || '—';
}

function renderDistribution(data) {
  renderDonut(
    document.getElementById('dash-source'),
    document.getElementById('dash-source-legend'),
    data.visits?.sources?.[distState.sources] || [],
    '总访问',
  );
  renderDonut(
    document.getElementById('dash-device'),
    document.getElementById('dash-device-legend'),
    data.visits?.devices?.[distState.devices] || [],
    '总访问',
  );
}

// 页面访问排行 / 访客地域分布（横条榜）。
function renderVisitRanks(data) {
  const topPaths = document.getElementById('dash-top-paths');
  if (topPaths) {
    const list = (data.visits?.topPaths || []).slice(0, 10).map((d) => ({ ...d, rank: true, title: d.title || d.key }));
    topPaths.innerHTML = list.length
      ? rankRows(list, { showSub: true })
      : '<p class="empty">暂无访问数据。</p>';
  }
  const regions = document.getElementById('dash-regions');
  if (regions) {
    const list = (data.visits?.topRegions || []).slice(0, 10).map((d) => ({ ...d, rank: true }));
    regions.innerHTML = list.length
      ? rankRows(list)
      : '<p class="empty">暂无归属地数据。</p>';
  }
}

function renderTrendByRange(data) {
  const v = data.visits || {};
  let points;
  if (trendState.range === '7') {
    points = (v.days || []).slice(-7).map((d) => ({ label: d.date.slice(5), fullLabel: d.date, value: d.pv, uv: d.uv }));
  } else if (trendState.range === '12m') {
    points = (v.months || []).map((m) => ({ label: m.month.slice(2), fullLabel: m.month, value: m.count, uv: null }));
  } else {
    points = (v.days || []).map((d) => ({ label: d.date.slice(5), fullLabel: d.date, value: d.pv, uv: d.uv }));
  }
  renderTrend(document.getElementById('dash-trend'), points);
}

function renderContentLists(data) {
  const c = data.content;
  const p = c.posts;

  // 文章状态占比（堆叠条） + 分类分布。
  const mix = document.getElementById('dash-post-mix');
  if (mix) {
    const parts = [
      { key: '已发布', count: p.published, color: '#5a9e6f' },
      { key: '草稿', count: p.drafts, color: '#c9a227' },
      { key: '回收站', count: p.trash, color: '#7f8187' },
    ];
    const total = Math.max(1, parts.reduce((s, d) => s + d.count, 0));
    mix.innerHTML =
      `<div class="stack-bar__track">${parts
        .filter((d) => d.count > 0)
        .map((d) => `<span class="stack-bar__seg" style="width:${(d.count / total) * 100}%;background:${d.color}"></span>`)
        .join('')}</div>
      <div class="stack-bar__legend">${parts
        .map((d) => `<span><i style="background:${d.color}"></i>${esc(d.key)} ${d.count}（${pct1((d.count / total) * 100)}%）</span>`)
        .join('')}</div>`;
  }

  const cat = document.getElementById('dash-category');
  if (cat) cat.innerHTML = rankRows((p.categories || []).slice(0, 8), { unit: '篇' });

  // 标签云：字号随数量缩放。
  const tags = document.getElementById('dash-tags');
  if (tags) {
    const list = (p.tags || []).slice(0, 30);
    if (!list.length) tags.innerHTML = '<p class="empty">暂无标签。</p>';
    else {
      const max = Math.max(1, ...list.map((d) => d.count));
      tags.innerHTML = list
        .map((d) => {
          const size = 13 + Math.round((d.count / max) * 9);
          return `<span class="tag-cloud__item" style="font-size:${size}px" title="${esc(d.key)} · ${d.count} 篇">${esc(d.key)}<i>${d.count}</i></span>`;
        })
        .join('');
    }
  }

  const latest = document.getElementById('dash-latest');
  if (latest) {
    const list = p.latest || [];
    latest.innerHTML = list.length
      ? list
          .map(
            (x) => `<li class="mini-list__item">
              <a href="/admin/posts/edit?path=${encodeURIComponent(x.id)}">${esc(x.title)}</a>
              <span class="mini-list__meta">${esc(x.date || '—')}</span>
            </li>`,
          )
          .join('')
      : '<li class="empty">还没有已发布的文章。</li>';
  }

  const topRead = document.getElementById('dash-top-read');
  if (topRead) {
    const list = (p.topRead || []).map((d) => ({ ...d, rank: true, key: d.id }));
    topRead.innerHTML = list.length
      ? rankRows(list, { showSub: true, unit: '次' })
      : '<p class="empty">暂无阅读数据，文章被访问后这里会出现排行。</p>';
  }

  // 评论：数量 + 近 30 天趋势 + 最近评论。
  const cs = document.getElementById('dash-comment-stats');
  if (cs) {
    const cm = c.comments;
    cs.innerHTML = [
      { label: '评论总数', value: cm.total },
      { label: '可见', value: cm.visible },
      { label: '已隐藏', value: cm.hidden },
      { label: '近 7 天新增', value: cm.week, chip: deltaChip(cm.week, cm.prevWeek, '较前 7 天') },
    ]
      .map(
        (x) => `<div class="mini-stats__item">
          <strong>${fmt(x.value)}</strong>
          <span>${esc(x.label)}</span>
          ${x.chip || ''}
        </div>`,
      )
      .join('');
  }
  renderMiniBars(document.getElementById('dash-comment-trend'), c.comments?.days || []);

  const recent = document.getElementById('dash-comment-recent');
  if (recent) {
    const list = c.comments?.recent || [];
    recent.innerHTML = list.length
      ? list
          .map(
            (x) => `<li class="mini-list__item mini-list__item--col">
              <span class="mini-list__head"><strong>${esc(x.nick)}</strong>${x.master ? '<span class="badge badge--pub">博主</span>' : ''}${x.status === 'hidden' ? '<span class="badge badge--draft">已隐藏</span>' : ''}<span class="mini-list__meta">${new Date(x.created).toLocaleString('zh-CN')}</span></span>
              <span class="mini-list__text">${esc(x.excerpt)}</span>
              <code class="mini-list__url">${esc(x.url)}</code>
            </li>`,
          )
          .join('')
      : '<li class="empty">还没有评论。</li>';
  }
}

function renderAll(data) {
  if (!data) return;
  // 重渲染会替换图表 DOM，旧的悬停提示不会再收到 mouseleave——先收起。
  hideTip();
  renderVisitStats(data);
  renderContentStats(data);
  renderServerStats(data);
  renderServerDetail(data);
  renderAlerts(data);
  renderBuild(data);
  renderTrendByRange(data);
  renderDistribution(data);
  renderVisitRanks(data);
  renderContentLists(data);
}

// ============ 刷新控制 ============
const trendState = { range: '30' };
const distState = { sources: 'all', devices: 'all' };
const INTERVAL_KEY = 'admin-dash-interval';

let rootEl = null;
let lastData = null;
let busy = false;
let timer = null;
let firstPaint = true;

function toast(message, isError) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = message;
  el.classList.toggle('toast--error', !!isError);
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    el.hidden = true;
  }, 3200);
}

function setUpdated(text) {
  const el = document.getElementById('dash-updated');
  if (el) el.textContent = text;
}

function setLoading(on) {
  if (!rootEl) return;
  rootEl.classList.toggle('is-loading', on);
  const btn = document.getElementById('dash-refresh');
  if (btn) {
    btn.disabled = on;
    btn.textContent = on ? '刷新中…' : '立即刷新';
  }
}

async function fetchJson(path) {
  // 同 admin.js 的统一请求网关：出站恒为 /api/_，目标经 X-Target 传入。
  const res = await fetch('/api/_', {
    headers: { 'X-Target': btoa(encodeURIComponent(path)) },
  });
  if (res.status === 401) {
    window.location.href = '/admin/login';
    throw new Error('未登录');
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error((data && data.error) || `请求失败 (${res.status})`);
  return data;
}

async function refresh() {
  if (busy || !rootEl || !document.getElementById('dash-root')) return;
  busy = true;
  setLoading(true);
  const t0 = performance.now();
  try {
    const data = await fetchJson('/api/manage/dashboard');
    data.rttMs = performance.now() - t0;
    lastData = data;
    renderAll(data);
    firstPaint = false;
    setUpdated(`数据更新于 ${new Date().toLocaleTimeString('zh-CN')}`);
  } catch (err) {
    setUpdated(`刷新失败：${err.message || '网络错误'}（保留上次数据）`);
    toast(err.message || '刷新失败', true);
  } finally {
    busy = false;
    setLoading(false);
  }
}

function startAuto() {
  stopAuto();
  const select = document.getElementById('dash-interval');
  const seconds = Number(select?.value || 0);
  if (!seconds) return;
  timer = setInterval(() => {
    // 后台标签页不打扰：页面不可见时跳过本轮。
    if (document.hidden) return;
    refresh();
  }, seconds * 1000);
}

function stopAuto() {
  if (timer) clearInterval(timer);
  timer = null;
}

function bindControls() {
  document.getElementById('dash-refresh')?.addEventListener('click', () => refresh());

  const select = document.getElementById('dash-interval');
  if (select) {
    const saved = localStorage.getItem(INTERVAL_KEY);
    if (saved != null && [...select.options].some((o) => o.value === saved)) select.value = saved;
    select.addEventListener('change', () => {
      localStorage.setItem(INTERVAL_KEY, select.value);
      startAuto();
      toast(select.value === '0' ? '已关闭自动刷新' : `已开启自动刷新（${select.selectedOptions[0].textContent}）`);
    });
  }

  // 时间范围 / 分布范围切换（事件委托，按钮是静态骨架里的）。
  rootEl.addEventListener('click', (e) => {
    const trendBtn = e.target.closest('#dash-trend-range [data-range]');
    if (trendBtn) {
      trendState.range = trendBtn.getAttribute('data-range');
      trendBtn.parentElement.querySelectorAll('.seg__btn').forEach((b) => b.classList.toggle('seg__btn--active', b === trendBtn));
      renderTrendByRange(lastData || {});
      return;
    }
    const distBtn = e.target.closest('[data-dash-dist] [data-range]');
    if (distBtn) {
      const group = distBtn.closest('[data-dash-dist]').getAttribute('data-dash-dist');
      distState[group] = distBtn.getAttribute('data-range');
      distBtn.parentElement.querySelectorAll('.seg__btn').forEach((b) => b.classList.toggle('seg__btn--active', b === distBtn));
      renderDistribution(lastData || {});
    }
  });
}

// 页面进入（含无刷新换页后）初始化；离开页面由 stopDashboard 收尾。
export function initDashboard() {
  rootEl = document.getElementById('dash-root');
  if (!rootEl) return;
  busy = false;
  firstPaint = true;
  trendState.range = '30';
  distState.sources = 'all';
  distState.devices = 'all';
  hideTip();
  bindControls();
  const boot = window.__BOOT__?.dash;
  if (boot) {
    lastData = boot;
    renderAll(boot);
    firstPaint = false;
    setUpdated(`数据更新于 ${new Date(boot.fetchedAt || Date.now()).toLocaleTimeString('zh-CN')}`);
    // 首屏服务器指标缺失（监控缓存未就绪）时后台补拉一次完整数据，
    // 不阻塞首屏渲染。
    if (boot.server?.pending) refresh();
  } else {
    // 首屏没有内嵌数据时才主动拉一次（正常不会走到这里）。
    refresh();
  }
  startAuto();
}

export function stopDashboard() {
  stopAuto();
  hideTip();
  rootEl = null;
}
