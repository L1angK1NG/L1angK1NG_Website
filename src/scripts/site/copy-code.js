// 代码块一键复制按钮。
export function initCopyCode(signal) {
  const writeClipboard = async (text) => {
    if (globalThis.navigator?.clipboard?.writeText) {
      await globalThis.navigator.clipboard.writeText(text);
      return true;
    }

    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.append(textarea);
    textarea.select();
    const copied = document.execCommand('copy');
    textarea.remove();
    return copied;
  };

  document.querySelectorAll('.post-content pre').forEach((pre) => {
    if (pre.querySelector('[data-copy-code]')) {
      return;
    }

    const code = pre.querySelector('code');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'copy-code-button';
    button.dataset.copyCode = '';
    button.textContent = '复制';
    button.setAttribute('aria-label', '复制代码');
    pre.append(button);

    button.addEventListener('click', async () => {
      const text = code?.innerText ?? pre.innerText.replace(button.innerText, '');

      try {
        const copied = await writeClipboard(text.trimEnd());

        if (!copied) {
          throw new Error('Copy command failed');
        }

        button.textContent = '已复制';
        button.classList.add('is-copied');
        window.setTimeout(() => {
          button.textContent = '复制';
          button.classList.remove('is-copied');
        }, 1800);
      } catch {
        button.textContent = '复制失败';
        window.setTimeout(() => {
          button.textContent = '复制';
        }, 1800);
      }
    }, { signal });
  });
}
