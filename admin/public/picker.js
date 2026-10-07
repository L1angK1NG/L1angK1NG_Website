// 自定义日期时间选择器：替代原生 date / datetime-local 输入框，视觉与后台
// 统一。触发器是只读文本框（右侧日历图标），点击弹出面板：月份切换 + 日期
// 网格（周一起始、今天描边、选中高亮）+ 时分步进（data-picker="datetime"
// 时显示时间行）；「此刻 / 今天」「清空」「确定」快捷操作。
// 值格式：'YYYY-MM-DD'（未设时间）或 'YYYY-MM-DD HH:mm'（精确到分钟）。

const pad = (n) => String(n).padStart(2, '0');

const parseValue = (raw) => {
  const m = String(raw || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?$/);
  if (!m) return null;
  return { y: Number(m[1]), mo: Number(m[2]) - 1, d: Number(m[3]), hh: Number(m[4] || 0), mi: Number(m[5] || 0) };
};

const formatValue = (p, withTime) => {
  if (!p) return '';
  const date = `${p.y}-${pad(p.mo + 1)}-${pad(p.d)}`;
  return withTime && (p.hh || p.mi) ? `${date} ${pad(p.hh)}:${pad(p.mi)}` : date;
};

export function initDateTimePickers(signal) {
  const triggers = document.querySelectorAll('[data-picker]');
  if (!triggers.length) return;

  let pop = null;
  let currentInput = null;
  let draft = null; // { y, mo, d, hh, mi }
  let viewYear = 0;
  let viewMonth = 0;

  const withTime = () => currentInput?.getAttribute('data-picker') === 'datetime';

  const close = () => {
    if (pop) pop.remove();
    pop = null;
    currentInput = null;
  };

  // 写回输入框；closeAfter=false 时只刷新面板（继续选时间）。
  // 同时派发 input / change：站点数据页的年月日增减控件等联动逻辑监听 change。
  const notifyValue = () => {
    if (!currentInput) return;
    currentInput.dispatchEvent(new Event('input', { bubbles: true }));
    currentInput.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const commit = (closeAfter) => {
    if (!currentInput) return;
    currentInput.value = formatValue(draft, withTime());
    notifyValue();
    if (closeAfter) close();
    else renderDays();
  };

  const renderDays = () => {
    if (!pop) return;
    pop.querySelector('.picker-pop__title').textContent = `${viewYear} 年 ${viewMonth + 1} 月`;
    const first = new Date(viewYear, viewMonth, 1);
    const startOffset = (first.getDay() + 6) % 7; // 周一为首
    const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
    const now = new Date();
    let html = '';
    for (let i = 0; i < startOffset; i++) html += '<span class="picker-pop__day is-empty"></span>';
    for (let d = 1; d <= daysInMonth; d++) {
      const isToday = now.getFullYear() === viewYear && now.getMonth() === viewMonth && now.getDate() === d;
      const isSel = draft && draft.y === viewYear && draft.mo === viewMonth && draft.d === d;
      html += `<button type="button" class="picker-pop__day${isToday ? ' is-today' : ''}${isSel ? ' is-selected' : ''}" data-day="${d}">${d}</button>`;
    }
    pop.querySelector('.picker-pop__days').innerHTML = html;
    const hh = pop.querySelector('[data-time="hh"]');
    const mi = pop.querySelector('[data-time="mi"]');
    if (hh) hh.textContent = pad(draft.hh);
    if (mi) mi.textContent = pad(draft.mi);
  };

  const open = (input) => {
    close();
    currentInput = input;
    const parsed = parseValue(input.value);
    const now = new Date();
    draft = parsed || { y: now.getFullYear(), mo: now.getMonth(), d: now.getDate(), hh: 0, mi: 0 };
    viewYear = draft.y;
    viewMonth = draft.mo;

    pop = document.createElement('div');
    pop.className = 'picker-pop pop-in';
    pop.innerHTML = `
      <div class="picker-pop__head">
        <button type="button" class="date-stepper__btn" data-nav="-1" aria-label="上个月">‹</button>
        <strong class="picker-pop__title"></strong>
        <button type="button" class="date-stepper__btn" data-nav="1" aria-label="下个月">›</button>
      </div>
      <div class="picker-pop__week">${['一', '二', '三', '四', '五', '六', '日'].map((w) => `<span>${w}</span>`).join('')}</div>
      <div class="picker-pop__days"></div>
      ${
        withTime()
          ? `<div class="picker-pop__time">
        <span class="field__label">时间</span>
        <div class="date-stepper">
          <button type="button" class="date-stepper__btn" data-tick="hh:-1" aria-label="小时减一">−</button>
          <span class="picker-pop__timeval" data-time="hh">00</span>
          <span class="date-stepper__unit">时</span>
          <button type="button" class="date-stepper__btn" data-tick="hh:1" aria-label="小时加一">＋</button>
        </div>
        <div class="date-stepper">
          <button type="button" class="date-stepper__btn" data-tick="mi:-5" aria-label="分钟减五">−</button>
          <span class="picker-pop__timeval" data-time="mi">00</span>
          <span class="date-stepper__unit">分</span>
          <button type="button" class="date-stepper__btn" data-tick="mi:5" aria-label="分钟加五">＋</button>
        </div>
      </div>`
          : ''
      }
      <div class="picker-pop__foot">
        <button type="button" class="btn btn--sm btn--ghost" data-act="clear">清空</button>
        <button type="button" class="btn btn--sm" data-act="now">${withTime() ? '此刻' : '今天'}</button>
        <button type="button" class="btn btn--sm btn--primary" data-act="ok">确定</button>
      </div>`;
    document.body.append(pop);

    // 定位在触发器正下方；靠近右/下边缘时翻转，保证面板不出屏。
    const rect = input.getBoundingClientRect();
    const pw = pop.offsetWidth;
    const ph = pop.offsetHeight;
    pop.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - pw - 12))}px`;
    pop.style.top = `${Math.min(rect.bottom + 8, window.innerHeight - ph - 12)}px`;

    renderDays();

    pop.addEventListener('click', (e) => {
      // 面板内部点击不外冒：renderDays 会重绘网格、被点元素随即脱离 DOM，
      // 一旦冒泡到 document 的「点外部关闭」判断就会误判成面板外点击。
      e.stopPropagation();
      const nav = e.target.closest('[data-nav]');
      if (nav) {
        viewMonth += Number(nav.getAttribute('data-nav'));
        if (viewMonth < 0) {
          viewMonth = 11;
          viewYear -= 1;
        } else if (viewMonth > 11) {
          viewMonth = 0;
          viewYear += 1;
        }
        renderDays();
        return;
      }
      const day = e.target.closest('[data-day]');
      if (day) {
        draft = { ...draft, y: viewYear, mo: viewMonth, d: Number(day.getAttribute('data-day')) };
        // 纯日期模式点日即定；日期时间模式先定日期、继续选时间。
        commit(!withTime());
        return;
      }
      const tick = e.target.closest('[data-tick]');
      if (tick) {
        const [part, delta] = tick.getAttribute('data-tick').split(':');
        const step = Number(delta);
        if (part === 'hh') draft.hh = (draft.hh + step + 24) % 24;
        else draft.mi = (draft.mi + step + 60) % 60;
        renderDays();
        return;
      }
      const act = e.target.closest('[data-act]');
      if (!act) return;
      const kind = act.getAttribute('data-act');
      if (kind === 'clear') {
        currentInput.value = '';
        notifyValue();
        close();
      } else if (kind === 'now') {
        const t = new Date();
        draft = { y: t.getFullYear(), mo: t.getMonth(), d: t.getDate(), hh: t.getHours(), mi: t.getMinutes() };
        viewYear = draft.y;
        viewMonth = draft.mo;
        commit(true);
      } else if (kind === 'ok') {
        commit(true);
      }
    });
  };

  triggers.forEach((input) => {
    input.readOnly = true;
    input.classList.add('picker-input');
    input.addEventListener('click', () => open(input));
  });

  // 点面板与触发框之外、或按 Esc 关闭面板。
  document.addEventListener('click', (e) => {
    if (pop && !e.target.closest('.picker-pop') && !e.target.closest('[data-picker]')) close();
  }, { signal });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  }, { signal });
}
