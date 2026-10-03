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

const today = () => new Date().toISOString().slice(0, 10);

// 记录一次页面访问。path 归一化（去 query/hash），限制长度防止撑爆存储。
// 计数与归属地合并写入统一走 updateJSON（文件级互斥），并发打点不丢计数；
// 归属地的外部查询在锁外进行，网络慢不会阻塞其他打点请求。
export async function recordView({ path, title, ip }) {
  const p = String(path || '/').split('?')[0].split('#')[0].slice(0, 300) || '/';

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
    // 只保留最近 90 天的逐日计数，避免文件无限膨胀。
    const dayKeys = Object.keys(data.days).sort();
    while (dayKeys.length > 90) delete data.days[dayKeys.shift()];

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

export function summary({ pathsLimit = 20, regionsLimit = 20 } = {}) {
  const data = load();
  const day = today();
  const days = Object.entries(data.days).sort((a, b) => b[0].localeCompare(a[0]));
  return {
    total: data.total,
    today: data.days[day] || 0,
    yesterday: days[1]?.[1] || 0,
    week: days.slice(0, 7).reduce((sum, [, n]) => sum + n, 0),
    days: days.slice(0, 30).reverse().map(([date, count]) => ({ date, count })),
    topPaths: sortByCount(data.paths, pathsLimit).filter((p) => p.key.startsWith('/')),
    topRegions: sortByCount(data.regions, regionsLimit),
    updatedAt: data.updatedAt,
  };
}
