'use strict';
const crypto = require('node:crypto');
const {
  DataError,
  ok,
  nowIso,
  genId,
  sha256hex,
  toDataError,
} = require('./db');

const ROLES = ['player', 'support', 'admin'];

const SCRYPT_OPTS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const KEY_BYTES = 32;

const SERVICE_SCOPES = [
  'wallet:read',
  'wallet:write',
  'ledger:read',
  'games:write',
  'rooms:write',
  'payments:reconcile',
  'metrics:read',
  'users:read'
];

const PERMISSIONS = {
  'game:play': ['player', 'support', 'admin'],
  'wallet:viewOwn': ['player', 'support', 'admin'],
  'session:manageOwn': ['player', 'support', 'admin'],
  'user:view': ['support', 'admin'],
  'audit:view': ['support', 'admin'],
  'room:manage': ['admin'],
  'game:manage': ['admin'],
  'wallet:manage': ['admin'],
  'user:manage': ['admin'],
  'session:manageAny': ['admin'],
  'service:manage': ['admin'],
};

function hashPassword(password) {
  ok(
    typeof password === 'string' && password.length >= 8 && password.length <= 128,
    'E_ARG',
    'password must be 8-128 characters',
  );
  const salt = crypto.randomBytes(16).toString('hex');
  const key = crypto.scryptSync(password, salt, 64, SCRYPT_OPTS).toString('hex');
  return 'scrypt$' + salt + '$' + key;
}

function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = parts[1];
  const expectedHex = parts[2];
  if (!/^[0-9a-f]+$/.test(salt) || !/^[0-9a-f]+$/.test(expectedHex)) return false;
  const computed = crypto.scryptSync(password, salt, expectedHex.length / 2, SCRYPT_OPTS);
  const expected = Buffer.from(expectedHex, 'hex');
  if (computed.length !== expected.length) return false;
  return crypto.timingSafeEqual(computed, expected);
}

function generateToken() {
  return crypto.randomBytes(KEY_BYTES).toString('hex');
}

function stripPasswordHash(user) {
  if (!user) return null;
  const { password_hash, ...safe } = user;
  void password_hash;
  return safe;
}

function assertRole(user, roles) {
  const list = Array.isArray(roles) ? roles : [roles];
  ok(user && user.id, 'E_UNAUTHORIZED', 'authentication required');
  if (!list.includes(user.role)) {
    throw new DataError('E_FORBIDDEN', 'forbidden role: ' + user.role);
  }
}

function can(user, permission) {
  if (!user || !permission) return false;
  const allowed = PERMISSIONS[permission] || [];
  return allowed.includes(user.role);
}

function assertPermission(user, permission) {
  ok(user && user.id, 'E_UNAUTHORIZED', 'authentication required');
  if (!can(user, permission)) {
    throw new DataError('E_FORBIDDEN', 'forbidden permission: ' + permission);
  }
}

function getSession(db, id) {
  const row = db.prepare('SELECT * FROM auth_sessions WHERE id = ?').get(id);
  ok(row, 'E_NO_SESSION', 'session not found: ' + id);
  return row;
}

function getService(db, id) {
  const row = db.prepare('SELECT * FROM service_credentials WHERE id = ?').get(id);
  ok(row, 'E_NO_SERVICE', 'service credential not found: ' + id);
  return { ...row, scopes: parseScopes(row.scopes_json) };
}

function parseScopes(text) {
  try {
    const parsed = JSON.parse(text || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function buildAuth(db, repos) {
  function register(input) {
    const password = input && input.password;
    ok(typeof password === 'string', 'E_ARG', 'password required');
    const user = repos.createUser({ ...input, passwordHash: hashPassword(password) });
    repos.recordAudit({
      actorType: 'system',
      action: 'user.register',
      targetType: 'user',
      targetId: user.id,
      detail: { username: user.username },
    });
    return stripPasswordHash(repos.getById(user.id));
  }

  function login(identity, password, options = {}) {
    const user = repos.findByIdentity(identity);
    const valid = user ? verifyPassword(password, user.password_hash) : false;
    if (!user || !valid) {
      repos.recordAudit({
        actorType: 'user',
        actorId: user && user.id || null,
        action: 'auth.login.failed',
        targetType: 'user',
        targetId: user && user.id || null,
        detail: { identity, ip: options.ip && String(options.ip) || null },
      });
      throw new DataError('E_BAD_CREDENTIALS', 'invalid identity or password');
    }
    if (user.status !== 'active') {
      repos.recordAudit({
        actorType: 'user',
        actorId: user.id,
        action: 'auth.login.blocked',
        targetType: 'user',
        targetId: user.id,
        detail: { status: user.status },
      });
      throw new DataError('E_USER_INACTIVE', 'user is not active: ' + user.status);
    }
    const created = createSession(user.id, options);
    repos.recordAudit({
      actorType: 'user',
      actorId: user.id,
      action: 'auth.login',
      targetType: 'user',
      targetId: user.id,
      detail: { sessionId: created.session.id, ip: options.ip && String(options.ip) || null },
    });
    return { ...created, user: stripPasswordHash(repos.getById(user.id)) };
  }

  function logout(userId, tokenOrSessionId) {
    const session = revokeSession(tokenOrSessionId);
    repos.recordAudit({
      actorType: 'user',
      actorId: userId || session.user_id,
      action: 'auth.logout',
      targetType: 'user',
      targetId: session.user_id,
      detail: { sessionId: session.id },
    });
    return session;
  }

  function changePassword(userId, newPassword, options = {}) {
    const user = repos.getById(userId);
    if (options.currentPassword) {
      ok(
        verifyPassword(options.currentPassword, user.password_hash),
        'E_BAD_CREDENTIALS',
        'current password is incorrect',
      );
    }
    db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(
      hashPassword(newPassword),
      nowIso(),
      userId,
    );
    revokeUserSessions(userId);
    repos.recordAudit({
      actorType: 'user',
      actorId: userId,
      action: 'auth.password_changed',
      targetType: 'user',
      targetId: userId,
    });
    return { changed: true };
  }

  function createSession(userId, options = {}) {
    const user = repos.getById(userId);
    ok(user.status === 'active', 'E_USER_INACTIVE', 'user is not active: ' + user.status);
    const now = options.now instanceof Date ? options.now : new Date();
    const ttlMs = options.ttlMs === undefined ? SESSION_TTL_MS : options.ttlMs;
    ok(Number.isFinite(ttlMs) && ttlMs > 0, 'E_ARG', 'session ttl must be a positive number of ms');
    const token = generateToken();
    const id = genId();
    const created = now.toISOString();
    const expires = new Date(now.getTime() + ttlMs).toISOString();
    db.prepare(
      `INSERT INTO auth_sessions (id, user_id, token_hash, ip, user_agent, created_at, expires_at, last_used_at, revoked_at)
       VALUES (?,?,?,?,?,?,?,?,NULL)`,
    ).run(
      id,
      userId,
      sha256hex(token),
      options.ip && String(options.ip) || null,
      options.userAgent && String(options.userAgent) || null,
      created,
      expires,
      created,
    );
    return { session: getSession(db, id), token };
  }

  function authenticateToken(token, options = {}) {
    ok(typeof token === 'string' && token.length > 0, 'E_ARG', 'token required');
    const row = db
      .prepare('SELECT * FROM auth_sessions WHERE token_hash = ?')
      .get(sha256hex(token));
    if (!row) throw new DataError('E_INVALID_TOKEN', 'unknown session token');
    if (row.revoked_at) throw new DataError('E_SESSION_REVOKED', 'session is revoked');
    const now = options.now instanceof Date ? options.now : new Date();
    if (now.getTime() >= Date.parse(row.expires_at)) {
      throw new DataError('E_SESSION_EXPIRED', 'session has expired');
    }
    const user = repos.getById(row.user_id);
    if (user.status !== 'active') {
      throw new DataError('E_USER_INACTIVE', 'user is not active: ' + user.status);
    }
    db.prepare('UPDATE auth_sessions SET last_used_at = ? WHERE id = ?').run(now.toISOString(), row.id);
    return { session: getSession(db, row.id), user: stripPasswordHash(user) };
  }

  function revokeSession(tokenOrId) {
    ok(typeof tokenOrId === 'string' && tokenOrId.length > 0, 'E_ARG', 'session token or id required');
    const row =
      db.prepare('SELECT * FROM auth_sessions WHERE id = ?').get(tokenOrId) ||
      db.prepare('SELECT * FROM auth_sessions WHERE token_hash = ?').get(sha256hex(tokenOrId));
    ok(row, 'E_NO_SESSION', 'session not found');
    if (!row.revoked_at) {
      db.prepare('UPDATE auth_sessions SET revoked_at = ? WHERE id = ?').run(nowIso(), row.id);
    }
    return getSession(db, row.id);
  }

  function revokeUserSessions(userId, options = {}) {
    const ts = nowIso();
    if (options.exceptSessionId) {
      return db
        .prepare('UPDATE auth_sessions SET revoked_at = ? WHERE user_id = ? AND id != ? AND revoked_at IS NULL')
        .run(ts, userId, options.exceptSessionId)
        .changes;
    }
    return db
      .prepare('UPDATE auth_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
      .run(ts, userId).changes;
  }

  function listSessions(userId, options = {}) {
    const limit = Number.isSafeInteger(options.limit) ? options.limit : 100;
    const offset = Number.isSafeInteger(options.offset) ? options.offset : 0;
    return db
      .prepare('SELECT * FROM auth_sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?')
      .all(userId, limit, offset);
  }

  function setUserRole(userId, role) {
    ok(ROLES.includes(role), 'E_ARG', 'invalid role: ' + role);
    const user = repos.getById(userId);
    if (user.role === 'admin' && role !== 'admin') {
      const count = db
        .prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND status = 'active'")
        .get().c;
      ok(count > 1, 'E_LAST_ADMIN', 'cannot demote the last active admin');
    }
    db.prepare('UPDATE users SET role = ?, updated_at = ? WHERE id = ?').run(role, nowIso(), userId);
    repos.recordAudit({
      actorType: 'system',
      action: 'user.role_changed',
      targetType: 'user',
      targetId: userId,
      detail: { from: user.role, to: role },
    });
    return stripPasswordHash(repos.getById(userId));
  }

  function registerService(input) {
    const name = String(input && input.name || '').trim();
    ok(name.length >= 3 && name.length <= 60, 'E_ARG', 'service name must be 3-60 chars');
    const scopes = Array.isArray(input && input.scopes) ? input.scopes : [];
    ok(
      scopes.length > 0 && scopes.every((s) => SERVICE_SCOPES.includes(s)),
      'E_ARG',
      'invalid service scope(s)',
    );
    const id = genId();
    const key = generateToken();
    const ts = nowIso();
    try {
      db.prepare(
        `INSERT INTO service_credentials (id, name, key_hash, scopes_json, status, created_at, revoked_at, last_used_at)
         VALUES (?,?,?,?,?,?,NULL,NULL)`,
      ).run(id, name, sha256hex(key), JSON.stringify(scopes), 'active', ts);
    } catch (err) {
      throw toDataError(err, 'E_SERVICE_CREATE', 'service credential create failed: ' + name);
    }
    return { credential: getService(db, id), key };
  }

  function authenticateService(key, requiredScope) {
    ok(typeof key === 'string' && key.length > 0, 'E_ARG', 'service key required');
    const row = db
      .prepare('SELECT * FROM service_credentials WHERE key_hash = ?')
      .get(sha256hex(key));
    if (!row) throw new DataError('E_INVALID_SERVICE_KEY', 'invalid service key');
    if (row.status !== 'active') {
      throw new DataError('E_SERVICE_REVOKED', 'service credential is revoked');
    }
    const scopes = parseScopes(row.scopes_json);
    if (requiredScope && !scopes.includes(requiredScope)) {
      throw new DataError('E_FORBIDDEN', 'service lacks required scope: ' + requiredScope);
    }
    db.prepare('UPDATE service_credentials SET last_used_at = ? WHERE id = ?').run(nowIso(), row.id);
    return { credential: getService(db, row.id), scopes };
  }

  function revokeService(idOrName) {
    ok(typeof idOrName === 'string' && idOrName.length > 0, 'E_ARG', 'service id or name required');
    const row =
      db.prepare('SELECT * FROM service_credentials WHERE id = ?').get(idOrName) ||
      db.prepare('SELECT * FROM service_credentials WHERE name = ?').get(idOrName);
    ok(row, 'E_NO_SERVICE', 'service credential not found');
    if (row.status === 'active') {
      db.prepare(
        'UPDATE service_credentials SET status = ?, revoked_at = ? WHERE id = ?',
      ).run('revoked', nowIso(), row.id);
    }
    return getService(db, row.id);
  }

  function listServices(options = {}) {
    const limit = Number.isSafeInteger(options.limit) ? options.limit : 100;
    const offset = Number.isSafeInteger(options.offset) ? options.offset : 0;
    return db
      .prepare('SELECT * FROM service_credentials ORDER BY created_at ASC LIMIT ? OFFSET ?')
      .all(limit, offset)
      .map((r) => {
        const { key_hash, scopes_json, ...safe } = r;
        void key_hash;
        return { ...safe, scopes: parseScopes(scopes_json) };
      });
  }

  return {
    can,
    assertRole,
    assertPermission,
    register,
    login,
    logout,
    changePassword,
    createSession,
    authenticateToken,
    revokeSession,
    revokeUserSessions,
    listSessions,
    setUserRole,
    registerService,
    authenticateService,
    revokeService,
    listServices,
  };
}

module.exports = {
  ROLES,
  SERVICE_SCOPES,
  PERMISSIONS,
  hashPassword,
  verifyPassword,
  generateToken,
  assertRole,
  assertPermission,
  can,
  buildAuth,
};