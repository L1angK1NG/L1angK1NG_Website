// 文章图片灯箱：点击正文图片放大预览，点击空白或 Esc 关闭。
export function initLightbox(signal) {
  const images = document.querySelectorAll(
    '.post-content img:not(.legacy-inline-image)',
  );

  if (!images.length) {
    return;
  }

  let overlay = null;

  const onKey = (event) => {
    if (event.key === 'Escape') {
      close();
    }
  };

  function close() {
    if (!overlay) {
      return;
    }

    const node = overlay;
    overlay = null;
    node.classList.remove('is-open');
    document.removeEventListener('keydown', onKey);
    window.setTimeout(() => node.remove(), 200);
  }

  const open = (source, alt) => {
    overlay = document.createElement('div');
    overlay.className = 'lightbox';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', alt || '图片预览');

    const full = document.createElement('img');
    full.src = source;
    full.alt = alt || '';
    overlay.append(full);
    overlay.addEventListener('click', close, { signal });
    document.body.append(overlay);
    requestAnimationFrame(() => overlay?.classList.add('is-open'));
    document.addEventListener('keydown', onKey, { signal });
  };

  images.forEach((image) => {
    image.addEventListener('click', () => {
      open(image.currentSrc || image.src, image.alt);
    }, { signal });
  });
}
