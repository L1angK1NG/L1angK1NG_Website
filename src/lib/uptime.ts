// 网站运行时间：由开站日期计算「x年x月x天」。
// 年月日按日历借位（不是每月按 30 天折算）；后台 admin/views.mjs 里有同一份
// 算法的服务端副本（两处运行时互不依赖，改动请保持一致）。
export function formatUptime(since: string, now: Date = new Date()): string {
  const start = new Date(`${since}T00:00:00`);
  if (!since || Number.isNaN(start.getTime()) || start.getTime() > now.getTime()) return '';
  let y = now.getFullYear() - start.getFullYear();
  let m = now.getMonth() - start.getMonth();
  let d = now.getDate() - start.getDate();
  if (d < 0) {
    m -= 1;
    // 不足一天时借「上一个月」的天数补齐零头。
    d += new Date(now.getFullYear(), now.getMonth(), 0).getDate();
  }
  if (m < 0) {
    y -= 1;
    m += 12;
  }
  return `${y}年${m}月${d}天`;
}
