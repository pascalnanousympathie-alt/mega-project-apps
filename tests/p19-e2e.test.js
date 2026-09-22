'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDataLayer } = require('../core');
const { createApp } = require('../server/boot');

const PW = 'Str0ng!Pass';
const CALLBACK_SECRET = 'callback-secret-value';
const CREDENTIALS = { mvola: {
  consumerKey: 'test-consumer-key',
  consumerSecret: 'test-consumer-secret',
  merchantNumber: '0340000000',
  partnerName: 'ACEP',
  callbackSecret: CALLBACK_SECRET,
  baseUrl: 'https://mvola.test',
} };

function makeTransport() {
  const calls = [];
  const transport = async (spec) => {
    calls.push(spec);
    if (/\/token$/.test(spec.url)) {
      return { status: 200, ok: true, headers: {}, data: { access_token: 'test-access-token', expires_in: 3600 } };
    }
    if (spec.url.includes('merchantpay')) {
      if (spec.method === 'GET') {
        return { status: 200, ok: true, headers: {}, data: {
          transactionStatus: 'success',
          serverCorrelationId: spec.headers && spec.headers['x-correlation-id'],
        } };
      }
      return { status: 200, ok: true, headers: {}, data: {
        status: 'pending', serverCorrelationId: 'p19-mvola-ref-1',
      } };
    }
    return { status: 404, ok: false, headers: {}, data: {} };
  };
  transport.calls = calls;
  return transport;
}

async function call(base, method, pathname, opts = {}) {
  const headers = { accept: 'application/json', ...(opts.headers || {}) };
  if (opts.token) headers.authorization = 'Bearer ' + opts.token;
  if (opts.serviceKey) headers['x-service-key'] = opts.serviceKey;
  if (opts.idempotency) headers['idempotency-key'] = opts.idempotency;
  let body;
  if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  const res = await fetch(base + pathname, { method, headers, body });
  const text = await res.text();
  const json = JSON.parse(text);
  return { status: res.status, json, data: json.data ?? null, error: json.error ?? null, meta: json.meta ?? null };
}
function createWsClient(url, t) {
  const ws = new WebSocket(url);
  const queue = [];
  const waiters = [];
  let failure = null;
  const settle = () => {
    for (let i = 0; i < waiters.length; i += 1) {
      const waiter = waiters[i];
      const index = queue.findIndex(waiter.match);
      if (index >= 0) {
        const packet = queue.splice(index, 1)[0];
        waiters.splice(i, 1); i -= 1; clearTimeout(waiter.timer); waiter.resolve(packet);
      } else if (failure) {
        waiters.splice(i, 1); i -= 1; clearTimeout(waiter.timer); waiter.reject(failure);
      }
    }
  };
  function decode(frame) {
    for (const part of String(frame).split('\u001e')) {
      if (!part) continue;
      if (part[0] === '0') {
        queue.push({ kind: 'open', data: JSON.parse(part.slice(1)) });
        continue;
      }
      if (part[0] !== '4') continue;
      const body = part.slice(1); const type = body[0]; const rest = body.slice(1);
      const start = rest.search(/[[{]/); const payload = start >= 0 ? rest.slice(start) : '';
      if (type === '0') queue.push({ kind: 'connect', data: payload ? JSON.parse(payload) : null });
      else if (type === '2') {
        const [event, data] = JSON.parse(payload); queue.push({ kind: 'event', event, data });
      } else if (type === '4') queue.push({ kind: 'connect_error', data: payload ? JSON.parse(payload) : null });
    }
    settle();
  }
  ws.addEventListener('message', (event) => decode(event.data));
  ws.addEventListener('error', () => { failure = new Error('websocket error'); settle(); });
  ws.addEventListener('close', () => { failure = new Error('websocket closed'); settle(); });
  const waitFor = (match, ms = 5000) => new Promise((resolve, reject) => {
    const waiter = { match, resolve, reject, timer: setTimeout(() => reject(new Error('timeout')), ms) };
    waiters.push(waiter); settle();
  });
  t.after(() => { try { ws.close(); } catch (_) {} });
  return {
    open: () => waitFor((p) => p.kind === 'open'),
    handshake: (auth) => { ws.send('40' + JSON.stringify(auth)); return waitFor((p) => p.kind === 'connect' || p.kind === 'connect_error'); },
    emit: (event, data) => ws.send('42' + JSON.stringify([event, data])),
    event: (name) => waitFor((p) => p.kind === 'event' && p.event === name),
  };
}

test('P19 full journey: auth → lobby → game → wallet → payment → reconciliation', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acep-p19-e2e-'));
  const transport = makeTransport();
  const layer = createDataLayer({
    dataDir: dir,
    payments: { credentials: CREDENTIALS, env: {}, transport, callbackUrl: 'https://acep.test/payments/callback' },
  });
  const gameEvents = [];
  const app = createApp({
    layer,
    sweepIntervalMs: 0,
    gateway: {
      sweepIntervalMs: 0,
      onGameEvent(roomId, userId, payload) {
        gameEvents.push({ roomId, userId, payload });
        return { event: 'table:move', payload: { by: userId, move: payload.move } };
      },
    },
  });
  const address = await app.listen(0, '127.0.0.1');
  const base = 'http://127.0.0.1:' + address.port + '/api/v1';
  const wsUrl = 'ws://127.0.0.1:' + address.port + '/socket.io/?EIO=4&transport=websocket';
  t.after(async () => {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const game = layer.createGame({
    kind: 'domino',
    config: { name: 'P19 Domino', settings: { entryFee: 5000, commission: 0.1 } },
  });
  const ops = layer.auth.registerService({ name: 'p19-ops', scopes: ['payments:reconcile', 'ledger:read'] });

  const registered = await call(base, 'POST', '/auth/register', {
    body: { username: 'p19_e2e', password: PW, phone: '+261340000019', email: 'p19@example.mg' },
  });
  assert.equal(registered.status, 200, JSON.stringify(registered.json));

  const login = await call(base, 'POST', '/auth/login', {
    body: { identity: 'p19_e2e', password: PW },
  });
  assert.equal(login.status, 200, JSON.stringify(login.json));
  const token = login.data.token;
  const userId = login.data.user.id;

  const me = await call(base, 'GET', '/users/me', { token });
  assert.equal(me.status, 200);
  assert.equal(me.data.user.id, userId);
  assert.equal(me.data.games.some((x) => x.id === game.id), true, 'game is visible in lobby catalog');

  const wallet = await call(base, 'POST', '/wallets', {
    token, idempotency: 'p19-wallet-1', body: {},
  });
  assert.equal(wallet.status, 200, JSON.stringify(wallet.json));
  const walletId = wallet.data.wallet.id;

  const room = await call(base, 'POST', '/rooms', {
    token, idempotency: 'p19-room-1',
    body: { game_id: game.id, name: 'P19 Live Table', capacity: 2 },
  });
  assert.equal(room.status, 200, JSON.stringify(room.json));
  const roomId = room.data.room.id;

  const listed = await call(base, 'GET', '/rooms', { token });
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.data.map((x) => x.id), [roomId]);
  const ws = createWsClient(wsUrl, t);
  await ws.open();
  const handshake = await ws.handshake({ token, resumeToken: null });
  assert.equal(handshake.kind, 'connect');

  const connected = await ws.event('connected');
  assert.equal(connected.data.user_id, userId);
  assert.equal(connected.data.resumed, false);

  ws.emit('room:join', { roomId });
  const joined = await ws.event('room:joined');
  assert.equal(joined.data.room.id, roomId);
  assert.equal(joined.data.players.length, 1);
  assert.equal(joined.data.players[0].user_id, userId);
  await ws.event('room:state');

  ws.emit('room:ready', { ready: true });
  const ready = await ws.event('room:state');
  assert.equal(ready.data.players[0].ready, true);
  assert.equal(ready.data.state.ready[userId], true);

  ws.emit('room:start', {});
  const started = await ws.event('room:started');
  assert.equal(started.data.state.status, 'active');

  ws.emit('game:event', { move: { tile: '6|6', side: 'left' } });
  const move = await ws.event('table:move');
  assert.equal(move.data.by, userId);
  assert.deepEqual(move.data.move, { tile: '6|6', side: 'left' });
  assert.equal(gameEvents.length, 1);

  const intent = await call(base, 'POST', '/payments/intents', {
    token, idempotency: 'p19-payment-1',
    body: { provider: 'mvola', amount_milli: 25000, currency: 'MGA', customer: { msisdn: '0340123019' } },
  });
  assert.equal(intent.status, 200, JSON.stringify(intent.json));
  assert.equal(intent.data.intent.status, 'pending');
  assert.equal(intent.data.intent.wallet_id, walletId);

  const reconciled = await call(base, 'POST', '/payments/intents/' + intent.data.intent.id + '/reconcile', {
    serviceKey: ops.key,
    idempotency: 'p19-reconcile-1',
    body: {},
  });
  assert.equal(reconciled.status, 200, JSON.stringify(reconciled.json));
  assert.equal(reconciled.data.outcome, 'updated');
  assert.equal(reconciled.data.changed, true);
  assert.equal(reconciled.data.intent.status, 'succeeded');

  const walletAfter = await call(base, 'GET', '/wallets/' + walletId, { token });
  assert.equal(walletAfter.status, 200);
  assert.equal(walletAfter.data.balances.committed_milli, 25000);
  assert.equal(walletAfter.data.balances.available_milli, 25000);

  const reconList = await call(base, 'GET', '/payments/intents/' + intent.data.intent.id + '/reconciliations', {
    serviceKey: ops.key,
  });
  assert.equal(reconList.status, 200);
  assert.equal(reconList.data.length, 1);

  const ledger = await call(base, 'GET', '/ledger/entries?wallet_id=' + walletId, {
    serviceKey: ops.key,
  });
  assert.equal(ledger.status, 200);
  assert.ok(ledger.data.some((entry) => entry.amount_milli === 25000));

  ws.emit('room:close', {});
  const closed = await ws.event('room:closed');
  assert.equal(closed.data.room_id, roomId);
  assert.equal(layer.getRoom(roomId).status, 'closed');
});