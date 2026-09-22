'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { makeDataLayer, expectDataError } = require('./helpers');
const {
  hashPassword,
  verifyPassword,
  PERMISSIONS,
  ROLES,
  SERVICE_SCOPES,
} = require('../core/auth');

const PW = 'S3cretpass!';

test('hashes passwords with a unique salt and verifies them', () => {
  const h1 = hashPassword(PW);
  const h2 = hashPassword(PW);
  assert.notEqual(h1, h2);
  assert.ok(h1.startsWith('scrypt$'));
  assert.equal(h1.includes(PW), false);
  assert.equal(verifyPassword(PW, h1), true);
  assert.equal(verifyPassword('wrong-pass', h1), false);
  assert.equal(verifyPassword(PW, 'not-a-hash'), false);
});

test('rejects too-short passwords', () => {
  expectDataError(() => hashPassword('short'), 'E_ARG');
});

test('registers a user and never stores the plaintext password', (t) => {
  const { layer } = makeDataLayer(t);
  const user = layer.auth.register({
    username: 'reg_user',
    phone: '+261340000911',
    email: 'reg@example.mg',
    password: PW,
  });
  assert.ok(user.id);
  assert.equal(user.password_hash, undefined);
  const stored = layer.getById(user.id);
  assert.ok(stored.password_hash.startsWith('scrypt$'));
  assert.equal(stored.password_hash.includes(PW), false);
  const audit = layer.listAudit({ targetType: 'user', targetId: user.id });
  assert.ok(audit.some((e) => e.action === 'user.register'));
});

test('logs in by username, phone or email and issues a session token', (t) => {
  const { layer } = makeDataLayer(t);
  layer.auth.register({ username: 'log_me', phone: '+261340000988', email: 'log@example.mg', password: PW });
  for (const identity of ['log_me', '+261340000988', 'log@example.mg']) {
    const res = layer.auth.login(identity, PW, { ip: '192.0.2.10' });
    assert.ok(res.token.length >= 32);
    assert.ok(res.session.id);
    assert.equal(res.user.username, 'log_me');
    assert.equal(res.user.password_hash, undefined);
    const check = layer.auth.authenticateToken(res.token);
    assert.equal(check.user.id, res.user.id);
  }
});

test('rejects a wrong password and does not create a session', (t) => {
  const { layer } = makeDataLayer(t);
  layer.auth.register({ username: 'bad_pw', password: PW });
  expectDataError(() => layer.auth.login('bad_pw', 'wrong-password'), 'E_BAD_CREDENTIALS');
  assert.equal(layer.auth.listSessions(layer.findByUsername('bad_pw').id).length, 0);
  const audit = layer.listAudit({ actorType: 'user' });
  assert.ok(audit.some((e) => e.action === 'auth.login.failed'));
});

test('blocks login for inactive users', (t) => {
  const { layer } = makeDataLayer(t);
  const user = layer.auth.register({ username: 'blocked_pw', password: PW });
  layer.setUserStatus(user.id, 'blocked');
  expectDataError(() => layer.auth.login('blocked_pw', PW), 'E_USER_INACTIVE');
});

test('session tokens are not stored in plaintext and can be revoked', (t) => {
  const { layer } = makeDataLayer(t);
  const user = layer.auth.register({ username: 'sess_user', password: PW });
  const { token, session } = layer.auth.createSession(user.id);
  const stored = layer.db.prepare('SELECT token_hash FROM auth_sessions WHERE id = ?').get(session.id);
  assert.equal(stored.token_hash.includes(token), false);
  assert.notEqual(stored.token_hash, token);
  layer.auth.revokeSession(token);
  expectDataError(() => layer.auth.authenticateToken(token), 'E_SESSION_REVOKED');
});

test('expires sessions after the configured ttl', (t) => {
  const { layer } = makeDataLayer(t);
  const user = layer.auth.register({ username: 'ttl_user', password: PW });
  const base = new Date('2026-01-01T00:00:00.000Z');
  const { token } = layer.auth.createSession(user.id, { now: base, ttlMs: 60000 });
  const ok = layer.auth.authenticateToken(token, { now: new Date(base.getTime() + 59999) });
  assert.equal(ok.user.id, user.id);
  expectDataError(
    () => layer.auth.authenticateToken(token, { now: new Date(base.getTime() + 60000) }),
    'E_SESSION_EXPIRED',
  );
});

test('logout revokes the session via the auth service', (t) => {
  const { layer } = makeDataLayer(t);
  const user = layer.auth.register({ username: 'logout_user', password: PW });
  const { token, session } = layer.auth.createSession(user.id);
  layer.auth.logout(user.id, token);
  assert.ok(session.id);
  expectDataError(() => layer.auth.authenticateToken(token), 'E_SESSION_REVOKED');
  const audit = layer.listAudit({ targetType: 'user', targetId: user.id });
  assert.ok(audit.some((e) => e.action === 'auth.logout'));
});

test('changing the password revokes all existing sessions', (t) => {
  const { layer } = makeDataLayer(t);
  const user = layer.auth.register({ username: 'pw_user', password: PW });
  const { token } = layer.auth.createSession(user.id);
  expectDataError(() => layer.auth.changePassword(user.id, 'NewP@ss123', { currentPassword: 'wrong' }), 'E_BAD_CREDENTIALS');
  layer.auth.changePassword(user.id, 'NewP@ss123', { currentPassword: PW });
  expectDataError(() => layer.auth.authenticateToken(token), 'E_SESSION_REVOKED');
  const relogin = layer.auth.login('pw_user', 'NewP@ss123');
  assert.ok(relogin.token);
});

test('enforces role permissions via assertPermission and requireRoles', (t) => {
  const { layer } = makeDataLayer(t);
  const player = layer.auth.register({ username: 'perm_player', password: PW, role: 'player' });
  const admin = layer.auth.register({ username: 'perm_admin', password: PW, role: 'admin' });
  assert.ok(player.id && admin.id);
  const p1 = layer.getById(player.id);
  const a1 = layer.getById(admin.id);
  assert.equal(layer.auth.can(p1, 'wallet:viewOwn'), true);
  assert.equal(layer.auth.can(p1, 'user:manage'), false);
  expectDataError(() => layer.auth.assertPermission(p1, 'user:manage'), 'E_FORBIDDEN');
  expectDataError(() => layer.auth.assertRole(p1, 'admin'), 'E_FORBIDDEN');
  expectDataError(() => layer.auth.assertPermission(null, 'wallet:viewOwn'), 'E_UNAUTHORIZED');
  layer.auth.assertPermission(a1, 'user:manage');
  layer.auth.assertRole(a1, 'admin');
  assert.ok(Object.keys(PERMISSIONS).length >= 6);
});

test('promotes roles and prevents demoting the last active admin', (t) => {
  const { layer } = makeDataLayer(t);
  const first = layer.auth.register({ username: 'admin_one', password: PW, role: 'admin' });
  expectDataError(() => layer.auth.setUserRole(first.id, 'player'), 'E_LAST_ADMIN');
  const second = layer.auth.register({ username: 'admin_two', password: PW, role: 'admin' });
  const demoted = layer.auth.setUserRole(first.id, 'support');
  assert.equal(demoted.role, 'support');
  expectDataError(() => layer.auth.setUserRole(first.id, 'ghost'), 'E_ARG');
});

test('registers service credentials and authenticates by key and scope', (t) => {
  const { layer } = makeDataLayer(t);
  const created = layer.auth.registerService({
    name: 'domino.service',
    scopes: ['wallet:read', 'games:write'],
  });
  const { credential, key } = created;
  assert.ok(credential.id);
  assert.ok(key.length >= 32);
  assert.notEqual(credential.key_hash, key);
  assert.deepEqual(credential.scopes, ['wallet:read', 'games:write']);
  const authed = layer.auth.authenticateService(key, 'wallet:read');
  assert.equal(authed.credential.id, credential.id);
  expectDataError(() => layer.auth.authenticateService(key, 'no_such_scope'), 'E_FORBIDDEN');
});

test('rejects unknown, unscoped and revoked service credentials', (t) => {
  const { layer } = makeDataLayer(t);
  const { key } = layer.auth.registerService({ name: 'gateway.svc', scopes: ['wallet:write'] });
  expectDataError(() => layer.auth.authenticateService('deadbeefdeadbeef', 'wallet:write'), 'E_INVALID_SERVICE_KEY');
  expectDataError(() => layer.auth.authenticateService(key, 'ledger:read'), 'E_FORBIDDEN');
  layer.auth.revokeService('gateway.svc');
  expectDataError(() => layer.auth.authenticateService(key, 'wallet:write'), 'E_SERVICE_REVOKED');
});

test('rejects duplicate service names and unknown scopes', (t) => {
  const { layer } = makeDataLayer(t);
  layer.auth.registerService({ name: 'dup.svc', scopes: ['wallet:read'] });
  expectDataError(() => layer.auth.registerService({ name: 'dup.svc', scopes: ['wallet:read'] }), 'E_DUPLICATE');
  expectDataError(() => layer.auth.registerService({ name: 'bad.svc', scopes: ['nope'] }), 'E_ARG');
  expectDataError(() => layer.auth.registerService({ name: 'ab', scopes: ['wallet:read'] }), 'E_ARG');
});

test('service scope constants and roles are exported for policy review', () => {
  assert.ok(ROLES.includes('player'));
  assert.ok(ROLES.includes('admin'));
  assert.ok(SERVICE_SCOPES.includes('wallet:write'));
  assert.ok(SERVICE_SCOPES.includes('payments:reconcile'));
});