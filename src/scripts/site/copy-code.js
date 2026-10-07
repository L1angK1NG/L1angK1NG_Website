// 代码块增强：右上角一键复制 + 左上角语言标签。
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

  // 语言标签：来自 Astro 代码高亮写在 pre 上的 data-language，
  // 纯文本块不打标签（避免「plaintext」这种无信息噪声）。
  const LANG_LABELS = {
    js: 'JS', javascript: 'JS', ts: 'TS', typescript: 'TS', jsx: 'JSX', tsx: 'TSX',
    html: 'HTML', xml: 'XML', css: 'CSS', scss: 'SCSS', json: 'JSON', bash: 'Shell',
    sh: 'Shell', shell: 'Shell', zsh: 'Shell', powershell: 'PowerShell', cmd: 'CMD',
    python: 'Python', py: 'Python', go: 'Go', rust: 'Rust', java: 'Java', c: 'C',
    cpp: 'C++', 'c++': 'C++', 'c#': 'C#', csharp: 'C#', sql: 'SQL', yaml: 'YAML',
    yml: 'YAML', toml: 'TOML', ini: 'INI', markdown: 'MD', md: 'MD', diff: 'DIFF',
    astro: 'Astro', vue: 'Vue', php: 'PHP', ruby: 'Ruby', swift: 'Swift', kotlin: 'Kotlin',
  };

  document.querySelectorAll('.post-content pre').forEach((pre) => {
    if (pre.querySelector('[data-copy-code]')) {
      return;
    }

    const code = pre.querySelector('code');

    const lang = String(pre.dataset.language || '').toLowerCase();
    const langLabel = LANG_LABELS[lang];
    if (langLabel) {
      const chip = document.createElement('span');
      chip.className = 'code-lang';
      chip.setAttribute('aria-hidden', 'true');
      chip.textContent = langLabel;
      pre.append(chip);
    }

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
