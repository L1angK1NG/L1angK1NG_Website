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
  const reload = () => window.location.reload();

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

    const socialRowHtml = (ns, i) => `<div class="kv-row" data-social="${ns}" data-index="${i}">
        <input class="input" data-sfield="icon" value="" placeholder="图标名 如 bilibili" />
        <input class="input" data-sfield="label" value="" placeholder="显示名" />
        <input class="input" data-sfield="href" value="" placeholder="链接地址" />
        <button type="button" class="btn btn--sm btn--danger" data-social-remove="${ns}" data-index="${i}">删</button>
      </div>`;

    // 事件委托：新增/删除社交链接行（重渲染后依然有效）。
    document.addEventListener('click', (e) => {
      const addBtn = e.target.closest('[data-social-add]');
      if (addBtn) {
        const ns = addBtn.getAttribute('data-social-add');
        const box = document.getElementById(`p-${ns}-socials`);
        box.insertAdjacentHTML('beforeend', socialRowHtml(ns, Date.now()));
        return;
      }
      const rmBtn = e.target.closest('[data-social-remove]');
      if (rmBtn) rmBtn.closest('.kv-row').remove();
    });

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

  // ===== 项目管理 =====
  const projectEditor = document.getElementById('project-editor');
  if (projectEditor) {
    const openEditor = (p) => {
      projectEditor.hidden = false;
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
      friendEditor.hidden = false;
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
      const trackId = (btn) => btn.getAttribute('data-track-preview') || btn.getAttribute('data-track-toggle') || btn.getAttribute('data-track-edit') || btn.getAttribute('data-track-delete');
      const previewBtn = e.target.closest('[data-track-preview]');
      if (previewBtn) {
        const { tracks } = await api('/api/manage/music');
        const track = tracks.find((t) => t.id === previewBtn.getAttribute('data-track-preview'));
        if (!track) return;
        previewAudio.hidden = false;
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
        editor.hidden = false;
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
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    };
    const openEditor = (a) => {
      annEditor.hidden = false;
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
            startAt: start ? new Date(start).getTime() : 0,
            endAt: end ? new Date(end).getTime() : 0,
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
      replyEditor.hidden = false;
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
})();
