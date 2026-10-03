// 后台日志工具：静默 catch 不再无痕吞错——保留原有降级语义（出错不影响主流程），
// 但把失败原因打进日志，排障时有迹可循。
const stamp = () => new Date().toISOString().slice(11, 19);

export function logWarn(scope, err) {
  console.warn(`[admin] ${stamp()} ${scope}:`, err?.message || err);
}

export function logError(scope, err) {
  console.error(`[admin] ${stamp()} ${scope}:`, err?.message || err);
}
