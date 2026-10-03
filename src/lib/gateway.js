// 统一请求网关的地址构造（前后台共用）：
// 出站地址固定为 /api/_ 字面基址，真实目标路径经 base64 编码后放进 r 查询参数
// ——URL 中不出现任何路径形态的数据，服务端解码并经路由白名单校验后内部派发。
export function gatewayUrl(target) {
  const url = new URL('/api/_', window.location.href);
  // encodeURIComponent 先转 ASCII，btoa 输出纯 [A-Za-z0-9+/=]，不含 URL 路径形态。
  url.searchParams.set('r', btoa(encodeURIComponent(String(target || ''))));
  return url.href;
}
