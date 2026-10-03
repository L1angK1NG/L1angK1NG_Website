// 全局快捷键：按 / 或 Ctrl/⌘+K 聚焦搜索框（无搜索页则跳转搜索页）。
// 文档级监听只绑定一次，换页无需重复。
export function initShortcuts() {
  const isTyping = (el) =>
    el &&
    (el.tagName === 'INPUT' ||
      el.tagName === 'TEXTAREA' ||
      el.tagName === 'SELECT' ||
      el.isContentEditable);

  document.addEventListener('keydown', (event) => {
    const slash =
      event.key === '/' && !event.metaKey && !event.ctrlKey && !event.altKey;
    const cmdK =
      (event.metaKey || event.ctrlKey) && (event.key === 'k' || event.key === 'K');

    if (!slash && !cmdK) {
      return;
    }
    if (slash && isTyping(document.activeElement)) {
      return;
    }

    event.preventDefault();
    const input = document.querySelector('#search-input');

    if (input) {
      input.focus();
      input.select?.();
    } else {
      window.location.href = '/search/';
    }
  });
}
