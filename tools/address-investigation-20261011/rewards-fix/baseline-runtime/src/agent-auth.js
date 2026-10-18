import crypto from 'node:crypto';

const DEFAULT_TTL_MS = 12 * 60 * 60_000;
const SCRYPT_KEYLEN = 64;
const SCRYPT_N = 16384;

function tokenKey(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

// 密码哈希：scrypt + salt，返回 "salt:hash"（均 hex）
export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(String(password || ''), salt, SCRYPT_KEYLEN, { N: SCRYPT_N }).toString('hex');
  return `${salt}:${derived}`;
}

function verifyPassword(password, stored) {
  try {
    const [salt, expected] = String(stored || '').split(':');
    if (!salt || !expected) return false;
    const derived = crypto.scryptSync(String(password || ''), salt, SCRYPT_KEYLEN, { N: SCRYPT_N });
    return crypto.timingSafeEqual(Buffer.from(derived), Buffer.from(expected, 'hex'));
  } catch { return false; }
}

// database 需提供 getAgentByUsername(username) -> { id, username, passwordHash, walletAddress, status } | null
export function createAgentAuth({ database, ttlMs = DEFAULT_TTL_MS } = {}) {
  if (!database) throw new Error('agentAuth 需要 database');
  const sessions = new Map();

  function cleanup() {
    const now = Date.now();
    for (const [key, session] of sessions) if (session.expiresAt <= now) sessions.delete(key);
  }

  function login(username, password) {
    cleanup();
    const agent = database.getAgentByUsername(String(username || '').trim());
    if (!agent) throw Object.assign(new Error('账号或密码错误'), { statusCode: 401 });
    if (agent.status !== 'active') throw Object.assign(new Error('该账号已被禁用'), { statusCode: 401 });
    if (!verifyPassword(password, agent.passwordHash)) {
      throw Object.assign(new Error('账号或密码错误'), { statusCode: 401 });
    }
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + Math.max(30 * 60_000, Number(ttlMs) || DEFAULT_TTL_MS);
    sessions.set(tokenKey(token), { id: agent.id, username: agent.username, walletAddress: agent.walletAddress, expiresAt });
    return { token, username: agent.username, walletAddress: agent.walletAddress, expiresAt };
  }

  function session(token) {
    cleanup();
    const value = sessions.get(tokenKey(token));
    return value && value.expiresAt > Date.now() ? { ...value } : null;
  }

  function logout(token) { sessions.delete(tokenKey(token)); }

  // 禁用/删除账号时让其已有会话失效
  function invalidateByAgentId(agentId) {
    for (const [k, v] of sessions) if (v.id === agentId) sessions.delete(k);
  }

  return { login, logout, session, invalidateByAgentId };
}
