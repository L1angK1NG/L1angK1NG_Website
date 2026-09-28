// Shared comment UI + Twikoo backend client (no Twikoo front-end bundle).
// Used by the bottom comment box and selection quote flow.

const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (m) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]),
  );

const avatar = (md5) => `https://cravatar.cn/avatar/${encodeURIComponent(md5 || '')}?d=mp&s=80`;

const allowedTags = new Set([
  'A',
  'B',
  'BLOCKQUOTE',
  'BR',
  'CODE',
  'DEL',
  'EM',
  'I',
  'IMG',
  'LI',
  'OL',
  'P',
  'PRE',
  'S',
  'SPAN',
  'STRONG',
  'UL',
]);

const safeUrl = (value, protocols = ['http:', 'https:']) => {
  try {
    const url = new URL(value, location.origin);
    return protocols.includes(url.protocol);
  } catch {
    return false;
  }
};

const sanitizeComment = (html) => {
  const template = document.createElement('template');
  template.innerHTML = String(html || '');

  const walk = (node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === Node.COMMENT_NODE) {
        child.remove();
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;

      if (!allowedTags.has(child.tagName)) {
        child.replaceWith(document.createTextNode(child.textContent || ''));
        continue;
      }

      for (const attr of [...child.attributes]) {
        const name = attr.name.toLowerCase();
        const value = attr.value;
        const isLink = child.tagName === 'A' && ['href', 'title'].includes(name);
        const isImage = child.tagName === 'IMG' && ['src', 'alt', 'title'].includes(name);
        const isCode = ['CODE', 'PRE', 'SPAN'].includes(child.tagName) && name === 'class';

        if (
          name.startsWith('on') ||
          (!isLink && !isImage && !isCode) ||
          (name === 'href' && !safeUrl(value, ['http:', 'https:', 'mailto:'])) ||
          (name === 'src' && !safeUrl(value))
        ) {
          child.removeAttribute(attr.name);
        }
      }

      if (child.tagName === 'A' && child.getAttribute('href')) {
        child.setAttribute('target', '_blank');
        child.setAttribute('rel', 'noopener noreferrer');
      }
      if (child.tagName === 'IMG' && child.getAttribute('src')) {
        child.setAttribute('loading', 'lazy');
        child.setAttribute('referrerpolicy', 'no-referrer');
      }

      walk(child);
    }
  };

  walk(template.content);
  return template.innerHTML;
};

const rel = (ts) => {
  const d = (Date.now() - ts) / 1000;
  if (d < 60) return '刚刚';
  if (d < 3600) return `${Math.floor(d / 60)} 分钟前`;
  if (d < 86400) return `${Math.floor(d / 3600)} 小时前`;
  if (d < 2592000) return `${Math.floor(d / 86400)} 天前`;
  return new Date(ts).toLocaleDateString('zh-CN');
};

export function callTwikoo(envId, event, params = {}) {
  return fetch(envId, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event, ...params }),
  }).then((r) => r.json());
}

export const itemHTML = (c, { reply = false, actions = true } = {}) => {
  const replies = (c.replies || []).map((r) => itemHTML(r, { reply: true, actions })).join('');
  const id = esc(c.id);
  return `<li class="citem${reply ? ' citem--reply' : ''}" data-id="${id}">
    <img class="citem__avatar" src="${avatar(c.mailMd5)}" alt="" loading="lazy" referrerpolicy="no-referrer" />
    <div class="citem__body">
      <div class="citem__meta">
        <span class="citem__nick">${esc(c.nick)}</span>
        ${c.master ? '<span class="citem__badge">博主</span>' : ''}
        ${c.ruser ? `<span class="citem__re">回复 ${esc(c.ruser)}</span>` : ''}
        <time class="citem__time">${rel(c.created)}</time>
      </div>
      <div class="citem__content">${sanitizeComment(c.comment)}</div>
      ${
        actions
          ? `<div class="citem__actions">
        <button type="button" class="citem__act" data-like="${id}">♥ <span>${c.like || 0}</span></button>
        <button type="button" class="citem__act" data-reply="${id}" data-nick="${esc(c.nick)}">回复</button>
      </div>`
          : ''
      }
      ${replies ? `<ol class="citem__replies">${replies}</ol>` : ''}
    </div>
  </li>`;
};

const FORM = `
  <form class="cform" data-form>
    <span class="cform__avatar" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 20a8 8 0 0 1 16 0"/></svg></span>
    <div class="cform__main">
      <textarea class="cform__text" data-text rows="2" maxlength="500" placeholder="写下你的看法…"></textarea>
      <div class="cform__extra">
        <div class="cform__meta">
          <input type="text" data-nick placeholder="昵称" autocomplete="nickname" />
          <input type="email" data-mail placeholder="邮箱（选填）" autocomplete="email" />
          <input type="url" data-link placeholder="网址（选填）" autocomplete="url" />
        </div>
        <div class="cform__foot">
          <span class="cform__hint" data-hint>支持 Markdown</span>
          <button type="submit" class="cform__send" data-send>发送</button>
        </div>
      </div>
    </div>
  </form>
  <p class="cform__status" data-status hidden></p>
  <ol class="clist" data-list></ol>
  <p class="cbox__empty" data-empty hidden>还没有评论，来说两句吧。</p>
  <button type="button" class="cbox__more" data-more hidden>加载更多</button>`;

export function mountComments(root, { envId, url, onCount } = {}) {
  root.innerHTML = FORM;
  const $ = (s) => root.querySelector(s);
  const listEl = $('[data-list]');
  const form = $('[data-form]');
  const extraEl = $('.cform__extra');
  const textEl = $('[data-text]');
  const hintEl = $('[data-hint]');
  const statusEl = $('[data-status]');
  const emptyEl = $('[data-empty]');
  const moreEl = $('[data-more]');

  let page = 1;
  let loading = false;
  let replyTo = null;
  let pendingReturnY = null;

  const setStatus = (m, ok = true) => {
    statusEl.hidden = !m;
    statusEl.textContent = m || '';
    statusEl.classList.toggle('is-error', !ok);
  };
  const cancelReply = () => {
    replyTo = null;
    hintEl.textContent = '支持 Markdown';
  };

  const quoteText = ({ text, returnY } = {}) => {
    const quote = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 360);
    if (!quote) return;

    pendingReturnY = Number.isFinite(returnY) ? returnY : null;
    const quoted = `> ${quote}\n\n`;
    textEl.value = textEl.value.trim() ? `${textEl.value.trimEnd()}\n\n${quoted}` : quoted;
    form.classList.add('is-open');
    setStatus('已引用选中文本，发送后会回到刚才的位置。');
    // Own the final landing: focus without scrolling (the browser's instant
    // focus-scroll would race the smooth scroll), then glide to the composer.
    window.setTimeout(() => {
      textEl.focus({ preventScroll: true });
      textEl.setSelectionRange(textEl.value.length, textEl.value.length);
      textEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 80);
  };

  const load = async (reset = false) => {
    if (loading) return;
    loading = true;
    if (reset) page = 1;
    try {
      const res = await callTwikoo(envId, 'COMMENT_GET', { url, page, pageSize: 20, sortBy: 'created' });
      const data = res.data || [];
      const total = Number(res.count ?? data.length) || 0;
      if (reset) listEl.innerHTML = '';
      listEl.insertAdjacentHTML('beforeend', data.map((c) => itemHTML(c)).join(''));
      emptyEl.hidden = total > 0;
      const shown = listEl.querySelectorAll(':scope > .citem').length;
      moreEl.hidden = total === 0 || shown >= total;
      page += 1;
      if (onCount) onCount(total);
    } catch {
      moreEl.hidden = true;
    }
    loading = false;
  };

  // Reveal the extra fields on focus. Once the open transition finishes, drop
  // overflow:hidden so the inputs' focus ring isn't clipped at the edges.
  const revealExtra = () => {
    form.classList.add('is-open');
  };
  form.addEventListener('focusin', revealExtra);
  if (extraEl) {
    extraEl.addEventListener('transitionend', (e) => {
      if (e.propertyName === 'max-height' && form.classList.contains('is-open')) {
        extraEl.style.overflow = 'visible';
      }
    });
  }
  hintEl.addEventListener('click', (e) => {
    if (e.target.closest('[data-cancel]')) cancelReply();
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const comment = textEl.value.trim();
    const nick = $('[data-nick]').value.trim();
    const mail = $('[data-mail]').value.trim();
    const link = $('[data-link]').value.trim();
    if (!comment) return setStatus('写点什么再发吧。', false);
    if (!nick) {
      $('[data-nick]').focus();
      return setStatus('留个昵称吧。', false);
    }
    setStatus('发送中…');
    try {
      const params = { url, nick, mail, link, comment, ua: navigator.userAgent };
      if (replyTo) {
        params.pid = replyTo.pid;
        params.rid = replyTo.rid;
      }
      const res = await callTwikoo(envId, 'COMMENT_SUBMIT', params);
      const submitted = Boolean(res?.id || res?.data?.id || res?.code === 0);
      if (submitted) {
        const returnTo = pendingReturnY;
        pendingReturnY = null;
        textEl.value = '';
        cancelReply();
        setStatus('');
        load(true);
        if (Number.isFinite(returnTo)) {
          window.setTimeout(() => window.scrollTo({ top: returnTo, behavior: 'smooth' }), 350);
        }
      } else {
        setStatus('发送失败，请稍后再试。', false);
      }
    } catch {
      setStatus('发送失败，请稍后再试。', false);
    }
  });
  listEl.addEventListener('click', async (e) => {
    const likeBtn = e.target.closest('[data-like]');
    const replyBtn = e.target.closest('[data-reply]');
    if (likeBtn) {
      try {
        await callTwikoo(envId, 'COMMENT_LIKE', { id: likeBtn.dataset.like });
        const span = likeBtn.querySelector('span');
        span.textContent = (Number(span.textContent) || 0) + 1;
        likeBtn.classList.add('is-liked');
      } catch {
        /* ignore */
      }
    }
    if (replyBtn) {
      const item = replyBtn.closest('.citem');
      const top = replyBtn.closest('.clist > .citem') || item;
      replyTo = { pid: top.dataset.id, rid: item.dataset.id };
      hintEl.innerHTML = `正在回复 ${esc(replyBtn.dataset.nick)} <button type="button" class="cform__cancel" data-cancel>取消</button>`;
      form.classList.add('is-open');
      textEl.focus();
    }
  });
  moreEl.addEventListener('click', () => load(false));

  load(true);
  return { reload: () => load(true), quote: quoteText };
}
