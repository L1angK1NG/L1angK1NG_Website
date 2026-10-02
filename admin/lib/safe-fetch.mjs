// 服务端出站请求的安全封装（SSRF 防护）。
//
// 凡是服务端主动发起的 URL 请求（网易云 / Meting API、IP 归属地查询）都必须
// 走这里：仅允许 http/https 协议；请求前校验 host —— 拒绝 localhost、环回、
// 私有与保留地址；跟随重定向时对每一跳重新校验，防止重定向绕过。
import dns from 'node:dns/promises';
import net from 'node:net';

// 判断 IPv4/IPv6 字面量是否属于环回 / 私有 / 链路本地 / 保留网段。
function isBlockedAddress(address) {
  const ip = address.trim().toLowerCase().replace(/^\[|\]$/g, '');

  // —— IPv6 ——
  if (ip.includes(':')) {
    if (ip === '::' || ip === '::1') return true; // 未指定 / 环回
    if (ip.startsWith('fe8') || ip.startsWith('fe9') || ip.startsWith('fea') || ip.startsWith('feb')) return true; // 链路本地 fe80::/10
    if (ip.startsWith('fc') || ip.startsWith('fd')) return true; // 唯一本地 fc00::/7
    if (ip.startsWith('::ffff:')) {
      // IPv4 映射地址按内嵌的 IPv4 再判一次。
      return isBlockedAddress(ip.slice('::ffff:'.length));
    }
    if (ip.startsWith('64:ff9b:')) return true; // NAT64 保留
    return false;
  }

  // —— IPv4 ——
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true; // 格式非法一律拒绝
  const [a, b] = parts;
  if (a === 0 || a === 127) return true; // 未指定 / 环回
  if (a === 10) return true; // 10.0.0.0/8 私有
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 私有
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 私有
  if (a === 169 && b === 254) return true; // 链路本地 169.254.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 运营商级 NAT 100.64.0.0/10
  if (a >= 224) return true; // 组播 224.0.0.0/4 与保留 240.0.0.0/4
  return false;
}

function isBlockedHostname(hostname) {
  const host = String(hostname || '').trim().toLowerCase().replace(/\.$/, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.lan')) return true;
  // 字面量 IP 直接按地址段判定。
  if (net.isIP(host)) return isBlockedAddress(host);
  return false;
}

// 解析主机名并确认所有解析结果都是公网地址（防 DNS 重绑定：域名解析到私网）。
async function assertPublicHost(hostname) {
  if (isBlockedHostname(hostname)) {
    throw new Error(`目标地址不被允许：${hostname}`);
  }
  if (net.isIP(hostname)) return;
  let addresses;
  try {
    addresses = await dns.lookup(hostname, { all: true });
  } catch {
    throw new Error(`域名解析失败：${hostname}`);
  }
  if (!addresses.length) throw new Error(`域名解析失败：${hostname}`);
  for (const { address } of addresses) {
    if (isBlockedAddress(address)) {
      throw new Error(`目标地址不被允许：${hostname} → ${address}`);
    }
  }
}

function validateUrl(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl));
  } catch {
    throw new Error('URL 格式无效');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('仅允许 http/https 协议');
  }
  return url;
}

const MAX_REDIRECTS = 3;

// 安全的 fetch 封装：协议白名单 + host 校验 + 逐跳重定向校验 + 超时。
export async function safeFetch(rawUrl, options = {}) {
  const { timeoutMs = 8000, ...fetchOptions } = options;
  let current = validateUrl(rawUrl);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    await assertPublicHost(current.hostname);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetch(current, {
        ...fetchOptions,
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (err?.name === 'AbortError') throw new Error('请求超时');
      throw new Error(`请求失败：${err?.message || err}`);
    }
    clearTimeout(timer);

    // 3xx 重定向：只继续跟 http/https 的 Location，并对新地址重新校验。
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new Error('重定向缺少 Location');
      current = validateUrl(new URL(location, current).toString());
      continue;
    }
    return response;
  }
  throw new Error('重定向次数过多');
}

// 校验一个待展示/存储的用户提交 URL（不发起请求，只确认协议与格式）。
export function isSafeHttpUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
