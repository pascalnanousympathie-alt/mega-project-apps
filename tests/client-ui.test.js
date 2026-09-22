'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const format = require('../client/js/format.js');
const store = require('../client/js/store.js');
const router = require('../client/js/router.js');
const api = require('../client/js/api.js');
const views = require('../client/js/views.js');

const { createDataLayer } = require('../core');
const { buildApiHandlers } = require('../server/api');
const { createHttpServer } = require('../server/http');

const CLIENT_DIR = path.join(__dirname, '..', 'client');

test('router parses hashes, query strings and room params', () => {
  assert.deepEqual(router.parseHash('#/lobby'), { name: 'lobby', params: {}, query: {} });
  assert.equal(router.parseHash('').name, 'home');
  assert.equal(router.parseHash('#/').name, 'home');
  const room = router.parseHash('#/room/r%2D42?x=1');
  assert.equal(room.name, 'room');
  assert.equal(room.params.roomId, 'r-42');
  assert.equal(room.query.x, '1');
  assert.equal(router.parseHash('#/nope').name, 'not_found');
});

test('router gates auth and redirects login when authed', () => {
  const guest = router.resolveRoute('#/wallet', false);
  assert.equal(guest.name, 'login');
  assert.equal(guest.redirect.name, 'wallet');
  assert.equal(router.resolveRoute('#/login', true).name, 'home');
  assert.equal(router.resolveRoute('#/profile', true).name, 'profile');
  assert.equal(router.linkFor('room', { roomId: 'a b' }), '#/room/a%20b');
});

test('session store round-trips, sanitises and survives corrupt data', () => {
  const backend = store.memoryStorage();
  const s = store.createSessionStore(backend);
  assert.equal(s.load(), null);
  const saved = s.save({ token: 't0ken', expires_at: 'later', user: { id: 'u1' }, extra: 'dropped' });
  assert.deepEqual(saved, { token: 't0ken', expires_at: 'later', user: { id: 'u1' } });
  assert.equal(s.load().token, 't0ken');
  assert.equal(s.save({ notoken: true }), null);
  backend.setItem(store.SESSION_KEY, '{not json');
  assert.equal(s.load(), null);
  s.clear();
  assert.equal(s.load(), null);
});

test('format escapes html, groups money and parses inputs', () => {
  assert.equal(format.escapeHtml('<img src=x onerror="1">'), '&lt;img src=x onerror=&quot;1&quot;&gt;');
  assert.equal(format.escapeHtml(null), '');
  assert.equal(format.formatMilli(1234567), '1\u202f234\u202f567 Ar');
  assert.equal(format.formatMilli(-500), '\u2212500 Ar');
  assert.equal(format.formatMilli(500, { sign: 'force' }), '+500 Ar');
  assert.equal(format.parseMilliInput(' 1 234 Ar '), 1234);
  assert.equal(format.parseMilliInput('abc'), null);
  assert.equal(format.formatDateTime(new Date(2026, 8, 21, 10, 5)), '2026-09-21 10:05');
});

test('views render every P15 screen with escaped content', () => {
  const xss = '<script>alert(1)</script>';
  const login = views.renderLogin({ error: xss });
  assert.ok(login.includes('data-screen="login"'));
  assert.ok(!login.includes('<script>'));
  assert.ok(login.includes('&lt;script&gt;'));

  const home = views.renderHome({ user: { username: xss }, wallet: { balance_milli: 2500 }, games: [{ id: 'g1', kind: 'domino', name: 'D1', entry_fee_milli: 500 }] });
  assert.ok(home.includes('data-screen="home"'));
  assert.ok(home.includes('2\u202f500 Ar'));
  assert.ok(home.includes('#/lobby?game=g1'));
  assert.ok(!home.includes('<script>alert'));

  const lobby = views.renderLobby({ rooms: [{ id: 'r1', name: xss, players: 2, capacity: 2, status: 'waiting' }, { id: 'r2', name: 'open', players: 0, capacity: 4, status: 'waiting' }] });
  assert.ok(lobby.includes('Complète'));
  assert.ok(lobby.includes('data-room-id="r2"'));
  assert.ok(!lobby.includes('<script>alert'));

  const wallet = views.renderWallet({
    wallet: { currency: 'MGA', balance_milli: 1000 },
    entries: [{ id: 'e1', created_at: '2026-09-21T10:00:00Z', tx_type: 'deposit', direction: 'credit', amount_milli: 1000 }],
  });
  assert.ok(wallet.includes('data-screen="wallet"'));
  assert.ok(wallet.includes('+1\u202f000 Ar'));
  assert.ok(views.renderWallet({}).includes('data-testid="no-wallet"'));

  const profile = views.renderProfile({ me: { user: { username: 'ana', role: 'player' }, wallet: { balance_milli: 0 } } });
  assert.ok(profile.includes('data-testid="username"'));
  assert.ok(profile.includes('data-action="logout"'));
  assert.ok(views.renderNotFound().includes('data-screen="not_found"'));
});

test('waiting room actions follow host, readiness and player count', () => {
  const snap = {
    room: { id: 'r1', name: 'T', status: 'waiting', capacity: 2, host_user_id: 'u1' },
    players: [
      { user_id: 'u1', seat: 1, ready: true, presence: 'online' },
      { user_id: 'u2', seat: 2, ready: false, presence: 'online' },
    ],
  };
  const host = views.waitingActions(snap, 'u1');
  assert.equal(host.start, false);
  assert.equal(host.ready, false);
  assert.equal(host.unready, true);
  assert.equal(host.close, true);
  snap.players[1].ready = true;
  assert.equal(views.waitingActions(snap, 'u1').start, true);
  const guest = views.waitingActions(snap, 'u2');
  assert.equal(guest.start, false);
  assert.equal(guest.close, false);
  assert.equal(views.waitingActions(snap, 'u9').leave, false);
  const html = views.renderWaiting({ snapshot: snap, userId: 'u1' });
  assert.ok(html.includes('data-screen="waiting"'));
  assert.ok(html.includes('data-action="start-game"'));
});

test('domino game screen renders board state object and legal plays', () => {
  const snapshot = {
    match_id: 'm1',
    status: 'active',
    current_user_id: 'u1',
    boneyard_count: 3,
    board: { center: { a: 6, b: 6 }, left: [{ a: 5, b: 6 }], right: [] },
    hands: { u1: [{ a: 5, b: 2 }, { a: 6, b: 1 }], u2: [] },
    players: [{ user_id: 'u1', seat: 1 }, { user_id: 'u2', seat: 2 }],
  };
  const actions = views.gameActions(snapshot, 'u1');
  assert.equal(actions.play.length, 2);
  assert.deepEqual(actions.play[0].sides, ['left']);
  assert.deepEqual(actions.play[1].sides, ['right']);
  assert.equal(actions.draw, true);
  assert.equal(actions.pass, false);
  const html = views.renderGame({ snapshot, userId: 'u1', kind: 'domino' });
  assert.ok(html.includes('data-kind="domino"'));
  assert.ok(html.includes('6|1'));
  assert.ok(html.includes('5|6'));
  assert.ok(html.includes('data-action="draw-tile"'));
});

test('rami and loto game screens expose phase-correct controls', () => {
  const rami = views.renderGame({
    snapshot: {
      match_id: 'm2', status: 'active', turn_phase: 'discard', current_user_id: 'u1',
      stock_count: 20, last_discard: { key: 'H-7' }, own_hand: ['H-7', 'S-12', 'JK-0'],
    },
    userId: 'u1',
    kind: 'rami',
  });
  assert.ok(rami.includes('data-action="discard"'));
  assert.ok(rami.includes('data-action="meld"'));
  assert.ok(!rami.includes('data-action="draw-stock"'));

  const loto = views.renderGame({
    snapshot: { draw_id: 'd1', status: 'active', user_id: 'u1', cagnotte_milli: 90000, balls_drawn: 4, balls_total: 90, drawn: [7, 12, 33, 90], own_grid: [[1, 0, 5]] },
    userId: 'u1',
    kind: 'loto',
  });
  assert.ok(loto.includes('data-testid="drawn"'));
  assert.ok(loto.includes('data-action="next-ball"'));
  assert.ok(loto.includes('data-action="settle-draw"'));
});

test('api client wraps fetch with auth, idempotency and typed errors', async () => {
  const calls = [];
  const fakeFetch = (url, init) => {
    calls.push({ url, init });
    if (init.method === 'POST' && url.endsWith('/auth/login')) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ data: { token: 'abc' } }) });
    }
    if (url.endsWith('/users/me')) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ data: { user: { id: 'u1' } } }) });
    }
    if (url.endsWith('/wallets')) {
      return Promise.resolve({ ok: true, status: 201, json: () => Promise.resolve({ data: { wallet: { id: 'w1' } } }) });
    }
    return Promise.resolve({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ meta: { request_id: 'rq1' }, error: { code: 'E_VALIDATION', message: 'bad' } }),
    });
  };
  let token = null;
  const client = api.createApiClient({ fetch: fakeFetch, getToken: () => token });

  const login = await client.login('ana', 'Secret123');
  assert.deepEqual(login, { token: 'abc' });
  assert.equal(calls[0].url, '/api/v1/auth/login');
  assert.equal(JSON.parse(calls[0].init.body).identity, 'ana');

  token = 'abc';
  assert.deepEqual(await client.me(), { user: { id: 'u1' } });
  assert.equal(calls[1].init.headers.authorization, 'Bearer abc');

  await client.createWallet('MGA');
  assert.match(calls[2].init.headers['idempotency-key'], /^ui-/);

  await assert.rejects(client.listRooms('bogus'), (err) => {
    assert.equal(err.name, 'ApiError');
    assert.equal(err.status, 400);
    assert.equal(err.code, 'E_VALIDATION');
    assert.equal(err.requestId, 'rq1');
    return true;
  });

  const broken = api.createApiClient({ fetch: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.reject(new Error('nope')) }) });
  await assert.rejects(broken.health(), (err) => err.code === 'E_NETWORK');
  const dead = api.createApiClient({ fetch: () => Promise.reject(new Error('down')) });
  await assert.rejects(dead.health(), (err) => err.code === 'E_NETWORK');
});

async function startServer(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acep-p15-'));
  const layer = createDataLayer({ dataDir: dir });
  const server = createHttpServer({ layer, api: buildApiHandlers(layer), clientDir: CLIENT_DIR });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    try {
      layer.close();
    } catch (_) {
      // already closed
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { layer, base };
}

test('server serves the client shell, assets and security headers', async (t) => {
  const { base } = await startServer(t);
  const shell = await fetch(base + '/');
  assert.equal(shell.status, 200);
  assert.match(shell.headers.get('content-type'), /text\/html/);
  assert.match(shell.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(shell.headers.get('x-content-type-options'), 'nosniff');
  const html = await shell.text();
  assert.ok(html.includes('id="app"'));
  assert.ok(html.includes('./js/app.js'));

  const script = await fetch(base + '/js/views.js');
  assert.equal(script.status, 200);
  assert.match(script.headers.get('content-type'), /javascript/);

  const missing = await fetch(base + '/no-such-page');
  assert.equal(missing.status, 404);

  const traversal = await fetch(base + '/%2e%2e%2fpackage.json');
  assert.ok(traversal.status === 403 || traversal.status === 404);
});

test('client api module drives register→login→me→wallet flows against the real server', async (t) => {
  const { base } = await startServer(t);
  let token = null;
  const client = api.createApiClient({ baseUrl: base + '/api/v1', getToken: () => token });

  const reg = await client.register({ username: 'p15_user', password: 'Str0ng!Pass', phone: '+261340001515', email: 'p15@example.mg' });
  assert.equal(reg.user.username, 'p15_user');
  assert.equal(reg.user.password_hash, undefined);

  await assert.rejects(client.login('p15_user', 'wrong-password'), (err) => err.code === 'E_BAD_CREDENTIALS' && err.status === 401);

  const sess = await client.login('p15_user', 'Str0ng!Pass');
  token = sess.token;
  assert.ok(sess.expires_at);

  const me = await client.me();
  assert.equal(me.user.username, 'p15_user');
  assert.equal(me.wallet, null);
  assert.ok(Array.isArray(me.games));

  const created = await client.createWallet('MGA');
  assert.equal(created.wallet.currency, 'MGA');
  const detail = await client.wallet(created.wallet.id);
  assert.equal(detail.balances.available_milli, 0);
  assert.equal(detail.integrity_ok, true);
  const entries = await client.walletEntries(created.wallet.id, 5);
  assert.deepEqual(entries, []);
  assert.deepEqual(await client.listRooms(), []);

  const rooms = await client.listRooms();
  assert.ok(Array.isArray(rooms));

  const out = await client.logout();
  assert.equal(out.logged_out, true);
  await assert.rejects(client.me(), (err) => err.status === 401);
});
