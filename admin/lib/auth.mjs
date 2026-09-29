// Auth primitives for the single-admin backend: scrypt password verification,
// CSRF token checks, and a small in-memory login rate limiter.
//
// The password is never stored in plaintext. ADMIN_PASSWORD_HASH holds
// "<salt>:<hex>" produced by `npm run admin:hash`.
import crypto from 'node:crypto';

const SCRYPT_KEYLEN = 64;

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

export function verifyPassword(password, stored) {
  if (typeof stored !== 'string' || !stored.includes(':')) return false;
  const [salt, expected] = stored.split(':');
  if (!salt || !expected) return false;
  const actual = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  return timingSafeEqualHex(actual, expected);
}

export function verifyCredentials(username, password) {
  const expectedUser = process.env.ADMIN_USER || 'admin';
  const storedHash = process.env.ADMIN_PASSWORD_HASH || '';
  // Compare the username in constant time too; short-circuit only on empty config.
  const userOk =
    typeof username === 'string' &&
    username.length === expectedUser.length &&
    crypto.timingSafeEqual(Buffer.from(username), Buffer.from(expectedUser));
  const passOk = verifyPassword(password, storedHash);
  return userOk && passOk;
}

// —— CSRF ——
// A per-session token double-checked on every state-changing request. The
// cookie is SameSite=Strict, so this is belt-and-braces against CSRF.

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

// —— Login rate limiting ——
// In-memory per-IP counter with lockout. Single instance, so this is enough to
// blunt brute-force attempts without adding a dependency.

const attempts = new Map();
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
export const MAX_LOGIN_ATTEMPTS = 8;
const LOCK_MS = 15 * 60 * 1000; // lockout after too many failures

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

// Records a failed attempt and returns how many failures are now on file for
// this client, so the route can tell the user how many tries remain.
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
