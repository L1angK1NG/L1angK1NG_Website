// 无刷新导航的受控页面请求入口（安全基线集中在此）：
//   - 只接受后台路由白名单内的同源相对路径（不含协议/主机成分）；
//   - 非法路由返回 null，由调用方退回整页跳转，绝不代为发起任意请求。
const ADMIN_ROUTE_RE = /^\/admin(?:\/[\w-]+)*(?:\?path=[^#\s]*)?$/;

export function isAllowedAdminRoute(rel) {
  return ADMIN_ROUTE_RE.test(String(rel || ''));
}

export async function loadAdminPage(rel, signal) {
  const path = String(rel || '');
  if (!ADMIN_ROUTE_RE.test(path)) return null;
  // 统一请求网关：出站地址固定为 /api/_ 基址，页面路径经 base64 放进查询参数
  // （URL 中不出现路径形态数据），服务端解码白名单校验后内部派发。
  const url = new URL('/api/_', window.location.href);
  url.searchParams.set('r', btoa(encodeURIComponent(path)));
  return fetch(url.href, {
    signal,
    headers: { 'X-Requested-With': 'spa' },
  });
}
