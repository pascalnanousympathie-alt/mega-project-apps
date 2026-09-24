'use strict';
const crypto = require('node:crypto');
const { DataError, ok, nowIso, genId, safeMeta, safeRollback } = require('./db');
const {
  fullSet,
  shuffle,
  newBoard,
  openEnds,
  playsFor,
  canPlayAny,
  applyPlay,
  handPips,
  highestDouble,
  highestSingle,
  canDraw,
  chooseBotAction,
  findTile,
  sortHand,
  makeTile,
  tileKey,
  pips,
} = require('./domino');

const MOVE_TYPES = ['deal', 'join', 'start', 'draw', 'play', 'pass', 'win', 'block', 'leave', 'cancel'];
const MATCH_STATUSES = ['scheduled', 'active', 'finished', 'cancelled'];
const IGNORED_CANONICAL = new Set(['version', 'startedAt', 'finishedAt']);
const BOT_PREFIX = 'bot:';

function canonicalJson(value, ignoreSet) {
  const seen = new Set();
  function clean(v, key) {
    if (v === undefined) return null;
    if (v === null) return null;
    if (typeof v === 'number') return v;
    if (typeof v === 'boolean') return v;
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) return v.map(clean);
    if (typeof v === 'object') {
      const out = {};
      const keys = Object.keys(v).sort();
      for (const k of keys) {
        if (ignoreSet && ignoreSet.has(k)) continue;
        if (k === 'hands') {
          out[k] = cleanOrdered(v[k]);
          continue;
        }
        out[k] = clean(v[k], k);
      }
      return out;
    }
    return null;
  }
  function cleanOrdered(map) {
    const out = {};
    for (const k of Object.keys(map).sort()) {
      out[k] = clean(map[k]);
    }
    return out;
  }
  return JSON.stringify(clean(value));
}

function sha256hex(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

function defaultHandSize(numPlayers) {
  return numPlayers <= 2 ? 7 : 5;
}

function isBot(userId) {
  return typeof userId === 'string' && userId.startsWith(BOT_PREFIX);
}

function normalizeTile(tile) {
  ok(tile && (Array.isArray(tile) || typeof tile === 'object'), 'E_ARG', 'tile required');
  const a = Array.isArray(tile) ? tile[0] : tile.a;
  const b = Array.isArray(tile) ? tile[1] : tile.b;
  return makeTile(a, b);
}

function freshState(m) {
  return {
    mode: m.mode,
    status: m.status,
    seed: m.seed,
    settings: m.settings,
    players: [],
    order: [],
    hands: {},
    boneyard: [],
    board: newBoard(),
    turnIndex: 0,
    currentUserId: null,
    passStreak: 0,
    firstUserId: null,
    winnerUserId: null,
    endReason: null,
    scores: [],
    version: 0,
    startedAt: null,
    finishedAt: null,
  };
}

function computeScores(st, winnerUserId) {
  const scored = st.players.map((p) => ({
    userId: p.userId,
    seat: p.seat,
    pips: handPips(st.hands[p.userId] || []),
  }));
  const sorted = scored.slice().sort((x, y) => x.pips - y.pips || x.seat - y.seat);
  const rankOf = (pipsValue) =>
    1 + sorted.filter((s) => s.pips < pipsValue).filter((s, i, a) => a.findIndex((t) => t.pips === s.pips) === i).length;
  return scored
    .map((s) => ({ userId: s.userId, pips: s.pips, rank: rankOf(s.pips) }))
    .map((s, idx) => ({ ...s, winner: winnerUserId ? s.userId === winnerUserId : idx === 0 }));
}

function determineStarter(st) {
  let best = null;
  for (const player of st.players) {
    const hand = st.hands[player.userId] || [];
    const dbl = highestDouble(hand);
    const single = highestSingle(hand);
    let score = null;
    if (dbl) score = 100 + dbl.a;
    else if (single) score = pips(single);
    if (score !== null && (best === null || score > best.score || (score === best.score && player.seat < best.seat))) {
      best = { userId: player.userId, seat: player.seat, score };
    }
  }
  return best ? best.userId : st.players[0].userId;
}

function applySpec(st, spec) {
  switch (spec.moveType) {
    case 'join': {
      if (st.players.some((p) => p.userId === spec.userId)) return;
      const player = {
        userId: spec.userId,
        seat: spec.seat,
        kind: spec.kind || (isBot(spec.userId) ? 'bot' : 'human'),
        name: spec.name || null,
      };
      st.players.push(player);
      st.order.push(spec.userId);
      st.hands[spec.userId] = [];
      st.version += 1;
      return;
    }
    case 'deal': {
      st.boneyard = shuffle(fullSet(), st.seed);
      const handSize = spec.handSize || defaultHandSize(st.players.length);
      for (const player of st.players) {
        st.hands[player.userId] = sortHand(st.boneyard.splice(0, handSize));
      }
      st.version += 1;
      return;
    }
    case 'start': {
      st.firstUserId = determineStarter(st);
      st.turnIndex = st.order.indexOf(st.firstUserId);
      st.currentUserId = st.firstUserId;
      st.passStreak = 0;
      st.status = 'active';
      st.startedAt = spec.startedAt || nowIso();
      st.version += 1;
      return;
    }
    case 'play': {
      const tile = normalizeTile({ a: spec.tile_a, b: spec.tile_b });
      ok(spec.side === 'left' || spec.side === 'right', 'E_ARG', 'invalid side');
      const hand = st.hands[spec.userId] || [];
      if (findTile(hand, tile) === null) {
        throw new DataError('E_TILE_NOT_IN_HAND', 'tile is not in the player hand');
      }
      st.board = applyPlay(st.board, tile, spec.side);
      st.hands[spec.userId] = hand.filter((t) => tileKey(t) !== tileKey(tile));
      st.passStreak = 0;
      advance(st);
      st.version += 1;
      if ((st.hands[spec.userId] || []).length === 0) {
        st.status = 'finished';
        st.winnerUserId = spec.userId;
        st.endReason = 'emptied';
        st.scores = computeScores(st, spec.userId);
        st.finishedAt = nowIso();
        st.version += 1;
      }
      return;
    }
    case 'draw': {
      const tile = normalizeTile({ a: spec.tile_a, b: spec.tile_b });
      const at = findTile(st.boneyard, tile);
      ok(at !== null, 'E_NO_TILE_TO_DRAW', 'drawn tile is not in the boneyard');
      st.boneyard.splice(at.index, 1);
      st.hands[spec.userId] = sortHand([...(st.hands[spec.userId] || []), tile]);
      st.passStreak = 0;
      advance(st);
      st.version += 1;
      return;
    }
    case 'pass': {
      st.passStreak += 1;
      advance(st);
      st.version += 1;
      if (st.passStreak >= st.players.length) {
        st.status = 'finished';
        st.endReason = 'blocked';
        st.scores = computeScores(st, null);
        st.winnerUserId = st.scores.find((s) => s.winner) ? st.scores.find((s) => s.winner).userId : null;
        st.finishedAt = nowIso();
        st.version += 1;
      }
      return;
    }
    case 'win': {
      st.status = 'finished';
      st.winnerUserId = spec.userId;
      st.endReason = 'emptied';
      st.scores = computeScores(st, spec.userId);
      st.finishedAt = nowIso();
      st.version += 1;
      return;
    }
    case 'block': {
      st.status = 'finished';
      st.endReason = 'blocked';
      st.scores = computeScores(st, null);
      st.winnerUserId = st.scores.find((s) => s.winner) ? st.scores.find((s) => s.winner).userId : null;
      st.finishedAt = nowIso();
      st.version += 1;
      return;
    }
    case 'leave': {
      const idx = st.order.indexOf(spec.userId);
      if (idx === -1) return;
      st.order.splice(idx, 1);
      st.players = st.players.filter((p) => p.userId !== spec.userId);
      delete st.hands[spec.userId];
      if (idx < st.turnIndex) st.turnIndex -= 1;
      if (st.turnIndex >= st.order.length) st.turnIndex = 0;
      st.currentUserId = st.order.length > 0 ? st.order[st.turnIndex] : null;
      st.version += 1;
      return;
    }
    case 'cancel': {
      st.status = 'cancelled';
      st.version += 1;
      return;
    }
    default:
      throw new DataError('E_ARG', 'unknown move_type: ' + spec.moveType);
  }
}

function advance(st) {
  if (st.order.length === 0) {
    st.turnIndex = 0;
    st.currentUserId = null;
    return;
  }
  st.turnIndex = (st.turnIndex + 1) % st.order.length;
  st.currentUserId = st.order[st.turnIndex];
}

function buildDominoGame(deps) {
  const db = deps && deps.db;
  const repos = deps && deps.repos;
  const gameWallet = (deps && deps.gameWallet) || null;
  ok(db, 'E_ARG', 'domino game requires db');
  ok(repos, 'E_ARG', 'domino game requires repos');

  function getMatch(id) {
    const row = db.prepare('SELECT * FROM domino_matches WHERE id = ?').get(id);
    ok(row, 'E_NO_MATCH', 'domino match not found: ' + id);
    return loadMatch(row);
  }

  function loadMatch(row) {
    const settings = JSON.parse(row.settings_json || '{}');
    const state = JSON.parse(row.state_json || '{}');
    const stateHash = row.state_hash || sha256hex(canonicalJson(freshState({ ...row, settings })));
    return {
      ...row,
      settings,
      state,
      state_hash: stateHash,
    };
  }

  function matchForRoom(roomId) {
    const row = db.prepare('SELECT * FROM domino_matches WHERE room_id = ? ORDER BY created_at ASC LIMIT 1').get(roomId);
    return row ? loadMatch(row) : null;
  }

  function movesOf(matchId) {
    return db
      .prepare('SELECT * FROM domino_moves WHERE match_id = ? ORDER BY move_index ASC')
      .all(matchId)
      .map(parseMove);
  }

  function parseMove(row) {
    let detail = {};
    try {
      detail = JSON.parse(row.detail_json || '{}');
    } catch (_) {
      detail = {};
    }
    return { ...row, detail };
  }

  function genesisHash(m) {
    return sha256hex(
      canonicalJson({ id: m.id, mode: m.mode, seed: m.seed, settings: m.settings || {} }),
    );
  }

  function moveHash(m, spec, prevHash) {
    const payload = canonicalJson({
      match_id: m.id,
      move_index: spec.moveIndex,
      user_id: spec.userId,
      move_type: spec.moveType,
      tile_a: spec.tile_a === undefined ? null : spec.tile_a,
      tile_b: spec.tile_b === undefined ? null : spec.tile_b,
      side: spec.side === undefined ? null : spec.side,
    });
    return sha256hex(payload + '\x1f' + prevHash);
  }

  function persistMatch(m) {
    m.state_hash = sha256hex(canonicalJson(m.state, IGNORED_CANONICAL));
    db.prepare(
      `UPDATE domino_matches SET state_json = ?, state_hash = ?, status = ?, updated_at = ?, finished_at = ? WHERE id = ?`,
    ).run(
      safeMeta(m.state),
      m.state_hash,
      m.state.status,
      nowIso(),
      m.state.finishedAt || null,
      m.id,
    );
  }

  function persistMove(m, spec, prevHash) {
    const row = db.prepare(
      `INSERT INTO domino_moves (match_id, move_index, user_id, move_type, tile_a, tile_b, side, hash, detail_json, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    );
    row.run(
      m.id,
      spec.moveIndex,
      spec.userId,
      spec.moveType,
      spec.tile_a === undefined ? null : spec.tile_a,
      spec.tile_b === undefined ? null : spec.tile_b,
      spec.side === undefined ? null : spec.side,
      spec.hash,
      safeMeta(spec.detail),
      nowIso(),
    );
    return spec.hash;
  }

  function applyMoney(m, spec) {
    if (!gameWallet) return;
    const econ = m.settings && m.settings.economy;
    if (!econ) return;
    const st = m.state;
    if (econ.mode === 'crypto') {
      const cryptoInput = {
        gameKind: 'domino', gameId: m.id, players: st.players,
        stakeUsdCents: econ.stake_usd_cents, asset: econ.asset, network: econ.network,
        eventHash: spec.hash,
      };
      if (spec.moveType === 'start') {
        gameWallet.chargeCryptoEntryFeesWithinTx(cryptoInput);
        return;
      }
      if (spec.moveType === 'cancel') {
        if (st.startedAt) {
          for (const player of st.players.filter((p) => p && p.kind !== 'bot')) {
            gameWallet.refundCryptoEntryWithinTx({ ...cryptoInput, userId: player.userId });
          }
        }
        return;
      }
      if (st.status === 'finished') {
        gameWallet.settlePot({
          gameKind: 'domino', gameId: m.id, players: st.players,
          economy: econ, commissionFraction: econ.commission_fraction,
          winnerUserId: st.winnerUserId, eventHash: spec.hash,
        });
      }
      return;
    }
    if (!Number.isSafeInteger(econ.entry_fee_milli) || econ.entry_fee_milli <= 0) return;
    if (spec.moveType === 'start') {
      gameWallet.chargeEntryFees({ gameKind: 'domino', gameId: m.id, players: st.players, entryFeeMilli: econ.entry_fee_milli, eventHash: spec.hash });
      return;
    }
    if (spec.moveType === 'cancel') {
      if (st.startedAt) gameWallet.refundEntries({ gameKind: 'domino', gameId: m.id, players: st.players, entryFeeMilli: econ.entry_fee_milli, eventHash: spec.hash });
      return;
    }
    if (st.status === 'finished') {
      gameWallet.settlePot({ gameKind: 'domino', gameId: m.id, players: st.players, entryFeeMilli: econ.entry_fee_milli, commissionFraction: econ.commission_fraction, winnerUserId: st.winnerUserId, eventHash: spec.hash });
    }
  }

  function runStep(m, spec) {
    db.exec('BEGIN IMMEDIATE');
    try {
      applySpec(m.state, spec);
      const prevHash = chainTail(m, spec.moveIndex - 1);
      spec.hash = moveHash(m, spec, prevHash);
      persistMove(m, spec, prevHash);
      persistMatch(m);
      applyMoney(m, spec);
      db.exec('COMMIT');
      return m;
    } catch (err) {
      safeRollback(db);
      throw err;
    }
  }

  function chainTail(m, upToIndex) {
    if (upToIndex < 1) return genesisHash(m);
    const row = db
      .prepare('SELECT * FROM domino_moves WHERE match_id = ? AND move_index = ?')
      .get(m.id, upToIndex);
    ok(row, 'E_NO_MOVE', 'move ' + upToIndex + ' not found for chain tail');
    return row.hash;
  }

  function findNextMoveIndex(matchId) {
    const row = db
      .prepare('SELECT MAX(move_index) AS n FROM domino_moves WHERE match_id = ?')
      .get(matchId);
    return (row && row.n === null ? 0 : row.n) + 1;
  }

  function createMatch(input) {
    const mode = input && input.mode;
    const userId = input && input.userId;
    const roomId = input && input.roomId || null;
    ok(mode === 'online' || mode === 'offline', 'E_ARG', 'mode must be online or offline');
    ok(typeof userId === 'string' && userId.length > 0, 'E_ARG', 'userId required');
    if (mode === 'online') {
      repos.getRoom(roomId);
      const room = repos.getRoom(roomId);
      const game = repos.getGame(room.game_id);
      ok(game.kind === 'domino', 'E_ARG', 'room does not belong to domino game');
    }
    const settings = input && input.settings && typeof input.settings === 'object' ? { ...input.settings } : {};
    const seed = settings.seed || genId() + ':' + crypto.randomBytes(8).toString('hex');
    delete settings.seed;
    if (gameWallet) {
      settings.economy = gameWallet.normalizeEconomy(input && input.settings, mode);
    }
    const id = genId();
    const ts = nowIso();
    const m = {
      id,
      user_id: userId,
      room_id: roomId,
      mode,
      status: 'scheduled',
      settings,
      seed,
      state_json: '{}',
      state_hash: '',
      created_at: ts,
      updated_at: ts,
      finished_at: null,
      settings,
      state: null,
    };
    m.state = freshState(m);
    m.state_hash = sha256hex(canonicalJson(m.state, IGNORED_CANONICAL));
    db.prepare(
      `INSERT INTO domino_matches (id, user_id, room_id, mode, status, settings_json, seed, state_json, state_hash, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(id, userId, roomId, mode, 'scheduled', safeMeta(settings), seed, safeMeta(m.state), m.state_hash, ts, ts);
    if (mode === 'offline') {
      const botCount = Number.isInteger(settings.botCount) ? settings.botCount : 1;
      ok(botCount >= 1 && botCount <= 3, 'E_ARG', 'botCount must be between 1 and 3');
      for (let i = 1; i <= botCount; i += 1) {
        stepJoin(m, 'bot:' + i, i + 1, 'bot', 'Bot ' + i);
      }
      stepJoin(m, userId, 1, 'human', null);
    }
    recordAudit(userId, 'domino.match.created', { mode, room_id: roomId });
    return getMatch(id);
  }

  function stepJoin(m, userId, seat, kind, name) {
    const spec = {
      moveIndex: findNextMoveIndex(m.id),
      userId,
      moveType: 'join',
      seat,
      kind,
      name,
      detail: { seat, kind, name: name || null },
    };
    runStep(m, spec);
    if (kind === 'human') {
      recordAudit(userId, 'domino.match.joined', { match_id: m.id, seat });
    }
  }

  function joinMatch(matchId, userId) {
    const m = getMatch(matchId);
    ok(m.state.status === 'scheduled', 'E_MATCH_ACTIVE', 'match is no longer in the lobby');
    if (m.state.players.some((p) => p.userId === userId)) {
      throw new DataError('E_ALREADY_JOINED', 'user already in match');
    }
    const seat = m.state.players.reduce((max, p) => Math.max(max, p.seat), 0) + 1;
    stepJoin(m, userId, seat, isBot(userId) ? 'bot' : 'human', null);
    return getMatch(matchId);
  }

  function ensurePlayer(m, userId) {
    if (m.state.status !== 'scheduled' && !m.state.players.some((p) => p.userId === userId)) {
      throw new DataError('E_NOT_IN_MATCH', 'user is not part of the running match');
    }
    if (m.state.players.some((p) => p.userId === userId)) return;
    const seat = m.state.players.reduce((max, p) => Math.max(max, p.seat), 0) + 1;
    stepJoin(m, userId, seat, isBot(userId) ? 'bot' : 'human', null);
  }

  function startMatch(matchId, opts = {}) {
    const m = getMatch(matchId);
    ok(m.state.status === 'scheduled', 'E_MATCH_ACTIVE', 'match already started');
    const user = opts.byUserId;
    ok(typeof user === 'string' && user.length > 0, 'E_ARG', 'byUserId required');
    if (m.state.players.length < 2) {
      throw new DataError('E_CANNOT_START', 'need at least two players to start');
    }
    if (!m.state.players.some((p) => p.userId === user && p.kind === 'human')) {
      throw new DataError('E_FORBIDDEN', 'only a match player can start');
    }
    const dealSpec = { moveIndex: findNextMoveIndex(m.id), userId: user, moveType: 'deal', handSize: handSize(m), detail: {} };
    runStep(m, dealSpec);
    const startSpec = { moveIndex: findNextMoveIndex(m.id), userId: user, moveType: 'start', startedAt: nowIso(), detail: {} };
    runStep(m, startSpec);
    if (m.state.status === 'active') {
      runBots(m);
    }
    recordAudit(user, 'domino.match.started', { match_id: m.id });
    return getMatch(matchId);
  }

  function handSize(m) {
    const setting = m.settings.handSize;
    if (Number.isInteger(setting) && setting >= 1 && setting <= 28) return setting;
    return defaultHandSize(m.state.players.length);
  }

  function applyAction(matchId, userId, action) {
    const m = getMatch(matchId);
    const st = m.state;
    ok(st.status === 'active', 'E_MATCH_NOT_ACTIVE', 'match is not active');
    ok(st.currentUserId === userId, 'E_NOT_YOUR_TURN', 'not your turn');
    ok(action && typeof action === 'object', 'E_ARG', 'action required');
    const spec = buildActionSpec(m, userId, action);
    runStep(m, spec);
    if (st.status === 'active') {
      runBots(m);
    }
    return getMatch(matchId);
  }

  function buildActionSpec(m, userId, action) {
    const st = m.state;
    switch (action.type) {
      case 'play': {
        const tile = normalizeTile(action.tile);
        const side = action.side;
        ok(side === 'left' || side === 'right', 'E_ARG', 'invalid side');
        ok(
          playsFor(st.hands[userId] || [], st.board).some((p) => p.side === side && tileKey(p.tile) === tileKey(tile)),
          'E_TILE_NO_MATCH',
          'tile cannot be played on that end',
        );
        const ends = openEnds(st.board);
        return {
          moveIndex: findNextMoveIndex(m.id),
          userId,
          moveType: 'play',
          tile_a: tile.a,
          tile_b: tile.b,
          side,
          detail: { ends: ends ? [ends.left, ends.right] : null },
        };
      }
      case 'draw': {
        ok(canDraw(st.boneyard), 'E_NO_TILE_TO_DRAW', 'the boneyard is empty');
        const tile = st.boneyard[st.boneyard.length - 1];
        return {
          moveIndex: findNextMoveIndex(m.id),
          userId,
          moveType: 'draw',
          tile_a: tile.a,
          tile_b: tile.b,
          detail: { remaining: st.boneyard.length - 1 },
        };
      }
      case 'pass': {
        ok(!canPlayAny(st.hands[userId] || [], st.board), 'E_CANNOT_PASS', 'a playable tile exists, pass is not allowed');
        return { moveIndex: findNextMoveIndex(m.id), userId, moveType: 'pass', detail: { passStreak: st.passStreak + 1 } };
      }
      default:
        throw new DataError('E_ARG', 'unknown action type: ' + action.type);
    }
  }

  function runBots(m) {
    while (m.state.status === 'active' && isBot(m.state.currentUserId)) {
      const bot = m.state.currentUserId;
      const hand = m.state.hands[bot] || [];
      const choice = chooseBotAction(hand, m.state.board, m.state.boneyard);
      if (choice.action === 'play') {
        runStep(m, {
          moveIndex: findNextMoveIndex(m.id),
          userId: bot,
          moveType: 'play',
          tile_a: choice.tile.a,
          tile_b: choice.tile.b,
          side: choice.side,
          detail: { bot: true },
        });
      } else if (choice.action === 'draw') {
        const tile = m.state.boneyard[m.state.boneyard.length - 1];
        runStep(m, {
          moveIndex: findNextMoveIndex(m.id),
          userId: bot,
          moveType: 'draw',
          tile_a: tile.a,
          tile_b: tile.b,
          detail: { bot: true },
        });
      } else {
        runStep(m, {
          moveIndex: findNextMoveIndex(m.id),
          userId: bot,
          moveType: 'pass',
          detail: { bot: true, passStreak: m.state.passStreak + 1 },
        });
      }
    }
  }

  function cancelMatch(matchId, userId) {
    const m = getMatch(matchId);
    ok(m.state.status === 'scheduled' || m.state.status === 'active', 'E_MATCH_CLOSED', 'match is already finished');
    ok(m.user_id === userId, 'E_FORBIDDEN', 'only the owner can cancel');
    runStep(m, { moveIndex: findNextMoveIndex(m.id), userId, moveType: 'cancel', detail: {} });
    recordAudit(userId, 'domino.match.cancelled', { match_id: m.id });
    return getMatch(matchId);
  }

  function stateOf(matchId) {
    return getMatch(matchId).state;
  }

  function listMatches(options = {}) {
    const limit = Number.isSafeInteger(options.limit) ? options.limit : 100;
    const offset = Number.isSafeInteger(options.offset) ? options.offset : 0;
    const where = [];
    const params = [];
    if (options.userId) {
      where.push('user_id = ?');
      params.push(options.userId);
    }
    if (options.status) {
      where.push('status = ?');
      params.push(options.status);
    }
    if (options.mode) {
      where.push('mode = ?');
      params.push(options.mode);
    }
    const sql = 'SELECT * FROM domino_matches' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    return db.prepare(sql).all(...params, limit, offset).map(loadMatch);
  }

  function verifyMatch(matchId) {
    const m = getMatch(matchId);
    const st = freshState(m);
    const moves = movesOf(matchId);
    let prev = genesisHash(m);
    for (const row of moves) {
      const expected = sha256hex(
        canonicalJson({
          match_id: row.match_id,
          move_index: row.move_index,
          user_id: row.user_id,
          move_type: row.move_type,
          tile_a: row.tile_a === undefined ? null : row.tile_a,
          tile_b: row.tile_b === undefined ? null : row.tile_b,
          side: row.side === undefined ? null : row.side,
        }) + '\x1f' + prev,
      );
      if (expected !== row.hash) {
        throw new DataError('E_TAMPER', 'domino move hash mismatch at index ' + row.move_index);
      }
      prev = row.hash;
      applySpec(st, {
        userId: row.user_id,
        moveType: row.move_type,
        tile_a: row.tile_a,
        tile_b: row.tile_b,
        side: row.side,
        seat: row.detail ? row.detail.seat : undefined,
        kind: row.detail ? row.detail.kind : undefined,
        name: row.detail ? row.detail.name : undefined,
        handSize: m.settings.handSize,
      });
    }
    const replayed = canonicalJson(st, IGNORED_CANONICAL);
    const stored = canonicalJson(m.state, IGNORED_CANONICAL);
    if (replayed !== stored) {
      throw new DataError('E_TAMPER', 'domino final state does not match the move replay');
    }
    const expectedStateHash = sha256hex(canonicalJson(m.state, IGNORED_CANONICAL));
    if (m.state_hash !== expectedStateHash) {
      throw new DataError('E_TAMPER', 'domino state hash mismatch');
    }
    if (gameWallet) {
      gameWallet.verifyGameEconomy({
        gameKind: 'domino',
        gameId: m.id,
        players: m.state.players,
        economy: m.settings && m.settings.economy,
        started: !!m.state.startedAt,
        finished: m.state.status === 'finished',
        cancelled: m.state.status === 'cancelled',
        winnerUserId: m.state.winnerUserId,
      });
    }
    return { ok: true, moves: moves.length, state_hash: m.state_hash };
  }

  function economySummary(m) {
    const econ = m.settings && m.settings.economy;
    if (!gameWallet || !econ || econ.entry_fee_milli <= 0) {
      return { entry_fee_milli: 0, pot_milli: 0, prize_milli: 0, commission_milli: 0 };
    }
    return gameWallet.summary({
      gameKind: 'domino',
      gameId: m.id,
      players: m.state.players,
      entryFeeMilli: econ.entry_fee_milli,
      commissionFraction: econ.commission_fraction,
    });
  }

  function publicState(m) {
    const st = m.state;
    const current = st.currentUserId
      ? st.players.find((p) => p.userId === st.currentUserId)
      : null;
    return {
      match_id: m.id,
      mode: m.mode,
      status: st.status,
      seed: m.seed,
      settings: m.settings,
      players: st.players.map((p) => ({
        user_id: p.userId,
        seat: p.seat,
        kind: p.kind,
        name: p.name,
        tile_count: (st.hands[p.userId] || []).length,
        pips: handPips(st.hands[p.userId] || []),
      })),
      hands: mapHands(st),
      board: st.board,
      boneyard_count: st.boneyard.length,
      turn_index: st.turnIndex,
      current_user_id: st.currentUserId,
      current_seat: current ? current.seat : null,
      first_user_id: st.firstUserId,
      pass_streak: st.passStreak,
      winner_user_id: st.winnerUserId,
      end_reason: st.endReason,
      scores: st.scores,
      economy: economySummary(m),
      version: st.version,
    };
  }

  function mapHands(st) {
    const out = {};
    for (const userId of Object.keys(st.hands)) {
      out[userId] = st.hands[userId] || [];
    }
    return out;
  }

  function onGameEvent(roomId, userId, payload) {
    ok(typeof roomId === 'string' && roomId.length > 0, 'E_ARG', 'roomId required');
    ok(typeof userId === 'string' && userId.length > 0, 'E_ARG', 'userId required');
    ok(payload && typeof payload === 'object', 'E_ARG', 'game event payload required');
    const room = repos.getRoom(roomId);
    const game = repos.getGame(room.game_id);
    ok(game.kind === 'domino', 'E_ARG', 'room is not a domino room');
    const member = room.host_user_id === userId || repos.roomPlayers(roomId).some((p) => p.user_id === userId);
    ok(member, 'E_NOT_IN_MATCH', 'user is not a member of this room');
    let m = matchForRoom(roomId);
    if (!m) {
      m = createMatch({
        mode: 'online',
        userId: room.host_user_id,
        roomId,
        settings: payload.settings || (game.config && game.config.settings) || null,
      });
    }
    ensurePlayer(m, userId);
    const action = payload.action;
    switch (action) {
      case 'status':
        return { event: 'domino:state', payload: publicState(m) };
      case 'start': {
        const started = startMatch(m.id, { byUserId: userId });
        return { event: 'domino:started', payload: publicState(started) };
      }
      case 'play':
      case 'draw':
      case 'pass': {
        m = applyAction(m.id, userId, { type: action, tile: payload.tile, side: payload.side });
        const finished = m.state.status === 'finished';
        return {
          event: finished ? 'domino:finished' : 'domino:state',
          payload: publicState(m),
        };
      }
      default:
        throw new DataError('E_ARG', 'unknown domino action: ' + action);
    }
  }

  function recordAudit(userId, action, detail) {
    try {
      repos.recordAudit({
        actorType: 'user',
        actorId: userId,
        action,
        targetType: 'domino_match',
        targetId: detail.match_id || null,
        detail,
      });
    } catch (_) {
      // audit must never break the game loop
    }
  }

  return {
    createMatch,
    getMatch,
    matchForRoom,
    listMatches,
    joinMatch,
    startMatch,
    applyAction,
    cancelMatch,
    stateOf,
    movesOf,
    publicState,
    verifyMatch,
    onGameEvent,
  };
}

module.exports = {
  buildDominoGame,
  canonicalJson,
  sha256hex,
  defaultHandSize,
  MOVE_TYPES,
  MATCH_STATUSES,
};