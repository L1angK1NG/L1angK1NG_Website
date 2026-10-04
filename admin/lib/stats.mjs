// 博客访问统计：总访问次数、各文章访问量排名、访客 IP 归属地排名。
//
// 前台每个页面加载时向 /api/stats/view 打点（sendBeacon），这里把计数落到
// data/stats.json。归属地按 IP 哈希缓存（stats.json 的 ipCache 字段），
// 同一访客只查询一次外部接口。不保存原始 IP，只保存哈希与归属地。
import { readJSON, updateJSON } from './store.mjs';
import { lookupRegion } from './geo.mjs';

const STATS_FILE = 'stats.json';
const EMPTY = {
  total: 0,
  days: {},
  paths: {},
  regions: {},
  ipCache: {},
  updatedAt: '',
};

const load = () => ({ ...structuredClone(EMPTY), ...readJSON(STATS_FILE, EMPTY) });

// —— 日界线 ——
// 「今天」按北京时间（UTC+8）划分：无论后台跑在哪个时区的服务器上，
// 今日访问都对应当地 00:00 至当前的访问次数。
const DAY_OFFSET_MS = 8 * 60 * 60 * 1000;
const dayKeyOf = (ts = Date.now()) => new Date(ts + DAY_OFFSET_MS).toISOString().slice(0, 10);
const today = () => dayKeyOf();

// N 天前（含今天为第 0 天）的日期键，用于滚动窗口合计与补零的日序列。
const dayKeyAgo = (days) => dayKeyOf(Date.now() - days * 24 * 60 * 60 * 1000);

// 每日计数保留最近 400 天：覆盖「近一年」（365 天）统计并留出缓冲，
// 避免文件无限膨胀。
const MAX_DAYS = 400;

// 页面地址里中文以百分号编码传输（如 /projects/%E5%AD%A6%E8%BF%B9-…），
// 统一解码成原始中文再存储与展示；解码失败（畸形转义）时保留原样。
const decodePath = (p) => {
  try {
    return decodeURIComponent(p);
  } catch {
    return p;
  }
};

// 记录一次页面访问。path 归一化（解码中文、去 query/hash），限制长度防止撑爆存储。
// 计数与归属地合并写入统一走 updateJSON（文件级互斥），并发打点不丢计数；
// 归属地的外部查询在锁外进行，网络慢不会阻塞其他打点请求。
export async function recordView({ path, title, ip }) {
  const raw = String(path || '/').split('?')[0].split('#')[0];
  const p = decodePath(raw).slice(0, 300) || '/';

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
    data.total += 1;
    const day = today();
    data.days[day] = (data.days[day] || 0) + 1;
    // 只保留最近 400 天的逐日计数，避免文件无限膨胀。
    const dayKeys = Object.keys(data.days).sort();
    while (dayKeys.length > MAX_DAYS) delete data.days[dayKeys.shift()];

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

export function summary({ pathsLimit = 20, regionsLimit = 20 } = {}) {
  const data = load();
  const day = today();
  const days = Object.entries(data.days).sort((a, b) => b[0].localeCompare(a[0]));

  // 滚动窗口合计：窗口内没有记录的日子计 0（而不是拿「最近几个有记录的日子」凑数）。
  const sumSince = (fromKey) =>
    days.reduce((sum, [date, n]) => (date >= fromKey ? sum + n : sum), 0);

  // 近一年每月序列：最近 12 个自然月（含本月）补零，按时间正序。
  const months = [];
  const now = new Date(Date.now() + DAY_OFFSET_MS);
  for (let i = 11; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    months.push({ month: d.toISOString().slice(0, 7), count: 0 });
  }
  const monthMap = new Map(months.map((m) => [m.month, m]));
  for (const [date, n] of Object.entries(data.days)) {
    const slot = monthMap.get(date.slice(0, 7));
    if (slot) slot.count += n;
  }

  return {
    total: data.total,
    today: data.days[day] || 0,
    yesterday: data.days[dayKeyAgo(1)] || 0,
    week: sumSince(dayKeyAgo(6)),
    month: sumSince(dayKeyAgo(29)),
    year: sumSince(dayKeyAgo(364)),
    months,
    topPaths: sortByCount(mergePaths(data.paths), pathsLimit).filter((p) => p.key.startsWith('/')),
    topRegions: sortByCount(data.regions, regionsLimit),
    updatedAt: data.updatedAt,
  };
}
