import crypto from 'node:crypto';

const DEFAULT_TTL_MS = 12 * 60 * 60_000;

function safeEqual(actual, expected) {
  const left = Buffer.from(String(actual || ''));
  const right = Buffer.from(String(expected || ''));
  return left.length === right.length && right.length > 0 && crypto.timingSafeEqual(left, right);
}

function tokenKey(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

export function createAdminAuth({ username, password, ttlMs = DEFAULT_TTL_MS } = {}) {
  const expectedUsername = String(username || '').trim();
  const expectedPassword = String(password || '');
  const sessions = new Map();

  function cleanup() {
    const now = Date.now();
    for (const [key, session] of sessions) if (session.expiresAt <= now) sessions.delete(key);
  }

  function login(inputUsername, inputPassword) {
    cleanup();
    if (!expectedUsername || !expectedPassword) throw Object.assign(new Error('后台账号密码尚未配置'), { statusCode:503 });
    const validUsername = safeEqual(String(inputUsername || '').trim(), expectedUsername);
    const validPassword = safeEqual(inputPassword, expectedPassword);
    if (!validUsername || !validPassword) throw Object.assign(new Error('账号或密码错误'), { statusCode:401 });
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + Math.max(30 * 60_000, Number(ttlMs) || DEFAULT_TTL_MS);
    sessions.set(tokenKey(token), { username:expectedUsername, expiresAt });
    return { token, username:expectedUsername, expiresAt };
  }

  function session(token) {
    cleanup();
    const value = sessions.get(tokenKey(token));
    return value && value.expiresAt > Date.now() ? { ...value } : null;
  }

  function logout(token) {
    sessions.delete(tokenKey(token));
  }

  return { login, logout, session };
}
