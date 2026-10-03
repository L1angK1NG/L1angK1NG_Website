// 文章图片的字节一旦到达就打上标记，让 CSS 能将其淡入。
export function initImgFade() {
  document.querySelectorAll('.post-content img').forEach((img) => {
    const mark = () => img.classList.add('is-loaded');
    if (img.complete) {
      mark();
      return;
    }
    img.addEventListener('load', mark, { once: true });
    img.addEventListener('error', mark, { once: true });
  });
}
