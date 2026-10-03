// 音乐数据层：本地上传曲目 + 网易云外部曲源的统一歌单。
//
// 歌单存 data/music.json；本地音频文件存 data/music-files/（不进 git），
// 由后台服务通过 /api/music/file/:name 提供带 Range 的流式播放。
// 网易云曲目只记录歌曲 ID 与元数据，播放地址在运行时经 Meting 兼容 API
// 解析（带缓存），避免落库过期外链。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readJSON, writeJSON, newId, MUSIC_FILES_DIR } from './store.mjs';
import { safeFetch } from './safe-fetch.mjs';

const MUSIC_FILE = 'music.json';
const EMPTY = { tracks: [] };

const load = () => {
  const data = readJSON(MUSIC_FILE, EMPTY);
  return { tracks: Array.isArray(data.tracks) ? data.tracks : [] };
};
const save = (data) => writeJSON(MUSIC_FILE, data);

const clean = (v, max) => String(v ?? '').trim().slice(0, max);

export function listTracks() {
  return load().tracks.map((t) => ({
    id: t.id,
    source: t.source === 'local' ? 'local' : 'netease',
    title: clean(t.title, 120) || '未知歌曲',
    artist: clean(t.artist, 120) || '未知歌手',
    cover: clean(t.cover, 400),
    fileName: t.fileName || '',
    neteaseId: t.neteaseId || '',
    url: clean(t.url, 500),
    enabled: t.enabled !== false,
    createdAt: Number(t.createdAt) || 0,
  }));
}

export function getTrack(id) {
  return load().tracks.find((t) => t.id === String(id)) || null;
}

export function removeTrack(id) {
  const data = load();
  const track = data.tracks.find((t) => t.id === String(id));
  if (!track) throw new Error('曲目不存在');
  data.tracks = data.tracks.filter((t) => t.id !== String(id));
  save(data);
  // 本地文件一并删除（按内容哈希去重的文件可能被复用，删除前再确认无其他引用）。
  if (track.fileName) {
    const stillUsed = data.tracks.some((t) => t.fileName === track.fileName);
    if (!stillUsed) {
      try {
        fs.unlinkSync(path.join(MUSIC_FILES_DIR, path.basename(track.fileName)));
      } catch {
        /* 文件不存在就忽略 */
      }
    }
  }
  return { ok: true };
}

export function updateTrack(id, patch) {
  const data = load();
  const track = data.tracks.find((t) => t.id === String(id));
  if (!track) throw new Error('曲目不存在');
  if (patch.title !== undefined) track.title = clean(patch.title, 120) || track.title;
  if (patch.artist !== undefined) track.artist = clean(patch.artist, 120) || track.artist;
  if (patch.cover !== undefined) track.cover = clean(patch.cover, 400);
  if (patch.enabled !== undefined) track.enabled = Boolean(patch.enabled);
  save(data);
  return track;
}

// 调整曲目顺序：按 ids 数组整体重排。
export function reorderTracks(ids) {
  const data = load();
  const map = new Map(data.tracks.map((t) => [t.id, t]));
  const ordered = [];
  for (const id of Array.isArray(ids) ? ids : []) {
    const t = map.get(String(id));
    if (t) {
      ordered.push(t);
      map.delete(String(id));
    }
  }
  // 未列出的曲目保持原有相对顺序追加到末尾。
  for (const t of data.tracks) if (map.has(t.id)) ordered.push(t);
  data.tracks = ordered;
  save(data);
  return { ok: true };
}

// —— 本地上传 ——
// 音频先做内容哈希去重（与媒体库同一策略），再登记为 local 曲目。
export function addLocalTrack({ buffer, originalName, title, artist, cover }) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('音频文件为空');
  const ext = path.extname(originalName || '').toLowerCase();
  const hash = crypto.createHash('sha256').update(buffer).digest('hex');

  fs.mkdirSync(MUSIC_FILES_DIR, { recursive: true });
  let fileName = '';
  // 同内容文件复用已存储的副本。
  for (const entry of fs.readdirSync(MUSIC_FILES_DIR, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const digest = crypto.createHash('sha256').update(fs.readFileSync(path.join(MUSIC_FILES_DIR, entry.name))).digest('hex');
    if (digest === hash) {
      fileName = entry.name;
      break;
    }
  }
  if (!fileName) {
    const base = path
      .basename(originalName || 'track', ext)
      .replace(/[^\w一-龥-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'track';
    fileName = `${Date.now()}-${base}${ext}`;
    fs.writeFileSync(path.join(MUSIC_FILES_DIR, fileName), buffer);
  }

  const data = load();
  const track = {
    id: newId(),
    source: 'local',
    title: clean(title, 120) || path.basename(originalName || '未知歌曲', ext),
    artist: clean(artist, 120) || '未知歌手',
    cover: clean(cover, 400),
    fileName,
    neteaseId: '',
    enabled: true,
    createdAt: Date.now(),
  };
  data.tracks.push(track);
  save(data);
  return track;
}

// —— 网易云曲源 ——
// Meting 兼容接口按「配置源 → 备用公共源」依次降级；全部失败时回退到
// 网易云官方公开接口（仅取元数据，播放地址仍以 Meting 为准）。
const API_BASE = () =>
  String(process.env.PUBLIC_MUSIC_API || 'https://meting.mikus.ink/api').trim() ||
  'https://meting.mikus.ink/api';

const FALLBACK_BASES = [
  'https://api.injahow.cn/meting/',
  'https://meting.qjqq.cn/api',
];

// 解析歌曲 ID：支持纯数字、歌曲/歌单分享链接。
export function parseNeteaseId(input) {
  const text = clean(input, 400);
  if (!text) return null;
  if (/^\d+$/.test(text)) return { type: 'song', id: text };
  const songMatch = text.match(/song\?id=(\d+)/i) || text.match(/\/song\/(\d+)/i);
  if (songMatch) return { type: 'song', id: songMatch[1] };
  const listMatch = text.match(/playlist\?id=(\d+)/i) || text.match(/\/playlist\/(\d+)/i);
  if (listMatch) return { type: 'playlist', id: listMatch[1] };
  return null;
}

const fetchMeting = async (params) => {
  const bases = [API_BASE(), ...FALLBACK_BASES.filter((b) => b !== API_BASE())];
  let lastError = null;
  for (const base of bases) {
    try {
      const endpoint = new URL(base);
      for (const [k, v] of Object.entries(params)) endpoint.searchParams.set(k, v);
      const res = await safeFetch(endpoint.toString(), {
        timeoutMs: 8000,
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`音乐接口请求失败：${res.status}`);
      return res.json();
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('音乐接口均不可用');
};

// 网易云官方公开接口：仅用于获取歌曲/歌单元数据（名称、歌手、封面）。
const fetchNeteaseOfficial = async (pathAndQuery) => {
  const res = await safeFetch(`https://music.163.com${pathAndQuery}`, {
    timeoutMs: 8000,
    headers: {
      Accept: 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      Referer: 'https://music.163.com',
    },
  });
  if (!res.ok) throw new Error(`网易云接口请求失败：${res.status}`);
  const data = await res.json();
  // 网易云对不存在/被风控的接口也返回 HTTP 200 + body code，需再判一层。
  if (data && typeof data === 'object' && 'code' in data && Number(data.code) !== 200) {
    throw new Error(`网易云接口返回异常（code ${data.code}）`);
  }
  return data;
};

// Meting 的歌单条目往往不带 id 字段，但 url / lrc 里带歌曲 ID
// （如 ...type=url&id=1974443815），优先从中提取，取不到再退回条目自带 id。
export function extractNeteaseId(item) {
  const direct = clean(item?.id ?? item?.neteaseId, 40);
  if (/^\d+$/.test(direct)) return direct;
  const fromUrl = String(item?.url ?? item?.src ?? item?.lrc ?? '').match(/[?&](?:id|songid)=(\d{4,})/i);
  return fromUrl ? fromUrl[1] : '';
}

// 把 Meting 返回的条目归一成内部曲目结构。url 记录 Meting 解析链接作 fallback
// 播放地址（服务端 302 到真实音频、长期有效）；正常情况下播放器优先用
// neteaseId 走 /api/public/playlist/resolve 懒解析。
const metingItemToTrack = (item) => ({
  id: newId(),
  source: 'netease',
  title: clean(item?.title ?? item?.name, 120) || '未知歌曲',
  artist: clean(item?.author ?? item?.artist, 120) || '未知歌手',
  cover: clean(item?.pic ?? item?.cover ?? item?.image, 400),
  fileName: '',
  neteaseId: extractNeteaseId(item),
  url: clean(item?.url ?? item?.src, 500),
  enabled: true,
  createdAt: Date.now(),
});

// 拉取网易云歌单曲目列表（Meting 优先，官方接口兜底），导入与后台预览共用。
async function fetchNeteasePlaylistItems(playlistId) {
  let data = null;
  try {
    data = await fetchMeting({ server: 'netease', type: 'playlist', id: playlistId });
  } catch {
    // Meting 不可用时用官方接口读歌单曲目列表。
  }
  if (!Array.isArray(data) || !data.length) {
    // 官方歌单详情接口（带歌曲 id）；注意 /api/playlist/track/all 已不存在（404）。
    const official = await fetchNeteaseOfficial(
      `/api/v6/playlist/detail?id=${encodeURIComponent(playlistId)}&n=500`,
    );
    const songs = official?.playlist?.tracks ?? official?.songs ?? official?.tracks ?? [];
    data = songs.map((song) => ({
      id: song.id,
      name: song.name,
      artist: (song.ar ?? song.artists ?? []).map((a) => a.name).join('/'),
      pic: song.al?.picUrl ?? song.album?.picUrl ?? '',
    }));
  }
  return Array.isArray(data) ? data : [];
}

// 按歌曲 ID / 分享链接添加单曲或整个歌单。
// type 可显式指定 'song' | 'playlist'（如同步按钮传纯数字歌单 ID）；
// 未指定时：分享链接按链接语义、纯数字默认按单曲，查无此曲再按歌单重试
// （纯数字 ID 在网易云既可能是单曲也可能是歌单）。
export async function importNetease(input, { type } = {}) {
  const parsed = parseNeteaseId(input);
  if (!parsed) throw new Error('无法识别的网易云链接或 ID');
  const forced = type === 'song' || type === 'playlist' ? type : null;
  const plainId = /^\d+$/.test(clean(input, 400));
  const kind = forced || parsed.type;
  const added = [];

  if (kind === 'song') {
    let item = null;
    try {
      const data = await fetchMeting({ server: 'netease', type: 'song', id: parsed.id });
      item = Array.isArray(data) ? data[0] : data;
    } catch {
      // Meting 全部不可用时用网易云官方接口补元数据（播放地址播放时再解析）。
    }
    if (!item) {
      try {
        const official = await fetchNeteaseOfficial(
          `/api/song/detail/?ids=%5B${encodeURIComponent(parsed.id)}%5D`,
        );
        const song = official?.songs?.[0];
        if (song) {
          item = {
            id: song.id,
            name: song.name,
            artist: (song.artists ?? []).map((a) => a.name).join('/'),
            pic: song.album?.picUrl ?? '',
          };
        }
      } catch {
        /* 查不到按“不是单曲”处理 */
      }
    }
    if (item) {
      const track = metingItemToTrack({ ...item, id: parsed.id });
      const store = load();
      if (store.tracks.some((t) => t.neteaseId === track.neteaseId)) {
        throw new Error('该歌曲已在歌单中');
      }
      store.tracks.push(track);
      save(store);
      added.push(track);
      return { tracks: added, playlist: false };
    }
    // 显式指定单曲就到此为止；纯数字未指定类型时继续按歌单重试。
    if (forced === 'song' || !plainId) throw new Error('未找到该歌曲');
  }

  const data = await fetchNeteasePlaylistItems(parsed.id);
  if (!Array.isArray(data) || !data.length) throw new Error('歌单为空或无法读取');
  const store = load();
  const existing = new Set(store.tracks.map((t) => t.neteaseId).filter(Boolean));
  for (const item of data.slice(0, 500)) {
    const track = metingItemToTrack(item);
    // 歌单导入时 item 可能没有 id，用「标题+歌手」兜底判重。
    const key = track.neteaseId || `${track.title}|${track.artist}`;
    if (track.neteaseId && existing.has(track.neteaseId)) continue;
    if (!track.neteaseId && store.tracks.some((t) => `${t.title}|${t.artist}` === key)) continue;
    existing.add(track.neteaseId);
    store.tracks.push(track);
    added.push(track);
  }
  // 重复同步是常态（歌单无新增时），按成功处理而不是报错。
  if (!added.length) {
    return { tracks: [], playlist: true, message: '歌单中的曲目都已在管理歌单中，无新增。' };
  }
  save(store);
  return { tracks: added, playlist: true };
}

// —— 播放地址解析（网易云曲目） ——
// Meting 返回的外链通常有效期有限，这里做「曲目 ID → 地址」内存缓存
// （30 分钟），过期或播放失败后由前端触发重新解析。
const urlCache = new Map(); // neteaseId -> { url, at }

// 像音频直链的地址（带音频扩展名，可能带查询串）。
const looksLikeDirectAudio = (u) => /\.(mp3|m4a|flac|aac|ogg|wav)(\?|$)/i.test(String(u || ''));

// 跟随 302 解出最终音频直链。Meting 的 type=song / type=url 给出的都是
// 「跳板链接」（302 到真实 CDN 音频）；<audio> 直接加载跳板会失败（实测
// 服务端对浏览器请求回 522），必须在服务端解出最终地址再返回。
// 用 GET 但不读 body（safeFetch 逐跳校验并跟随重定向，res.url 即最终地址）。
async function unwrapRedirect(url) {
  try {
    const res = await safeFetch(url, { timeoutMs: 8000, headers: { Accept: '*/*' } });
    const finalUrl = String(res.url ?? '');
    return res.ok && /^https?:\/\//i.test(finalUrl) ? finalUrl : '';
  } catch {
    return '';
  }
}

export async function resolvePlayUrl(neteaseId, { refresh = false } = {}) {
  const id = clean(neteaseId, 40);
  if (!id) throw new Error('缺少歌曲 ID');
  const hit = urlCache.get(id);
  if (!refresh && hit && Date.now() - hit.at < 30 * 60 * 1000 && hit.url) return hit.url;

  // 优先 type=song 取元数据与播放链接。
  let url = '';
  try {
    const data = await fetchMeting({ server: 'netease', type: 'song', id });
    const item = Array.isArray(data) ? data[0] : data;
    url = clean(item?.url ?? item?.src, 500);
  } catch {
    // 换 type=url 兜底（返回 302 跳转到真实音频，这里取跟随后的最终地址）。
    try {
      const bases = [API_BASE(), ...FALLBACK_BASES.filter((b) => b !== API_BASE())];
      for (const base of bases) {
        const endpoint = new URL(base);
        endpoint.searchParams.set('server', 'netease');
        endpoint.searchParams.set('type', 'url');
        endpoint.searchParams.set('id', id);
        const res = await safeFetch(endpoint.toString(), {
          timeoutMs: 8000,
          headers: { Accept: 'application/json' },
        });
        const finalUrl = String(res.url ?? '');
        if (res.ok && /^https?:\/\//i.test(finalUrl)) {
          url = finalUrl;
          break;
        }
      }
    } catch {
      /* 两条路都失败 */
    }
  }

  if (!url || !/^https?:\/\//i.test(url)) throw new Error('该歌曲暂不可播放（可能受版权或 VIP 限制）');

  // 拿到的是跳板链接就解出最终音频直链（已直链则跳过）。
  if (!looksLikeDirectAudio(url)) {
    url = (await unwrapRedirect(url)) || url;
  }

  urlCache.set(id, { url, at: Date.now() });
  return url;
}

// —— 歌词（LRC 文本） ——
// 与播放地址一样经本服务转发（浏览器不直连 Meting）。Meting 的 lrc 端点
// 返回纯文本 LRC；网易云官方歌词接口返回 JSON，作兜底。缓存 24 小时
// （歌词不会变；没有歌词也缓存空串，避免反复回源）。
const lyricCache = new Map(); // neteaseId -> { at, lyric }

export async function getLyric(neteaseId, { refresh = false } = {}) {
  const id = clean(neteaseId, 40);
  if (!id) throw new Error('缺少歌曲 ID');
  const hit = lyricCache.get(id);
  if (!refresh && hit && Date.now() - hit.at < 24 * 60 * 60 * 1000) return hit.lyric;

  // 两个来源竞速取先回：Meting 的 lrc 端点（纯文本 LRC）时有抖动，
  // 网易云官方歌词接口（JSON）较稳——谁先返回非空用谁，避免歌词拖着不显示。
  const fromMeting = (async () => {
    const bases = [API_BASE(), ...FALLBACK_BASES.filter((b) => b !== API_BASE())];
    for (const base of bases) {
      const endpoint = new URL(base);
      endpoint.searchParams.set('server', 'netease');
      endpoint.searchParams.set('type', 'lrc');
      endpoint.searchParams.set('id', id);
      const res = await safeFetch(endpoint.toString(), {
        timeoutMs: 4000,
        headers: { Accept: 'text/plain' },
      });
      if (res.ok) {
        const text = String((await res.text()) ?? '').trim();
        if (text) return text;
      }
    }
    return '';
  })();

  const fromOfficial = (async () => {
    try {
      const data = await fetchNeteaseOfficial(
        `/api/song/lyric?id=${encodeURIComponent(id)}&lv=1&kv=1&tv=-1`,
      );
      return String(data?.lrc?.lyric ?? '').trim();
    } catch {
      return '';
    }
  })();

  const lyric = await Promise.any(
    [fromMeting, fromOfficial].map((p) => p.then((v) => (v ? v : Promise.reject(new Error('empty'))))),
  ).catch(() => '');

  lyricCache.set(id, { at: Date.now(), lyric });
  return lyric;
}

// 前台歌单接口：返回启用中的曲目。本地曲目附带直链；网易云曲目不预先
// 逐条解析（歌单大时会串行请求太慢），由播放器在播放前调用 resolve
// 接口懒解析，失败的曲目由播放器自动跳过。
//
// 管理歌单为空时的服务端兜底：代拉 .env 配置的网易云歌单返回。浏览器不直连
// Meting（其 CDN 对浏览器请求有防盗链/抖动，实测会 522），全部经本服务转发。
const neteaseFallbackCache = new Map(); // playlistId -> { at, tracks }

export async function publicPlaylist() {
  const managed = listTracks().filter((t) => t.enabled);
  if (managed.length) {
    return managed.map((t) => {
      if (t.source === 'local') {
        return { ...t, url: `/api/music/file/${encodeURIComponent(t.fileName)}` };
      }
      // 优先带解析缓存里的新鲜音频直链；有 neteaseId 的曲目无缓存时留空，
      // 交给播放器懒解析（返回 CDN 直链）；只有无 ID 的曲目才退回入库时保存
      // 的 Meting 链接兜底（跳板链接直接给 <audio> 会加载失败）。
      const hit = urlCache.get(t.neteaseId);
      const fresh = hit && Date.now() - hit.at < 30 * 60 * 1000 ? hit.url : '';
      return { ...t, url: fresh || (t.neteaseId ? '' : t.url || '') };
    });
  }

  const playlistId = clean(process.env.PUBLIC_NETEASE_PLAYLIST_ID, 40);
  if (!/^\d{1,20}$/.test(playlistId)) return [];
  let hit = neteaseFallbackCache.get(playlistId);
  if (!hit || Date.now() - hit.at > 10 * 60 * 1000) {
    try {
      const items = await fetchNeteasePlaylistItems(playlistId);
      const tracks = items
        .slice(0, 500)
        .map((item) => {
          const t = metingItemToTrack(item);
          // 只回带歌曲 ID 的曲目（播放走懒解析）；跳板链接不下发给 <audio>。
          return {
            id: t.id,
            source: 'netease',
            title: t.title,
            artist: t.artist,
            cover: t.cover,
            neteaseId: t.neteaseId,
            url: '',
            enabled: true,
          };
        })
        .filter((t) => t.neteaseId);
      hit = { at: Date.now(), tracks };
      neteaseFallbackCache.set(playlistId, hit);
    } catch {
      // 拉取失败返回空列表，前端展示加载失败并可重试。
      return [];
    }
  }
  return hit.tracks;
}
