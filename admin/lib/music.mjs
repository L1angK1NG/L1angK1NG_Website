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
  return res.json();
};

// 把 Meting 返回的条目归一成内部曲目结构（不落播放外链，播放时再解析）。
const metingItemToTrack = (item) => ({
  id: newId(),
  source: 'netease',
  title: clean(item?.title ?? item?.name, 120) || '未知歌曲',
  artist: clean(item?.author ?? item?.artist, 120) || '未知歌手',
  cover: clean(item?.pic ?? item?.cover ?? item?.image, 400),
  fileName: '',
  neteaseId: clean(item?.id, 40),
  enabled: true,
  createdAt: Date.now(),
});

// 按歌曲 ID / 分享链接添加单曲或整个歌单。
export async function importNetease(input) {
  const parsed = parseNeteaseId(input);
  if (!parsed) throw new Error('无法识别的网易云链接或 ID');
  const added = [];

  if (parsed.type === 'song') {
    let item = null;
    try {
      const data = await fetchMeting({ server: 'netease', type: 'song', id: parsed.id });
      item = Array.isArray(data) ? data[0] : data;
    } catch {
      // Meting 全部不可用时用网易云官方接口补元数据（播放地址播放时再解析）。
    }
    if (!item) {
      const official = await fetchNeteaseOfficial(
        `/api/song/detail/?ids=%5B${encodeURIComponent(parsed.id)}%5D`,
      );
      const song = official?.songs?.[0];
      if (!song) throw new Error('未找到该歌曲');
      item = {
        id: song.id,
        name: song.name,
        artist: (song.artists ?? []).map((a) => a.name).join('/'),
        pic: song.album?.picUrl ?? '',
      };
    }
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

  let data = null;
  try {
    data = await fetchMeting({ server: 'netease', type: 'playlist', id: parsed.id });
  } catch {
    // Meting 不可用时用官方接口读歌单曲目列表。
  }
  if (!Array.isArray(data) || !data.length) {
    const official = await fetchNeteaseOfficial(
      `/api/playlist/track/all?id=${encodeURIComponent(parsed.id)}&limit=500&offset=0`,
    );
    const songs = official?.songs ?? official?.tracks ?? [];
    data = songs.map((song) => ({
      id: song.id,
      name: song.name,
      artist: (song.ar ?? song.artists ?? []).map((a) => a.name).join('/'),
      pic: song.al?.picUrl ?? song.album?.picUrl ?? '',
    }));
  }
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
  if (!added.length) throw new Error('歌单中的曲目都已存在');
  save(store);
  return { tracks: added, playlist: true };
}

// —— 播放地址解析（网易云曲目） ——
// Meting 返回的外链通常有效期有限，这里做「曲目 ID → 地址」内存缓存
// （30 分钟），过期或播放失败后由前端触发重新解析。
const urlCache = new Map(); // neteaseId -> { url, at }

export async function resolvePlayUrl(neteaseId, { refresh = false } = {}) {
  const id = clean(neteaseId, 40);
  if (!id) throw new Error('缺少歌曲 ID');
  const hit = urlCache.get(id);
  if (!refresh && hit && Date.now() - hit.at < 30 * 60 * 1000 && hit.url) return hit.url;

  // 优先 type=song：响应里的 url 多为可直接播放的地址
  // （部分实现返回 302 包装链接，<audio> 会自动跟随）。
  let url = '';
  try {
    const data = await fetchMeting({ server: 'netease', type: 'song', id });
    const item = Array.isArray(data) ? data[0] : data;
    url = clean(item?.url ?? item?.src, 500);
  } catch {
    // 换 type=url 兜底（返回 302 跳转到真实音频，这里取 Location）。
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
        // safeFetch 跟随重定向后 res.url 即最终音频地址。
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
  urlCache.set(id, { url, at: Date.now() });
  return url;
}

// 前台歌单接口：返回启用中的曲目。本地曲目附带直链；网易云曲目不预先
// 逐条解析（歌单大时会串行请求太慢），由播放器在播放前调用 resolve
// 接口懒解析，失败的曲目由播放器自动跳过。
export async function publicPlaylist() {
  const tracks = listTracks().filter((t) => t.enabled);
  return tracks.map((t) => {
    if (t.source === 'local') {
      return { ...t, url: `/api/music/file/${encodeURIComponent(t.fileName)}` };
    }
    // 缓存里已有解析结果就直接带上，否则留空给播放器懒解析。
    const hit = urlCache.get(t.neteaseId);
    const fresh = hit && Date.now() - hit.at < 30 * 60 * 1000 ? hit.url : '';
    return { ...t, url: fresh };
  });
}
