// 服务器运行状态监控（仪表盘「服务器监控」模块的数据源）。
//
// 全部指标都从本机读取，不做任何网络请求：CPU/内存/负载走 os 模块，
// 磁盘与网卡流量走系统命令（Linux: df、/proc/net/dev；Windows: PowerShell CIM），
// 服务响应延迟用 perf_hooks 的事件循环延迟直方图。系统命令的结果带缓存
// （磁盘 30 秒、网卡 5 秒），避免仪表盘每次刷新都拉起子进程。
// 指标超阈值时生成告警项，由仪表盘醒目展示。
import os from 'node:os';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { monitorEventLoopDelay } from 'node:perf_hooks';

// —— 阈值（超出即告警；warn 先提醒，danger 醒目红） ——
export const THRESHOLDS = {
  cpuWarn: 75,
  cpuDanger: 90,
  memWarn: 80,
  memDanger: 92,
  diskWarn: 80,
  diskDanger: 90,
  latencyWarn: 200,
  latencyDanger: 500,
};

const isWin = process.platform === 'win32';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// —— CPU 使用率 ——
// 相邻两次采样之间的「非空闲时间占比」。每次采样会等待 250ms 取第二组样本。
const cpuSample = () =>
  os.cpus().reduce(
    (acc, cpu) => {
      const t = cpu.times;
      acc.idle += t.idle;
      acc.total += t.user + t.nice + t.sys + t.irq + t.idle;
      return acc;
    },
    { idle: 0, total: 0 },
  );

async function cpuPercent() {
  // 每次都等待一组新样本再算非空闲占比：逻辑简单、首次刷新也准确。
  const before = cpuSample();
  await sleep(250);
  const after = cpuSample();
  const dTotal = after.total - before.total;
  const dIdle = after.idle - before.idle;
  if (dTotal <= 0) return 0;
  return Math.round((1 - dIdle / dTotal) * 1000) / 10;
}

// —— 事件循环延迟（服务响应能力的直接体现） ——
const loopHistogram = monitorEventLoopDelay({ resolution: 20 });
loopHistogram.enable();

// —— 磁盘 ——
const execFileAsync = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 8000, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout));
    });
  });

const diskCache = { at: 0, value: null };
const DISK_TTL_MS = 30 * 1000;

async function diskUsage() {
  if (Date.now() - diskCache.at < DISK_TTL_MS && diskCache.value) return diskCache.value;
  let list = [];
  try {
    if (isWin) {
      const out = await execFileAsync('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | ForEach-Object { "{0}|{1}|{2}" -f $_.DeviceID,$_.FreeSpace,$_.Size }',
      ]);
      list = out
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [mount, free, total] = line.split('|');
          const t = Number(total) || 0;
          const f = Number(free) || 0;
          return t > 0 ? { mount: mount.trim(), total: t, free: f, used: t - f, percent: Math.round(((t - f) / t) * 1000) / 10 } : null;
        })
        .filter(Boolean);
    } else {
      const out = await execFileAsync('df', ['-kP']);
      list = out
        .split(/\r?\n/)
        .slice(1)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const cols = line.split(/\s+/);
          const total = (Number(cols[1]) || 0) * 1024;
          const used = (Number(cols[2]) || 0) * 1024;
          const free = (Number(cols[3]) || 0) * 1024;
          return total > 0 ? { mount: cols[5], total, free, used, percent: Math.round((used / total) * 1000) / 10 } : null;
        })
        .filter(Boolean);
    }
  } catch {
    list = diskCache.value || []; // 读取失败沿用旧值，仪表盘不至于空白
  }
  diskCache.at = Date.now();
  diskCache.value = list;
  return list;
}

// —— 网卡流量 ——
// 累计字节数（开机以来）由系统提供；速率 = 相邻两次采样差值 / 间隔。
const netCache = { at: 0, sample: null, rate: { rx: 0, tx: 0 }, supported: true };
const NET_TTL_MS = 5 * 1000;

async function netCounters() {
  if (isWin) {
    const out = await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-NetAdapterStatistics | ForEach-Object { "{0}|{1}|{2}" -f $_.Name,$_.ReceivedBytes,$_.SentBytes }',
    ]);
    return out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .reduce(
        (acc, line) => {
          const [, rx, tx] = line.split('|');
          acc.rx += Number(rx) || 0;
          acc.tx += Number(tx) || 0;
          return acc;
        },
        { rx: 0, tx: 0 },
      );
  }
  // Linux：/proc/net/dev 汇总所有非回环网卡。
  const raw = fs.readFileSync('/proc/net/dev', 'utf8');
  return raw
    .split(/\r?\n/)
    .slice(2)
    .reduce(
      (acc, line) => {
        const [iface, rest] = line.split(':');
        if (!rest) return acc;
        const name = iface.trim();
        if (name === 'lo') return acc;
        const cols = rest.trim().split(/\s+/).map(Number);
        acc.rx += cols[0] || 0;
        acc.tx += cols[8] || 0;
        return acc;
      },
      { rx: 0, tx: 0 },
    );
}

async function netStats() {
  const now = Date.now();
  if (now - netCache.at < NET_TTL_MS && netCache.sample) {
    return { rxRate: netCache.rate.rx, txRate: netCache.rate.tx, rxTotal: netCache.sample.rx, txTotal: netCache.sample.tx, supported: netCache.supported };
  }
  try {
    const cur = await netCounters();
    const prev = netCache.sample;
    const dt = prev ? Math.max(1, (now - netCache.at) / 1000) : 0;
    if (prev && dt) {
      // 计数器被重置（如网卡重启）时速率按 0 计。
      netCache.rate = {
        rx: Math.max(0, Math.round((cur.rx - prev.rx) / dt)),
        tx: Math.max(0, Math.round((cur.tx - prev.tx) / dt)),
      };
    }
    netCache.at = now;
    netCache.sample = cur;
    netCache.supported = true;
    return { rxRate: netCache.rate.rx, txRate: netCache.rate.tx, rxTotal: cur.rx, txTotal: cur.tx, supported: true };
  } catch {
    netCache.at = now;
    netCache.supported = false;
    return { rxRate: null, txRate: null, rxTotal: null, txTotal: null, supported: false };
  }
}

const formatBytes = (n) => {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n >= 1024 * 1024 * 1024) return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
};

const formatDuration = (sec) => {
  const s = Math.max(0, Math.floor(sec));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d} 天 ${h} 小时`;
  if (h > 0) return `${h} 小时 ${m} 分`;
  return `${m} 分 ${s % 60} 秒`;
};

// 采集一份完整快照：仪表盘刷新接口调用一次。
export async function snapshot({ fast = false } = {}) {
  // fast 模式用于后台首屏渲染：立即返回缓存/瞬时指标，不让 PowerShell
  // 与 CPU 采样拖慢 HTML 输出；完整采样在后台补刷新。
  if (fast) {
    refreshSoon();
    if (cache.value) return { ...cache.value, cached: true, pending: false };
    return { ...instantPart(), cpu: null, disk: [], net: { rxRate: null, txRate: null, rxTotal: null, txTotal: null, supported: false, rxRateText: '采集中…', txRateText: '采集中…', rxTotalText: '—', txTotalText: '—' }, alerts: [], pending: true };
  }
  const value = await collect();
  cache.at = Date.now();
  cache.value = value;
  return value;
}

// 后台串行刷新（去重）：fast 模式触发，稍后更新缓存供下次读取。
const refreshSoon = () => {
  if (refreshSoon.queued) return;
  refreshSoon.queued = true;
  setTimeout(() => {
    collect()
      .then((value) => {
        cache.at = Date.now();
        cache.value = value;
      })
      .catch(() => {})
      .finally(() => {
        refreshSoon.queued = false;
      });
  }, 0);
};

// 瞬时可得的部分（内存/运行时间/平台/事件循环）：fast 模式也返回真实值。
function instantPart() {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const loopMean = Math.round((loopHistogram.mean / 1e6) * 100) / 100;
  const loopP99 = Math.round((loopHistogram.percentile(99) / 1e6) * 100) / 100;
  loopHistogram.reset();
  const proc = process.memoryUsage();
  return {
    mem: {
      total: totalMem,
      free: freeMem,
      used: usedMem,
      percent: Math.round((usedMem / totalMem) * 1000) / 10,
      processRss: proc.rss,
      heapUsed: proc.heapUsed,
    },
    latency: { meanMs: loopMean, p99Ms: loopP99, sampleMs: 0 },
    uptime: {
      systemText: formatDuration(os.uptime()),
      processText: formatDuration(process.uptime()),
      systemSec: Math.floor(os.uptime()),
      processSec: Math.floor(process.uptime()),
    },
    platform: {
      os: `${os.type()} ${os.release()}`,
      arch: os.arch(),
      node: process.version,
    },
    thresholds: THRESHOLDS,
    collectedAt: Date.now(),
  };
}

const cache = { at: 0, value: null };

async function collect() {
  const started = Date.now();
  const [cpu, disk, net] = await Promise.all([cpuPercent(), diskUsage(), netStats()]);
  const base = instantPart();
  base.cpu = {
    percent: cpu,
    cores: os.cpus().length,
    model: os.cpus()[0]?.model?.trim() || '',
    load1: Math.round(os.loadavg()[0] * 100) / 100,
    load5: Math.round(os.loadavg()[1] * 100) / 100,
    load15: Math.round(os.loadavg()[2] * 100) / 100,
  };
  base.disk = disk;
  base.net = {
    ...net,
    rxRateText: net.supported ? `${formatBytes(net.rxRate)}/s` : '不支持',
    txRateText: net.supported ? `${formatBytes(net.txRate)}/s` : '不支持',
    rxTotalText: formatBytes(net.rxTotal),
    txTotalText: formatBytes(net.txTotal),
  };
  base.latency.sampleMs = Date.now() - started;
  base.pending = false;

  const t = THRESHOLDS;
  const alerts = [];
  const push = (level, metric, text) => alerts.push({ level, metric, text });
  if (cpu >= t.cpuDanger) push('danger', 'cpu', `CPU 使用率 ${cpu}%，已超过 ${t.cpuDanger}% 危险线`);
  else if (cpu >= t.cpuWarn) push('warn', 'cpu', `CPU 使用率 ${cpu}%，已超过 ${t.cpuWarn}% 警戒线`);
  if (base.mem.percent >= t.memDanger) push('danger', 'mem', `内存占用 ${base.mem.percent}%，已超过 ${t.memDanger}% 危险线`);
  else if (base.mem.percent >= t.memWarn) push('warn', 'mem', `内存占用 ${base.mem.percent}%，已超过 ${t.memWarn}% 警戒线`);
  for (const d of disk) {
    if (d.percent >= t.diskDanger) push('danger', 'disk', `磁盘 ${d.mount} 已用 ${d.percent}%，剩余 ${formatBytes(d.free)}`);
    else if (d.percent >= t.diskWarn) push('warn', 'disk', `磁盘 ${d.mount} 已用 ${d.percent}%，剩余 ${formatBytes(d.free)}`);
  }
  if (base.latency.p99Ms >= t.latencyDanger) push('danger', 'latency', `服务响应延迟 ${base.latency.p99Ms}ms，已超过 ${t.latencyDanger}ms 危险线`);
  else if (base.latency.p99Ms >= t.latencyWarn) push('warn', 'latency', `服务响应延迟 ${base.latency.p99Ms}ms，已超过 ${t.latencyWarn}ms 警戒线`);
  base.alerts = alerts;
  return base;
}
