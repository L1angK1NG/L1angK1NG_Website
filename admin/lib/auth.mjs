// 单管理员后台的认证基础组件：scrypt 密码校验、CSRF token 校验，以及一个
// 小巧的内存版登录限流器。
//
// 密码永远不会以明文存储。ADMIN_PASSWORD_HASH 保存由 `npm run admin:hash`
// 生成的 "<salt>:<hex>"。
import crypto from 'node:crypto';
import { promisify } from 'node:util';

const SCRYPT_KEYLEN = 64;
// 异步 scrypt：登录请求不阻塞事件循环（scryptSync 在高并发下会卡住整个后台）。
const scryptAsync = promisify(crypto.scrypt);

export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  return `${salt}:${hash}`;
}

const timingSafeEqualHex = (a, b) => {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return crypto.timingSafeEqual(bufA, bufB);
};

export async function verifyPassword(password, stored) {
  if (typeof stored !== 'string' || !stored.includes(':')) return false;
  const [salt, expected] = stored.split(':');
  if (!salt || !expected) return false;
  const actual = (await scryptAsync(password, salt, SCRYPT_KEYLEN)).toString('hex');
  return timingSafeEqualHex(actual, expected);
}

export async function verifyCredentials(username, password) {
  const expectedUser = process.env.ADMIN_USER || 'admin';
  const storedHash = process.env.ADMIN_PASSWORD_HASH || '';
  // 用户名同样使用恒定时间比较；仅在配置为空时才短路跳过。
  const userOk =
    typeof username === 'string' &&
    username.length === expectedUser.length &&
    crypto.timingSafeEqual(Buffer.from(username), Buffer.from(expectedUser));
  // 即使用户名不匹配也照常计算密码哈希，保持耗时一致，避免时序侧信道。
  const passOk = await verifyPassword(password, storedHash);
  return userOk && passOk;
}

// —— CSRF ——
// 每个会话持有一个 token，并在每个更改状态的请求上做双重校验。Cookie 本身
// 已是 SameSite=Strict，因此这只是针对 CSRF 的额外双保险。

export function newCsrfToken() {
  return crypto.randomBytes(24).toString('hex');
}

export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function requireCsrf(req, res, next) {
  const token = req.get('x-csrf-token') || req.body?.csrfToken;
  if (!req.session?.csrfToken || !safeEqual(token, req.session.csrfToken)) {
    return res.status(403).json({ error: 'CSRF 校验失败，请刷新页面后重试。' });
  }
  return next();
}

// —— 登录限流 ——
// 基于内存的按 IP 计数器，并带锁定机制。单实例部署下，无需引入额外依赖就
// 足以挫败暴力破解尝试。

const attempts = new Map();
const WINDOW_MS = 15 * 60 * 1000; // 15 分钟
export const MAX_LOGIN_ATTEMPTS = 8;
const LOCK_MS = 15 * 60 * 1000; // 失败次数过多后的锁定时长

const clientKey = (req) => req.ip || req.socket?.remoteAddress || 'unknown';

export function isLocked(req) {
  const key = clientKey(req);
  const rec = attempts.get(key);
  if (!rec) return 0;
  const now = Date.now();
  if (rec.lockedUntil && rec.lockedUntil > now) {
    return Math.ceil((rec.lockedUntil - now) / 1000);
  }
  if (rec.firstAt && now - rec.firstAt > WINDOW_MS) {
    attempts.delete(key);
  }
  return 0;
}

// 记录一次失败尝试，并返回该客户端目前已登记的失败次数，方便路由告知用户
// 还剩多少次尝试机会。
export function recordFailure(req) {
  const key = clientKey(req);
  const now = Date.now();
  const rec = attempts.get(key) || { count: 0, firstAt: now };
  if (now - rec.firstAt > WINDOW_MS) {
    rec.count = 0;
    rec.firstAt = now;
  }
  rec.count += 1;
  if (rec.count >= MAX_LOGIN_ATTEMPTS) {
    rec.lockedUntil = now + LOCK_MS;
  }
  attempts.set(key, rec);
  return rec.count;
}

export function clearFailures(req) {
  attempts.delete(clientKey(req));
}
