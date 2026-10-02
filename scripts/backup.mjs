// 手动触发一次数据备份 —— 与后台「构建发布」成功后的自动备份走同一条流水线。
// 适用场景：首次配置好远端私库后立即补推；或想在不发布的情况下留存一份数据。
// 用法：npm run backup
import { loadEnv } from '../admin/lib/env.mjs';

loadEnv();

const { runBackup } = await import('../admin/lib/backup.mjs');

console.log('[backup] 开始备份数据…');
const result = await runBackup(null);
console.log(result.summary);
if (result.error) console.error(result.error);
if (result.ok && result.pushed) console.log('[backup] 完成：远端与本地数据已同步。');
else if (result.ok) console.log('[backup] 本地备份完成（远端未推送，原因见上）。');
else process.exit(1);
