'use strict';
const crypto = require('node:crypto');
const { DataError, ok } = require('./db');
const { toSocketError, validateClientEvent } = require('./contracts');

const DEFAULT_GRACE_MS = 30000;
const DEFAULT_MAX_EVENTS_PER_MIN = 120;
const RATE_WINDOW_MS = 60000;
const EVENT_NAME_RE = /^[a-zA-Z][a-zA-Z0-9:_-]{0,63}$/;

const CLIENT_EVENTS = [
  'room:list',
  'room:join',
  'room:leave',
  'room:ready',
  'room:start',
  'room:close',
  'room:state',
  'gateway:ping',
  'game:event',
];

function buildGateway(deps) {
  const db = deps && deps.db;
  const repos = deps && deps.repos;
  const auth = deps && deps.auth;
  ok(db && repos && auth, 'E_ARG', 'gateway requires db, repos and auth');
  const options = (deps && deps.options) || {};

  const graceMs =
    Number.isFinite(options.graceMs) && options.graceMs >= 0 ? options.graceMs : DEFAULT_GRACE_MS;
  const maxEventsPerMin =
    Number.isInteger(options.maxEventsPerMin) && options.maxEventsPerMin > 0
      ? options.maxEventsPerMin
      : DEFAULT_MAX_EVENTS_PER_MIN;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const genToken =
    typeof options.genToken === 'function'
      ? options.genToken
      : () => crypto.randomBytes(32).toString('hex');

  const connections = new Map();
  const byUser = new Map();
  const roomStates = new Map();
  const rate = new Map();
  let sweepTimer = null;

  function connectionFor(socketId) {
    return connections.get(socketId) || null;
  }

  function emitToUser(userId, event, payload) {
    const socketId = byUser.get(userId);
    const rec = socketId ? connections.get(socketId) : null;
    if (rec && rec.socket) rec.socket.emit(event, payload);
    return rec ? rec.socket : null;
  }

  function broadcast(roomId, event, payload) {
    for (const rec of connections.values()) {
      if (rec.roomId === roomId && rec.connected && rec.socket) {
        rec.socket.emit(event, payload);
      }
    }
  }

  function socketsInRoom(roomId) {
    const out = [];
    for (const rec of connections.values()) {
      if (rec.roomId === roomId && rec.socket) out.push(rec.socket);
    }
    return out;
  }

  function usersInRoom(roomId) {
    return [...connections.values()]
      .filter((r) => r.roomId === roomId)
      .map((r) => r.userId);
  }

  function getRoomState(roomId) {
    let state = roomStates.get(roomId);
    if (!state) {
      state = { version: 0, status: 'waiting', ready: {}, startedAt: null, eventSeq: 0 };
      roomStates.set(roomId, state);
    }
    return state;
  }

  function bump(roomId) {
    const state = getRoomState(roomId);
    state.version += 1;
    return state;
  }

  function presenceOf(roomId, userId) {
    const socketId = byUser.get(userId);
    const rec = socketId ? connections.get(socketId) : null;
    if (!rec) return 'offline';
    if (rec.connected) return rec.roomId === roomId ? 'present' : 'offline';
    return rec.roomId === roomId ? 'away' : 'offline';
  }

  function roomSnapshot(roomId) {
    const room = repos.getRoom(roomId);
    const state = getRoomState(roomId);
    const players = repos.roomPlayers(roomId).map((p) => ({
      user_id: p.user_id,
      seat: p.seat,
      joined_at: p.joined_at,
      presence: presenceOf(roomId, p.user_id),
      ready: !!state.ready[p.user_id],
    }));
    return {
      room: {
        id: room.id,
        name: room.name,
        game_id: room.game_id,
        host_user_id: room.host_user_id,
        capacity: room.capacity,
        status: room.status,
        created_at: room.created_at,
        updated_at: room.updated_at,
      },
      players,
      present_count: players.filter((p) => p.presence === 'present').length,
      state: {
        version: state.version,
        status: state.status,
        started_at: state.startedAt,
        host_user_id: room.host_user_id,
        ready: state.ready,
      },
    };
  }

  function roomListPayload() {
    return repos
      .listRooms({ status: 'waiting' })
      .map((room) => {
        const state = getRoomState(room.id);
        return {
          id: room.id,
          name: room.name,
          game_id: room.game_id,
          host_user_id: room.host_user_id,
          capacity: room.capacity,
          status: room.status,
          players: room.players,
          state_version: state.version,
        };
      });
  }

  function auditRecord(rec, roomId, action, detail) {
    try {
      repos.recordAudit({
        actorType: 'user',
        actorId: rec.userId,
        action,
        targetType: 'room',
        targetId: roomId,
        detail,
      });
    } catch (_) {
      // audit must never break the gateway loop
    }
  }

  function removeRecord(rec, reason) {
    connections.delete(rec.id);
    if (byUser.get(rec.userId) === rec.id) byUser.delete(rec.userId);
    rate.delete(rec.id);
    void reason;
  }

  function finalizeConnection(rec, reason) {
    const roomId = rec.roomId;
    if (roomId) {
      try {
        repos.leaveRoom(roomId, rec.userId);
      } catch (_) {
        // seat already released
      }
      const state = getRoomState(roomId);
      delete state.ready[rec.userId];
      bump(roomId);
      broadcast(roomId, 'room:state', roomSnapshotSafe(roomId));
      broadcast(roomId, 'room:presence', presencePayloadSafe(roomId));
      auditRecord(rec, roomId, 'gateway.leave', { reason: reason || 'timeout' });
    }
    removeRecord(rec, reason);
  }

  function roomSnapshotSafe(roomId) {
    try {
      return roomSnapshot(roomId);
    } catch (_) {
      return null;
    }
  }

  function presencePayloadSafe(roomId) {
    try {
      return { room_id: roomId, players: roomSnapshot(roomId).players };
    } catch (_) {
      return null;
    }
  }

  function fail(socket, code, message) {
    try {
      socket.emit('error', toSocketError(new DataError(code || 'E_GATEWAY', message || 'gateway error')));
      socket.disconnect(true);
    } catch (_) {
      // socket may already be gone
    }
    return false;
  }

  function registerClientHandlers(socket) {
    for (const event of CLIENT_EVENTS) {
      socket.on(event, (payload) => handleEvent(socket.id, event, payload));
    }
  }

  function tryResume(userId, resumeToken) {
    const socketId = byUser.get(userId);
    const rec = socketId ? connections.get(socketId) : null;
    if (!rec) return null;
    if (rec.connected) return null;
    if (now() - rec.disconnectedAt > graceMs) return null;
    if (rec.reconnectToken && resumeToken !== rec.reconnectToken) return null;
    return rec;
  }

  function handleConnection(socket) {
    ok(socket && socket.id && typeof socket.id === 'string', 'E_ARG', 'socket id required');
    let authResult;
    try {
      authResult = auth.authenticateToken(socket.token);
    } catch (err) {
      return fail(socket, err.code, err.message);
    }
    const user = authResult.user;
    const session = authResult.session;

    let resumeToken = typeof socket.resumeToken === 'string' ? socket.resumeToken : null;
    const resume = tryResume(user.id, resumeToken);
    if (resume) {
      return rebind(socket, resume, user, session);
    }

    const existing = connections.get(byUser.get(user.id));
    if (existing && existing.connected) {
      return fail(socket, 'E_ALREADY_CONNECTED', 'user already has an active connection');
    }
    if (existing) {
      finalizeConnection(existing, 'superseded');
    }

    const record = {
      id: socket.id,
      userId: user.id,
      sessionId: session.id,
      ip: socket.ip || null,
      userAgent: socket.userAgent || null,
      socket,
      connected: true,
      disconnectedAt: null,
      roomId: null,
      reconnectToken: genToken(),
      lastEvent: now(),
      startedAt: now(),
    };
    connections.set(socket.id, record);
    byUser.set(user.id, socket.id);
    registerClientHandlers(socket);
    socket.emit('connected', {
      connection_id: socket.id,
      user_id: user.id,
      resumed: false,
      reconnect_token: record.reconnectToken,
    });
    return true;
  }

  function rebind(socket, rec, user, session) {
    if (rec.roomId) {
      try {
        const room = repos.getRoom(rec.roomId);
        if (room.status === 'closed') {
          rec.roomId = null;
        }
      } catch (_) {
        rec.roomId = null;
      }
    }
    connections.delete(rec.id);
    rate.delete(rec.id);
    rec.id = socket.id;
    rec.sessionId = session.id;
    rec.socket = socket;
    rec.connected = true;
    rec.disconnectedAt = null;
    rec.lastEvent = now();
    rec.reconnectToken = genToken();
    connections.set(socket.id, rec);
    byUser.set(user.id, socket.id);
    registerClientHandlers(socket);
    socket.emit('connected', {
      connection_id: socket.id,
      user_id: user.id,
      resumed: true,
      reconnect_token: rec.reconnectToken,
    });
    if (rec.roomId) {
      const snapshot = roomSnapshotSafe(rec.roomId);
      if (snapshot) socket.emit('room:state', snapshot);
      const presence = presencePayloadSafe(rec.roomId);
      if (presence) broadcast(rec.roomId, 'room:presence', presence);
      auditRecord(rec, rec.roomId, 'gateway.reconnected', { connection_id: socket.id });
    }
    return true;
  }

  function handleDisconnect(socketId) {
    const rec = connectionFor(socketId);
    if (!rec) return false;
    rec.connected = false;
    rec.disconnectedAt = now();
    rec.lastEvent = now();
    if (rec.roomId) {
      const presence = presencePayloadSafe(rec.roomId);
      if (presence) broadcast(rec.roomId, 'room:presence', presence);
      const state = getRoomState(rec.roomId);
      state.ready[rec.userId] = false;
      bump(rec.roomId);
      const snap = roomSnapshotSafe(rec.roomId);
      if (snap) broadcast(rec.roomId, 'room:state', snap);
    }
    return true;
  }

  function sweep() {
    const expired = [...connections.values()].filter(
      (r) => !r.connected && now() - r.disconnectedAt > graceMs,
    );
    for (const rec of expired) finalizeConnection(rec, 'timeout');
    return expired.length;
  }

  function startSweep(intervalMs) {
    stopSweep();
    const ms = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 5000;
    sweepTimer = setInterval(() => {
      try {
        sweep();
      } catch (_) {
        // keep the loop alive
      }
    }, ms);
    if (typeof sweepTimer.unref === 'function') sweepTimer.unref();
    return sweepTimer;
  }

  function stopSweep() {
    if (sweepTimer) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
  }

  function checkRate(socketId) {
    const t = now();
    let entry = rate.get(socketId);
    if (!entry || t - entry.start >= RATE_WINDOW_MS) {
      entry = { start: t, count: 0 };
      rate.set(socketId, entry);
    }
    entry.count += 1;
    if (entry.count > maxEventsPerMin) {
      throw new DataError('E_RATE_LIMITED', 'event rate limit exceeded');
    }
  }

  function requireConnected(socketId) {
    const rec = connectionFor(socketId);
    ok(rec && rec.connected, 'E_NOT_CONNECTED', 'socket is not connected');
    return rec;
  }

  function handleEvent(socketId, event, payload) {
    try {
      const rec = requireConnected(socketId);
      checkRate(socketId);
      rec.lastEvent = now();
      validateClientEvent(event, payload);
      return dispatchEvent(rec, event, payload);
    } catch (err) {
      const rec = connectionFor(socketId);
      if (rec && rec.socket) rec.socket.emit('error', toSocketError(err, { event }));
      return false;
    }
  }

  function requireInRoom(rec) {
    ok(rec.roomId, 'E_NOT_IN_ROOM', 'user is not in a room');
    return rec.roomId;
  }

  function dispatchEvent(rec, event, payload) {
    switch (event) {
      case 'gateway:ping':
        rec.socket.emit('gateway:pong', { ts: now() });
        return true;
      case 'room:list':
        rec.socket.emit('room:list', { rooms: roomListPayload() });
        return true;
      case 'room:state': {
        const roomId = requireInRoom(rec);
        rec.socket.emit('room:state', roomSnapshot(roomId));
        return true;
      }
      case 'room:join': {
        const roomId = payload && payload.roomId;
        ok(typeof roomId === 'string' && roomId.length > 0, 'E_ARG', 'roomId required');
        return doJoin(rec, roomId, (payload && payload.resume) === true);
      }
      case 'room:leave':
        return doLeave(rec);
      case 'room:ready': {
        const roomId = requireInRoom(rec);
        const ready = (payload && payload.ready) === true;
        const state = getRoomState(roomId);
        state.ready[rec.userId] = ready;
        bump(roomId);
        const snap = roomSnapshot(roomId);
        broadcast(roomId, 'room:state', snap);
        return true;
      }
      case 'room:start':
        return doStart(rec);
      case 'room:close':
        return doClose(rec);
      case 'game:event':
        return doGameEvent(rec, payload);
      default:
        throw new DataError('E_INVALID_EVENT', 'unknown event: ' + event);
    }
  }

  function doJoin(rec, roomId, resume) {
    const room = repos.getRoom(roomId);
    ok(room.status !== 'closed', 'E_ROOM_CLOSED', 'room is closed');
    if (rec.roomId && rec.roomId !== roomId) {
      leaveCurrentRoom(rec);
    }
    repos.joinRoom(roomId, rec.userId);
    rec.roomId = roomId;
    const state = getRoomState(roomId);
    if (!resume) {
      delete state.ready[rec.userId];
    } else {
      state.ready[rec.userId] = true;
    }
    bump(roomId);
    const snapshot = roomSnapshot(roomId);
    rec.socket.emit('room:joined', { ...snapshot, resume });
    broadcast(roomId, 'room:presence', { room_id: roomId, players: snapshot.players });
    broadcast(roomId, 'room:state', snapshot);
    auditRecord(rec, roomId, 'room.joined', { seat: seatOf(roomId, rec.userId), resume });
    return true;
  }

  function seatOf(roomId, userId) {
    const row = repos
      .roomPlayers(roomId)
      .find((p) => p.user_id === userId);
    return row ? row.seat : null;
  }

  function leaveCurrentRoom(rec) {
    const roomId = rec.roomId;
    if (!roomId) return;
    const seat = seatOf(roomId, rec.userId);
    try {
      repos.leaveRoom(roomId, rec.userId);
    } catch (_) {
      // already left
    }
    const state = getRoomState(roomId);
    delete state.ready[rec.userId];
    bump(roomId);
    rec.roomId = null;
    rec.socket.emit('room:left', { room_id: roomId, seat });
    const snap = roomSnapshotSafe(roomId);
    if (snap) broadcast(roomId, 'room:state', snap);
    const presence = presencePayloadSafe(roomId);
    if (presence) broadcast(roomId, 'room:presence', presence);
    auditRecord(rec, roomId, 'room.left', { seat });
  }

  function doLeave(rec) {
    requireInRoom(rec);
    leaveCurrentRoom(rec);
    return true;
  }

  function assertHost(rec, roomId) {
    const room = repos.getRoom(roomId);
    ok(room.host_user_id === rec.userId, 'E_FORBIDDEN', 'only the room host can do this');
    return room;
  }

  function doStart(rec) {
    const roomId = requireInRoom(rec);
    const room = assertHost(rec, roomId);
    ok(room.status !== 'closed', 'E_ROOM_CLOSED', 'room is closed');
    if (room.status !== 'active') {
      repos.setRoomStatus(roomId, 'active');
    }
    const state = getRoomState(roomId);
    state.status = 'active';
    state.startedAt = now();
    state.version = 0;
    bump(roomId);
    const snap = roomSnapshot(roomId);
    broadcast(roomId, 'room:started', snap);
    broadcast(roomId, 'room:state', snap);
    auditRecord(rec, roomId, 'room.started', {});
    return true;
  }

  function doClose(rec) {
    const roomId = requireInRoom(rec);
    const room = assertHost(rec, roomId);
    ok(room.status !== 'closed', 'E_ROOM_CLOSED', 'room is closed');
    for (const p of repos.roomPlayers(roomId)) {
      try {
        repos.leaveRoom(roomId, p.user_id);
      } catch (_) {
        // player already left
      }
    }
    if (room.status !== 'closed') {
      repos.setRoomStatus(roomId, 'closed');
    }
    const state = getRoomState(roomId);
    state.status = 'closed';
    state.version = 0;
    bump(roomId);
    const targets = socketsInRoom(roomId);
    for (const socket of targets) {
      const targetRec = connectionFor(socket.id);
      if (targetRec && targetRec.roomId === roomId) {
        targetRec.roomId = null;
        socket.emit('room:closed', { room_id: roomId });
      }
    }
    broadcast(roomId, 'room:state', roomSnapshotSafe(roomId));
    auditRecord(rec, roomId, 'room.closed', {});
    return true;
  }

  function doGameEvent(rec, payload) {
    const roomId = requireInRoom(rec);
    ok(payload && typeof payload === 'object', 'E_ARG', 'game event payload required');
    const handler = options.onGameEvent;
    ok(handler, 'E_NO_HANDLER', 'no game event handler configured');
    const result = handler(roomId, rec.userId, payload);
    if (result === undefined || result === null) return true;
    ok(result && typeof result === 'object', 'E_FORBIDDEN', 'game handler must return an object');
    const eventName = result.event;
    ok(typeof eventName === 'string' && EVENT_NAME_RE.test(eventName), 'E_FORBIDDEN', 'invalid game event name');
    const state = getRoomState(roomId);
    state.eventSeq += 1;
    const outPayload =
      result.payload && typeof result.payload === 'object' ? { ...result.payload, seq: state.eventSeq } : { seq: state.eventSeq };
    broadcast(roomId, eventName, outPayload);
    return true;
  }

  function gameBroadcast(roomId, eventName, payload) {
    ok(typeof roomId === 'string' && roomId.length > 0, 'E_ARG', 'roomId required');
    ok(typeof eventName === 'string' && EVENT_NAME_RE.test(eventName), 'E_FORBIDDEN', 'invalid game event name');
    const state = getRoomState(roomId);
    state.eventSeq += 1;
    const outPayload =
      payload && typeof payload === 'object' ? { ...payload, seq: state.eventSeq } : { seq: state.eventSeq };
    broadcast(roomId, eventName, outPayload);
    return state.eventSeq;
  }

  function stats() {
    let connected = 0;
    let away = 0;
    for (const rec of connections.values()) {
      if (rec.connected) connected += 1;
      else away += 1;
    }
    return {
      connections: connections.size,
      connected,
      away,
      rooms: roomStates.size,
      rate_limited: rate.size,
      grace_ms: graceMs,
      max_events_per_min: maxEventsPerMin,
    };
  }

  return {
    handleConnection,
    handleDisconnect,
    handleEvent,
    sweep,
    startSweep,
    stopSweep,
    emitToUser,
    broadcast,
    gameBroadcast,
    usersInRoom,
    roomSnapshot,
    stats,
    CLIENT_EVENTS,
  };
}

module.exports = {
  buildGateway,
  DEFAULT_GRACE_MS,
  DEFAULT_MAX_EVENTS_PER_MIN,
  CLIENT_EVENTS,
};