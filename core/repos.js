'use strict';
const {
  DataError,
  ok,
  nowIso,
  genId,
  safeMeta,
  parseRow,
  toDataError,
} = require('./db');

const USER_ROLES = ['player', 'admin', 'support'];
const USER_STATUSES = ['active', 'blocked', 'disabled'];
const WALLET_STATUSES = ['active', 'locked', 'closed'];
const GAME_KINDS = ['domino', 'loto', 'rami'];
const GAME_STATUSES = ['scheduled', 'active', 'finished', 'cancelled'];
const ROOM_STATUSES = ['waiting', 'active', 'closed'];
const AUDIT_ACTOR_TYPES = ['user', 'system'];

const USERNAME_RE = /^[A-Za-z0-9_.]{3,32}$/;
const PHONE_RE = /^\+?[0-9]{8,15}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const CRYPTO_WALLET_PROVIDERS = ['metamask', 'trust_wallet', 'coinbase_wallet', 'walletconnect', 'ledger', 'trezor', 'other'];
const CRYPTO_WALLET_ASSET_NETWORKS = {
  BTC: ['bitcoin'],
  ETH: ['ethereum'],
  USDT: ['ethereum', 'tron', 'polygon'],
  USDC: ['ethereum', 'polygon', 'solana'],
  SOL: ['solana'],
};

function buildRepositories(db) {
  function createUser(input) {
    const username = String(input && input.username || '').trim();
    const phone = input && input.phone ? String(input.phone).trim() : null;
    const email = input && input.email ? String(input.email).trim() : null;
    const displayName = input && input.displayName ? String(input.displayName).trim() : null;
    const role = (input && input.role) || 'player';
    const status = (input && input.status) || 'active';
    ok(USERNAME_RE.test(username), 'E_ARG', 'invalid username (3-32 chars, alnum/_/.)');
    if (phone !== null) ok(PHONE_RE.test(phone), 'E_ARG', 'invalid phone');
    if (email !== null) ok(EMAIL_RE.test(email), 'E_ARG', 'invalid email');
    ok(USER_ROLES.includes(role), 'E_ARG', 'invalid role: ' + role);
    ok(USER_STATUSES.includes(status), 'E_ARG', 'invalid user status');
    const id = genId();
    const ts = nowIso();
    try {
      db.prepare(
        `INSERT INTO users (id, username, phone, email, display_name, role, status, password_hash, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      ).run(id, username, phone, email, displayName, role, status, input.passwordHash || null, ts, ts);
    } catch (err) {
      throw toDataError(err, 'E_USER_CREATE', 'user create failed');
    }
    return getById(id);
  }

  function getById(id) {
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    ok(row, 'E_NO_USER', 'user not found: ' + id);
    return row;
  }

  function findByUsername(username) {
    return db.prepare('SELECT * FROM users WHERE username = ?').get(String(username || '').trim()) || null;
  }

  function findByIdentity(identity) {
    const value = String(identity || '').trim();
    return (
      (USERNAME_RE.test(value)
        ? db.prepare('SELECT * FROM users WHERE username = ?').get(value)
        : undefined) ||
      (EMAIL_RE.test(value)
        ? db.prepare('SELECT * FROM users WHERE email = ?').get(value)
        : undefined) ||
      (PHONE_RE.test(value)
        ? db.prepare('SELECT * FROM users WHERE phone = ?').get(value)
        : undefined) ||
      null
    );
  }

  function setStatus(id, status) {
    ok(USER_STATUSES.includes(status), 'E_ARG', 'invalid user status');
    const row = getById(id);
    const ts = nowIso();
    db.prepare('UPDATE users SET status = ?, updated_at = ? WHERE id = ?').run(status, ts, id);
    return { ...row, status, updated_at: ts };
  }

  function listUsers(options = {}) {
    const limit = Number.isSafeInteger(options.limit) ? options.limit : 100;
    const offset = Number.isSafeInteger(options.offset) ? options.offset : 0;
    return db.prepare('SELECT * FROM users ORDER BY created_at ASC LIMIT ? OFFSET ?').all(limit, offset);
  }

  function createWallet(userId, input = {}) {
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    ok(row, 'E_NO_USER', 'user not found: ' + userId);
    const currency = input.currency || 'MGA';
    ok(currency === 'MGA', 'E_ARG', 'unsupported currency: ' + currency);
    const id = genId();
    const ts = nowIso();
    try {
      db.prepare(
        'INSERT INTO wallets (id, user_id, currency, balance_milli, version, status, created_at, updated_at) VALUES (?,?,?,0,0,?,?,?)',
      ).run(id, userId, currency, 'active', ts, ts);
    } catch (err) {
      throw toDataError(err, 'E_WALLET_CREATE', 'wallet create failed');
    }
    return getWallet(id);
  }

  function getWallet(id) {
    const row = db.prepare('SELECT * FROM wallets WHERE id = ?').get(id);
    ok(row, 'E_NO_WALLET', 'wallet not found: ' + id);
    return row;
  }

  function getWalletByUser(userId) {
    const row = db.prepare('SELECT * FROM wallets WHERE user_id = ?').get(userId);
    ok(row, 'E_NO_WALLET', 'wallet not found for user: ' + userId);
    return row;
  }

  function listWallets(options = {}) {
    const limit = Number.isSafeInteger(options.limit) ? options.limit : 100;
    const offset = Number.isSafeInteger(options.offset) ? options.offset : 0;
    return db.prepare('SELECT * FROM wallets ORDER BY created_at ASC LIMIT ? OFFSET ?').all(limit, offset);
  }

  function setWalletStatus(id, status) {
    ok(WALLET_STATUSES.includes(status), 'E_ARG', 'invalid wallet status');
    const row = getWallet(id);
    if (row.status === 'closed') {
      throw new DataError('E_WALLET_CLOSED', 'wallet is closed and cannot change status');
    }
    const ts = nowIso();
    db.prepare('UPDATE wallets SET status = ?, updated_at = ?, version = version + 1 WHERE id = ?').run(status, ts, id);
    return { ...row, status, updated_at: ts };
  }

  function createCryptoWallet(userId, input = {}) {
    getById(userId);
    const provider = String(input.provider || '').trim().toLowerCase();
    const asset = String(input.asset || '').trim().toUpperCase();
    const network = String(input.network || '').trim().toLowerCase();
    const address = String(input.address || '').trim();
    const memo = input.addressMemo === undefined || input.addressMemo === null ? null : String(input.addressMemo).trim();
    const label = input.label === undefined || input.label === null ? null : String(input.label).trim();

    ok(CRYPTO_WALLET_PROVIDERS.includes(provider), 'E_CRYPTO_WALLET_INVALID', 'unsupported wallet provider: ' + provider);
    ok(Object.prototype.hasOwnProperty.call(CRYPTO_WALLET_ASSET_NETWORKS, asset), 'E_CRYPTO_WALLET_INVALID', 'unsupported crypto asset: ' + asset);
    ok(CRYPTO_WALLET_ASSET_NETWORKS[asset].includes(network), 'E_CRYPTO_WALLET_INVALID', 'network is not supported for ' + asset);
    ok(address.length >= 20 && address.length <= 160, 'E_CRYPTO_WALLET_INVALID', 'invalid wallet address length');
    if (memo !== null) ok(memo.length <= 120, 'E_CRYPTO_WALLET_INVALID', 'wallet memo too long');
    if (label !== null) ok(label.length <= 80, 'E_CRYPTO_WALLET_INVALID', 'wallet label too long');

    const id = genId();
    const ts = nowIso();
    try {
      db.prepare(
        `INSERT INTO crypto_wallets
          (id, user_id, provider, asset, network, address, address_memo, label, status, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(id, userId, provider, asset, network, address, memo || null, label || null, 'active', ts, ts);
    } catch (err) {
      throw toDataError(err, 'E_CRYPTO_WALLET_CREATE', 'crypto wallet create failed');
    }
    return getCryptoWallet(id);
  }

  function getCryptoWallet(id) {
    const row = db.prepare('SELECT * FROM crypto_wallets WHERE id = ?').get(String(id || ''));
    ok(row, 'E_CRYPTO_WALLET_NOT_FOUND', 'crypto wallet not found: ' + id);
    return row;
  }

  function listCryptoWallets(userId, options = {}) {
    getById(userId);
    const limit = Number.isSafeInteger(options.limit) ? Math.min(Math.max(options.limit, 1), 100) : 100;
    const offset = Number.isSafeInteger(options.offset) && options.offset >= 0 ? options.offset : 0;
    return db
      .prepare(
        "SELECT * FROM crypto_wallets WHERE user_id = ? AND status = 'active' ORDER BY created_at ASC, id ASC LIMIT ? OFFSET ?",
      )
      .all(userId, limit, offset);
  }

  function disableCryptoWallet(userId, id) {
    const wallet = getCryptoWallet(id);
    ok(wallet.user_id === userId, 'E_FORBIDDEN', 'crypto wallet does not belong to this user');
    if (wallet.status === 'disabled') return wallet;
    const ts = nowIso();
    db.prepare('UPDATE crypto_wallets SET status = ?, updated_at = ? WHERE id = ?').run('disabled', ts, id);
    return getCryptoWallet(id);
  }

  function createGame(input) {
    const kind = input && input.kind;
    const status = (input && input.status) || 'scheduled';
    ok(GAME_KINDS.includes(kind), 'E_ARG', 'invalid game kind: ' + kind);
    ok(GAME_STATUSES.includes(status), 'E_ARG', 'invalid game status');
    const id = genId();
    const ts = nowIso();
    db.prepare(
      'INSERT INTO games (id, kind, status, config_json, created_at, updated_at) VALUES (?,?,?,?,?,?)',
    ).run(id, kind, status, safeMeta(input.config), ts, ts);
    return getGame(id);
  }

  function getGame(id) {
    const row = db.prepare('SELECT * FROM games WHERE id = ?').get(id);
    ok(row, 'E_NO_GAME', 'game not found: ' + id);
    return parseRow(row);
  }

  function setGameStatus(id, status) {
    ok(GAME_STATUSES.includes(status), 'E_ARG', 'invalid game status');
    const row = getGame(id);
    if (row.status === 'finished' || row.status === 'cancelled') {
      throw new DataError('E_GAME_CLOSED', 'game is already ' + row.status);
    }
    const ts = nowIso();
    db.prepare('UPDATE games SET status = ?, updated_at = ? WHERE id = ?').run(status, ts, id);
    return { ...row, status, updated_at: ts };
  }

  function listGames(options = {}) {
    const limit = Number.isSafeInteger(options.limit) ? options.limit : 100;
    const offset = Number.isSafeInteger(options.offset) ? options.offset : 0;
    const status = options.status;
    if (status) {
      return db
        .prepare('SELECT * FROM games WHERE status = ? ORDER BY created_at ASC LIMIT ? OFFSET ?')
        .all(status, limit, offset)
        .map(parseRow);
    }
    return db.prepare('SELECT * FROM games ORDER BY created_at ASC LIMIT ? OFFSET ?').all(limit, offset).map(parseRow);
  }

  function createRoom(input) {
    const name = String(input && input.name || '');
    const gameId = input && input.gameId;
    const hostUserId = input && input.hostUserId;
    const capacity = input && input.capacity !== undefined ? input.capacity : 4;
    ok(name.length >= 1 && name.length <= 60, 'E_ARG', 'room name required (max 60 chars)');
    getGame(gameId);
    getById(hostUserId);
    ok(Number.isInteger(capacity) && capacity >= 1 && capacity <= 30, 'E_ARG', 'capacity 1..30');
    const id = genId();
    const ts = nowIso();
    db.prepare(
      'INSERT INTO rooms (id, game_id, name, host_user_id, capacity, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
    ).run(id, gameId, name, hostUserId, capacity, 'waiting', ts, ts);
    return getRoom(id);
  }

  function getRoom(id) {
    const row = db.prepare('SELECT * FROM rooms WHERE id = ?').get(id);
    ok(row, 'E_NO_ROOM', 'room not found: ' + id);
    return row;
  }

  function setRoomStatus(id, status) {
    ok(ROOM_STATUSES.includes(status), 'E_ARG', 'invalid room status');
    const row = getRoom(id);
    if (row.status === 'closed') {
      throw new DataError('E_ROOM_CLOSED', 'room is already closed');
    }
    const ts = nowIso();
    db.prepare('UPDATE rooms SET status = ?, updated_at = ? WHERE id = ?').run(status, ts, id);
    return { ...row, status, updated_at: ts };
  }

  function activePlayers(db, roomId) {
    return db.prepare(
      'SELECT seat FROM room_players WHERE room_id = ? AND left_at IS NULL ORDER BY seat ASC',
    ).all(roomId);
  }

  function joinRoom(roomId, userId) {
    const room = getRoom(roomId);
    ok(rowExists(userId), 'E_REFERENCE', 'user not found: ' + userId);
    ok(room.status !== 'closed', 'E_ROOM_CLOSED', 'room is closed');
    const existingRow = db
      .prepare('SELECT * FROM room_players WHERE room_id = ? AND user_id = ?')
      .get(roomId, userId);
    if (existingRow && existingRow.left_at === null) {
      throw new DataError('E_ALREADY_JOINED', 'user already in room');
    }
    const active = activePlayers(db, roomId);
    if (active.length >= room.capacity) {
      throw new DataError('E_ROOM_FULL', 'room is full');
    }
    const ts = nowIso();
    if (existingRow) {
      db.prepare('UPDATE room_players SET left_at = NULL, joined_at = ? WHERE room_id = ? AND user_id = ?').run(
        ts,
        roomId,
        userId,
      );
      return roomPlayers(roomId);
    }
    const usedSeats = db
      .prepare('SELECT seat FROM room_players WHERE room_id = ? ORDER BY seat ASC')
      .all(roomId)
      .map((r) => r.seat);
    let seat = 1;
    while (usedSeats.includes(seat) && seat <= room.capacity) seat += 1;
    if (seat > room.capacity) {
      throw new DataError('E_ROOM_FULL', 'no seat available');
    }
    try {
      db.prepare(
        'INSERT INTO room_players (room_id, user_id, seat, joined_at, left_at) VALUES (?,?,?,?,NULL)',
      ).run(roomId, userId, seat, ts);
    } catch (err) {
      throw toDataError(err, 'E_ROOM_JOIN', 'join failed');
    }
    return roomPlayers(roomId);
  }

  function rowExists(userId) {
    return !!db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId);
  }

  function leaveRoom(roomId, userId) {
    const ts = nowIso();
    const res = db
      .prepare('UPDATE room_players SET left_at = ? WHERE room_id = ? AND user_id = ? AND left_at IS NULL')
      .run(ts, roomId, userId);
    ok(res.changes === 1, 'E_NOT_IN_ROOM', 'user is not in room');
    return roomPlayers(roomId);
  }

  function roomPlayers(roomId) {
    return db
      .prepare('SELECT * FROM room_players WHERE room_id = ? AND left_at IS NULL ORDER BY seat ASC')
      .all(roomId);
  }

  function listRooms(options = {}) {
    const limit = Number.isSafeInteger(options.limit) ? options.limit : 100;
    const offset = Number.isSafeInteger(options.offset) ? options.offset : 0;
    const status = options.status;
    if (status) {
      return db
        .prepare('SELECT * FROM rooms WHERE status = ? ORDER BY created_at ASC LIMIT ? OFFSET ?')
        .all(status, limit, offset)
        .map((r) => ({ ...r, players: activePlayers(db, r.id).length }));
    }
    return db
      .prepare('SELECT * FROM rooms ORDER BY created_at ASC LIMIT ? OFFSET ?')
      .all(limit, offset)
      .map((r) => ({ ...r, players: activePlayers(db, r.id).length }));
  }

  function recordAudit(input) {
    const actorType = input && input.actorType;
    const action = String(input && input.action || '');
    const targetType = String(input && input.targetType || '');
    ok(AUDIT_ACTOR_TYPES.includes(actorType), 'E_ARG', 'invalid actor_type: ' + actorType);
    ok(action.length >= 1 && action.length <= 80, 'E_ARG', 'action required');
    ok(targetType.length >= 1 && targetType.length <= 40, 'E_ARG', 'target_type required');
    const id = genId();
    db.prepare(
      'INSERT INTO audit_entries (id, actor_type, actor_id, action, target_type, target_id, detail_json, ledger_hash, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    ).run(
      id,
      actorType,
      input.actorId || null,
      action,
      targetType,
      input.targetId || null,
      safeMeta(input.detail),
      input.ledgerHash || null,
      nowIso(),
    );
    return getAudit(id);
  }

  function getAudit(id) {
    return parseRow(db.prepare('SELECT * FROM audit_entries WHERE id = ?').get(id));
  }

  function listAudit(options = {}) {
    const limit = Number.isSafeInteger(options.limit) ? options.limit : 100;
    const offset = Number.isSafeInteger(options.offset) ? options.offset : 0;
    let sql = 'SELECT * FROM audit_entries';
    const where = [];
    const params = [];
    if (options.targetType) {
      where.push('target_type = ?');
      params.push(String(options.targetType));
    }
    if (options.targetId) {
      where.push('target_id = ?');
      params.push(String(options.targetId));
    }
    if (options.actorId) {
      where.push('actor_id = ?');
      params.push(String(options.actorId));
    }
    if (options.actorType) {
      where.push('actor_type = ?');
      params.push(String(options.actorType));
    }
    if (where.length) sql += ' WHERE ' + where.join(' AND ');
    sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);
    return db.prepare(sql).all(...params).map(parseRow);
  }

  return {
    createUser,
    getById,
    findByUsername,
    findByIdentity,
    setUserStatus: setStatus,
    listUsers,
    createWallet,
    getWallet,
    getWalletByUser,
    listWallets,
    setWalletStatus,
    createCryptoWallet,
    getCryptoWallet,
    listCryptoWallets,
    disableCryptoWallet,
    createGame,
    getGame,
    setGameStatus,
    listGames,
    createRoom,
    getRoom,
    setRoomStatus,
    joinRoom,
    leaveRoom,
    roomPlayers,
    listRooms,
    recordAudit,
    getAudit,
    listAudit,
  };
}

module.exports = {
  buildRepositories,
  USER_ROLES,
  USER_STATUSES,
  WALLET_STATUSES,
  GAME_KINDS,
  GAME_STATUSES,
  ROOM_STATUSES,
  AUDIT_ACTOR_TYPES,
  CRYPTO_WALLET_PROVIDERS,
  CRYPTO_WALLET_ASSET_NETWORKS,
};