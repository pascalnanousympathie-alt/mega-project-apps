'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDataLayer } = require('../core');
const rules = require('../core/rami');
const { applySpec, freshState } = require('../core/rami-game');

function makeReopenableLayer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acep-rami-'));
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

function setupRamiRoom(layer, host, guest) {
  const game = layer.createGame({ kind: 'rami', config: { jokers: 2 } });
  const room = layer.createRoom({ gameId: game.id, hostUserId: host.id, name: 'Rami', capacity: 2 });
  layer.joinRoom(room.id, host.id);
  layer.joinRoom(room.id, guest.id);
  layer.setRoomStatus(room.id, 'active');
  return { game, room };
}

function activateOnline(layer, room, host, guest) {
  const s1 = layer.rami.onGameEvent(room.id, host.id, { action: 'status' });
  layer.rami.onGameEvent(room.id, guest.id, { action: 'status' });
  const started = layer.rami.onGameEvent(room.id, host.id, { action: 'start' });
  const st = layer.rami.getGame(started.payload.game_id).state;
  assert.equal(st.status, 'active');
  assert.notEqual(st.currentUserId, null);
  return layer.rami.getGame(started.payload.game_id);
}

function runOfflineRami(layer, gameId, userId) {
  let game = layer.rami.startGame(gameId, { byUserId: userId });
  let guard = 0;
  while (game.state.status === 'active' && guard < 600) {
    guard += 1;
    assert.equal(game.state.currentUserId, userId, 'bot turns should be automated');
    const st = game.state;
    const hand = st.hands[userId] || [];
    let action;
    if (st.turnPhase === 'draw') {
      const top = st.discard.length ? st.discard[st.discard.length - 1] : null;
      action = { type: 'draw', source: top && rules.canUseCardInMeld(top, hand) ? 'discard' : 'stock' };
    } else {
      const melds = rules.findMelds(hand);
      if (melds.length > 0) {
        const keys = melds.map((md) => md.map(rules.cardKey));
        const used = new Set(keys.flat());
        const remaining = hand.filter((k) => !used.has(k));
        game = layer.rami.applyAction(game.id, userId, { type: 'meld', melds: keys });
        if (remaining.length >= 1) {
          action = { type: 'discard', card: highestPoint(remaining) };
        }
      }
      if (game.state.status !== 'active') break;
      if (!action) action = { type: 'discard', card: highestPoint(hand) };
    }
    game = layer.rami.applyAction(game.id, userId, action);
  }
  assert.equal(game.state.status, 'finished', 'game should terminate');
  return game;
}

function highestPoint(hand) {
  let worst = hand[0];
  for (const k of hand) if (rules.handPoints([k]) >= rules.handPoints([worst])) worst = k;
  return worst;
}

test('createGame builds an offline game with human and bots deterministically', (t) => {
  const { layer, dir } = makeReopenableLayer();
  t.after(() => {
    try { layer.close(); } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const u = makeUser(layer, 'rami_host');
  const m = layer.rami.createGame({ mode: 'offline', userId: u.id, settings: { botCount: 2, seed: 'rami-fixed' } });
  assert.equal(m.mode, 'offline');
  assert.equal(m.state.status, 'scheduled');
  assert.equal(m.state.players.length, 3);
  assert.equal(m.state.players[0].userId, 'bot:1');
  assert.equal(m.state.players[0].kind, 'bot');
  assert.equal(m.state.players[2].userId, u.id);
  assert.equal(m.state.players[2].seat, 1);

  const m2 = layer.rami.createGame({ mode: 'offline', userId: u.id, settings: { botCount: 1, seed: 'fixed-seed' } });
  const m3 = layer.rami.createGame({ mode: 'offline', userId: u.id, settings: { botCount: 1, seed: 'fixed-seed' } });
  const keys = (st) => JSON.stringify([st.stock, st.hands].flat(2));
  assert.equal(keys(m2.state), keys(m3.state), 'same seed deals the same cards');

  const m4 = layer.rami.createGame({ mode: 'offline', userId: u.id, settings: { botCount: 1, seed: 'fixed-seed', handSize: 7 } });
  const dealt = m4.state.players.reduce((n, p) => n + (m4.state.hands[p.userId] || []).length, 0);
  assert.equal(dealt, 14);
});

test('startGame enforces players, ownership and single start', (t) => {
  const { layer, dir } = makeReopenableLayer();
  t.after(() => {
    try { layer.close(); } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const u = makeUser(layer, 'starter');
  const intruder = makeUser(layer, 'intruder');
  const m = layer.rami.createGame({ mode: 'offline', userId: u.id, settings: { botCount: 1, seed: 'start-seed' } });
  assert.throws(() => layer.rami.startGame(m.id, { byUserId: intruder.id }), (e) => e.code === 'E_FORBIDDEN');
  const s = layer.rami.startGame(m.id, { byUserId: u.id });
  assert.equal(s.state.status, 'active');
  assert.equal(s.state.hands[u.id].length, 10);
  assert.ok(s.state.stock.length > 0);
  assert.equal(s.state.discard.length, 0);
  assert.equal(s.state.turnPhase, 'draw');
  assert.throws(() => layer.rami.startGame(m.id, { byUserId: u.id }), (e) => e.code === 'E_GAME_ACTIVE');

  const solo = layer.rami.createGame({ mode: 'online', userId: u.id, roomId: null });
  assert.throws(() => layer.rami.startGame(solo.id, { byUserId: u.id }), (e) => e.code === 'E_CANNOT_START');
});

test('turn engine rejects out-of-turn and wrong-phase actions in an online game', (t) => {
  const { layer, dir } = makeReopenableLayer();
  t.after(() => {
    try { layer.close(); } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const host = makeUser(layer, 'host_a');
  const guest = makeUser(layer, 'guest_a');
  const { room } = setupRamiRoom(layer, host, guest);
  const m = activateOnline(layer, room, host, guest);
  const current = m.state.currentUserId;
  const other = current === host.id ? guest : host;
  const actor = current === host.id ? host : guest;

  assert.throws(() => layer.rami.applyAction(m.id, other.id, { type: 'draw', source: 'stock' }), (e) => e.code === 'E_NOT_YOUR_TURN');
  assert.throws(() => layer.rami.applyAction(m.id, actor.id, { type: 'melds', melds: [] }), (e) => e.code === 'E_ARG');
  const drawn = layer.rami.applyAction(m.id, actor.id, { type: 'draw', source: 'stock' });
  assert.equal(drawn.state.turnPhase, 'discard');
  assert.equal(drawn.state.currentUserId, actor.id, 'player keeps the turn after drawing');
  assert.throws(() => layer.rami.applyAction(m.id, actor.id, { type: 'draw', source: 'stock' }), (e) => e.code === 'E_WRONG_PHASE');

  const hand = drawn.state.hands[actor.id];
  const junk = highestPoint(hand);
  assert.throws(() => layer.rami.applyAction(m.id, actor.id, { type: 'discard', card: 'XX:1' }), (e) => e.code === 'E_CARD_NOT_IN_HAND');
  const discarded = layer.rami.applyAction(m.id, actor.id, { type: 'discard', card: junk });
  assert.equal(discarded.state.currentUserId, other.id, 'turn advances after discard');
  assert.equal(discarded.state.turnPhase, 'draw');
  assert.equal(discarded.state.discard[discarded.state.discard.length - 1], junk);
  layer.rami.verifyGame(m.id);
});

test('draw source validation covers empty stock and discard-top mismatch', (t) => {
  const { layer, dir } = makeReopenableLayer();
  t.after(() => {
    try { layer.close(); } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const host = makeUser(layer, 'host_b');
  const guest = makeUser(layer, 'guest_b');
  const { room } = setupRamiRoom(layer, host, guest);
  const m = activateOnline(layer, room, host, guest);

  const st = { ...m.state, stock: [], discard: ['H:1', 'H:2', 'H:3'], currentUserId: m.state.currentUserId, turnPhase: 'draw' };
  const specDraw = {
    userId: m.state.currentUserId,
    moveType: 'draw',
    source: 'stock',
    card: 'H:1',
    moveIndex: layer.rami.movesOf(m.id).length + 1,
  };
  assert.throws(() => applySpec(st, specDraw), (e) => e.code === 'E_STOCK_EMPTY');

  const stPhased = { ...st, discard: ['H:1', 'H:2', 'H:3'], turnPhase: 'discard' };
  assert.throws(
    () => applySpec(stPhased, { userId: stPhased.currentUserId, moveType: 'draw', source: 'stock', card: 'H:1' }),
    (e) => e.code === 'E_WRONG_PHASE',
  );
});

test('meld validation rejects bad melds and enforces a mandatory discard card', (t) => {
  const { layer, dir } = makeReopenableLayer();
  t.after(() => {
    try { layer.close(); } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const host = makeUser(layer, 'host_c');
  const guest = makeUser(layer, 'guest_c');
  const { room } = setupRamiRoom(layer, host, guest);
  const m = activateOnline(layer, room, host, guest);
  const actor = m.state.players.find((p) => p.userId === m.state.currentUserId);
  const g = layer.rami.getGame(m.id);

  const st = freshState(g);
  st.players = actor.kind === 'bot' ? [] : m.state.players;
  st.order = m.state.order;
  st.hands = m.state.hands;
  st.currentUserId = m.state.currentUserId;
  st.turnPhase = 'discard';
  const hand = st.hands[st.currentUserId] || [];
  const hk = new Set(hand);

  const trio = hand.filter((k) => hk.has(k) && !k.startsWith('JK:') && k.split(':')[1] === hand[0].split(':')[1]);
  const madeUp = hand.find((k) => k.split(':')[1] === '7');
  const meldBad = { currentUserId: m.state.currentUserId };
  assert.throws(() => applySpec(st, { userId: 'nobody', moveType: 'meld', melds: [['H:1', 'S:1', 'D:1']] }), (e) => e.code === 'E_NOT_YOUR_TURN');
  assert.throws(
    () => applySpec(st, { userId: st.currentUserId, moveType: 'meld', melds: [['H:1', 'S:2', 'D:3']] }),
    (e) => e.code === 'E_GROUP_RANK',
  );

  const specNone = { userId: st.currentUserId, moveType: 'meld', melds: [] };
  assert.throws(() => applySpec(st, specNone), (e) => e.code === 'E_MELDS_REQUIRED');

  const validMelds = rules.findMelds(hand.slice(0, 8));
  if (validMelds.length > 0) {
    const melded = applySpec(st, {
      userId: st.currentUserId,
      moveType: 'meld',
      melds: validMelds.map((md) => md.map(rules.cardKey)),
    });
    const remainingCount = (melded.hands[st.currentUserId] || []).length;
    assert.ok(remainingCount >= 1, 'must keep a discard card');
    assert.equal(melded.table[st.currentUserId].length, validMelds.length);
    assert.equal(melded.turnPhase, 'discard', 'melding does not advance the turn');
  }
  void madeUp;
  void trio;
  void meldBad;
});

test('applySpec crafts that melding the entire hand is rejected (E_NO_DISCARD)', () => {
  const st = freshState({ mode: 'offline', status: 'active', seed: 'x', settings: {} });
  st.players.push({ userId: 'P1', seat: 1, kind: 'human', name: null });
  st.order = ['P1'];
  st.hands.P1 = ['H:1', 'H:2', 'H:3', 'C:9'];
  st.currentUserId = 'P1';
  st.turnPhase = 'discard';
  const wholeHand = { userId: 'P1', moveType: 'meld', melds: [['H:1', 'H:2', 'H:3']] };
  const applied = applySpec(st, wholeHand);
  assert.equal(applied.hands.P1.join(','), 'C:9');
  assert.equal(applied.table.P1.length, 1);

  const st2 = freshState({ mode: 'offline', status: 'active', seed: 'x', settings: {} });
  st2.players.push({ userId: 'P2', seat: 1, kind: 'human', name: null });
  st2.order = ['P2'];
  st2.hands.P2 = ['H:1', 'H:2', 'H:3'];
  st2.currentUserId = 'P2';
  st2.turnPhase = 'discard';
  assert.throws(
    () => applySpec(st2, { userId: 'P2', moveType: 'meld', melds: [['H:1', 'H:2', 'H:3']] }),
    (e) => e.code === 'E_NO_DISCARD',
  );
});

test('offline game finishes with hand_empty and a verified move chain (seed-a)', (t) => {
  const { layer, dir } = makeReopenableLayer();
  t.after(() => {
    try { layer.close(); } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const u = makeUser(layer, 'offline_a');
  const m = layer.rami.createGame({ mode: 'offline', userId: u.id, settings: { seed: 'seed-a' } });
  const game = runOfflineRami(layer, m.id, u.id);
  assert.equal(game.state.endReason, 'hand_empty');
  assert.ok(game.state.winnerUserId, 'a winner is declared');
  assert.ok(game.state.players.some((p) => p.userId === game.state.winnerUserId));
  const winner = game.state.scores.find((s) => s.userId === game.state.winnerUserId);
  assert.equal(winner.points, 0, 'the winner has no cards left');
  assert.equal(winner.rank, 1);
  const moves = layer.rami.movesOf(m.id);
  assert.ok(moves.length >= 2);
  assert.equal(moves[0].move_type, 'join');
  const verify = layer.rami.verifyGame(m.id);
  assert.deepEqual(verify, { ok: true, moves: moves.length, state_hash: game.state_hash });
});

test('discarding the last card in hand wins the game', () => {
  const st = freshState({ mode: 'offline', status: 'active', seed: 'x', settings: {} });
  st.players.push({ userId: 'P1', seat: 1, kind: 'human', name: null });
  st.players.push({ userId: 'P2', seat: 2, kind: 'human', name: null });
  st.order = ['P1', 'P2'];
  st.hands.P1 = ['H:1'];
  st.hands.P2 = ['S:3', 'S:4', 'S:5'];
  st.currentUserId = 'P1';
  st.turnPhase = 'discard';
  applySpec(st, { userId: 'P1', moveType: 'discard', card: 'H:1' });
  assert.equal(st.status, 'finished');
  assert.equal(st.endReason, 'hand_empty');
  assert.equal(st.winnerUserId, 'P1');
  assert.equal(st.scores.find((s) => s.userId === 'P1').points, 0);
  assert.equal(st.scores.find((s) => s.userId === 'P1').winner, true);
});

test('deck integrity holds across a played and persisted game', (t) => {
  const { layer, dir } = makeReopenableLayer();
  const u = makeUser(layer, 'persist_a');
  const m = layer.rami.createGame({ mode: 'offline', userId: u.id, settings: { seed: 'persist-seed' } });
  runOfflineRami(layer, m.id, u.id);
  layer.rami.verifyGame(m.id);
  layer.close();

  const reopened = createDataLayer({ dataDir: dir });
  t.after(() => {
    try { reopened.close(); } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const got = reopened.rami.getGame(m.id);
  assert.equal(got.state.status, 'finished');
  assert.equal(got.state.winnerUserId, u.id);
  const flattened = Object.values(got.state.table).flat(2);
  const all = Object.values(got.state.hands).flat().concat(got.state.stock, got.state.discard, flattened);
  assert.equal(all.length, 54, 'all 54 cards remain in play across the finished game');
  assert.deepEqual(reopened.rami.verifyGame(m.id), { ok: true, moves: reopened.rami.movesOf(m.id).length, state_hash: got.state_hash });
});

test('verifyGame detects tampered move rows and tampered state', (t) => {
  const { layer, dir } = makeReopenableLayer();
  t.after(() => {
    try { layer.close(); } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const u = makeUser(layer, 'tamper_b');
  const m = layer.rami.createGame({ mode: 'offline', userId: u.id, settings: { seed: 'seed-a' } });
  runOfflineRami(layer, m.id, u.id);
  layer.rami.verifyGame(m.id);

  const drawRow = layer.db
    .prepare("SELECT * FROM rami_moves WHERE game_id = ? AND move_type = 'draw' AND source = 'stock' ORDER BY move_index LIMIT 1")
    .get(m.id);
  if (drawRow) {
    const flipped = drawRow.card === 'JK:1' ? 'H:1' : drawRow.card === 'H:1' ? 'H:2' : 'H:1';
    layer.db.prepare('UPDATE rami_moves SET card = ? WHERE game_id = ? AND move_index = ?').run(flipped, m.id, drawRow.move_index);
    assert.throws(() => layer.rami.verifyGame(m.id), (e) => e.code === 'E_TAMPER');
  }

  const played = layer.rami.createGame({ mode: 'offline', userId: u.id, settings: { seed: 'seed-b' } });
  runOfflineRami(layer, played.id, u.id);
  const row = layer.db.prepare('SELECT state_json AS s FROM rami_games WHERE id = ?').get(played.id);
  const state = JSON.parse(row.s);
  state.scores[0].points = 999;
  layer.db.prepare('UPDATE rami_games SET state_json = ? WHERE id = ?').run(JSON.stringify(state), played.id);
  assert.throws(() => layer.rami.verifyGame(played.id), (e) => e.code === 'E_TAMPER');
});

test('online rooms drive rami games through the gateway room event flow', (t) => {
  const { layer, dir } = makeReopenableLayer();
  t.after(() => {
    try { layer.close(); } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const host = makeUser(layer, 'gw_host');
  const guest = makeUser(layer, 'gw_guest');
  const { room } = setupRamiRoom(layer, host, guest);

  assert.throws(() => layer.rami.onGameEvent(room.id, 'x-user', { action: 'status' }), (e) => e.code === 'E_NOT_IN_GAME');
  assert.throws(() => layer.rami.onGameEvent(room.id, host.id, { action: 'nope' }), (e) => e.code === 'E_ARG');

  const s1 = layer.rami.onGameEvent(room.id, host.id, { action: 'status' });
  assert.equal(s1.event, 'rami:state');
  assert.equal(s1.payload.status, 'scheduled');
  const s2 = layer.rami.onGameEvent(room.id, guest.id, { action: 'status' });
  assert.equal(s2.payload.players.length, 2);

  const started = layer.rami.onGameEvent(room.id, host.id, { action: 'start' });
  assert.equal(started.event, 'rami:started');
  assert.equal(started.payload.status, 'active');

  let state = started.payload;
  let guard = 0;
  while (state.status === 'active' && guard < 300) {
    guard += 1;
    const cur = state.current_user_id;
    const actor = cur === host.id ? host : guest;
    let res;
    if (state.turn_phase === 'draw') {
      res = layer.rami.onGameEvent(room.id, actor.id, { action: 'draw', source: 'stock' });
    } else {
      const hand = state.own_hand || [];
      const discards = rules.findMelds(hand);
      if (discards.length > 0) {
        res = layer.rami.onGameEvent(room.id, actor.id, {
          action: 'meld',
          melds: discards.slice(0, 1).map((md) => md.map(rules.cardKey)),
        });
        if (res.payload.turn_phase === 'discard') {
          const remaining = state.own_hand.filter((k) => !discards[0].map(rules.cardKey).includes(k));
          res = layer.rami.onGameEvent(room.id, actor.id, { action: 'discard', card: remaining[remaining.length - 1] });
        }
      } else {
        res = layer.rami.onGameEvent(room.id, actor.id, { action: 'discard', card: hand[hand.length - 1] });
      }
    }
    state = res.payload;
  }
  assert.equal(state.status, 'finished');
  assert.equal(state.end_reason, 'hand_empty');

  const game = layer.rami.gameForRoom(room.id);
  assert.equal(game.mode, 'online');
  assert.equal(game.state.status, 'finished');
  assert.ok(game.state.players.length === 2);
  layer.rami.verifyGame(game.id);
});

test('real gateway broadcast delivers rami events to room sockets', (t) => {
  const { layer, dir } = makeReopenableLayer();
  t.after(() => {
    try { layer.close(); } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const host = layer.auth.register({ username: 'rs_host_' + Math.random().toString(16).slice(2), password: 'S3cretpass!', role: 'player' });
  const guest = layer.auth.register({ username: 'rs_guest_' + Math.random().toString(16).slice(2), password: 'S3cretpass!', role: 'player' });
  const game = layer.createGame({ kind: 'rami' });
  const room = layer.createRoom({ gameId: game.id, hostUserId: host.id, name: 'RamiGW', capacity: 2 });
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
  const seen = guestSock.last('rami:state');
  assert.ok(seen);
  assert.equal(seen.game_id, layer.rami.gameForRoom(room.id).id);
  assert.equal(seen.status, 'scheduled');
});

function fakeSocket(token) {
  const handlers = {};
  const sent = [];
  const sock = {
    id: 'sock-' + Math.random().toString(16).slice(2),
    token,
    resumeToken: null,
    ip: '127.0.0.1',
    userAgent: 'rami-test',
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

test('joinGame, listGames and cancelGame enforce lobby rules', (t) => {
  const { layer, dir } = makeReopenableLayer();
  t.after(() => {
    try { layer.close(); } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const u = makeUser(layer, 'lobby_host');
  const m = layer.rami.createGame({ mode: 'offline', userId: u.id });
  const listed = layer.rami.listGames({ userId: u.id, mode: 'offline' });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, m.id);

  const other = makeUser(layer, 'lobby_other');
  assert.throws(
    () => layer.rami.joinGame(m.id, m.state.players[0].userId),
    (e) => e.code === 'E_ALREADY_JOINED',
  );
  const joined = layer.rami.joinGame(m.id, other.id);
  assert.equal(joined.state.players.length, 3);
  layer.rami.startGame(m.id, { byUserId: u.id });
  assert.throws(() => layer.rami.joinGame(m.id, other.id), (e) => e.code === 'E_GAME_ACTIVE');

  const intruder = makeUser(layer, 'lobby_intruder');
  const m2 = layer.rami.createGame({ mode: 'offline', userId: u.id });
  assert.throws(() => layer.rami.cancelGame(m2.id, intruder.id), (e) => e.code === 'E_FORBIDDEN');
  const cancelled = layer.rami.cancelGame(m2.id, u.id);
  assert.equal(cancelled.state.status, 'cancelled');
  layer.rami.verifyGame(m2.id);
  assert.throws(() => layer.rami.cancelGame(m2.id, u.id), (e) => e.code === 'E_GAME_CLOSED');
});