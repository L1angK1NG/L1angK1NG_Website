// 后台面板客户端。原生 JS（ES module），无需构建步骤。携带 CSRF token 调用
// JSON API，驱动编辑器实时预览、媒体上传和构建任务。
// HTML 净化复用前台同一套白名单逻辑（/admin-assets/shared/sanitize.js）；
// 无刷新导航的页面请求走 /admin-assets/page-loader.js（路由白名单在彼处校验）。
import { sanitizeHtml } from '/admin-assets/shared/sanitize.js';
import { isAllowedAdminRoute, loadAdminPage } from '/admin-assets/page-loader.js';
import { initDashboard, stopDashboard } from '/admin-assets/dashboard.js?v=1918';
import { initDateTimePickers } from '/admin-assets/picker.js?v=1910';

(() => {
  // 页面级启动数据：无刷新导航换页后由 initPage 重新读取（boot / csrf 都是活值）。
  let boot = window.__BOOT__ || {};

  const toastEl = () => document.getElementById('toast');
  function toast(message, isError) {
    const el = toastEl();
    if (!el) return;
    el.textContent = message;
    el.classList.toggle('toast--error', !!isError);
    el.hidden = false;
    // 滑入 → 停留 → 滑出（两段式，避免 display 切换的生硬感）。
    el.classList.remove('is-out');
    requestAnimationFrame(() => el.classList.add('is-in'));
    clearTimeout(toast._t);
    toast._t = setTimeout(() => {
      el.classList.remove('is-in');
      el.classList.add('is-out');
      setTimeout(() => {
        el.hidden = true;
        el.classList.remove('is-out');
      }, 250);
    }, 3200);
  }

  // 面板/编辑器露出时播放入场动画（每次调用都重新触发）。
  const reveal = (el) => {
    if (!el) return;
    el.hidden = false;
    el.classList.remove('pop-in');
    void el.offsetWidth;
    el.classList.add('pop-in');
  };

  const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // 后台 API 路由白名单：只允许 /api/ 下的相对路径（可带查询串）——
  // 所有请求都是发给本后台自身的接口，其余地址一律拒绝。
  const API_ROUTE_RE = /^\/api\/[\w\-/.]*(?:\?[^#\s]*)?$/;

  // 统一请求网关：出站 URL 恒为字面量 /api/_（不含协议与主机成分，永远指向本站
  // 自身），真实接口路径经双重编码放进 X-Target 请求头，服务端解码白名单校验后
  // 内部派发——目标不进入 URL。
  async function api(path, { method = 'GET', body, raw, noAuthRedirect } = {}) {
    const endpoint = String(path || '');
    if (!API_ROUTE_RE.test(endpoint)) {
      throw new Error('非法的接口地址');
    }
    const opts = { method, headers: {} };
    const token = window.__BOOT__?.csrfToken;
    if (token) opts.headers['X-CSRF-Token'] = token;
    opts.headers['X-Target'] = btoa(encodeURIComponent(endpoint));
    if (raw) {
      opts.body = body;
    } else if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch('/api/_', opts);
    if (res.status === 401 && !noAuthRedirect) {
      window.location.href = '/admin/login';
      throw new Error('未登录');
    }
    let data = null;
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) data = await res.json();
    if (!res.ok) throw new Error((data && data.error) || `请求失败 (${res.status})`);
    return data;
  }

  // —— 登录认证 ——
  const loginForm = document.getElementById('login-form');
  if (loginForm) {
    const errorBox = document.getElementById('login-error');
    const errorMsg = document.getElementById('login-error-msg');

    const showLoginError = (message) => {
      if (!errorBox || !errorMsg) return;
      errorMsg.textContent = message;
      errorBox.hidden = false;
      // 重新触发抖动动画，让连续的登录失败同样醒目。
      errorBox.classList.remove('alert--shake');
      void errorBox.offsetWidth;
      errorBox.classList.add('alert--shake');
      const userInput = loginForm.querySelector('input[name="username"]');
      const passInput = loginForm.querySelector('input[name="password"]');
      (userInput.value ? passInput : userInput).focus();
    };
    const hideLoginError = () => {
      if (errorBox) errorBox.hidden = true;
    };
    // 重新输入时清除过期的错误提示，让表单始终反映当前输入，
    // 而不是残留之前那条已失效的「密码错误」。
    loginForm.querySelectorAll('input').forEach((input) => {
      input.addEventListener('input', hideLoginError);
    });

    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(loginForm);
      const submitBtn = loginForm.querySelector('button[type="submit"]');
      submitBtn.disabled = true;
      submitBtn.textContent = '登录中…';
      hideLoginError();
      try {
        // noAuthRedirect：登录失败必须在页面上内联提示——此时重新加载页面
        // 会清空用户已经输入的凭据。
        await api('/api/login', {
          method: 'POST',
          noAuthRedirect: true,
          body: {
            username: fd.get('username'),
            password: fd.get('password'),
            // 「30 分钟内记住登录状态」复选框（默认勾选）。
            remember: fd.get('remember') === 'on',
          },
        });
        window.location.href = '/admin';
      } catch (err) {
        showLoginError(err.message || '登录失败，请重试。');
        submitBtn.disabled = false;
        submitBtn.textContent = '登录';
      }
    });
  }

  const logoutBtn = document.getElementById('logout');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      try {
        await api('/api/logout', { method: 'POST' });
      } catch {
        /* 忽略 */
      }
      window.location.href = '/admin/login';
    });
  }

  // 社交链接行的新增/删除用事件委托（文档级，只绑一次；行可任意重渲染）。
  const socialRowHtml = (ns, i) => `<div class="kv-row" data-social="${ns}" data-index="${i}">
        <input class="input" data-sfield="icon" value="" placeholder="图标名 如 bilibili" />
        <input class="input" data-sfield="label" value="" placeholder="显示名" />
        <input class="input" data-sfield="href" value="" placeholder="链接地址" />
        <button type="button" class="btn btn--sm btn--danger" data-social-remove="${ns}" data-index="${i}">删</button>
      </div>`;

  document.addEventListener('click', (e) => {
    const addBtn = e.target.closest('[data-social-add]');
    if (addBtn) {
      const ns = addBtn.getAttribute('data-social-add');
      const box = document.getElementById(`p-${ns}-socials`);
      if (box) box.insertAdjacentHTML('beforeend', socialRowHtml(ns, Date.now()));
      return;
    }
    const rmBtn = e.target.closest('[data-social-remove]');
    if (rmBtn) rmBtn.closest('.kv-row')?.remove();
  });

  // ===== 页面级初始化 =====
  // 每次页面内容切换（无刷新导航 / 操作后刷新）都会重跑：重新读取 boot 数据、
  // 为新 DOM 绑定交互。登录/退出/文档级委托等常驻绑定都在本函数之外。
  // 每轮初始化轮换 AbortController：document 级监听（粘贴插图、Esc 等）
  // 用 signal 绑定，换页时自动清理，不会跨页面累积。
  let pageController = null;

  function initPage() {
    boot = window.__BOOT__ || {};
    pageController?.abort();
    pageController = new AbortController();
    const { signal } = pageController;

    // —— 仪表盘 ——
    // 换页后先停掉旧页面的自动刷新定时器，再按需初始化（离开仪表盘即静止）。
    stopDashboard();
    if (document.getElementById('dash-root')) initDashboard();

    // —— 自定义日期时间选择器（编辑器等页面的 [data-picker] 输入框） ——
    initDateTimePickers(signal);

  // —— 编辑器（写作优先版式） ——
  const bodyArea = document.getElementById('body');
  const slugInput = document.getElementById('slug');
  const urlPreview = document.getElementById('url-preview');
  const collection = boot.collection;
  const isEditor = !!bodyArea && !!collection;

  if (isEditor) {
    // slug 与 URL 预览（位于设置抽屉内）。
    const updateUrlPreview = () => {
      if (!urlPreview || !slugInput) return;
      const prefix = collection === 'posts' ? '/posts/' : '/notes/';
      urlPreview.textContent = prefix + (slugInput.value.trim() || '…') + '/';
    };
    if (slugInput) {
      slugInput.addEventListener('input', updateUrlPreview);
      updateUrlPreview();
    }

    // 标签页：写作 / 预览。
    const previewEl = document.getElementById('preview');
    const tabs = document.querySelectorAll('.tab');
    tabs.forEach((tab) => {
      tab.addEventListener('click', async () => {
        tabs.forEach((t) => t.classList.toggle('tab--active', t === tab));
        const toPreview = tab.dataset.tab === 'preview';
        if (toPreview) {
          try {
            const { html } = await api('/api/preview', { method: 'POST', body: { markdown: bodyArea.value } });
            // 预览输出过白名单净化再注入：即使内容含恶意 HTML 也不会执行。
            previewEl.innerHTML = sanitizeHtml(html, { extended: true });
          } catch (err) {
            previewEl.textContent = '预览失败：' + err.message;
          }
          reveal(previewEl);
          bodyArea.hidden = true;
        } else {
          previewEl.hidden = true;
          reveal(bodyArea);
        }
      });
    });

    const saveBtn = document.getElementById('save-btn');
    if (saveBtn) {
      saveBtn.addEventListener('click', async () => {
        const fields = {};
        for (const el of document.querySelectorAll('[data-field]')) {
          const name = el.getAttribute('data-field');
          fields[name] = el.type === 'checkbox' ? el.checked : el.value;
        }
        const id = slugInput ? slugInput.value.trim() : '';
        saveBtn.disabled = true;
        saveBtn.textContent = '保存中…';
        try {
          const result = await api(`/api/save/${collection}`, {
            method: 'POST',
            body: { id, originalId: boot.originalId || null, fields, body: bodyArea.value },
          });
          toast(result.message || '已保存');
          if (boot.isNew) navigate(`/admin/${collection}/edit?path=${encodeURIComponent(result.id)}`);
          else saveBtn.textContent = '已保存';
        } catch (err) {
          toast(err.message, true);
          saveBtn.disabled = false;
          saveBtn.textContent = '保存';
        }
      });
    }

    // —— 字数统计 ——
    const countEl = document.getElementById('editor-count');
    const updateCount = () => {
      if (!countEl) return;
      const text = bodyArea.value;
      const cjk = (text.match(/[一-龥]/g) || []).length;
      const words = (text.replace(/[一-龥]/g, ' ').match(/[A-Za-z0-9]+/g) || []).length;
      const total = cjk + words;
      countEl.textContent = `${total} 字 · 约 ${Math.max(1, Math.round(total / 300))} 分钟`;
    };
    bodyArea.addEventListener('input', updateCount);
    updateCount();

    // —— 多级撤销 / 重做 ——
    // 插入图片、格式包裹这类程序化改写会清空浏览器原生撤销栈，因此自带快照
    // 历史：连续打字 400ms 内合并为一组，程序化修改单独成组；Ctrl+Z 撤销、
    // Ctrl+Y（或 Ctrl+Shift+Z）重做，恢复内容的同时恢复光标位置。
    const history = {
      stack: [{ value: bodyArea.value, selStart: bodyArea.selectionStart ?? 0, selEnd: bodyArea.selectionEnd ?? 0 }],
      index: 0,
      lastAt: 0,
    };
    const historySnapshot = () => ({
      value: bodyArea.value,
      selStart: bodyArea.selectionStart ?? 0,
      selEnd: bodyArea.selectionEnd ?? 0,
    });
    const pushHistory = (force = false) => {
      const now = Date.now();
      const top = history.stack[history.index];
      if (top.value === bodyArea.value) return;
      if (!force && now - history.lastAt < 400 && history.index === history.stack.length - 1) {
        // 输入合并：把这组打字的终点并入顶部快照。
        history.stack[history.index] = historySnapshot();
      } else {
        history.stack = history.stack.slice(0, history.index + 1);
        history.stack.push(historySnapshot());
        if (history.stack.length > 120) history.stack.shift();
        history.index = history.stack.length - 1;
      }
      history.lastAt = now;
    };
    const restoreHistory = (snap) => {
      bodyArea.value = snap.value;
      bodyArea.selectionStart = snap.selStart;
      bodyArea.selectionEnd = snap.selEnd;
      bodyArea.focus();
      updateCount();
    };
    const undoEdit = () => {
      if (history.index <= 0) return toast('没有可撤销的操作');
      history.index -= 1;
      restoreHistory(history.stack[history.index]);
      history.lastAt = 0; // 撤销后的下一次输入另起一组
    };
    const redoEdit = () => {
      if (history.index >= history.stack.length - 1) return toast('没有可重做的操作');
      history.index += 1;
      restoreHistory(history.stack[history.index]);
      history.lastAt = 0;
    };
    bodyArea.addEventListener('input', () => pushHistory(false));

    // —— Markdown 快捷格式 ——
    const wrapSelection = (before, after, placeholder) => {
      const start = bodyArea.selectionStart ?? bodyArea.value.length;
      const end = bodyArea.selectionEnd ?? start;
      const selected = bodyArea.value.slice(start, end) || placeholder;
      bodyArea.value = bodyArea.value.slice(0, start) + before + selected + after + bodyArea.value.slice(end);
      bodyArea.selectionStart = start + before.length;
      bodyArea.selectionEnd = start + before.length + selected.length;
      bodyArea.focus();
      updateCount();
      pushHistory(true);
    };
    const linePrefix = (prefix) => {
      const start = bodyArea.selectionStart ?? bodyArea.value.length;
      const lineStart = bodyArea.value.lastIndexOf('\n', start - 1) + 1;
      bodyArea.value = bodyArea.value.slice(0, lineStart) + prefix + bodyArea.value.slice(lineStart);
      bodyArea.selectionStart = bodyArea.selectionEnd = start + prefix.length;
      bodyArea.focus();
      updateCount();
      pushHistory(true);
    };
    const FORMATS = {
      bold: () => wrapSelection('**', '**', '加粗文字'),
      italic: () => wrapSelection('*', '*', '斜体文字'),
      code: () => wrapSelection('`', '`', 'code'),
      link: () => wrapSelection('[', '](https://)', '链接文字'),
      quote: () => linePrefix('> '),
      list: () => linePrefix('- '),
      heading: () => linePrefix('## '),
    };
    document.querySelectorAll('[data-fmt]').forEach((btn) => {
      btn.addEventListener('click', () => FORMATS[btn.getAttribute('data-fmt')]?.());
    });

    // —— 工具栏按钮反馈 ——
    // 点击后短促高亮（is-pressed 淡出），每次点击都有明确回应；
    // 插图弹窗打开期间「插图」按钮保持激活态（is-active）。
    document.querySelector('.editor__toolbar')?.addEventListener('click', (e) => {
      const btn = e.target.closest('.tool-btn');
      if (!btn) return;
      btn.classList.add('is-pressed');
      window.setTimeout(() => btn.classList.remove('is-pressed'), 320);
    });

    // —— 图片插入 ——
    // 两条路径：弹窗（媒体库选图 / 上传，配尺寸·对齐·图注）与拖拽/粘贴正文
    // 即时插入（沿用上次的尺寸/对齐选择）。多张批量按顺序插入。
    const modal = document.getElementById('img-modal');
    const galleryEl = document.getElementById('img-gallery');
    const thumbEl = document.getElementById('img-thumb');
    const selectedNameEl = document.getElementById('img-selected-name');
    const insertBtn = document.getElementById('img-insert');
    const captionInput = document.getElementById('img-caption');
    const fileInput = document.getElementById('img-file');
    const dropZone = document.getElementById('img-drop');
    const imgState = { url: '', size: '33', align: 'center' };

    const escText = (s) =>
      String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const isImageFile = (file) =>
      /\.(jpe?g|png|webp)$/i.test(file.name) || ['image/jpeg', 'image/png', 'image/webp'].includes(file.type);
    const validateImage = (file) => {
      if (!isImageFile(file)) return '仅支持 JPG、PNG、WebP 格式的图片';
      if (file.size > 10 * 1024 * 1024) return `图片不能超过 10MB（当前 ${(file.size / 1048576).toFixed(1)}MB）`;
      return '';
    };

    // 在光标处插入一段/多段图片片段（替换选区；与上下文保持空行独立成段）。
    const insertAtCaret = (snippets) => {
      const start = bodyArea.selectionStart ?? bodyArea.value.length;
      const end = bodyArea.selectionEnd ?? start;
      const before = bodyArea.value.slice(0, start);
      const after = bodyArea.value.slice(end);
      const padBefore = before && !before.endsWith('\n') ? '\n\n' : before.endsWith('\n\n') ? '' : '\n';
      const padAfter = after.startsWith('\n\n') || after === '' ? '\n' : '\n\n';
      const inserted = padBefore + snippets.join('\n\n') + padAfter;
      bodyArea.value = before + inserted + after;
      bodyArea.selectionStart = bodyArea.selectionEnd = start + inserted.length;
      bodyArea.focus();
      updateCount();
      pushHistory(true);
    };

    // 生成图片片段：有图注时展开为多行块（figcaption 显示在图片下方）。
    const buildFigure = (url, caption) => {
      const alt = escText(caption || '');
      const imgTag = `<img src="${escText(url)}" alt="${alt}" loading="lazy" decoding="async">`;
      const cls = `post-figure post-figure--${imgState.align} post-figure--w${imgState.size}`;
      return caption
        ? `<figure class="${cls}">\n  ${imgTag}\n  <figcaption>${escText(caption)}</figcaption>\n</figure>`
        : `<figure class="${cls}">${imgTag}</figure>`;
    };

    const galleryItemHtml = (url, name) =>
      `<button type="button" class="img-gallery__item" data-url="${escText(url)}" title="${escText(name)}"><img src="${escText(url)}" alt="${escText(name)}" loading="lazy" /></button>`;

    const selectImage = (url, name) => {
      imgState.url = url;
      thumbEl.src = url;
      thumbEl.hidden = false;
      selectedNameEl.textContent = name || url;
      insertBtn.disabled = false;
      galleryEl.querySelectorAll('.img-gallery__item').forEach((el) => {
        el.classList.toggle('is-selected', el.getAttribute('data-url') === url);
      });
    };

    const loadGallery = async () => {
      galleryEl.innerHTML = '<p class="empty">媒体库加载中…</p>';
      try {
        const { items } = await api('/api/media');
        galleryEl.innerHTML = items.length
          ? items.slice(0, 36).map((f) => galleryItemHtml(f.url, f.name)).join('')
          : '<p class="empty">媒体库还是空的，上传一张吧。</p>';
      } catch (err) {
        galleryEl.innerHTML = `<p class="empty">媒体库加载失败：${escText(err.message)}</p>`;
      }
    };

    const openModal = () => {
      modal.hidden = false;
      document.getElementById('img-insert-btn')?.classList.add('is-active');
      reveal(modal.querySelector('.modal__card'));
      loadGallery();
    };
    const closeModal = () => {
      modal.hidden = true;
      document.getElementById('img-insert-btn')?.classList.remove('is-active');
      imgState.url = '';
      thumbEl.hidden = true;
      thumbEl.removeAttribute('src');
      selectedNameEl.textContent = '尚未选择图片';
      insertBtn.disabled = true;
      captionInput.value = '';
    };

    document.getElementById('img-insert-btn')?.addEventListener('click', openModal);
    modal.querySelectorAll('[data-img-close]').forEach((el) => el.addEventListener('click', closeModal));

    // 尺寸 / 对齐胶囊（跨插入记忆上次选择）。
    modal.querySelectorAll('.chips .chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        const group = chip.closest('.chips').getAttribute('data-chip-group');
        chip.parentElement.querySelectorAll('.chip').forEach((c) => c.classList.toggle('is-active', c === chip));
        imgState[group] = chip.getAttribute(`data-${group}`);
      });
    });

    galleryEl.addEventListener('click', (e) => {
      const item = e.target.closest('.img-gallery__item');
      if (item) selectImage(item.getAttribute('data-url'), item.getAttribute('title'));
    });

    // 弹窗内上传：逐张上传后自动选中，多张全部进入媒体库网格。
    const uploadIntoModal = async (fileList) => {
      const files = [...fileList].filter(isImageFile);
      if (!files.length) return;
      for (const file of files) {
        const invalid = validateImage(file);
        if (invalid) {
          toast(`${file.name}：${invalid}`, true);
          continue;
        }
        try {
          const result = await api(`/api/upload?filename=${encodeURIComponent(file.name)}`, {
            method: 'POST',
            body: file,
            raw: true,
          });
          galleryEl.insertAdjacentHTML('afterbegin', galleryItemHtml(result.url, file.name));
          selectImage(result.url, file.name);
        } catch (err) {
          toast(`${file.name}：${err.message}`, true);
        }
      }
    };

    document.getElementById('img-pick')?.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      // 先清空 value：同一文件再次被选中时也能触发 change。
      const picked = fileInput.files ? [...fileInput.files] : [];
      fileInput.value = '';
      if (picked.length) uploadIntoModal(picked);
    });
    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.classList.add('is-over');
    });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('is-over'));
    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('is-over');
      const files = e.dataTransfer && e.dataTransfer.files;
      if (files && files.length) uploadIntoModal(files);
    });

    // 确认插入（带图注的单张流程）。
    insertBtn.addEventListener('click', () => {
      if (!imgState.url) return toast('请先选择或上传图片', true);
      insertAtCaret([buildFigure(imgState.url, captionInput.value.trim())]);
      closeModal();
      toast('图片已插入正文');
    });

    // —— 拖拽 / 粘贴到正文 = 即时插入（无需弹窗，多张按顺序） ——
    const instantInsert = async (fileList) => {
      const files = [...fileList].filter(isImageFile);
      if (!files.length) return;
      const urls = [];
      for (const file of files) {
        const invalid = validateImage(file);
        if (invalid) {
          toast(`${file.name}：${invalid}`, true);
          continue;
        }
        try {
          const result = await api(`/api/upload?filename=${encodeURIComponent(file.name)}`, {
            method: 'POST',
            body: file,
            raw: true,
          });
          urls.push(result.url);
        } catch (err) {
          toast(`${file.name}：${err.message}`, true);
        }
      }
      if (urls.length) {
        insertAtCaret(urls.map((url) => buildFigure(url, '')));
        toast(`已插入 ${urls.length} 张图片`);
      }
    };

    bodyArea.addEventListener('dragover', (e) => e.preventDefault());
    bodyArea.addEventListener('drop', (e) => {
      const files = e.dataTransfer && e.dataTransfer.files;
      if (files && [...files].some(isImageFile)) {
        e.preventDefault();
        instantInsert(files);
      }
    });

    // 粘贴：弹窗打开时上传进弹窗；否则直接插入正文。
    document.addEventListener('paste', (e) => {
      const files = e.clipboardData && e.clipboardData.files;
      if (!files || !files.length || !isImageFile(files[0])) return;
      e.preventDefault();
      if (modal.hidden) instantInsert(files);
      else uploadIntoModal(files);
    }, { signal });

    // Esc 关闭图片弹窗；Ctrl+Z / Ctrl+Y 在正文区撤销与重做。
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !modal.hidden) {
        closeModal();
        return;
      }
      const inBody = e.target === bodyArea || Boolean(e.target.closest?.('.editor__toolbar'));
      if (!inBody || !(e.ctrlKey || e.metaKey)) return;
      const key = e.key.toLowerCase();
      if (key === 'z' && !e.shiftKey) {
        e.preventDefault();
        undoEdit();
      } else if (key === 'y' || (key === 'z' && e.shiftKey)) {
        e.preventDefault();
        redoEdit();
      }
    }, { signal });
  }

  // —— 上传（封面字段按钮 + 媒体页面） ——
  async function uploadFile(file, onDone) {
    const qs = encodeURIComponent(file.name);
    try {
      const result = await api(`/api/upload?filename=${qs}`, { method: 'POST', body: file, raw: true });
      toast(result.duplicate ? '文件内容与已有文件相同，已复用现有文件' : '上传成功');
      if (onDone) onDone(result);
    } catch (err) {
      toast(err.message, true);
    }
  }

  function pickAndUpload(targetInputId) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = () => {
      const file = input.files && input.files[0];
      if (file) uploadFile(file, (result) => {
        const target = targetInputId && document.getElementById(targetInputId);
        if (target) target.value = result.url;
      });
    };
    input.click();
  }

  document.querySelectorAll('[data-upload-target]').forEach((btn) => {
    btn.addEventListener('click', () => pickAndUpload(btn.getAttribute('data-upload-target')));
  });

  const uploadInput = document.getElementById('upload-input');
  const uploadZone = document.getElementById('upload-zone');
  if (uploadInput) {
    uploadInput.addEventListener('change', () => {
      const file = uploadInput.files && uploadInput.files[0];
      if (file) uploadFile(file, () => refreshPage());
    });
  }
  if (uploadZone) {
    uploadZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      uploadZone.classList.add('upload-zone--over');
    });
    uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('upload-zone--over'));
    uploadZone.addEventListener('drop', (e) => {
      e.preventDefault();
      uploadZone.classList.remove('upload-zone--over');
      const file = e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) uploadFile(file, () => refreshPage());
    });
  }

  document.querySelectorAll('[data-copy]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(btn.getAttribute('data-copy'));
        toast('已复制链接');
      } catch {
        toast('复制失败', true);
      }
    });
  });

  // —— 媒体删除（媒体页面） ——
  document.querySelectorAll('[data-media-delete]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const name = btn.getAttribute('data-media-delete');
      if (!window.confirm(`确定删除「${name}」吗？若仍被文章或随笔引用，删除会被拒绝。`)) return;
      btn.disabled = true;
      try {
        await api('/api/media/delete', { method: 'POST', body: { name } });
        toast('已删除');
        const item = btn.closest('.media-item');
        if (item) item.remove();
      } catch (err) {
        toast(err.message, true);
        btn.disabled = false;
      }
    });
  });

  // —— 删除（列表页面，移入回收站） ——
  document.querySelectorAll('[data-delete]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-delete');
      const coll = btn.getAttribute('data-collection');
      if (!window.confirm(`确定删除「${id}」吗？删除后会移入回收站，可随时恢复。`)) return;
      try {
        const result = await api(`/api/delete/${coll}`, { method: 'POST', body: { id } });
        toast(result.message || '已移入回收站');
        refreshPage();
      } catch (err) {
        toast(err.message, true);
      }
    });
  });

  // —— 回收站（恢复 / 彻底删除 / 清空） ——
  document.querySelectorAll('[data-trash-restore]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        const result = await api('/api/trash/restore', {
          method: 'POST',
          body: { collection: btn.getAttribute('data-collection'), file: btn.getAttribute('data-trash-restore') },
        });
        toast(result.message || '已恢复');
        refreshPage();
      } catch (err) {
        toast(err.message, true);
      }
    });
  });
  document.querySelectorAll('[data-trash-purge]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!window.confirm('彻底删除后无法找回，确定吗？')) return;
      try {
        const result = await api('/api/trash/purge', {
          method: 'POST',
          body: { collection: btn.getAttribute('data-collection'), file: btn.getAttribute('data-trash-purge') },
        });
        toast(result.message || '已彻底删除');
        refreshPage();
      } catch (err) {
        toast(err.message, true);
      }
    });
  });
  const purgeAllBtn = document.getElementById('trash-purge-all');
  if (purgeAllBtn) {
    purgeAllBtn.addEventListener('click', async () => {
      if (!window.confirm('确定清空回收站吗？所有条目将被彻底删除，无法找回。')) return;
      try {
        const result = await api('/api/trash/purge', {
          method: 'POST',
          body: { collection: purgeAllBtn.getAttribute('data-collection'), all: true },
        });
        toast(result.message || '已清空');
        refreshPage();
      } catch (err) {
        toast(err.message, true);
      }
    });
  }

  // —— 动态模块（页面内容 / 项目 / 导航 / 友链 / 音乐 / 公告 / 评论） ——
  const bind = (sel, evt, fn) => {
    document.querySelectorAll(sel).forEach((el) => el.addEventListener(evt, fn));
  };
  const val = (id) => {
    const el = document.getElementById(id);
    return el ? el.value.trim() : '';
  };
  const setVal = (id, v) => {
    const el = document.getElementById(id);
    if (el) el.value = v ?? '';
  };
  // 操作成功后的「刷新」只换内容不整页重载（无刷新导航，保留滚动之外的一切状态）。
  const reload = () => refreshPage();

  // ===== 页面内容（主页 hero + 关于页 + 页脚） =====
  const profileSave = document.getElementById('profile-save');
  if (profileSave) {
    // requireHref=false 用于页脚链接（链接可空，渲染为纯文字胶囊）
    const collectSocials = (ns, requireHref = true) =>
      [...document.querySelectorAll(`[data-social="${ns}"]`)].map((row) => ({
        icon: row.querySelector('[data-sfield="icon"]').value.trim(),
        label: row.querySelector('[data-sfield="label"]').value.trim(),
        href: row.querySelector('[data-sfield="href"]').value.trim(),
      })).filter((s) => s.label && (!requireHref || s.href));

    profileSave.addEventListener('click', async () => {
      profileSave.disabled = true;
      profileSave.textContent = '保存中…';
      try {
        const result = await api('/api/manage/profile', {
          method: 'POST',
          body: {
            profile: {
              hero: {
                eyebrow: val('p-hero-eyebrow'),
                title: val('p-hero-title'),
                bio: val('p-hero-bio'),
                actionLabel: val('p-hero-action-label'),
                actionHref: val('p-hero-action-href'),
                socials: collectSocials('hero'),
              },
              about: {
                lead: val('p-about-lead'),
                subs: val('p-about-subs').split('\n').map((s) => s.trim()).filter(Boolean),
                facts: val('p-about-facts').split('\n').map((s) => s.trim()).filter(Boolean),
                socials: collectSocials('about'),
              },
              footer: {
                tagline: val('p-footer-tagline'),
                links: collectSocials('footer', false),
                copyright: val('p-footer-copyright'),
                attribution: val('p-footer-attribution'),
              },
            },
          },
        });
        toast(result.message || '已保存');
        profileSave.textContent = '已保存';
        setTimeout(() => {
          profileSave.disabled = false;
          profileSave.textContent = '保存';
        }, 1500);
      } catch (err) {
        toast(err.message, true);
        profileSave.disabled = false;
        profileSave.textContent = '保存';
      }
    });
  }

  // ===== 站点数据（开站日期） =====
  const siteMetaSave = document.getElementById('site-meta-save');
  if (siteMetaSave) {
    const dateInput = document.getElementById('site-since');
    const yEl = document.getElementById('site-year');
    const mEl = document.getElementById('site-month');
    const dEl = document.getElementById('site-day');

    const pad = (n) => String(n).padStart(2, '0');
    const daysInMonth = (y, m) => new Date(y, m, 0).getDate();

    // 数字控件（年月日）↔ 日期输入框双向联动：日历选完回填数字，增减改完写回日期。
    const syncFromInput = () => {
      const raw = (dateInput?.value || '').split('-');
      if (!raw[0]) {
        const now = new Date();
        yEl.value = String(now.getFullYear());
        mEl.value = String(now.getMonth() + 1);
        dEl.value = String(now.getDate());
        return;
      }
      yEl.value = String(Number(raw[0]));
      mEl.value = String(Number(raw[1]));
      dEl.value = String(Number(raw[2]));
    };
    const syncToInput = () => {
      const y = Number(yEl.value) || new Date().getFullYear();
      const m = Math.min(12, Math.max(1, Number(mEl.value) || 1));
      const d = Math.min(daysInMonth(y, m), Math.max(1, Number(dEl.value) || 1));
      yEl.value = String(y);
      mEl.value = String(m);
      dEl.value = String(d);
      if (dateInput) dateInput.value = `${y}-${pad(m)}-${pad(d)}`;
    };

    // −／＋ 按真实日历进位：日期加减跨月跨年，月份增减时日期自动落到月末。
    const stepDate = (unit, delta) => {
      const y = Number(yEl.value) || new Date().getFullYear();
      const m = Math.min(12, Math.max(1, Number(mEl.value) || 1));
      const d = Math.min(daysInMonth(y, m), Math.max(1, Number(dEl.value) || 1));
      let ny = y;
      let nm = m;
      let nd = d;
      if (unit === 'day') {
        const t = new Date(y, m - 1, d + delta);
        ny = t.getFullYear();
        nm = t.getMonth() + 1;
        nd = t.getDate();
      } else if (unit === 'month') {
        const t = new Date(y, m - 1 + delta, 1);
        ny = t.getFullYear();
        nm = t.getMonth() + 1;
        nd = Math.min(d, daysInMonth(ny, nm));
      } else if (unit === 'year') {
        ny = y + delta;
        nd = Math.min(d, daysInMonth(ny, m));
      }
      yEl.value = String(ny);
      mEl.value = String(nm);
      dEl.value = String(nd);
      syncToInput();
    };

    syncFromInput();
    dateInput?.addEventListener('change', syncFromInput);
    // 输入时轻同步（不回写数字框，避免打字时光标跳动），失焦时再做钳制归位。
    const syncSoft = () => {
      const y = Number(yEl.value);
      const m = Number(mEl.value);
      const d = Number(dEl.value);
      if (dateInput && y >= 1970 && y <= 9999 && m >= 1 && m <= 12 && d >= 1 && d <= 31) {
        dateInput.value = `${y}-${pad(m)}-${pad(d)}`;
      }
    };
    [yEl, mEl, dEl].forEach((el) => {
      el?.addEventListener('input', syncSoft);
      el?.addEventListener('change', syncToInput);
    });
    document.querySelectorAll('[data-date-step]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const unit = btn.closest('[data-step-unit]')?.getAttribute('data-step-unit');
        const delta = Number(btn.getAttribute('data-date-step')) || 0;
        stepDate(unit, delta);
      });
    });
    document.getElementById('site-since-today')?.addEventListener('click', () => {
      const now = new Date();
      if (dateInput) dateInput.value = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
      syncFromInput();
    });

    siteMetaSave.addEventListener('click', async () => {
      siteMetaSave.disabled = true;
      siteMetaSave.textContent = '保存中…';
      try {
        // 保存前强制归位一次：手输数字后未失焦就点保存，也保证日期是最新值。
        syncToInput();
        const result = await api('/api/manage/site-meta', {
          method: 'POST',
          body: { since: val('site-since') },
        });
        toast(result.message || '已保存');
        reload();
      } catch (err) {
        toast(err.message, true);
        siteMetaSave.disabled = false;
        siteMetaSave.textContent = '保存开站日期';
      }
    });
  }

  // ===== 项目管理 =====
  const projectEditor = document.getElementById('project-editor');
  if (projectEditor) {
    const openEditor = (p) => {
      reveal(projectEditor);
      document.getElementById('project-editor-title').textContent = p ? '编辑项目' : '新建项目';
      setVal('pj-id', p?.id || '');
      setVal('pj-title', p?.title || '');
      setVal('pj-slug', p?.slug || '');
      setVal('pj-subtitle', p?.subtitle || '');
      setVal('pj-description', p?.description || '');
      setVal('pj-cover', p?.cover || '');
      setVal('pj-status', p?.status || '已上线');
      setVal('pj-tech', (p?.tech || []).join(', '));
      setVal('pj-order', p?.order ?? 0);
      document.getElementById('pj-featured').checked = Boolean(p?.featured);
      setVal('pj-links', (p?.links || []).map((l) => `${l.label}|${l.url}`).join('\n'));
      setVal('pj-content', p?.content || '');
      projectEditor.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };

    bind('[data-project-edit]', 'click', async (e) => {
      const id = e.target.getAttribute('data-project-edit');
      // 详情正文较长，编辑时从接口取完整数据。
      try {
        const { items } = await api('/api/manage/projects');
        openEditor(items.find((p) => p.id === id) || null);
      } catch (err) {
        toast(err.message, true);
      }
    });
    bind('[data-project-delete]', 'click', async (e) => {
      if (!window.confirm('确定删除该项目吗？此操作不可撤销。')) return;
      try {
        await api('/api/manage/projects/delete', { method: 'POST', body: { id: e.target.getAttribute('data-project-delete') } });
        toast('已删除');
        reload();
      } catch (err) {
        toast(err.message, true);
      }
    });
    document.getElementById('project-new')?.addEventListener('click', () => openEditor(null));
    document.getElementById('project-cancel')?.addEventListener('click', () => (projectEditor.hidden = true));
    document.getElementById('project-save')?.addEventListener('click', async () => {
      const links = val('pj-links')
        .split('\n')
        .map((line) => {
          const [label, url] = line.split('|');
          return { label: (label || '').trim(), url: (url || '').trim() };
        })
        .filter((l) => l.label && l.url);
      try {
        const result = await api('/api/manage/projects/save', {
          method: 'POST',
          body: {
            id: val('pj-id') || null,
            title: val('pj-title'),
            slug: val('pj-slug'),
            subtitle: val('pj-subtitle'),
            description: val('pj-description'),
            cover: val('pj-cover'),
            status: val('pj-status'),
            tech: val('pj-tech').split(/[,，]/).map((s) => s.trim()).filter(Boolean),
            order: Number(val('pj-order')) || 0,
            featured: document.getElementById('pj-featured').checked,
            links,
            content: val('pj-content'),
          },
        });
        toast(result.message || '已保存');
        reload();
      } catch (err) {
        toast(err.message, true);
      }
    });
  }

  // ===== 网址导航 =====
  const navCats = document.getElementById('nav-cats');
  if (navCats) {
    const catHtml = (ci) => `<div class="navcat" data-cat-index="${ci}">
        <div class="navcat__head">
          <input class="input navcat__name" value="" placeholder="分类名" />
          <button type="button" class="btn btn--sm btn--danger" data-cat-remove="${ci}">删除分类</button>
        </div>
        <div class="navcat__links"></div>
        <button type="button" class="btn btn--sm" data-link-add="${ci}">+ 添加网址</button>
      </div>`;
    const linkHtml = (ci, li) => `<div class="kv-row" data-cat-link="${ci}" data-link-index="${li}">
        <input class="input" data-lfield="name" value="" placeholder="网站名" />
        <input class="input" data-lfield="url" value="" placeholder="https://…" />
        <input class="input" data-lfield="desc" value="" placeholder="简介（选填）" />
        <button type="button" class="btn btn--sm btn--danger" data-link-remove="${ci}" data-link-index="${li}">删</button>
      </div>`;

    navCats.addEventListener('click', (e) => {
      const addCat = e.target.closest('#nav-cat-add') || e.target.closest('[data-cat-add]');
      if (addCat) {
        const empty = navCats.querySelector('.empty');
        if (empty) empty.remove();
        navCats.insertAdjacentHTML('beforeend', catHtml(Date.now()));
        return;
      }
      const rmCat = e.target.closest('[data-cat-remove]');
      if (rmCat) {
        rmCat.closest('.navcat').remove();
        return;
      }
      const addLink = e.target.closest('[data-link-add]');
      if (addLink) {
        const ci = addLink.getAttribute('data-link-add');
        addLink.previousElementSibling.insertAdjacentHTML('beforeend', linkHtml(ci, Date.now()));
        return;
      }
      const rmLink = e.target.closest('[data-link-remove]');
      if (rmLink) rmLink.closest('.kv-row').remove();
    });
    document.getElementById('nav-cat-add')?.addEventListener('click', () => {
      const empty = navCats.querySelector('.empty');
      if (empty) empty.remove();
      navCats.insertAdjacentHTML('beforeend', catHtml(Date.now()));
    });

    document.getElementById('nav-save')?.addEventListener('click', async () => {
      const categories = [...navCats.querySelectorAll('.navcat')].map((cat, ci) => ({
        id: `cat-${ci + 1}`,
        name: cat.querySelector('.navcat__name').value.trim(),
        links: [...cat.querySelectorAll('.kv-row')].map((row) => ({
          name: row.querySelector('[data-lfield="name"]').value.trim(),
          url: row.querySelector('[data-lfield="url"]').value.trim(),
          desc: row.querySelector('[data-lfield="desc"]').value.trim(),
        })),
      }));
      try {
        const result = await api('/api/manage/nav', { method: 'POST', body: { nav: { categories } } });
        toast(result.message || '已保存');
      } catch (err) {
        toast(err.message, true);
      }
    });
  }

  // ===== 友链 =====
  const friendEditor = document.getElementById('friend-editor');
  if (friendEditor) {
    const openEditor = (f) => {
      reveal(friendEditor);
      document.getElementById('friend-editor-title').textContent = f ? '编辑友链' : '手动添加友链';
      setVal('fr-id', f?.id || '');
      setVal('fr-name', f?.name || '');
      setVal('fr-url', f?.url || '');
      setVal('fr-avatar', f?.avatar || '');
      setVal('fr-desc', f?.desc || '');
      setVal('fr-email', f?.email || '');
      friendEditor.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    document.getElementById('friend-new')?.addEventListener('click', () => openEditor(null));
    document.getElementById('friend-cancel')?.addEventListener('click', () => (friendEditor.hidden = true));

    document.getElementById('friend-notice-save')?.addEventListener('click', async () => {
      try {
        const result = await api('/api/manage/friends/notice', { method: 'POST', body: { notice: document.getElementById('friend-notice').value } });
        toast(result.message || '已保存');
      } catch (err) {
        toast(err.message, true);
      }
    });

    bind('[data-friend-review]', 'click', async (e) => {
      try {
        const result = await api('/api/manage/friends/review', {
          method: 'POST',
          body: { id: e.target.getAttribute('data-friend-review'), status: e.target.getAttribute('data-status') },
        });
        toast(result.message || '已更新');
        reload();
      } catch (err) {
        toast(err.message, true);
      }
    });
    bind('[data-friend-edit]', 'click', async (e) => {
      try {
        const data = await api('/api/manage/friends');
        openEditor(data.items.find((f) => f.id === e.target.getAttribute('data-friend-edit')) || null);
      } catch (err) {
        toast(err.message, true);
      }
    });
    bind('[data-friend-delete]', 'click', async (e) => {
      if (!window.confirm('确定删除该友链吗？')) return;
      try {
        await api('/api/manage/friends/delete', { method: 'POST', body: { id: e.target.getAttribute('data-friend-delete') } });
        toast('已删除');
        reload();
      } catch (err) {
        toast(err.message, true);
      }
    });
    document.getElementById('friend-save')?.addEventListener('click', async () => {
      try {
        const result = await api('/api/manage/friends/save', {
          method: 'POST',
          body: {
            id: val('fr-id') || null,
            name: val('fr-name'),
            url: val('fr-url'),
            avatar: val('fr-avatar'),
            desc: val('fr-desc'),
            email: val('fr-email'),
          },
        });
        toast(result.message || '已保存');
        reload();
      } catch (err) {
        toast(err.message, true);
      }
    });
  }

  // ===== 音乐 =====
  const musicTable = document.getElementById('music-table');
  if (musicTable) {
    const uploadInput = document.getElementById('music-upload-input');
    const uploadZone = document.getElementById('music-upload-zone');
    const previewAudio = document.getElementById('music-preview-audio');

    const uploadTrack = (file) => {
      if (!file) return;
      const params = new URLSearchParams({
        filename: file.name,
        title: val('music-up-title'),
        artist: val('music-up-artist'),
        cover: val('music-up-cover'),
      });
      api(`/api/manage/music/upload?${params}`, { method: 'POST', body: file, raw: true })
        .then((result) => {
          toast(result.message || '已上传');
          reload();
        })
        .catch((err) => toast(err.message, true));
    };
    uploadInput?.addEventListener('change', () => uploadTrack(uploadInput.files?.[0]));
    uploadZone?.addEventListener('dragover', (e) => {
      e.preventDefault();
      uploadZone.classList.add('upload-zone--over');
    });
    uploadZone?.addEventListener('dragleave', () => uploadZone.classList.remove('upload-zone--over'));
    uploadZone?.addEventListener('drop', (e) => {
      e.preventDefault();
      uploadZone.classList.remove('upload-zone--over');
      uploadTrack(e.dataTransfer.files?.[0]);
    });

    document.getElementById('music-netease-import')?.addEventListener('click', async (e) => {
      const input = val('music-netease-input');
      if (!input) return toast('请填写歌曲 / 歌单链接或 ID', true);
      e.target.disabled = true;
      e.target.textContent = '导入中…';
      try {
        const result = await api('/api/manage/music/import-netease', { method: 'POST', body: { input } });
        toast(result.message || '已导入');
        reload();
      } catch (err) {
        toast(err.message, true);
        e.target.disabled = false;
        e.target.textContent = '导入';
      }
    });

    // 试听 / 上下架 / 编辑 / 删除
    musicTable.addEventListener('click', async (e) => {
      const previewBtn = e.target.closest('[data-track-preview]');
      if (previewBtn) {
        const { tracks } = await api('/api/manage/music');
        const track = tracks.find((t) => t.id === previewBtn.getAttribute('data-track-preview'));
        if (!track) return;
        reveal(previewAudio);
        if (track.source === 'local') {
          previewAudio.src = `/api/music/file/${encodeURIComponent(track.fileName)}`;
        } else {
          // 网易云曲目先解析出可播放地址再设 src。
          try {
            const { url } = await api(`/api/public/playlist/resolve/${track.neteaseId}`);
            previewAudio.src = url;
          } catch (err) {
            return toast(err.message, true);
          }
        }
        previewAudio.play().catch(() => {});
        return;
      }
      const toggleBtn = e.target.closest('[data-track-toggle]');
      if (toggleBtn) {
        try {
          const { tracks } = await api('/api/manage/music');
          const track = tracks.find((t) => t.id === toggleBtn.getAttribute('data-track-toggle'));
          await api('/api/manage/music/update', { method: 'POST', body: { id: track.id, enabled: !track.enabled } });
          reload();
        } catch (err) {
          toast(err.message, true);
        }
        return;
      }
      const editBtn = e.target.closest('[data-track-edit]');
      if (editBtn) {
        const { tracks } = await api('/api/manage/music');
        const track = tracks.find((t) => t.id === editBtn.getAttribute('data-track-edit'));
        if (!track) return;
        const editor = document.getElementById('track-editor');
        reveal(editor);
        setVal('tr-id', track.id);
        setVal('tr-title', track.title);
        setVal('tr-artist', track.artist);
        setVal('tr-cover', track.cover);
        editor.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
      const deleteBtn = e.target.closest('[data-track-delete]');
      if (deleteBtn && window.confirm('确定删除该曲目吗？')) {
        try {
          await api('/api/manage/music/delete', { method: 'POST', body: { id: deleteBtn.getAttribute('data-track-delete') } });
          toast('已删除');
          reload();
        } catch (err) {
          toast(err.message, true);
        }
      }
    });

    document.getElementById('track-save')?.addEventListener('click', async () => {
      try {
        await api('/api/manage/music/update', {
          method: 'POST',
          body: { id: val('tr-id'), title: val('tr-title'), artist: val('tr-artist'), cover: val('tr-cover') },
        });
        toast('已保存');
        reload();
      } catch (err) {
        toast(err.message, true);
      }
    });
    document.getElementById('track-cancel')?.addEventListener('click', () => (document.getElementById('track-editor').hidden = true));

    // 顺序调整：上移 / 下移所选行（点击行选中）。
    let selectedRow = null;
    musicTable.addEventListener('click', (e) => {
      const row = e.target.closest('[data-track-row]');
      if (row && !e.target.closest('button')) {
        musicTable.querySelectorAll('[data-track-row]').forEach((r) => r.classList.remove('row-selected'));
        row.classList.add('row-selected');
        selectedRow = row;
      }
    });
    const move = (dir) => {
      if (!selectedRow) return toast('请先点选一行曲目', true);
      const sibling = dir < 0 ? selectedRow.previousElementSibling : selectedRow.nextElementSibling;
      if (!sibling || !sibling.hasAttribute('data-track-row')) return;
      if (dir < 0) sibling.before(selectedRow);
      else sibling.after(selectedRow);
    };
    document.getElementById('music-reorder-up')?.addEventListener('click', () => move(-1));
    document.getElementById('music-reorder-down')?.addEventListener('click', () => move(1));
    document.getElementById('music-reorder-save')?.addEventListener('click', async () => {
      const ids = [...musicTable.querySelectorAll('[data-track-row]')].map((r) => r.getAttribute('data-track-row'));
      try {
        const result = await api('/api/manage/music/reorder', { method: 'POST', body: { ids } });
        toast(result.message || '顺序已保存');
      } catch (err) {
        toast(err.message, true);
      }
    });
  }

  // ===== 公告 =====
  const annEditor = document.getElementById('ann-editor');
  if (annEditor) {
    const toLocalInput = (ts) => {
      if (!ts) return '';
      const d = new Date(ts);
      const pad = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    };
    // 自定义选择器的值（'YYYY-MM-DD' 或 'YYYY-MM-DD HH:mm'）转本地时间戳：
    // 手动解析年月日时分，避免 'YYYY-MM-DD' 被 Date 按 UTC 解析偏 8 小时。
    const parseLocalMs = (v) => {
      const m = String(v || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?$/);
      if (!m) return 0;
      return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] || 0), Number(m[5] || 0)).getTime();
    };
    const openEditor = (a) => {
      reveal(annEditor);
      document.getElementById('ann-editor-title').textContent = a ? '编辑公告' : '新建公告';
      setVal('an-id', a?.id || '');
      setVal('an-title', a?.title || '');
      setVal('an-content', a?.content || '');
      setVal('an-link', a?.link || '');
      setVal('an-start', toLocalInput(a?.startAt));
      setVal('an-end', toLocalInput(a?.endAt));
      document.getElementById('an-enabled').checked = a ? a.enabled !== false : true;
      annEditor.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    document.getElementById('ann-new')?.addEventListener('click', () => openEditor(null));
    document.getElementById('ann-cancel')?.addEventListener('click', () => (annEditor.hidden = true));
    bind('[data-ann-edit]', 'click', async (e) => {
      try {
        const { items } = await api('/api/manage/announcements');
        openEditor(items.find((a) => a.id === e.target.getAttribute('data-ann-edit')) || null);
      } catch (err) {
        toast(err.message, true);
      }
    });
    bind('[data-ann-delete]', 'click', async (e) => {
      if (!window.confirm('确定删除该公告吗？')) return;
      try {
        await api('/api/manage/announcements/delete', { method: 'POST', body: { id: e.target.getAttribute('data-ann-delete') } });
        toast('已删除');
        reload();
      } catch (err) {
        toast(err.message, true);
      }
    });
    document.getElementById('ann-save')?.addEventListener('click', async () => {
      const start = val('an-start');
      const end = val('an-end');
      try {
        const result = await api('/api/manage/announcements/save', {
          method: 'POST',
          body: {
            id: val('an-id') || null,
            title: val('an-title'),
            content: val('an-content'),
            link: val('an-link'),
            startAt: parseLocalMs(start),
            endAt: parseLocalMs(end),
            enabled: document.getElementById('an-enabled').checked,
          },
        });
        toast(result.message || '已保存');
        reload();
      } catch (err) {
        toast(err.message, true);
      }
    });
  }

  // ===== 评论 =====
  const commentRows = document.getElementById('comment-rows');
  if (commentRows) {
    bind('[data-comment-status]', 'click', async (e) => {
      try {
        const result = await api('/api/manage/comments/status', {
          method: 'POST',
          body: { id: e.target.getAttribute('data-comment-status'), status: e.target.getAttribute('data-status') },
        });
        toast(result.message || '已更新');
        reload();
      } catch (err) {
        toast(err.message, true);
      }
    });
    bind('[data-comment-delete]', 'click', async (e) => {
      if (!window.confirm('确定删除该评论及其所有回复吗？')) return;
      try {
        await api('/api/manage/comments/delete', { method: 'POST', body: { id: e.target.getAttribute('data-comment-delete') } });
        toast('已删除');
        reload();
      } catch (err) {
        toast(err.message, true);
      }
    });

    const replyEditor = document.getElementById('comment-reply-editor');
    bind('[data-comment-reply]', 'click', (e) => {
      reveal(replyEditor);
      setVal('cr-id', e.target.getAttribute('data-comment-reply'));
      replyEditor.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    document.getElementById('comment-reply-cancel')?.addEventListener('click', () => (replyEditor.hidden = true));
    document.getElementById('comment-reply-send')?.addEventListener('click', async () => {
      try {
        const result = await api('/api/manage/comments/reply', {
          method: 'POST',
          body: { id: val('cr-id'), comment: val('cr-text') },
        });
        toast(result.message || '回复已发布');
        reload();
      } catch (err) {
        toast(err.message, true);
      }
    });

    // 筛选与搜索：带参跳回列表页（服务端按 status / keyword 过滤）。
    const gotoComments = (extra) => {
      const params = new URLSearchParams();
      if (extra && extra !== 'all') params.set('status', extra);
      const kw = val('comment-search');
      if (kw) params.set('keyword', kw);
      window.location.href = `/admin/comments?${params}`;
    };
    bind('[data-comment-filter]', 'click', (e) => gotoComments(e.target.getAttribute('data-comment-filter')));
    document.getElementById('comment-search')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') gotoComments();
    });
  }

  // —— 构建 ——
  const buildBtn = document.getElementById('build-btn');
  const rollbackBtn = document.getElementById('rollback-btn');
  const buildLog = document.getElementById('build-log');
  const buildState = document.getElementById('build-state');
  const buildTime = document.getElementById('build-time');

  if (buildBtn) {
    buildBtn.addEventListener('click', async () => {
      buildBtn.disabled = true;
      buildBtn.textContent = '构建中…';
      if (buildState) buildState.textContent = 'building';
      try {
        const result = await api('/api/build', { method: 'POST' });
        if (buildLog) buildLog.textContent = result.log || '';
        if (buildState) buildState.textContent = result.ok ? 'success' : 'failed';
        if (buildTime) buildTime.textContent = new Date().toLocaleString('zh-CN');
        toast(result.message, !result.ok);
        buildBtn.disabled = false;
        buildBtn.textContent = '构建并发布';
        if (result.ok) setTimeout(() => window.location.reload(), 1200);
      } catch (err) {
        toast(err.message, true);
        buildBtn.disabled = false;
        buildBtn.textContent = '构建并发布';
      }
    });
  }

  if (rollbackBtn) {
    rollbackBtn.addEventListener('click', async () => {
      if (!window.confirm('确定回滚到上一个版本吗？')) return;
      try {
        const result = await api('/api/build/rollback', { method: 'POST' });
        toast(result.message);
        setTimeout(() => window.location.reload(), 800);
      } catch (err) {
        toast(err.message, true);
      }
    });
  }

  // —— 数据备份仓库地址 ——
  const backupRemoteInput = document.getElementById('backup-remote');
  const backupSaveBtn = document.getElementById('backup-save');
  if (backupRemoteInput && backupSaveBtn) {
    backupSaveBtn.addEventListener('click', async () => {
      backupSaveBtn.disabled = true;
      try {
        const result = await api('/api/backup/config', {
          method: 'POST',
          body: { remoteUrl: backupRemoteInput.value.trim() },
        });
        toast(result.message || '已保存');
        // 刷新内容以展示新的「当前生效」地址与来源（无刷新导航）
        setTimeout(() => refreshPage(), 800);
      } catch (err) {
        toast(err.message, true);
        backupSaveBtn.disabled = false;
      }
    });
  }
  }

  // ===== 无刷新导航（SPA） =====
  // 侧栏与内容内链接点击时只替换 <main> 内容并重新绑定，不再整页重载：
  // 切换页面无白屏闪烁、无强制刷新感，操作成功后的「刷新」同样只换内容。
  // 页面请求统一走 page-loader.js（路由白名单校验集中在彼处）。
  const mainEl = document.querySelector('.main');
  let navSeq = 0;
  let navCtrl = null;

  // 顶部细进度条：导航请求期间流动提示。
  const navProgress = document.createElement('div');
  navProgress.className = 'nav-progress';
  document.body.append(navProgress);
  const progressStart = () => navProgress.classList.add('is-active');
  const progressDone = () => navProgress.classList.remove('is-active');

  // 统计数字入场滚动（从 0 缓动到目标值）。
  function animateCounters() {
    if (reducedMotion()) return;
    document.querySelectorAll('.stat__value').forEach((el) => {
      const raw = el.textContent.trim();
      const m = raw.match(/^([\d,]+)(.*)$/);
      if (!m) return;
      const target = Number(m[1].replace(/,/g, ''));
      if (!Number.isFinite(target) || target === 0) return;
      const suffix = m[2];
      const started = performance.now();
      const step = (now) => {
        const p = Math.min(1, (now - started) / 600);
        const eased = 1 - Math.pow(1 - p, 3);
        el.textContent = `${Math.round(target * eased)}${suffix}`;
        if (p < 1) requestAnimationFrame(step);
        else el.textContent = raw;
      };
      requestAnimationFrame(step);
    });
  }

  // 页面内容入场编排：顶层区块错峰升起 + 统计数字滚动。
  function enterMain() {
    if (!mainEl) return;
    [...mainEl.children].forEach((el, i) => {
      el.classList.remove('rise-in');
      if (reducedMotion()) return;
      el.style.setProperty('--stagger', `${Math.min(i, 10) * 55}ms`);
      void el.offsetWidth;
      el.classList.add('rise-in');
    });
    animateCounters();
  }

  // 换内容：旧内容快速淡出 → 替换 → 新内容入场编排。
  async function swapMain(html, title) {
    if (!mainEl) return;
    if (title && document.title !== title) document.title = title;
    if (reducedMotion()) {
      mainEl.innerHTML = html;
      return;
    }
    mainEl.classList.add('is-leaving');
    await wait(110);
    mainEl.innerHTML = html;
    mainEl.classList.remove('is-leaving');
    enterMain();
  }

  function setActiveNav(pathname) {
    document.querySelectorAll('.nav__item').forEach((a) => {
      const href = a.getAttribute('href') || '';
      const active =
        href === '/admin'
          ? pathname === '/admin' || pathname === '/admin/'
          : pathname.startsWith(href);
      a.classList.toggle('nav__item--active', active);
    });
  }

  // 从地址栏取当前路由（先过白名单再交给 navigate）。
  function currentRel() {
    const rel = location.pathname + location.search;
    return isAllowedAdminRoute(rel) ? rel : null;
  }

  async function navigate(url, { push = true } = {}) {
    const target = new URL(String(url), location.origin);
    const rel = target.pathname + target.search;
    // 白名单校验（独立早退）：路由形状不符直接整页跳转交回浏览器。
    if (!isAllowedAdminRoute(rel)) {
      location.href = target.href;
      return;
    }
    // 仅同源 http(s) 且不含凭据的地址才走无刷新导航。
    if (target.origin !== location.origin) {
      location.href = target.href;
      return;
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      location.href = target.href;
      return;
    }
    if (target.username || target.password) {
      location.href = target.href;
      return;
    }
    if (!mainEl) {
      location.href = target.href;
      return;
    }
    const seq = ++navSeq;
    navCtrl?.abort();
    navCtrl = new AbortController();
    progressStart();
    try {
      const res = await loadAdminPage(rel, navCtrl.signal);
      if (!res) {
        location.href = target.href;
        return;
      }
      if (seq !== navSeq) return; // 已被更新的导航取代
      if (res.status === 401) {
        location.href = '/admin/login';
        return;
      }
      if (!res.ok) throw new Error(`页面加载失败（${res.status}）`);
      const html = await res.text();
      if (seq !== navSeq) return;
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const newMain = doc.querySelector('.main');
      if (!newMain) {
        // 结构异常（如登录页/错误页）退回整页加载，保证不卡在坏状态。
        location.href = target.href;
        return;
      }
      // 提取新页面的启动数据（boot / csrf，服务器输出为纯 JSON），供 initPage 用。
      const bootMatch = html.match(/window\.__BOOT__\s*=\s*(\{[\s\S]*\})\s*;?\s*<\/script>/);
      if (bootMatch) {
        try {
          window.__BOOT__ = JSON.parse(bootMatch[1]);
        } catch {
          /* boot 解析失败保留旧值 */
        }
      }
      await swapMain(newMain.innerHTML, doc.title);
      if (push) history.pushState({}, '', target.pathname + target.search);
      setActiveNav(target.pathname);
      window.scrollTo({ top: 0 });
      initPage();
    } catch (err) {
      if (err?.name !== 'AbortError') {
        toast(err?.message || '页面加载失败，请重试', true);
      }
    } finally {
      if (seq === navSeq) progressDone();
    }
  }

  // 操作成功后的「刷新」：只重新拉取当前页内容。
  const refreshPage = () => {
    const rel = currentRel();
    if (rel) navigate(rel, { push: false });
    else location.reload();
  };

  // 内链点击拦截：仅同源 /admin 路径走无刷新导航，修饰键/新标签保持原生行为。
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href^="/admin"]');
    if (!a || e.defaultPrevented || e.button !== 0) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (a.target === '_blank' || a.hasAttribute('download')) return;
    const url = new URL(a.getAttribute('href'), location.origin);
    const rel = url.pathname + url.search;
    if (!isAllowedAdminRoute(rel)) return; // 不拦截，交回浏览器
    if (url.origin !== location.origin) return;
    e.preventDefault();
    navigate(rel);
  });

  window.addEventListener('popstate', () => {
    const rel = currentRel();
    if (rel) navigate(rel, { push: false });
  });

  // 首次进入也走同样的入场编排。
  enterMain();
  initPage();
})();
