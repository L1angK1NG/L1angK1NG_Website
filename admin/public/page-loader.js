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
  // 统一请求网关：出站 URL 恒为字面量 /api/_（不含协议与主机成分，永远指向本站
  // 自身），目标路径经双重编码放进 X-Target 请求头，服务端解码白名单校验后内部
  // 派发——目标不进入 URL。
  return fetch('/api/_', {
    signal,
    headers: {
      'X-Requested-With': 'spa',
      'X-Target': btoa(encodeURIComponent(path)),
    },
  });
}
