// 访问统计打点：每次页面加载（含 ClientRouter 换页）向后台上报路径与标题，
// 用于总访问量 / 文章排行 / 归属地统计。同时带上来源页与 UA——服务端只按
// 「搜索引擎/直接访问」「手机/桌面」等类别归并计数，不保存原始值。
// 失败静默（fetch().catch），且本地 API 已被判定不可用时不再发请求——
// 浏览器对失败的网络请求必然报错，跳过请求是唯一的静默方式。
let lastPath = '';
let lastAt = 0;

export function trackView() {
  const path = window.location.pathname;
  // 短时间内同路径重复触发（换页动画回跳）不重复计数。
  const now = Date.now();
  if (path === lastPath && now - lastAt < 3000) return;
  lastPath = path;
  lastAt = now;
  const opts = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      path,
      title: document.title,
      ref: (document.referrer || '').slice(0, 300),
      ua: (navigator.userAgent || '').slice(0, 200),
    }),
    keepalive: true,
  };
  // 走 API 哨兵门控：无后端时整个会话只留一条探测错误，打点全部跳过。
  try {
    const request = window.__blogApi?.gateFetch
      ? window.__blogApi.gateFetch('/api/public/view', opts)
      : fetch('/api/public/view', opts);
    Promise.resolve(request).catch(() => {});
  } catch {
    /* 打点失败静默 */
  }
}
