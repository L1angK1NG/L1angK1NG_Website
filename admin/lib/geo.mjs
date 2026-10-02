// IP 归属地解析（访问统计用）。
//
// 查询结果按「IP 哈希 → 归属地」缓存进 stats.json，同一访客只查一次；
// 多个数据源依次降级，全部失败时归属地记为「未知」，绝不阻塞打点请求。
// 所有出站请求都经 safeFetch（仅 http/https、host 拒绝私有/环回地址）。
import crypto from 'node:crypto';
import net from 'node:net';
import { safeFetch } from './safe-fetch.mjs';

export const ipHash = (ip) => crypto.createHash('sha256').update(String(ip || '')).digest('hex').slice(0, 24);

// 内网 / 环回地址无需查询外部接口。
function isLocalIp(ip) {
  const value = String(ip || '').replace(/^\[|\]$/g, '');
  if (net.isIPv4(value)) {
    const a = Number(value.split('.')[0]);
    return a === 10 || a === 127 || (a === 192 && value.startsWith('192.168.')) || (a === 172 && Number(value.split('.')[1]) >= 16 && Number(value.split('.')[1]) <= 31) || a === 0;
  }
  if (net.isIPv6(value)) {
    return value === '::1' || value === '::' || value.startsWith('fe80') || value.startsWith('fc') || value.startsWith('fd') || value.startsWith('::ffff:127.') || value.startsWith('::ffff:10.') || value.startsWith('::ffff:192.168.');
  }
  return true; // 无法识别的一律按内网处理，避免拿非法值去请求外部接口
}

const clean = (v) => String(v ?? '').trim();

// 各数据源返回的字段不同，统一归一成「省份/城市」字符串。
async function queryPconline(ip) {
  const res = await safeFetch(`https://whois.pconline.com.cn/ipJson.jsp?ip=${encodeURIComponent(ip)}&json=true`, {
    timeoutMs: 5000,
    headers: { 'User-Agent': 'L1angK1NG-Blog/1.0' },
  });
  if (!res.ok) return null;
  const data = await res.json();
  const pro = clean(data.pro);
  const city = clean(data.city);
  if (!pro) return null;
  return city && city !== pro ? `${pro}·${city}` : pro;
}

async function queryIpApi(ip) {
  const res = await safeFetch(
    `http://ip-api.com/json/${encodeURIComponent(ip)}?lang=zh-CN&fields=status,country,regionName,city`,
    { timeoutMs: 5000, headers: { 'User-Agent': 'L1angK1NG-Blog/1.0' } },
  );
  if (!res.ok) return null;
  const data = await res.json();
  if (data.status !== 'success') return null;
  const region = clean(data.regionName);
  const city = clean(data.city);
  if (region && city && city !== region) return `${region}·${city}`;
  return region || clean(data.country) || null;
}

async function queryIpapiCo(ip) {
  const res = await safeFetch(`https://ipapi.co/${encodeURIComponent(ip)}/json/`, {
    timeoutMs: 5000,
    headers: { 'User-Agent': 'L1angK1NG-Blog/1.0' },
  });
  if (!res.ok) return null;
  const data = await res.json();
  if (data.error) return null;
  const region = clean(data.region);
  const city = clean(data.city);
  if (region && city && city !== region) return `${region}·${city}`;
  return region || clean(data.country_name) || null;
}

// 查询归属地。cache 是 stats.json 里的 ipCache 字段（调用方负责持久化）。
export async function lookupRegion(ip, cache = {}) {
  const value = String(ip || '').trim();
  if (!value || isLocalIp(value)) return '本机/内网';
  const key = ipHash(value);
  const hit = cache[key];
  if (hit?.region) return hit.region;

  for (const provider of [queryPconline, queryIpApi, queryIpapiCo]) {
    try {
      const region = await provider(value);
      if (region) {
        cache[key] = { region, at: new Date().toISOString() };
        return region;
      }
    } catch {
      // 换下一个数据源
    }
  }
  // 全部失败：短暂记为未知，但仍写入缓存避免每次都重试全部源。
  cache[key] = { region: '未知', at: new Date().toISOString() };
  return '未知';
}
