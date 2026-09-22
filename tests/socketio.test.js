'use strict';
// P18 — gateway transport binding (core/socketio.js) driven over a real websocket.
//
// The gateway logic itself is covered by tests/gateway.test.js with an
// in-memory socket double. This file covers the socket.io binding used by
// server/boot.js: option wiring, the auth middleware, and a genuine
// engine.io/socket.io handshake driven by a minimal protocol client built on
// the global WebSocket.
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { Server } = require('socket.io');
const { buildSocketIo, buildGateway, createServer, socketAuthMiddleware } = require('../core');
const { makeDataLayer } = require('./helpers');

const PW = 'S3cretpass!';
const WAIT_MS = 5000;

// ------------------------------------------------------------------ client ----
// Minimal socket.io v4 client over engine.io v4 websocket framing:
// engine.io: '0' open, '4' message; socket.io inside the message:
// '0' connect, '2' event, '4' connect_error, '1' disconnect.
function decodeFrames(frame) {
  const packets = [];
  for (const part of String(frame).split('\u001e')) {
    if (!part) continue;
    if (part[0] === '0') {
      packets.push({ kind: 'open', data: JSON.parse(part.slice(1)) });
      continue;
    }
    if (part[0] !== '4') continue; // ping/pong/close frames carry no assertion target
    const body = part.slice(1);
    const type = body[0];
    const rest = body.slice(1);
    const jsonStart = rest.search(/[[{]/);
    const payload = jsonStart >= 0 ? rest.slice(jsonStart) : '';
    if (type === '0') packets.push({ kind: 'connect', data: payload ? JSON.parse(payload) : null });
    else if (type === '1') packets.push({ kind: 'disconnect', data: payload || null });
    else if (type === '4') packets.push({ kind: 'connect_error', data: payload ? JSON.parse(payload) : null });
    else if (type === '2') {
      const [event, data] = JSON.parse(payload);
      packets.push({ kind: 'event', event, data });
    }
  }
  return packets;
}

function describeMatch(match) {
  if (!match || match.kind === undefined) return 'packet';
  return match.kind === 'event' ? 'event ' + match.event : match.kind;
}

function createClient(url) {
  const ws = new WebSocket(url);
  const queue = [];
  const waiters = [];
  let failure = null;

  function settle() {
    for (let i = 0; i < waiters.length; i += 1) {
      const waiter = waiters[i];
      const index = queue.findIndex(waiter.match);
      if (index >= 0) {
        const packet = queue.splice(index, 1)[0];
        waiters.splice(i, 1);
        i -= 1;
        clearTimeout(waiter.timer);
        waiter.resolve(packet);
      } else if (failure) {
        waiters.splice(i, 1);
        i -= 1;
        clearTimeout(waiter.timer);
        waiter.reject(failure);
      }
    }
  }

  function fail(err) {
    if (!failure) failure = err;
    settle();
  }

  ws.addEventListener('message', (event) => {
    for (const packet of decodeFrames(event.data)) queue.push(packet);
    settle();
  });
  ws.addEventListener('error', () => fail(new Error('websocket error')));
  ws.addEventListener('close', () => fail(new Error('websocket closed')));

  function waitFor(match, timeoutMs = WAIT_MS) {
    return new Promise((resolve, reject) => {
      const waiter = { match, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error('timeout waiting for ' + describeMatch(match)));
      }, timeoutMs);
      waiters.push(waiter);
      settle();
    });
  }

  return {
    ws,
    open: () => waitFor((p) => p.kind === 'open'),
    handshake: (auth) => {
      ws.send('40' + JSON.stringify(auth));
      return waitFor((p) => p.kind === 'connect' || p.kind === 'connect_error');
    },
    emit: (event, payload) => ws.send('42' + JSON.stringify([event, payload])),
    event: (name) => waitFor((p) => p.kind === 'event' && p.event === name),
    close: () => {
      try {
        ws.close();
      } catch (_) {
        // already closed
      }
    },
  };
}

async function waitUntil(predicate, timeoutMs = WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return predicate();
}

// ------------------------------------------------------------------ harness ---

async function makeServer(t, options = {}) {
  const { layer } = makeDataLayer(t);
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const built = buildSocketIo({
    dataLayer: layer,
    httpServer: server,
    options: { gateway: { sweepIntervalMs: 0, ...(options.gateway || {}) } },
  });
  t.after(async () => {
    built.gateway.stopSweep();
    await new Promise((resolve) => built.io.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  });
  const url = 'ws://127.0.0.1:' + server.address().port + '/socket.io/?EIO=4&transport=websocket';
  return { layer, server, built, url };
}

function makePlayer(t, layer, url, username) {
  const user = layer.auth.register({ username, password: PW, role: 'player' });
  const { token } = layer.auth.createSession(user.id);
  const client = createClient(url);
  t.after(() => client.close());
  return { user, token, client };
}

// -------------------------------------------------------------------- tests ---

test('buildSocketIo refuses to build without a data layer', () => {
  assert.throws(() => buildSocketIo({}), /requires a dataLayer/);
  assert.throws(() => buildSocketIo(), /requires a dataLayer/);
});

test('createServer applies socket.io defaults, options and reuses instances', async (t) => {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const io = createServer(server);
  t.after(() => {
    try {
      io.close();
    } catch (_) {
      // already closed
    }
    server.close();
  });
  assert.ok(io instanceof Server);
  assert.equal(io._opts.path, '/socket.io');
  assert.equal(io._opts.pingInterval, 25000);
  assert.equal(io._opts.pingTimeout, 20000);
  assert.equal(io._opts.maxHttpBufferSize, 1000000);

  // An already-built server is handed back untouched, options are not re-applied.
  const custom = new Server(server, { path: '/socket.io' });
  const reuse = createServer(custom, { pingInterval: 1234 });
  assert.equal(reuse, custom);
  assert.equal(reuse._opts.pingInterval, undefined);
  custom.close();

  const overridden = createServer(server, { path: '/realtime', maxHttpBufferSize: 4096 });
  assert.ok(overridden instanceof Server);
  assert.equal(overridden._opts.path, '/realtime');
  assert.equal(overridden._opts.maxHttpBufferSize, 4096);
  overridden.close();
});

test('socket auth middleware forwards the session and rejects anonymous handshakes', (t) => {
  const { layer } = makeDataLayer(t);
  const user = layer.auth.register({ username: 'mw_ws_user', password: PW });
  const { token } = layer.auth.createSession(user.id);
  const middleware = socketAuthMiddleware(layer.auth);

  const results = [];
  middleware({ handshake: {}, data: {} }, (...args) => results.push(args));
  assert.ok(results[0][0] instanceof Error);
  assert.equal(results[0][0].message, 'E_ARG');

  const socket = { handshake: { auth: { token, resumeToken: 'resume-abc' } }, data: {} };
  middleware(socket, (...args) => results.push(args));
  // next() with no arguments signals acceptance.
  assert.deepEqual(results[1], []);
  assert.equal(socket.data.user.id, user.id);
  assert.ok(socket.data.session.id);
  assert.equal(socket.data.resumeToken, 'resume-abc');

  const loose = { handshake: { auth: { token, resumeToken: 42 } }, data: {} };
  middleware(loose, () => {});
  assert.equal(loose.data.resumeToken, null);

  const revoked = layer.auth.createSession(user.id).token;
  layer.auth.revokeSession(revoked);
  middleware({ handshake: { auth: { token: revoked } }, data: {} }, (...args) => results.push(args));
  assert.equal(results[results.length - 1][0].message, 'E_SESSION_REVOKED');

  const direct = { handshake: undefined };
  middleware(direct, (...args) => results.push(args));
  assert.equal(results[results.length - 1][0].message, 'E_ARG');
});

test('realtime gateway drives a real websocket session end to end', async (t) => {
  const clock = { t: 1_800_000_000_000 };
  const { layer, built, url } = await makeServer(t, {
    gateway: { now: () => clock.t, graceMs: 30000 },
  });
  const player = makePlayer(t, layer, url, 'ws_player');
  const game = layer.createGame({ kind: 'domino' });
  const room = layer.createRoom({ gameId: game.id, hostUserId: player.user.id, name: 'WS Table' });

  await player.client.open();
  const handshake = await player.client.handshake({ token: player.token, resumeToken: null });
  assert.equal(handshake.kind, 'connect');
  assert.ok(handshake.data.sid);

  const connected = await player.client.event('connected');
  assert.equal(connected.data.user_id, player.user.id);
  assert.equal(connected.data.resumed, false);
  assert.ok(connected.data.reconnect_token.length >= 32);

  player.client.emit('gateway:ping', {});
  const pong = await player.client.event('gateway:pong');
  assert.equal(pong.data.ts, clock.t);

  player.client.emit('room:join', { roomId: room.id });
  const joined = await player.client.event('room:joined');
  assert.equal(joined.data.room.id, room.id);
  assert.equal(joined.data.players.length, 1);
  assert.equal(joined.data.players[0].user_id, player.user.id);
  assert.equal(joined.data.players[0].seat, 1);

  const presence = await player.client.event('room:presence');
  assert.equal(presence.data.room_id, room.id);
  assert.deepEqual(built.gateway.usersInRoom(room.id), [player.user.id]);
  assert.equal(built.gateway.stats().connected, 1);
  assert.ok(layer.listAudit({ targetType: 'room', targetId: room.id }).some((e) => e.action === 'room.joined'));
  assert.ok(connected.data.connection_id);

  // Closing the socket must reach gateway.handleDisconnect through the binding.
  player.client.close();
  assert.ok(await waitUntil(() => built.gateway.stats().connected === 0));
  assert.equal(built.gateway.stats().away, 1);

  // The seat is only released when the reconnect grace window expires.
  clock.t += 30001;
  assert.ok(built.gateway.sweep() >= 1);
  assert.equal(built.gateway.stats().connections, 0);
  assert.equal(built.gateway.stats().away, 0);
  assert.deepEqual(built.gateway.usersInRoom(room.id), []);
});

test('realtime gateway rejects a websocket connection with an invalid token', async (t) => {
  const { built, url } = await makeServer(t);
  const client = createClient(url);
  t.after(() => client.close());

  await client.open();
  const rejected = await client.handshake({ token: 'not-a-real-token' });
  assert.equal(rejected.kind, 'connect_error');
  assert.equal(rejected.data.message, 'E_INVALID_TOKEN');
  // The middleware refuses before the gateway ever sees a connection.
  assert.equal(built.gateway.stats().connections, 0);
  assert.equal(built.gateway.stats().connected, 0);
});

test('buildSocketIo reuses an injected gateway and honors the sweep setting', async (t) => {
  const { layer, server } = await makeServer(t);
  const io = new Server(server, { path: '/socket.io' });
  t.after(() => {
    try {
      io.close();
    } catch (_) {
      // already closed
    }
  });
  const gateway = buildGateway({ db: layer.db, repos: layer, auth: layer.auth });
  let sweeps = 0;
  const realStartSweep = gateway.startSweep;
  gateway.startSweep = (ms) => {
    sweeps += 1;
    return realStartSweep(ms);
  };

  const disabled = buildSocketIo({
    dataLayer: layer,
    httpServer: io,
    gateway,
    options: { gateway: { sweepIntervalMs: 0 } },
  });
  assert.equal(disabled.gateway, gateway);
  assert.equal(disabled.io, io);
  assert.equal(sweeps, 0);

  const enabled = buildSocketIo({ dataLayer: layer, httpServer: io, gateway, options: {} });
  assert.equal(enabled.gateway, gateway);
  assert.equal(sweeps, 1);
  gateway.stopSweep();
});
