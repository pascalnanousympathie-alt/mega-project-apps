'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDataLayer } = require('../core');
const rules = require('../core/loto');

const VALID = [
  [1, 14, null, 36, null, null, 63, null, 88],
  [5, null, 21, null, 47, 58, null, 71, null],
  [null, 18, 27, 32, 41, 52, null, null, null],
];

const FULL_BALLS = [1, 14, 36, 63, 88, 5, 21, 47, 58, 71, 18, 27, 32, 41, 52];

function makeReopenableLayer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acep-loto-'));
  const layer = createDataLayer({ dataDir: dir });
  return { layer, dir };
}

function makeUser(layer, name) {
  return layer.createUser({
    username: name,
    phone: '+26134' + String(Math.floor(Math.random() * 90000000) + 10000000),
    email: name.toLowerCase() + Math.random().toString(16).slice(2) + '@example.mg',
    displayName: name.toUpperCase(),
  });
}

function fundedUser(layer, name, milli) {
  const user = makeUser(layer, name);
  const wallet = layer.createWallet(user.id);
  layer.ledger.append({
    wallet_id: wallet.id,
    idempotency_key: 'fund:' + wallet.id,
    tx_type: 'deposit',
    direction: 'credit',
    amount_milli: milli,
  });
  return { user, wallet };
}

function setupLotoRoom(layer, host, capacity = 2) {
  const game = layer.createGame({ kind: 'loto' });
  const room = layer.createRoom({ gameId: game.id, hostUserId: host.id, name: 'Loto', capacity });
  layer.joinRoom(room.id, host.id);
  layer.setRoomStatus(room.id, 'active');
  return { game, room };
}

function fakeSocket(token) {
  const handlers = {};
  const sent = [];
  const sock = {
    id: 'sock-' + Math.random().toString(16).slice(2),
    token,
    resumeToken: null,
    ip: '127.0.0.1',
    userAgent: 'loto-test',
    emit(event, payload) {
      sent.push({ event, payload });
      return sock;
    },
    on(event, handler) {
      (handlers[event] = handlers[event] || []).push(handler);
      return sock;
    },
    fire(event, payload) {
      for (const h of handlers[event] || []) h(payload);
      return sock;
    },
    disconnect() {},
    last(event) {
      const hits = sent.filter((m) => m.event === event);
      return hits.length ? hits[hits.length - 1].payload : null;
    },
  };
  return sock;
}

test('createDraw builds an online scheduled draw and enforces the loto room', (t) => {
  const { layer, dir } = makeReopenableLayer();
  t.after(() => {
    try { layer.close(); } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const u = makeUser(layer, 'draw_host');
  const { room } = setupLotoRoom(layer, u);
  const m = layer.loto.createDraw({
    mode: 'online',
    userId: u.id,
    roomId: room.id,
    settings: { entryFee: 500 },
  });
  assert.equal(m.mode, 'online');
  assert.equal(m.state.status, 'scheduled');
  assert.equal(m.state.settings.entryFee, 500);
  assert.equal(m.state.drawOrder.length, 90);
  layer.loto.verifyDraw(m.id);

  const g = layer.createGame({ kind: 'domino' });
  const badRoom = layer.createRoom({ gameId: g.id, hostUserId: u.id, name: 'X', capacity: 2 });
  assert.throws(
    () => layer.loto.createDraw({ mode: 'online', userId: u.id, roomId: badRoom.id }),
    (e) => e.code === 'E_ARG',
  );
});

test('purchaseTicket charges the wallet, grows the pool and is idempotent', (t) => {
  const { layer, dir } = makeReopenableLayer();
  t.after(() => {
    try { layer.close(); } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const { user, wallet } = fundedUser(layer, 'buyer', 10000);
  const { room } = setupLotoRoom(layer, user);
  const m = layer.loto.createDraw({ mode: 'online', userId: user.id, roomId: room.id, settings: { entryFee: 2500 } });

  const bought = layer.loto.purchaseTicket(m.id, user.id, { grid: VALID });
  assert.equal(bought.idempotent, false);
  assert.equal(bought.draw.state.pool_milli, 2500);
  assert.equal(bought.draw.state.tickets.length, 1);
  assert.equal(bought.draw.state.tickets[0].ticket_hash, rules.ticketHash(VALID));
  assert.equal(layer.getWallet(wallet.id).balance_milli, 7500);

  const replay = layer.loto.purchaseTicket(m.id, user.id, { grid: VALID });
  assert.equal(replay.idempotent, true);
  assert.equal(replay.draw.state.tickets.length, 1);
  assert.equal(layer.getWallet(wallet.id).balance_milli, 7500);
  layer.loto.verifyDraw(m.id);
});

test('purchase rejects invalid grids, no wallet and insufficient funds without side effects', (t) => {
  const { layer, dir } = makeReopenableLayer();
  t.after(() => {
    try { layer.close(); } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const poor = fundedUser(layer, 'poor', 1000);
  const { room } = setupLotoRoom(layer, poor.user);
  const m = layer.loto.createDraw({ mode: 'online', userId: poor.user.id, roomId: room.id, settings: { entryFee: 5000 } });

  const bad = VALID.map((r) => r.slice());
  bad[0][8] = null;
  assert.throws(() => layer.loto.purchaseTicket(m.id, poor.user.id, { grid: bad }), (e) => e.code === 'E_ROW_COUNT');
  assert.throws(
    () => layer.loto.purchaseTicket(m.id, poor.user.id, { grid: VALID }),
    (e) => e.code === 'E_INSUFFICIENT_FUNDS',
  );
  assert.equal(layer.loto.getDraw(m.id).state.tickets.length, 0);
  assert.equal(layer.loto.getDraw(m.id).state.pool_milli, 0);
  assert.equal(layer.getWallet(poor.wallet.id).balance_milli, 1000);

  const ghost = makeUser(layer, 'ghost');
  const m2 = layer.loto.createDraw({ mode: 'online', userId: ghost.id, roomId: room.id, settings: { entryFee: 100 } });
  assert.throws(() => layer.loto.purchaseTicket(m2.id, ghost.id, { grid: VALID }), (e) => e.code === 'E_NO_WALLET');
});

test('startDraw requires a participant and moves the draw to active', (t) => {
  const { layer, dir } = makeReopenableLayer();
  t.after(() => {
    try { layer.close(); } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const host = fundedUser(layer, 'starter', 5000);
  const other = fundedUser(layer, 'bystander', 5000);
  const { room } = setupLotoRoom(layer, host.user);
  const m = layer.loto.createDraw({ mode: 'online', userId: host.user.id, roomId: room.id, settings: { entryFee: 500 } });
  layer.loto.purchaseTicket(m.id, host.user.id, { grid: VALID });

  assert.throws(() => layer.loto.startDraw(m.id, other.user.id), (e) => e.code === 'E_NOT_IN_DRAW');
  const active = layer.loto.startDraw(m.id, host.user.id);
  assert.equal(active.state.status, 'active');
  assert.throws(() => layer.loto.startDraw(m.id, host.user.id), (e) => e.code === 'E_DRAW_ACTIVE');
});

test('a draw reaches quine then carton plein and settles prizes via the ledger', (t) => {
  const { layer, dir } = makeReopenableLayer();
  t.after(() => {
    try { layer.close(); } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const { user, wallet } = fundedUser(layer, 'winner', 10000);
  const { room } = setupLotoRoom(layer, user);
  const m = layer.loto.createDraw({
    mode: 'online',
    userId: user.id,
    roomId: room.id,
    settings: { entryFee: 1000, balls: FULL_BALLS },
  });
  layer.loto.purchaseTicket(m.id, user.id, { grid: VALID });
  layer.loto.startDraw(m.id, user.id);

  let d = layer.loto.getDraw(m.id);
  for (let i = 0; i < 5; i += 1) d = layer.loto.nextBall(d.id, user.id);
  assert.equal(d.state.status, 'active');
  const quineWin = d.state.wins.find((w) => w.category === 'quine');
  assert.ok(quineWin, 'a quine win should be recorded');
  assert.equal(quineWin.ball, 88);
  assert.equal(quineWin.ball_index, 4);

  for (let i = 5; i < FULL_BALLS.length; i += 1) d = layer.loto.nextBall(d.id, user.id);
  assert.equal(d.state.status, 'active');
  assert.ok(d.state.wins.some((w) => w.category === 'carton_plein'));

  const settled = layer.loto.settleDraw(d.id, user.id);
  const st = settled.state;
  assert.equal(st.status, 'finished');
  assert.equal(st.pool_remainder_milli, 0);
  const winner = st.winners.find((w) => w.ticketIndex === 0);
  assert.ok(winner.categories.includes('quine'));
  assert.ok(winner.categories.includes('carton_plein'));
  assert.equal(winner.prize_milli, 900);
  const balanceAfter = layer.getWallet(wallet.id).balance_milli;
  assert.equal(balanceAfter, 10000 - 1000 + 900);

  layer.ledger.verify();
  layer.loto.verifyDraw(m.id);
  const check = layer.wallet.byIdempotency(wallet.id, 'loto:prize:' + m.id + ':0:quine');
  assert.equal(check.tx_type, 'prize');
  assert.equal(check.amount_milli, 350);
});

test('verifyDraw detects tampered event rows', (t) => {
  const { layer, dir } = makeReopenableLayer();
  t.after(() => {
    try { layer.close(); } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const { user } = fundedUser(layer, 'tamper_player', 10000);
  const { room } = setupLotoRoom(layer, user);
  const m = layer.loto.createDraw({ mode: 'online', userId: user.id, roomId: room.id, settings: { entryFee: 500, balls: FULL_BALLS } });
  layer.loto.purchaseTicket(m.id, user.id, { grid: VALID });
  layer.loto.startDraw(m.id, user.id);
  let d = layer.loto.getDraw(m.id);
  for (let i = 0; i < FULL_BALLS.length; i += 1) d = layer.loto.nextBall(d.id, user.id);
  layer.loto.settleDraw(d.id, user.id);
  layer.loto.verifyDraw(m.id);

  const ballRow = layer.db
    .prepare("SELECT * FROM loto_events WHERE draw_id = ? AND event_type = 'ball' ORDER BY event_index LIMIT 1")
    .get(m.id);
  const flipped = ballRow.ball === 90 ? 1 : ballRow.ball + 1;
  layer.db
    .prepare('UPDATE loto_events SET ball = ? WHERE draw_id = ? AND event_index = ?')
    .run(flipped, m.id, ballRow.event_index);
  assert.throws(() => layer.loto.verifyDraw(m.id), (e) => e.code === 'E_TAMPER');
});

test('verifyDraw enforces the wallet handshake on prize ledger entries', (t) => {
  const { layer, dir } = makeReopenableLayer();
  t.after(() => {
    try { layer.close(); } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const { user, wallet } = fundedUser(layer, 'handshake', 10000);
  const { room } = setupLotoRoom(layer, user);
  const m = layer.loto.createDraw({ mode: 'online', userId: user.id, roomId: room.id, settings: { entryFee: 1000, balls: FULL_BALLS } });
  layer.loto.purchaseTicket(m.id, user.id, { grid: VALID });
  layer.loto.startDraw(m.id, user.id);
  let d = layer.loto.getDraw(m.id);
  for (let i = 0; i < FULL_BALLS.length; i += 1) d = layer.loto.nextBall(d.id, user.id);
  layer.loto.settleDraw(d.id, user.id);
  layer.loto.verifyDraw(m.id);

  layer.db
    .prepare("UPDATE ledger_entries SET amount_milli = amount_milli + 1 WHERE idempotency_key = 'loto:prize:" + m.id + ":0:quine'")
    .run();
  assert.throws(() => layer.loto.verifyDraw(m.id), (e) => e.code === 'E_TAMPER');

  const intact = layer.loto.getDraw(m.id);
  assert.equal(intact.state.status, 'finished');
  assert.equal(layer.getWallet(wallet.id).balance_milli, 10000 - 1000 + 900);
});

test('persistence survives reopen and verification stays green', (t) => {
  const { layer, dir } = makeReopenableLayer();
  let user;
  let m;
  {
    user = fundedUser(layer, 'persist', 10000);
    const { room } = setupLotoRoom(layer, user.user);
    m = layer.loto.createDraw({ mode: 'online', userId: user.user.id, roomId: room.id, settings: { entryFee: 1000, balls: FULL_BALLS } });
    layer.loto.purchaseTicket(m.id, user.user.id, { grid: VALID });
    layer.loto.startDraw(m.id, user.user.id);
    let d = layer.loto.getDraw(m.id);
    for (let i = 0; i < FULL_BALLS.length; i += 1) d = layer.loto.nextBall(d.id, user.user.id);
    layer.loto.settleDraw(d.id, user.user.id);
    layer.loto.verifyDraw(m.id);
    layer.close();
  }
  const reopened = createDataLayer({ dataDir: dir });
  t.after(() => {
    try { reopened.close(); } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const got = reopened.loto.getDraw(m.id);
  assert.equal(got.state.status, 'finished');
  assert.equal(got.state.pool_milli, 1000);
  assert.equal(got.state.tickets.length, 1);
  assert.deepEqual(reopened.loto.verifyDraw(m.id), {
    ok: true,
    events: reopened.loto.eventsOf(m.id).length,
    state_hash: got.state_hash,
  });
});

test('offline mode auto-buys free tickets and finishes deterministically', (t) => {
  const { layer, dir } = makeReopenableLayer();
  t.after(() => {
    try { layer.close(); } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const u = makeUser(layer, 'offline_host');
  const m = layer.loto.createDraw({
    mode: 'offline',
    userId: u.id,
    settings: { balls: [1, 14, 36, 63, 88], maxBalls: 5 },
  });
  assert.equal(m.state.tickets.length, 3);
  assert.equal(m.state.tickets[0].userId, 'bot:1');
  assert.equal(m.state.tickets[0].kind, 'bot');
  assert.equal(m.state.tickets[2].userId, u.id);
  assert.equal(m.state.pool_milli, 0);

  layer.loto.startDraw(m.id, u.id);
  let d = layer.loto.getDraw(m.id);
  let guard = 0;
  while (d.state.status === 'active' && guard < 10) {
    d = layer.loto.nextBall(d.id, u.id);
    guard += 1;
  }
  assert.equal(d.state.status, 'finished');
  assert.equal(d.state.drawn.length, 5);
  assert.equal(d.state.payouts.length, 0);
  layer.loto.verifyDraw(d.id);
});

test('cancel rules are strict and only apply to empty scheduled draws', (t) => {
  const { layer, dir } = makeReopenableLayer();
  t.after(() => {
    try { layer.close(); } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const host = fundedUser(layer, 'canceller', 5000);
  const intruder = fundedUser(layer, 'intruder', 5000);
  const { room } = setupLotoRoom(layer, host.user);
  const m = layer.loto.createDraw({ mode: 'online', userId: host.user.id, roomId: room.id, settings: { entryFee: 500 } });
  layer.loto.purchaseTicket(m.id, host.user.id, { grid: VALID });
  assert.throws(() => layer.loto.cancelDraw(m.id, intruder.user.id), (e) => e.code === 'E_HAS_TICKETS' || e.code === 'E_FORBIDDEN');

  const m2 = layer.loto.createDraw({ mode: 'sim', userId: host.user.id });
  assert.throws(() => layer.loto.cancelDraw(m2.id, intruder.user.id), (e) => e.code === 'E_FORBIDDEN');
  const cancelled = layer.loto.cancelDraw(m2.id, host.user.id);
  assert.equal(cancelled.state.status, 'cancelled');
  layer.loto.verifyDraw(m2.id);
  assert.throws(() => layer.loto.cancelDraw(m2.id, host.user.id), (e) => e.code === 'E_DRAW_CLOSED');
});

test('online rooms drive draws through the real gateway broadcast', (t) => {
  const { layer, dir } = makeReopenableLayer();
  t.after(() => {
    try { layer.close(); } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const host = layer.auth.register({ username: 'loto_host_' + Math.random().toString(16).slice(2), password: 'S3cretpass!', role: 'player' });
  const guest = layer.auth.register({ username: 'loto_guest_' + Math.random().toString(16).slice(2), password: 'S3cretpass!', role: 'player' });
  const hostWallet = layer.createWallet(host.id);
  const guestWallet = layer.createWallet(guest.id);
  layer.ledger.append({ wallet_id: hostWallet.id, idempotency_key: 'gw-h', tx_type: 'deposit', direction: 'credit', amount_milli: 5000 });
  layer.ledger.append({ wallet_id: guestWallet.id, idempotency_key: 'gw-g', tx_type: 'deposit', direction: 'credit', amount_milli: 5000 });

  const game = layer.createGame({ kind: 'loto' });
  const room = layer.createRoom({ gameId: game.id, hostUserId: host.id, name: 'LotoGW', capacity: 2 });
  const hs = layer.auth.createSession(host.id);
  const gs = layer.auth.createSession(guest.id);
  const hostSock = fakeSocket(hs.token);
  const guestSock = fakeSocket(gs.token);
  layer.gateway.handleConnection(hostSock);
  layer.gateway.handleConnection(guestSock);
  hostSock.fire('room:join', { roomId: room.id });
  guestSock.fire('room:join', { roomId: room.id });

  hostSock.fire('game:event', { action: 'status', settings: { entryFee: 500, balls: [1, 14], maxBalls: 2 } });
  hostSock.fire('game:event', { action: 'buy', grid: VALID });
  assert.ok(guestSock.last('loto:state'));
  guestSock.fire('game:event', { action: 'buy' });
  hostSock.fire('game:event', { action: 'start' });
  hostSock.fire('game:event', { action: 'ball' });
  const afterFirst = guestSock.last('loto:ball');
  assert.ok(afterFirst);
  assert.equal(afterFirst.balls_drawn, 1);
  hostSock.fire('game:event', { action: 'ball' });
  const finished = guestSock.last('loto:finished');
  assert.ok(finished, 'draw should finish after the configured max balls');
  assert.equal(finished.status, 'finished');

  const matchRoom = layer.loto.drawForRoom(room.id);
  assert.equal(matchRoom.mode, 'online');
  assert.equal(matchRoom.state.status, 'finished');
  layer.loto.verifyDraw(matchRoom.id);
});