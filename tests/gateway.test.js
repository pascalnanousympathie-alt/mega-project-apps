'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { buildGateway, socketAuthMiddleware, buildSocketIo } = require('../core');
const { makeDataLayer } = require('./helpers');

const PW = 'S3cretpass!';

function makeFakeSocket(token, resumeToken) {
  const handlers = {};
  const sent = [];
  const sock = {
    id: 'sock-' + crypto.randomUUID(),
    token: token || null,
    resumeToken: resumeToken || null,
    ip: '192.0.2.1',
    userAgent: 'test-client',
    _disconnected: false,
    emit(event, payload) {
      sent.push({ event, payload });
      return sock;
    },
    on(event, handler) {
      (handlers[event] = handlers[event] || []).push(handler);
      return sock;
    },
    fire(event, payload) {
      const list = handlers[event] || [];
      for (const handler of [...list]) handler(payload);
      return sock;
    },
    disconnect() {
      sock._disconnected = true;
    },
    last(event) {
      const hits = sent.filter((m) => m.event === event);
      return hits.length ? hits[hits.length - 1].payload : null;
    },
    all(event) {
      return sent.filter((m) => m.event === event).map((m) => m.payload);
    },
  };
  return sock;
}

function makeHarness(t, opts = {}) {
  const clock = { t: 0 };
  const { layer } = makeDataLayer(t);
  const gateway = buildGateway({
    db: layer.db,
    repos: layer,
    auth: layer.auth,
    options: {
      now: () => clock.t,
      graceMs: 30000,
      maxEventsPerMin: 500,
      ...opts,
    },
  });
  t.after(() => gateway.stopSweep());
  return { layer, gateway, clock };
}

function makePlayer(layer, gateway, username) {
  const user = layer.auth.register({ username, password: PW, role: 'player' });
  const { token, session } = layer.auth.createSession(user.id);
  const sock = makeFakeSocket(token);
  const accepted = gateway.handleConnection(sock) === true;
  return { user, token, session, sock, accepted };
}

function setupRoom(layer, gateway, host, capacity = 4) {
  const game = layer.createGame({ kind: 'domino', config: { tiles: 28 } });
  const room = layer.createRoom({ gameId: game.id, hostUserId: host.id, name: 'Table 1', capacity });
  return { game, room };
}

test('socket auth middleware accepts valid tokens and rejects bad ones', (t) => {
  const { layer } = makeHarness(t);
  const user = layer.auth.register({ username: 'mw_user', password: PW });
  const { token } = layer.auth.createSession(user.id);
  const mw = socketAuthMiddleware(layer.auth);

  let nextCalled = [];
  mw({ handshake: { auth: {} }, data: {} }, (...args) => nextCalled.push(args));
  assert.ok(nextCalled.length === 1);
  assert.ok(nextCalled[0][0] instanceof Error);

  nextCalled = [];
  mw({ handshake: { auth: { token: 'not-a-real-token' } }, data: {} }, (...args) => nextCalled.push(args));
  assert.equal(nextCalled[0][0].message, 'E_INVALID_TOKEN');

  const bad = layer.auth.register({ username: 'mw_badpw', password: PW });
  const revoked = layer.auth.createSession(bad.id).token;
  layer.auth.revokeSession(revoked);
  nextCalled = [];
  mw({ handshake: { auth: { token: revoked } }, data: {} }, (...args) => nextCalled.push(args));
  assert.equal(nextCalled[0][0].message, 'E_SESSION_REVOKED');

  nextCalled = [];
  const socket = { handshake: { auth: { token } }, data: {} };
  mw(socket, (...args) => nextCalled.push(args));
  assert.equal(nextCalled[0][0], undefined);
  assert.equal(socket.data.user.id, user.id);
  assert.ok(socket.data.session.id);
});

test('gateway rejects unauthenticated connections', (t) => {
  const { layer, gateway } = makeHarness(t);
  const sock = makeFakeSocket('garbage-token');
  const accepted = gateway.handleConnection(sock);
  assert.equal(accepted, false);
  const error = sock.last('error');
  assert.equal(error.code, 'E_INVALID_TOKEN');
  assert.equal(sock._disconnected, true);
});

test('fresh connect reports connected with a reconnect token', (t) => {
  const { layer, gateway } = makeHarness(t);
  const p = makePlayer(layer, gateway, 'fresh_user');
  assert.equal(p.accepted, true);
  const connected = p.sock.last('connected');
  assert.equal(connected.resumed, false);
  assert.equal(connected.user_id, p.user.id);
  assert.ok(connected.connection_id);
  assert.ok(connected.reconnect_token.length >= 32);
  assert.equal(gateway.stats().connected, 1);
});

test('join validates room, seats, fullness and broadcasts presence', (t) => {
  const { layer, gateway, clock } = makeHarness(t);
  void clock;
  const host = makePlayer(layer, gateway, 'join_host');
  const { room } = setupRoom(layer, gateway, host.user, 2);
  host.sock.fire('room:join', { roomId: room.id });
  const joined = host.sock.last('room:joined');
  assert.equal(joined.room.id, room.id);
  assert.equal(joined.players.length, 1);
  assert.equal(joined.players[0].seat, 1);
  assert.equal(joined.players[0].presence, 'present');
  assert.ok(joined.state.version > 0);

  const p2 = makePlayer(layer, gateway, 'join_p2');
  p2.sock.fire('room:join', { roomId: room.id });
  const p2joined = p2.sock.last('room:joined');
  assert.equal(p2joined.players.find((x) => x.user_id === host.user.id).seat, 1);
  assert.equal(p2joined.players.find((x) => x.user_id === p2.user.id).seat, 2);
  const hostPresence = host.sock.all('room:presence').pop();
  assert.equal(hostPresence.players.length, 2);

  const p3 = makePlayer(layer, gateway, 'join_p3');
  p3.sock.fire('room:join', { roomId: room.id });
  assert.equal(p3.sock.last('error').code, 'E_ROOM_FULL');
  host.sock.fire('room:join', { roomId: room.id });
  assert.equal(host.sock.last('error').code, 'E_ALREADY_JOINED');
  const nope = makePlayer(layer, gateway, 'join_nope');
  nope.sock.fire('room:join', { roomId: 'does-not-exist' });
  assert.equal(nope.sock.last('error').code, 'E_NO_ROOM');
});

test('single-room policy releases the previous room', (t) => {
  const { layer, gateway } = makeHarness(t);
  const host = makePlayer(layer, gateway, 'single_host');
  const game = layer.createGame({ kind: 'loto' });
  const roomA = layer.createRoom({ gameId: game.id, hostUserId: host.user.id, name: 'A' });
  const roomB = layer.createRoom({ gameId: game.id, hostUserId: host.user.id, name: 'B' });
  const watcher = makePlayer(layer, gateway, 'single_watch');
  watcher.sock.fire('room:join', { roomId: roomA.id });

  host.sock.fire('room:join', { roomId: roomA.id });
  assert.equal(host.sock.last('room:joined').room.id, roomA.id);

  host.sock.fire('room:join', { roomId: roomB.id });
  assert.equal(host.sock.last('room:left').room_id, roomA.id);
  assert.equal(host.sock.last('room:joined').room.id, roomB.id);
  const watcherPresence = watcher.sock.all('room:presence').pop();
  assert.equal(watcherPresence.players.find((x) => x.user_id === host.user.id), undefined);
});

test('explicit leave releases the seat and requires membership', (t) => {
  const { layer, gateway } = makeHarness(t);
  const host = makePlayer(layer, gateway, 'leave_host');
  const { room } = setupRoom(layer, gateway, host.user);
  host.sock.fire('room:join', { roomId: room.id });
  host.sock.fire('room:leave');
  const left = host.sock.last('room:left');
  assert.equal(left.room_id, room.id);
  assert.equal(layer.roomPlayers(room.id).length, 0);
  host.sock.fire('room:leave');
  assert.equal(host.sock.last('error').code, 'E_NOT_IN_ROOM');
  host.sock.fire('room:join', { roomId: room.id });
  host.sock.fire('room:leave');
  const rejoin = host.sock.all('room:joined').pop();
  assert.equal(rejoin.players.find((x) => x.user_id === host.user.id).seat, 1);
});

test('room start and close are host-only and authoritative', (t) => {
  const { layer, gateway } = makeHarness(t);
  const host = makePlayer(layer, gateway, 'auth_host');
  const { room } = setupRoom(layer, gateway, host.user);
  const guest = makePlayer(layer, gateway, 'auth_guest');
  host.sock.fire('room:join', { roomId: room.id });
  guest.sock.fire('room:join', { roomId: room.id });

  guest.sock.fire('room:start');
  assert.equal(guest.sock.last('error').code, 'E_FORBIDDEN');
  host.sock.fire('room:start');
  const started = host.sock.last('room:started');
  assert.equal(started.room.id, room.id);
  assert.equal(started.state.status, 'active');
  assert.equal(layer.getRoom(room.id).status, 'active');
  const guestState = guest.sock.all('room:state').pop();
  assert.equal(guestState.state.status, 'active');

  guest.sock.fire('room:close');
  assert.equal(guest.sock.last('error').code, 'E_FORBIDDEN');
  host.sock.fire('room:close');
  assert.equal(host.sock.last('room:closed').room_id, room.id);
  assert.equal(guest.sock.last('room:closed').room_id, room.id);
  assert.equal(layer.getRoom(room.id).status, 'closed');
  assert.equal(layer.roomPlayers(room.id).length, 0);
  const late = makePlayer(layer, gateway, 'auth_late');
  late.sock.fire('room:join', { roomId: room.id });
  assert.equal(late.sock.last('error').code, 'E_ROOM_CLOSED');
});

test('ready state is authoritative and requires membership', (t) => {
  const { layer, gateway } = makeHarness(t);
  const host = makePlayer(layer, gateway, 'ready_host');
  const { room } = setupRoom(layer, gateway, host.user);
  const guest = makePlayer(layer, gateway, 'ready_guest');
  host.sock.fire('room:join', { roomId: room.id });
  guest.sock.fire('room:join', { roomId: room.id });

  const outsider = makePlayer(layer, gateway, 'ready_out');
  outsider.sock.fire('room:ready', { ready: true });
  assert.equal(outsider.sock.last('error').code, 'E_NOT_IN_ROOM');

  guest.sock.fire('room:ready', { ready: true });
  const state = guest.sock.all('room:state').pop();
  assert.equal(state.state.ready[guest.user.id], true);
  const hostState = host.sock.all('room:state').pop();
  assert.equal(hostState.state.ready[guest.user.id], true);
  assert.equal(host.sock.all('room:state').length >= 2, true);
});

test('reconnect resumes the seat and syncs authoritative state', (t) => {
  const { layer, gateway, clock } = makeHarness(t);
  void clock;
  const host = makePlayer(layer, gateway, 're_host');
  const { room } = setupRoom(layer, gateway, host.user);
  host.sock.fire('room:join', { roomId: room.id });
  const p2 = makePlayer(layer, gateway, 're_p2');
  p2.sock.fire('room:join', { roomId: room.id });

  host.sock.disconnect();
  gateway.handleDisconnect(host.sock.id);
  assert.equal(gateway.stats().away, 1);
  const p2Presence = p2.sock.all('room:presence').pop();
  assert.equal(p2Presence.players.find((x) => x.user_id === host.user.id).presence, 'away');
  assert.equal(layer.roomPlayers(room.id).length, 2);

  const resumeToken = host.sock.last('connected').reconnect_token;
  const sock2 = makeFakeSocket(host.token, resumeToken);
  assert.equal(gateway.handleConnection(sock2), true);
  const connected = sock2.last('connected');
  assert.equal(connected.resumed, true);
  assert.equal(connected.user_id, host.user.id);
  const resumedState = sock2.last('room:state');
  assert.equal(resumedState.room.id, room.id);
  assert.equal(resumedState.players.find((x) => x.user_id === host.user.id).presence, 'present');
  assert.equal(gateway.stats().away, 0);
  assert.equal(gateway.stats().connected, 2);
  const p2Presence2 = p2.sock.all('room:presence').pop();
  assert.equal(p2Presence2.players.find((x) => x.user_id === host.user.id).presence, 'present');
});

test('sweep releases seats after the disconnect grace period', (t) => {
  const { layer, gateway, clock } = makeHarness(t);
  const host = makePlayer(layer, gateway, 'sweep_host');
  const { room } = setupRoom(layer, gateway, host.user);
  const p2 = makePlayer(layer, gateway, 'sweep_p2');
  host.sock.fire('room:join', { roomId: room.id });
  p2.sock.fire('room:join', { roomId: room.id });

  p2.sock.disconnect();
  gateway.handleDisconnect(p2.sock.id);
  assert.equal(gateway.stats().away, 1);
  clock.t += 31000;
  const swept = gateway.sweep();
  assert.equal(swept, 1);
  assert.equal(gateway.stats().away, 0);
  assert.equal(layer.roomPlayers(room.id).length, 1);
  const presence = host.sock.all('room:presence').pop();
  assert.equal(presence.players.length, 1);
  const audit = layer.listAudit({ targetType: 'room', targetId: room.id });
  assert.ok(audit.some((e) => e.action === 'gateway.leave'));
  assert.ok(audit.some((e) => e.action === 'room.joined'));
});

test('wrong resume token and duplicate live connections are rejected', (t) => {
  const { layer, gateway, clock } = makeHarness(t);
  void clock;
  const host = makePlayer(layer, gateway, 'dup_host');
  const { room } = setupRoom(layer, gateway, host.user);
  host.sock.fire('room:join', { roomId: room.id });

  const dup = makeFakeSocket(host.token, null);
  assert.equal(gateway.handleConnection(dup), false);
  assert.equal(dup.last('error').code, 'E_ALREADY_CONNECTED');

  host.sock.disconnect();
  gateway.handleDisconnect(host.sock.id);
  const fresh = makeFakeSocket(host.token, 'bogus-resume');
  assert.equal(gateway.handleConnection(fresh), true);
  assert.equal(fresh.last('connected').resumed, false);
  fresh.fire('room:join', { roomId: room.id });
  assert.equal(fresh.sock ? true : true, true);
  assert.equal(fresh.last('room:joined').room.id, room.id);
});

test('game:event passthrough is authoritative and membership-bound', (t) => {
  const { layer, gateway } = makeHarness(t, {
    onGameEvent(roomId, userId, payload) {
      return { event: 'table:deal', payload: { by: userId, cards: payload.cards || [1, 2] } };
    },
  });
  const host = makePlayer(layer, gateway, 'game_host');
  const { room } = setupRoom(layer, gateway, host.user);
  const guest = makePlayer(layer, gateway, 'game_guest');
  host.sock.fire('room:join', { roomId: room.id });
  guest.sock.fire('room:join', { roomId: room.id });

  guest.sock.fire('game:event', { cards: [9, 8] });
  const dealt = guest.sock.last('table:deal');
  assert.deepEqual(dealt.cards, [9, 8]);
  assert.equal(dealt.seq, 1);
  assert.equal(host.sock.last('table:deal').seq, 1);
  guest.sock.fire('game:event', { cards: [5] });
  assert.equal(guest.sock.last('table:deal').seq, 2);

  const outsider = makePlayer(layer, gateway, 'game_out');
  outsider.sock.fire('game:event', { cards: [] });
  assert.equal(outsider.sock.last('error').code, 'E_NOT_IN_ROOM');

  const seq = gateway.gameBroadcast(room.id, 'table:reveal', { value: 42 });
  assert.equal(seq, 3);
  assert.equal(guest.sock.last('table:reveal').value, 42);
});

test('game:event without a handler is rejected', (t) => {
  const { layer, gateway } = makeHarness(t);
  const host = makePlayer(layer, gateway, 'nohost');
  const { room } = setupRoom(layer, gateway, host.user);
  host.sock.fire('room:join', { roomId: room.id });
  host.sock.fire('game:event', { x: 1 });
  assert.equal(host.sock.last('error').code, 'E_NO_HANDLER');
});

test('unknown events and rate limits are rejected', (t) => {
  const { layer, gateway } = makeHarness(t, { maxEventsPerMin: 5 });
  const host = makePlayer(layer, gateway, 'rate_host');
  assert.equal(gateway.handleEvent(host.sock.id, 'bogus:event', {}), false);
  assert.equal(host.sock.last('error').code, 'E_INVALID_EVENT');
  for (let i = 0; i < 5; i += 1) host.sock.fire('gateway:ping');
  assert.equal(host.sock.last('error').code, 'E_RATE_LIMITED');
  assert.equal(host.sock.all('gateway:pong').length, 4);
});

test('room:list and room:state pull expose authoritative data', (t) => {
  const { layer, gateway } = makeHarness(t);
  const host = makePlayer(layer, gateway, 'list_host');
  const game = layer.createGame({ kind: 'rami' });
  layer.createRoom({ gameId: game.id, hostUserId: host.user.id, name: 'Lobby 1', capacity: 2 });
  const otherPlayer = makePlayer(layer, gateway, 'list_other');
  otherPlayer.sock.fire('room:list');
  const listing = otherPlayer.sock.last('room:list');
  assert.equal(listing.rooms.length, 1);
  assert.equal(listing.rooms[0].name, 'Lobby 1');
  assert.equal(listing.rooms[0].players, 0);

  const empty = makePlayer(layer, gateway, 'list_empty');
  empty.sock.fire('room:state');
  assert.equal(empty.sock.last('error').code, 'E_NOT_IN_ROOM');
});

test('connection tracking, registry and audits', (t) => {
  const { layer, gateway } = makeHarness(t);
  const host = makePlayer(layer, gateway, 'stat_host');
  const { room } = setupRoom(layer, gateway, host.user);
  const p2 = makePlayer(layer, gateway, 'stat_p2');
  host.sock.fire('room:join', { roomId: room.id });
  p2.sock.fire('room:join', { roomId: room.id });
  const stats = gateway.stats();
  assert.equal(stats.connections, 2);
  assert.equal(stats.connected, 2);
  assert.ok(stats.rooms >= 1);
  assert.deepEqual(gateway.usersInRoom(room.id).sort(), [host.user.id, p2.user.id].sort());
  const audit = layer.listAudit({ targetType: 'room', targetId: room.id });
  assert.equal(audit.filter((e) => e.action === 'room.joined').length, 2);
});

test('socket.io transport factory returns io and gateway', async (t) => {
  const http = require('node:http');
  const { layer } = makeHarness(t);
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    try {
      server.close();
    } catch (_) {
      // already closed
    }
  });
  const built = buildSocketIo({
    dataLayer: layer,
    httpServer: server,
    options: { gateway: { sweepIntervalMs: 0 } },
  });
  try {
    assert.ok(built.io);
    assert.ok(built.gateway.handleConnection);
    assert.ok(built.gateway.CLIENT_EVENTS.includes('room:join'));
    assert.ok(built.gateway.CLIENT_EVENTS.includes('gateway:ping'));
  } finally {
    built.gateway.stopSweep();
    await new Promise((resolve) => built.io.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  }
});