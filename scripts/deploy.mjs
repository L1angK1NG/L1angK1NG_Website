// 独立的"构建并发布"脚本 —— 与管理后台发布按钮使用的是同一条流水线。
// 适合首次部署，或用于按计划定时重建的 cron 任务。
// 用法：npm run deploy
import { loadEnv } from '../admin/lib/env.mjs';

loadEnv();

const { buildAndPublish, currentRelease } = await import('../admin/lib/build.mjs');

console.log('[deploy] 开始构建并发布…');
const result = await buildAndPublish();
console.log(result.message);
if (result.log) console.log(result.log);
console.log('[deploy] 当前版本:', result.release || currentRelease() || '—');

process.exit(result.ok ? 0 : 1);
