// Standalone "build and publish" — same pipeline the admin's publish button
// uses. Handy for a first deploy or for a cron job that rebuilds on a schedule.
// Usage: npm run deploy
import { loadEnv } from '../admin/lib/env.mjs';

loadEnv();

const { buildAndPublish, currentRelease } = await import('../admin/lib/build.mjs');

console.log('[deploy] 开始构建并发布…');
const result = await buildAndPublish();
console.log(result.message);
if (result.log) console.log(result.log);
console.log('[deploy] 当前版本:', result.release || currentRelease() || '—');

process.exit(result.ok ? 0 : 1);
