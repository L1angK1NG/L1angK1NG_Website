// 后台面板客户端。原生 JS，无需构建步骤。携带 CSRF token 调用 JSON API，
// 驱动编辑器实时预览、媒体上传和构建任务。
(() => {
  const boot = window.__BOOT__ || {};
  const csrfToken = boot.csrfToken || '';

  const toastEl = () => document.getElementById('toast');
  function toast(message, isError) {
    const el = toastEl();
    if (!el) return;
    el.textContent = message;
    el.classList.toggle('toast--error', !!isError);
    el.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => {
      el.hidden = true;
    }, 3200);
  }

  async function api(path, { method = 'GET', body, raw, noAuthRedirect } = {}) {
    const opts = { method, headers: {} };
    if (csrfToken) opts.headers['X-CSRF-Token'] = csrfToken;
    if (raw) {
      opts.body = body;
    } else if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(path, opts);
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
          body: { username: fd.get('username'), password: fd.get('password') },
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

  // —— 编辑器 ——
  const bodyArea = document.getElementById('body');
  const slugInput = document.getElementById('slug');
  const urlPreview = document.getElementById('url-preview');
  const collection = boot.collection;
  const isEditor = !!bodyArea && !!collection;

  if (isEditor) {
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
            previewEl.innerHTML = html;
          } catch (err) {
            previewEl.textContent = '预览失败：' + err.message;
          }
          previewEl.hidden = false;
          bodyArea.hidden = true;
        } else {
          previewEl.hidden = true;
          bodyArea.hidden = false;
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
          if (boot.isNew) window.location.href = `/admin/${collection}/edit?path=${encodeURIComponent(result.id)}`;
          else saveBtn.textContent = '已保存';
        } catch (err) {
          toast(err.message, true);
          saveBtn.disabled = false;
          saveBtn.textContent = '保存';
        }
      });
    }
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
      if (file) uploadFile(file, () => window.location.reload());
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
      if (file) uploadFile(file, () => window.location.reload());
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

  // —— 删除（列表页面） ——
  document.querySelectorAll('[data-delete]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-delete');
      const coll = btn.getAttribute('data-collection');
      if (!window.confirm(`确定删除「${id}」吗？此操作不可撤销。`)) return;
      try {
        await api(`/api/delete/${coll}`, { method: 'POST', body: { id } });
        toast('已删除');
        const row = btn.closest('tr');
        if (row) row.remove();
      } catch (err) {
        toast(err.message, true);
      }
    });
  });

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
})();
