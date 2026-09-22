'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDataLayer } = require('../core');
const rules = require('../core/domino');

function makeReopenableLayer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acep-domino-'));
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

function userActor(layer) {
  const u = makeUser(layer, 'user_' + Math.random().toString(16).slice(2, 10));
  return u;
}

function runOffline(layer, matchId, userId) {
  let match = layer.domino.startMatch(matchId, { byUserId: userId });
  let guard = 0;
  while (match.state.status === 'active' && guard < 300) {
    guard += 1;
    assert.equal(match.state.currentUserId, userId, 'bot turns should be automated');
    const hand = match.state.hands[userId] || [];
    const moves = rules.playsFor(hand, match.state.board);
    if (moves.length) {
      match = layer.domino.applyAction(match.id, userId, { type: 'play', tile: moves[0].tile, side: moves[0].side });
    } else if (rules.canDraw(match.state.boneyard)) {
      match = layer.domino.applyAction(match.id, userId, { type: 'draw' });
    } else {
      match = layer.domino.applyAction(match.id, userId, { type: 'pass' });
    }
  }
  assert.ok(match.state.status === 'finished', 'game should terminate');
  return match;
}

function setupOnlineRoom(layer, host, guest) {
  const game = layer.createGame({ kind: 'domino', config: { tiles: 28 } });
  const room = layer.createRoom({ gameId: game.id, hostUserId: host.id, name: 'Dom', capacity: 2 });
  layer.joinRoom(room.id, host.id);
  layer.joinRoom(room.id, guest.id);
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
    userAgent: 'domino-test',
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

test('createMatch builds an offline match with human and bots', (t) => {
  const { layer, dir } = makeReopenableLayer();
  t.after(() => {
    try { layer.close(); } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const u = userActor(layer);
  const m = layer.domino.createMatch({ mode: 'offline', userId: u.id, settings: { botCount: 2 } });
  assert.equal(m.mode, 'offline');
  assert.equal(m.state.status, 'scheduled');
  assert.equal(m.state.players.length, 3);
  assert.equal(m.state.players[0].userId, 'bot:1');
  assert.equal(m.state.players[0].kind, 'bot');
  assert.equal(m.state.players[2].userId, u.id);
  assert.equal(m.state.players[2].seat, 1);

  const m2 = layer.domino.createMatch({ mode: 'offline', userId: u.id, settings: { botCount: 1, seed: 'fixed-seed' } });
  const m3 = layer.domino.createMatch({ mode: 'offline', userId: u.id, settings: { botCount: 1, seed: 'fixed-seed' } });
  assert.deepEqual(m2.state.boneyard, m3.state.boneyard);
});

test('startMatch deals deterministically and picks a first player', (t) => {
  const { layer, dir } = makeReopenableLayer();
  t.after(() => {
    try { layer.close(); } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const u = userActor(layer);
  const m = layer.domino.createMatch({ mode: 'offline', userId: u.id, settings: { seed: 'deal-seed' } });
  assert.throws(() => layer.domino.startMatch(m.id, { byUserId: 'nobody' }), (e) => e.code === 'E_FORBIDDEN');
  const s = layer.domino.startMatch(m.id, { byUserId: u.id });
  assert.equal(s.state.status, 'active');
  assert.equal((s.state.hands[u.id] || []).length, 7);
  assert.equal((s.state.hands['bot:1'] || []).length, 6, 'bot is first player and auto-plays the opening tile');
  assert.equal(s.state.boneyard.length, 14);
  assert.equal(s.state.firstUserId, 'bot:1');
  assert.throws(() => layer.domino.startMatch(s.id, { byUserId: u.id }), (e) => e.code === 'E_MATCH_ACTIVE');
});

test('turn engine rejects out-of-turn and illegal actions', (t) => {
  const { layer, dir } = makeReopenableLayer();
  t.after(() => {
    try { layer.close(); } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const u = userActor(layer);
  const m = layer.domino.createMatch({ mode: 'offline', userId: u.id, settings: { seed: 'turn-seed' } });
  let match = layer.domino.startMatch(m.id, { byUserId: u.id });
  if (match.state.currentUserId !== u.id) {
    assert.throws(
      () => layer.domino.applyAction(match.id, u.id, { type: 'pass' }),
      (e) => e.code === 'E_NOT_YOUR_TURN',
    );
    assert.equal(match.state.currentUserId, 'bot:1');
    throw new Error('expected bot to start and auto-play; state should be at human turn');
  }
  const hand = match.state.hands[u.id];
  const legal = rules.playsFor(hand, match.state.board);
  assert.ok(legal.length > 0);
  assert.throws(
    () => layer.domino.applyAction(match.id, 'bot:1', { type: 'play', tile: legal[0].tile, side: legal[0].side }),
    (e) => e.code === 'E_NOT_YOUR_TURN',
  );
  const nonPlayable = hand.find((tile) => !legal.some((p) => rules.tileKey(p.tile) === rules.tileKey(tile)));
  if (nonPlayable) {
    assert.throws(
      () =>
        layer.domino.applyAction(match.id, u.id, {
          type: 'play',
          tile: nonPlayable,
          side: legal[0].side,
        }),
      (e) => e.code === 'E_TILE_NO_MATCH',
    );
  }
  assert.throws(
    () => layer.domino.applyAction(match.id, u.id, { type: 'pass' }),
    (e) => e.code === 'E_CANNOT_PASS',
  );
  assert.throws(
    () => layer.domino.applyAction(match.id, u.id, { type: 'bogus' }),
    (e) => e.code === 'E_ARG',
  );
});

test('offline game finishes with a winner and persistent verified moves (seed-a)', (t) => {
  const { layer, dir } = makeReopenableLayer();
  t.after(() => {
    try { layer.close(); } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const u = userActor(layer);
  const m = layer.domino.createMatch({ mode: 'offline', userId: u.id, settings: { seed: 'seed-a' } });
  const match = runOffline(layer, m.id, u.id);
  assert.equal(match.state.endReason, 'emptied');
  assert.equal(match.state.winnerUserId, u.id);
  const winner = match.state.scores.find((s) => s.userId === u.id);
  assert.equal(winner.pips, 0);
  assert.equal(winner.rank, 1);
  assert.ok(winner.winner);
  const moves = layer.domino.movesOf(m.id);
  assert.ok(moves.length >= 2);
  assert.equal(moves[0].move_type, 'join');
  const verify = layer.domino.verifyMatch(m.id);
  assert.deepEqual(verify, { ok: true, moves: moves.length, state_hash: match.state_hash });
});

test('blocked game scores by remaining pips and still verifies (seed-g)', (t) => {
  const { layer, dir } = makeReopenableLayer();
  t.after(() => {
    try { layer.close(); } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const u = userActor(layer);
  const m = layer.domino.createMatch({ mode: 'offline', userId: u.id, settings: { seed: 'seed-g' } });
  const match = runOffline(layer, m.id, u.id);
  assert.equal(match.state.endReason, 'blocked');
  const winner = match.state.scores.find((s) => s.winner);
  assert.ok(winner);
  const minPips = Math.min(...match.state.scores.map((s) => s.pips));
  assert.equal(winner.pips, minPips);
  assert.equal(winner.rank, 1);
  assert.equal(match.state.winnerUserId, winner.userId);
  layer.domino.verifyMatch(m.id);
});

test('persistence survives reopen and tampering is detected', (t) => {
  const { layer, dir } = makeReopenableLayer();
  const u = userActor(layer);
  const m = layer.domino.createMatch({ mode: 'offline', userId: u.id, settings: { seed: 'seed-a' } });
  runOffline(layer, m.id, u.id);
  layer.domino.verifyMatch(m.id);
  layer.close();

  const reopened = createDataLayer({ dataDir: dir });
  t.after(() => {
    try { reopened.close(); } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const got = reopened.domino.getMatch(m.id);
  assert.equal(got.state.status, 'finished');
  assert.equal(got.state.winnerUserId, u.id);
  assert.deepEqual(reopened.domino.verifyMatch(m.id), { ok: true, moves: reopened.domino.movesOf(m.id).length, state_hash: got.state_hash });

  const moves = reopened.domino.movesOf(m.id);
  const target = moves.find((mv) => mv.move_type === 'play');
  reopened.db
    .prepare('UPDATE domino_moves SET tile_a = ? WHERE match_id = ? AND move_index = ?')
    .run((target.tile_a + 1) % 7, m.id, target.move_index);
  assert.throws(() => reopened.domino.verifyMatch(m.id), (e) => e.code === 'E_TAMPER');
});

test('state tampering is detected even without touching move rows', (t) => {
  const { layer, dir } = makeReopenableLayer();
  t.after(() => {
    try { layer.close(); } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const u = userActor(layer);
  const m = layer.domino.createMatch({ mode: 'offline', userId: u.id, settings: { seed: 'seed-a' } });
  const match = runOffline(layer, m.id, u.id);
  const state = JSON.parse(layer.db.prepare('SELECT state_json AS s FROM domino_matches WHERE id = ?').get(m.id).s);
  state.scores[0].pips = 999;
  layer.db.prepare('UPDATE domino_matches SET state_json = ? WHERE id = ?').run(JSON.stringify(state), m.id);
  assert.throws(() => layer.domino.verifyMatch(m.id), (e) => e.code === 'E_TAMPER');
  assert.equal(match.state_hash, layer.domino.getMatch(m.id).state_hash);
});

test('online mode drives matches through the gateway room event flow', (t) => {
  const { layer, dir } = makeReopenableLayer();
  t.after(() => {
    try { layer.close(); } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const host = userActor(layer);
  const guest = userActor(layer);
  const { room } = setupOnlineRoom(layer, host, guest);

  assert.throws(() => layer.domino.onGameEvent(room.id, 'x-user', { action: 'status' }), (e) => e.code === 'E_NOT_IN_MATCH');
  assert.throws(() => layer.domino.onGameEvent(room.id, host.id, { action: 'nope' }), (e) => e.code === 'E_ARG');

  const s1 = layer.domino.onGameEvent(room.id, host.id, { action: 'status' });
  assert.equal(s1.event, 'domino:state');
  assert.equal(s1.payload.status, 'scheduled');
  const s2 = layer.domino.onGameEvent(room.id, guest.id, { action: 'status' });
  assert.equal(s2.payload.players.length, 2);

  const started = layer.domino.onGameEvent(room.id, host.id, { action: 'start' });
  assert.equal(started.event, 'domino:started');
  assert.equal(started.payload.status, 'active');

  let state = started.payload;
  let guard = 0;
  while (state.status === 'active' && guard < 200) {
    guard += 1;
    const cur = state.current_user_id;
    const actor = cur === host.id ? host : guest;
    const moves = rules.playsFor(state.hands[cur], state.board);
    let res;
    if (moves.length) {
      res = layer.domino.onGameEvent(room.id, actor.id, { action: 'play', tile: moves[0].tile, side: moves[0].side });
    } else if (rules.canDraw(state.boneyard)) {
      res = layer.domino.onGameEvent(room.id, actor.id, { action: 'draw' });
    } else {
      res = layer.domino.onGameEvent(room.id, actor.id, { action: 'pass' });
    }
    state = res.payload;
  }
  assert.equal(state.status, 'finished');
  assert.ok(['emptied', 'blocked'].includes(state.end_reason));

  const match = layer.domino.matchForRoom(room.id);
  assert.equal(match.mode, 'online');
  assert.equal(match.state.status, 'finished');
  assert.ok(match.state.players.length === 2);
  layer.domino.verifyMatch(match.id);

  const afterStart = layer.domino.onGameEvent(room.id, guest.id, { action: 'status' });
  assert.equal(afterStart.payload.status, 'finished');
});

test('online events pass through the real gateway broadcast', (t) => {
  const { layer, dir } = makeReopenableLayer();
  t.after(() => {
    try { layer.close(); } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const host = layer.auth.register({ username: 'gw_host_' + Math.random().toString(16).slice(2), password: 'S3cretpass!', role: 'player' });
  const guest = layer.auth.register({ username: 'gw_guest_' + Math.random().toString(16).slice(2), password: 'S3cretpass!', role: 'player' });
  const game = layer.createGame({ kind: 'domino' });
  const room = layer.createRoom({ gameId: game.id, hostUserId: host.id, name: 'GW', capacity: 2 });
  const hs = layer.auth.createSession(host.id);
  const gs = layer.auth.createSession(guest.id);
  const hostSock = fakeSocket(hs.token);
  const guestSock = fakeSocket(gs.token);
  layer.gateway.handleConnection(hostSock);
  layer.gateway.handleConnection(guestSock);
  hostSock.fire('room:join', { roomId: room.id });
  guestSock.fire('room:join', { roomId: room.id });
  hostSock.fire('room:ready', { ready: true });
  guestSock.fire('room:ready', { ready: true });
  hostSock.fire('room:start', {});
  hostSock.fire('game:event', { action: 'status' });
  const seen = guestSock.last('domino:state');
  assert.ok(seen);
  assert.equal(seen.match_id, layer.domino.matchForRoom(room.id).id);
  assert.equal(seen.status, 'scheduled');
});

test('listMatches filters and joinMatch enforces lobby rules', (t) => {
  const { layer, dir } = makeReopenableLayer();
  t.after(() => {
    try { layer.close(); } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const u = userActor(layer);
  const m = layer.domino.createMatch({ mode: 'offline', userId: u.id });
  layer.domino.listMatches({ userId: u.id, mode: 'offline' });
  const listed = layer.domino.listMatches({ userId: u.id });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, m.id);

  const other = userActor(layer);
  assert.throws(() => layer.domino.joinMatch(m.id, m.state.players[0].userId), (e) => e.code === 'E_ALREADY_JOINED');
  const joined = layer.domino.joinMatch(m.id, other.id);
  assert.equal(joined.state.players.length, 3);
  layer.domino.startMatch(m.id, { byUserId: u.id });
  assert.throws(() => layer.domino.joinMatch(m.id, other.id), (e) => e.code === 'E_MATCH_ACTIVE');
});

test('cancelMatch from a non-owner or after finish is rejected', (t) => {
  const { layer, dir } = makeReopenableLayer();
  t.after(() => {
    try { layer.close(); } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const u = userActor(layer);
  const intruder = userActor(layer);
  const m = layer.domino.createMatch({ mode: 'offline', userId: u.id });
  assert.throws(() => layer.domino.cancelMatch(m.id, intruder.id), (e) => e.code === 'E_FORBIDDEN');
  const cancelled = layer.domino.cancelMatch(m.id, u.id);
  assert.equal(cancelled.state.status, 'cancelled');
  layer.domino.verifyMatch(m.id);
  assert.throws(() => layer.domino.cancelMatch(m.id, u.id), (e) => e.code === 'E_MATCH_CLOSED');
});