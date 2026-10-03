// Meting 兼容音乐解析服务的出站请求入口（浏览器端）。
// 服务地址来自构建期配置（PUBLIC_MUSIC_API），编译后是字面量常量而非请求输入；
// 仅允许公网 http(s) 域名：拒绝 localhost / 私网 / 环回 / 链路本地 / 保留地址
// 与 IPv6 字面量。歌单 ID 只进查询参数且限制为纯数字。

// 解析服务基址：构建期由 Astro/Vite 内联为常量，运行期不可被请求改写。
const API_BASE = String(import.meta.env.PUBLIC_MUSIC_API ?? 'https://meting.mikus.ink/api');

const PRIVATE_HOSTS =
  /^(localhost|127\.|0\.|10\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/i;

function resolveApiUrl() {
  const url = new URL(API_BASE, window.location.href);
  const host = String(url.hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  const allowed =
    (url.protocol === 'https:' || url.protocol === 'http:') &&
    host.length > 0 &&
    !host.includes(':') &&
    host !== 'localhost' &&
    !host.endsWith('.localhost') &&
    !host.endsWith('.local') &&
    !host.endsWith('.internal') &&
    !host.endsWith('.home.arpa') &&
    !PRIVATE_HOSTS.test(host);
  if (!allowed) {
    throw new Error('Invalid music API base');
  }
  return url;
}

// 拉取网易云歌单曲目列表。playlistId 来自部署配置（组件 data 属性注入），
// 只允许纯数字，仅作为查询参数；出站目标主机固定为上述构建期常量。
export async function fetchMetingPlaylist(playlistId, { signal } = {}) {
  const id = String(playlistId ?? '').trim();
  if (!/^\d{1,20}$/.test(id)) {
    throw new Error('Invalid playlist id');
  }
  const endpoint = resolveApiUrl();
  endpoint.searchParams.set('server', 'netease');
  endpoint.searchParams.set('type', 'playlist');
  endpoint.searchParams.set('id', id);
  const response = await fetch(endpoint.href, {
    signal,
    mode: 'cors',
    credentials: 'omit',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`Playlist request failed: ${response.status}`);
  const data = await response.json();
  if (!Array.isArray(data)) throw new Error('Invalid playlist response');
  return data;
}
