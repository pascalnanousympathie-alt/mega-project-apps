'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { makeDataLayer, makeUser, expectDataError } = require('./helpers');

test('creates and transitions a game', (t) => {
  const { layer } = makeDataLayer(t);
  const game = layer.createGame({ kind: 'loto', config: { balls: 90, perRow: 5 } });
  assert.equal(game.kind, 'loto');
  assert.deepEqual(game.config, { balls: 90, perRow: 5 });
  assert.equal(layer.getGame(game.id).status, 'scheduled');
  layer.setGameStatus(game.id, 'active');
  layer.setGameStatus(game.id, 'finished');
  expectDataError(() => layer.setGameStatus(game.id, 'active'), 'E_GAME_CLOSED');
  expectDataError(() => layer.createGame({ kind: 'poker' }), 'E_ARG');
  expectDataError(() => layer.createGame({ kind: 'domino', status: 'bogus' }), 'E_ARG');
});

test('lists games filtered by status', (t) => {
  const { layer } = makeDataLayer(t);
  const a = layer.createGame({ kind: 'domino' });
  const b = layer.createGame({ kind: 'rami' });
  layer.setGameStatus(b.id, 'active');
  const active = layer.listGames({ status: 'active' });
  assert.equal(active.length, 1);
  assert.equal(active[0].id, b.id);
  assert.equal(layer.listGames().length, 2);
  assert.equal(layer.getGame(a.id).status, 'scheduled');
});

test('creates a room and joins players up to capacity', (t) => {
  const { layer } = makeDataLayer(t);
  const host = makeUser(layer, 'host_room');
  const game = layer.createGame({ kind: 'domino', config: { tiles: 28 } });
  const room = layer.createRoom({ gameId: game.id, hostUserId: host.id, name: 'Table 1', capacity: 2 });
  assert.equal(room.capacity, 2);
  assert.equal(room.status, 'waiting');
  const p2 = makeUser(layer, 'room_p2');
  const p3 = makeUser(layer, 'room_p3');
  layer.joinRoom(room.id, host.id);
  layer.joinRoom(room.id, p2.id);
  expectDataError(() => layer.joinRoom(room.id, p3.id), 'E_ROOM_FULL');
  expectDataError(() => layer.joinRoom(room.id, host.id), 'E_ALREADY_JOINED');
  assert.equal(layer.roomPlayers(room.id).length, 2);
  assert.equal(layer.listRooms()[0].players, 2);
});

test('seat is released on leave and reused on rejoin', (t) => {
  const { layer } = makeDataLayer(t);
  const host = makeUser(layer, 'seat_host');
  const p2 = makeUser(layer, 'seat_p2');
  const game = layer.createGame({ kind: 'domino' });
  const room = layer.createRoom({ gameId: game.id, hostUserId: host.id, name: 'S', capacity: 3 });
  assert.equal(layer.joinRoom(room.id, host.id)[0].seat, 1);
  layer.joinRoom(room.id, p2.id);
  assert.equal(layer.roomPlayers(room.id).find((p) => p.user_id === p2.id).seat, 2);
  layer.leaveRoom(room.id, p2.id);
  expectDataError(() => layer.leaveRoom(room.id, p2.id), 'E_NOT_IN_ROOM');
  assert.equal(layer.roomPlayers(room.id).length, 1);
  layer.joinRoom(room.id, p2.id);
  const players = layer.roomPlayers(room.id);
  assert.equal(players.length, 2);
  assert.equal(players.find((p) => p.user_id === p2.id).seat, 2);
});

test('room lifecycle rules', (t) => {
  const { layer } = makeDataLayer(t);
  const host = makeUser(layer, 'life_host');
  const game = layer.createGame({ kind: 'rami' });
  const room = layer.createRoom({ gameId: game.id, hostUserId: host.id, name: 'L', capacity: 4 });
  layer.setRoomStatus(room.id, 'active');
  layer.setRoomStatus(room.id, 'closed');
  expectDataError(() => layer.setRoomStatus(room.id, 'waiting'), 'E_ROOM_CLOSED');
  const late = makeUser(layer, 'life_late');
  expectDataError(() => layer.joinRoom(room.id, late.id), 'E_ROOM_CLOSED');
  expectDataError(
    () => layer.createRoom({ gameId: 'no-game', hostUserId: host.id, name: 'X' }),
    'E_NO_GAME',
  );
  expectDataError(
    () => layer.createRoom({ gameId: game.id, hostUserId: 'no-user', name: 'Y' }),
    'E_NO_USER',
  );
  expectDataError(() => layer.createRoom({ gameId: game.id, hostUserId: host.id, capacity: 0, name: 'Z' }), 'E_ARG');
});