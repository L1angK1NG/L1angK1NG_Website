// 博客访问统计：总访问次数、逐日访问量/访客数、来源与设备分布、
// 各文章访问量排名、访客 IP 归属地排名。
//
// 前台每个页面加载时向 /api/public/view 打点（sendBeacon），这里把计数落到
// data/stats.json。归属地按 IP 哈希缓存（stats.json 的 ipCache 字段），
// 同一访客只查询一次外部接口。隐私口径：不保存原始 IP / 原始 UA / 原始来源
// 地址——IP 只留哈希（访客去重用），UA 与来源只留归类结果（手机/桌面、
// 搜索引擎/直接访问等），可审计且不构成访客画像。
import { readJSON, updateJSON } from './store.mjs';
import { lookupRegion, ipHash } from './geo.mjs';

const STATS_FILE = 'stats.json';
const EMPTY = {
  total: 0,
  // 逐日桶：'YYYY-MM-DD' -> { pv, sources: {类别: n}, devices: {类别: n} }
  // （旧数据为纯数字 pv，读取时自动迁移）
  days: {},
  // 逐日访客去重集合：'YYYY-MM-DD' -> { 访客哈希前缀: 1 }
  uvSets: {},
  paths: {},
  regions: {},
  ipCache: {},
  updatedAt: '',
};

// 兼容旧格式：早期 days 的值是纯数字（只有 pv）。
const dayBucket = (v) => {
  if (typeof v === 'number') return { pv: v, sources: {}, devices: {} };
  return {
    pv: Number(v?.pv ?? v?.count ?? 0) || 0,
    sources: v?.sources && typeof v.sources === 'object' ? v.sources : {},
    devices: v?.devices && typeof v.devices === 'object' ? v.devices : {},
  };
};

const load = () => {
  const data = { ...structuredClone(EMPTY), ...readJSON(STATS_FILE, EMPTY) };
  data.uvSets = data.uvSets || {};
  return data;
};

// —— 日界线 ——
// 「今天」按北京时间（UTC+8）划分：无论后台跑在哪个时区的服务器上，
// 今日访问都对应当地 00:00 至当前的访问次数。
const DAY_OFFSET_MS = 8 * 60 * 60 * 1000;
export const dayKeyOf = (ts = Date.now()) => new Date(ts + DAY_OFFSET_MS).toISOString().slice(0, 10);
const today = () => dayKeyOf();

// N 天前（含今天为第 0 天）的日期键，用于滚动窗口合计与补零的日序列。
const dayKeyAgo = (days) => dayKeyOf(Date.now() - days * 24 * 60 * 60 * 1000);

// 每日计数保留最近 400 天：覆盖「近一年」（365 天）统计并留出缓冲，
// 避免文件无限膨胀。
const MAX_DAYS = 400;
// 单日访客去重集合上限：超出后当日 UV 停止增长（防数据文件被撑爆）。
const MAX_UV_PER_DAY = 3000;

// 页面地址里中文以百分号编码传输（如 /projects/%E5%AD%A6%E8%BF%B9-…），
// 统一解码成原始中文再存储与展示；解码失败（畸形转义）时保留原样。
const decodePath = (p) => {
  try {
    return decodeURIComponent(p);
  } catch {
    return p;
  }
};

// —— 来源归类 ——
// 只存类别，不存原始 referrer。站内跳转靠与请求 Host 比对识别。
const SEARCH_ENGINES = [
  'baidu.', 'google.', 'bing.', 'sogou.', 'so.com', '360.cn', 'duckduckgo.',
  'yahoo.', 'yandex.', 'sm.cn', 'quark.', 'ecosia.', 'startpage.', 'naver.',
];
const SOCIAL_SITES = [
  'weibo.', 'zhihu.', 'twitter.', 'x.com', 'facebook.', 'instagram.', 'reddit.',
  't.co', 't.me', 'telegram.', 'bilibili.', 'douyin.', 'xiaohongshu.', 'juejin.',
  'v2ex.', 'csdn.', 'jianshu.', 'segmentfault.', 'linux.do', 'sspai.', 'coolapk.',
];

const hostnameOf = (url) => {
  try {
    return new URL(String(url)).hostname.toLowerCase();
  } catch {
    return '';
  }
};

export function classifySource(ref, host) {
  const r = String(ref || '').trim();
  if (!r) return '直接访问';
  const h = hostnameOf(r);
  if (!h) return '直接访问';
  const site = String(host || '').split(':')[0].toLowerCase();
  if (site && (h === site || h.endsWith(`.${site}`))) return '站内跳转';
  if (SEARCH_ENGINES.some((s) => h.includes(s))) return '搜索引擎';
  if (SOCIAL_SITES.some((s) => h.includes(s))) return '社交媒体';
  return '外部链接';
}

// —— 设备归类 ——
// 只存类别，不存原始 UA。
export function classifyDevice(ua) {
  const s = String(ua || '').toLowerCase();
  if (!s) return '未知';
  if (/\bbot\b|spider|crawl|slurp|curl\/|wget\/|headless|python-requests|feedfetcher|monitor/.test(s)) {
    return '爬虫';
  }
  if (/ipad|tablet|playbook|silk|android(?!.*mobile)/.test(s)) return '平板';
  if (/mobi|iphone|ipod|android|blackberry|windows phone|harmonyos/.test(s)) return '手机';
  return '桌面';
}

// 记录一次页面访问。path 归一化（解码中文、去 query/hash），限制长度防止撑爆存储。
// 计数与归属地合并写入统一走 updateJSON（文件级互斥），并发打点不丢计数；
// 归属地的外部查询在锁外进行，网络慢不会阻塞其他打点请求。
export async function recordView({ path, title, ip, ref, ua, host }) {
  const raw = String(path || '/').split('?')[0].split('#')[0];
  const p = decodePath(raw).slice(0, 300) || '/';
  const source = classifySource(ref, host);
  const device = classifyDevice(ua);

  // 先拿 ipCache 快照在锁外查询归属地（结果只追加进快照，稍后合并回写）。
  const snapshot = await readJSON(STATS_FILE, EMPTY);
  const cachePatch = { ...(snapshot.ipCache || {}) };
  let region = null;
  try {
    region = await lookupRegion(ip, cachePatch);
  } catch {
    /* 归属地查询失败静默跳过，不影响计数 */
  }

  return updateJSON(STATS_FILE, EMPTY, (data) => {
    // 旧版 stats.json 没有 uvSets / 新版 days 桶，写入前先补齐结构。
    data.days = data.days || {};
    data.uvSets = data.uvSets || {};
    data.total += 1;
    const day = today();
    const bucket = dayBucket(data.days[day]);
    bucket.pv += 1;
    bucket.sources[source] = (bucket.sources[source] || 0) + 1;
    bucket.devices[device] = (bucket.devices[device] || 0) + 1;
    data.days[day] = bucket;

    // 访客去重：IP 哈希前缀入当日集合（不存原始 IP）。
    const uvSet = (data.uvSets[day] = data.uvSets[day] || {});
    const visitor = ipHash(ip).slice(0, 16);
    if (!(visitor in uvSet) && Object.keys(uvSet).length < MAX_UV_PER_DAY) uvSet[visitor] = 1;

    // 只保留最近 400 天的逐日计数与访客集合，避免文件无限膨胀。
    const dayKeys = Object.keys(data.days).sort();
    while (dayKeys.length > MAX_DAYS) {
      const gone = dayKeys.shift();
      delete data.days[gone];
      delete data.uvSets[gone];
    }

    const entry = (data.paths[p] = data.paths[p] || { title: '', count: 0, updatedAt: '' });
    entry.count += 1;
    if (title) entry.title = String(title).slice(0, 120);
    entry.updatedAt = new Date().toISOString();

    if (region) data.regions[region] = (data.regions[region] || 0) + 1;
    // 归属地缓存合并回写；只保留最近使用的 5000 条。
    Object.assign(data.ipCache, cachePatch);
    const cacheKeys = Object.keys(data.ipCache);
    if (cacheKeys.length > 5000) {
      cacheKeys
        .sort((a, b) => String(data.ipCache[a]?.at).localeCompare(String(data.ipCache[b]?.at)))
        .slice(0, cacheKeys.length - 5000)
        .forEach((k) => delete data.ipCache[k]);
    }

    data.updatedAt = new Date().toISOString();
    return { total: data.total };
  });
}

const sortByCount = (obj, limit) =>
  Object.entries(obj)
    .map(([key, value]) => ({ key, count: Number(value?.count ?? value) || 0, title: value?.title || '' }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);

// 页面路径归并：早期数据可能以百分号编码与解码两种形式各存一条，
// 汇总前按解码后的地址合并计数，避免同一页面重复上榜、数字被拆散。
const mergePaths = (paths) => {
  const merged = {};
  for (const [key, value] of Object.entries(paths)) {
    const k = decodePath(key);
    const cur = (merged[k] = merged[k] || { title: '', count: 0, updatedAt: '' });
    cur.count += Number(value?.count ?? value) || 0;
    cur.title = cur.title || value?.title || '';
    cur.updatedAt = cur.updatedAt || value?.updatedAt || '';
  }
  return merged;
};

// 把 N 天窗口内的来源/设备桶合计成 {类别: n}，再排成数组（降序）。
const sumBuckets = (data, fromKey, pick) => {
  const totals = {};
  for (const [date, raw] of Object.entries(data.days)) {
    if (date < fromKey) continue;
    for (const [key, n] of Object.entries(pick(dayBucket(raw)))) {
      totals[key] = (totals[key] || 0) + Number(n) || 0;
    }
  }
  return Object.entries(totals)
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count);
};

export function summary({ pathsLimit = 20, regionsLimit = 20 } = {}) {
  const data = load();
  const dayEntries = Object.entries(data.days).sort((a, b) => b[0].localeCompare(a[0]));

  // 滚动窗口合计：窗口内没有记录的日子计 0（而不是拿「最近几个有记录的日子」凑数）。
  const pvOf = (date) => dayBucket(data.days[date]).pv;
  const uvOf = (date) => Object.keys(data.uvSets?.[date] || {}).length;
  const sumSince = (fromKey) =>
    dayEntries.reduce((sum, [date, raw]) => (date >= fromKey ? sum + dayBucket(raw).pv : sum), 0);

  // 近一年每月序列：最近 12 个自然月（含本月）补零，按时间正序。
  const months = [];
  const now = new Date(Date.now() + DAY_OFFSET_MS);
  for (let i = 11; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    months.push({ month: d.toISOString().slice(0, 7), count: 0 });
  }
  const monthMap = new Map(months.map((m) => [m.month, m]));
  for (const [date, raw] of Object.entries(data.days)) {
    const slot = monthMap.get(date.slice(0, 7));
    if (slot) slot.count += dayBucket(raw).pv;
  }

  // 最近 32 天的日序列（访问量 + 访客数），按时间正序，缺失的日子补零。
  const days = [];
  for (let i = 31; i >= 0; i--) {
    const date = dayKeyAgo(i);
    days.push({ date, pv: pvOf(date), uv: uvOf(date) });
  }

  const rangeSeries = (n) => days.slice(-n);
  const rangeSums = (n) => {
    const slice = rangeSeries(n);
    return { pv: slice.reduce((s, d) => s + d.pv, 0), uv: slice.reduce((s, d) => s + d.uv, 0) };
  };
  // 区间独立访客 = 各日去重集合并集（同一访客多天访问只计一次）。
  const uvUnion = (n) => {
    const set = new Set();
    for (let i = n - 1; i >= 0; i--) {
      for (const key of Object.keys(data.uvSets?.[dayKeyAgo(i)] || {})) set.add(key);
    }
    return set.size;
  };

  const todayKey = dayKeyAgo(0);
  const yesterdayKey = dayKeyAgo(1);
  return {
    total: data.total,
    today: pvOf(todayKey),
    yesterday: pvOf(yesterdayKey),
    dayBefore: pvOf(dayKeyAgo(2)),
    week: sumSince(dayKeyAgo(6)),
    prevWeek: rangeSums(14).pv - rangeSums(7).pv,
    month: sumSince(dayKeyAgo(29)),
    prevMonth: rangeSums(60).pv - rangeSums(30).pv,
    year: sumSince(dayKeyAgo(364)),
    // 本月 / 上月（自然月）：同比口径。
    thisMonth: months[months.length - 1]?.count || 0,
    lastMonth: months[months.length - 2]?.count || 0,
    uv: {
      today: uvOf(todayKey),
      yesterday: uvOf(yesterdayKey),
      week: uvUnion(7),
      month: uvUnion(30),
    },
    days: rangeSeries(30),
    months,
    // 来源 / 设备分布：全部 / 近 7 天 / 近 30 天 三个口径，供仪表盘时间筛选。
    sources: {
      all: sumBuckets(data, '0000-00-00', (b) => b.sources),
      d7: sumBuckets(data, dayKeyAgo(6), (b) => b.sources),
      d30: sumBuckets(data, dayKeyAgo(29), (b) => b.sources),
    },
    devices: {
      all: sumBuckets(data, '0000-00-00', (b) => b.devices),
      d7: sumBuckets(data, dayKeyAgo(6), (b) => b.devices),
      d30: sumBuckets(data, dayKeyAgo(29), (b) => b.devices),
    },
    topPaths: sortByCount(mergePaths(data.paths), pathsLimit).filter((p) => p.key.startsWith('/')),
    topRegions: sortByCount(data.regions, regionsLimit),
    updatedAt: data.updatedAt,
  };
}
