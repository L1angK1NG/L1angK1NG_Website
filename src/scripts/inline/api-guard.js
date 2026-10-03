// API 可用性哨兵（head 内联，极小）：无后端环境（静态预览 / 接口挂掉）时，
// 浏览器对失败的网络请求必然打印错误，无法从 JS 静默——唯一办法是不再发请求。
//   1. 会话内首个 /api/ 请求充当探测：同帧的其他请求等它出结果再决定发不发，
//      把无后端环境的报错收敛到一条（而不是每个消费者各报一次）；
//   2. 探测失败（网络错误 / 404 / 5xx）后置位降级标记，后续请求直接跳过；
//   3. 标记带 10 分钟过期：临时性故障恢复后自动重试。
(() => {
  const KEY = 'blog-api-down-at';
  const TTL = 10 * 60 * 1000;
  let downAt = 0;
  try {
    downAt = Number(sessionStorage.getItem(KEY)) || 0;
  } catch {
    /* 存储不可用时按内存态处理 */
  }
  const expired = () => downAt > 0 && Date.now() - downAt > TTL;
  let probe = null;

  const markDown = () => {
    if (downAt > 0 && !expired()) return;
    downAt = Date.now();
    try {
      sessionStorage.setItem(KEY, String(downAt));
    } catch {
      /* 忽略 */
    }
  };

  // 统一请求网关地址构造：出站固定 /api/_ 基址，目标路径经 base64 放进查询
  // 参数（URL 中不出现路径形态数据），服务端解码白名单校验后内部派发。
  const adminApiUrl = (path) => {
    const u = new URL('/api/_', window.location.href);
    u.searchParams.set('r', btoa(encodeURIComponent(String(path || ''))));
    return u.href;
  };

  window.__blogApi = {
    get down() {
      return downAt > 0 && !expired();
    },
    fail: markDown,
    // 发起一次受门控的 API 请求（path 为 /api/ 下原始路径，内部经统一网关出站）：
    // 返回 Response；应跳过时返回 null。首个调用者即探测者，其余共享结果。
    async gateFetch(path, opts) {
      const url = adminApiUrl(path);
      if (this.down) return null;
      if (!probe) {
        probe = fetch(url, opts).then(
          (res) => {
            if (!res.ok && [404, 502, 503, 504].includes(res.status)) markDown();
            return res;
          },
          (err) => {
            // 请求被主动中断（刷新 / 切歌 / 切页）不算后端故障，不置降级标记，
            // 否则一次刷新就能让全站 /api 静默十分钟。
            if (err?.name !== 'AbortError') markDown();
            return null;
          },
        );
        return probe;
      }
      await probe;
      if (this.down) return null;
      return fetch(url, opts).catch(() => null);
    },
  };
})();
