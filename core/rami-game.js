'use strict';
const crypto = require('node:crypto');
const { DataError, ok, nowIso, genId, safeMeta, safeRollback } = require('./db');
const { canonicalJson, sha256hex } = require('./domino-game');
const {
  fullDeck,
  shuffleDeck,
  shuffle,
  sortHand,
  cardKey,
  parseCardKey,
  handPoints,
  findMelds,
  assertMeldSetPlayable,
  assertCardInHand,
  canUseCardInMeld,
  keysInMelds,
  deckAudit,
  MIN_MELD_LEN,
} = require('./rami');

const MOVE_TYPES = ['deal', 'join', 'start', 'draw', 'meld', 'discard', 'win', 'leave', 'cancel'];
const GAME_STATUSES = ['scheduled', 'active', 'finished', 'cancelled'];
const IGNORED_CANONICAL = new Set(['version', 'startedAt', 'finishedAt']);
const BOT_PREFIX = 'bot:';
const TURN_PHASES = ['draw', 'discard'];
const DRAW_SOURCES = ['stock', 'discard'];

function isBot(userId) {
  return typeof userId === 'string' && userId.startsWith(BOT_PREFIX);
}

function defaultHandSize(numPlayers) {
  if (numPlayers <= 2) return 10;
  if (numPlayers === 3) return 7;
  return 6;
}

function normalizeCard(value) {
  if (typeof value === 'string') return parseCardKey(value);
  if (value && typeof value === 'object') {
    if (value.joker === true) return { joker: true, id: value.id === 2 ? 2 : 1 };
    return parseCardKey(cardKey({ rank: value.rank, suit: value.suit }));
  }
  throw new DataError('E_ARG', 'card required');
}

function normalizeMelds(value) {
  ok(Array.isArray(value) && value.length > 0, 'E_ARG', 'melds required');
  return value.map((meld) => {
    ok(Array.isArray(meld) && meld.length >= MIN_MELD_LEN, 'E_ARG', 'each meld must contain at least ' + MIN_MELD_LEN + ' cards');
    return meld.map((card) => cardKey(normalizeCard(card)));
  });
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
    stock: [],
    discard: [],
    table: {},
    turnIndex: 0,
    currentUserId: null,
    turnPhase: 'draw',
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
    points: handPoints(st.hands[p.userId] || []),
  }));
  const sorted = scored.slice().sort((x, y) => x.points - y.points || x.seat - y.seat);
  const rankOf = (pointsValue) =>
    1 + sorted.filter((s) => s.points < pointsValue).filter((s, i, a) => a.findIndex((t) => t.points === s.points) === i).length;
  return scored
    .map((s) => ({ userId: s.userId, points: s.points, rank: rankOf(s.points) }))
    .map((s, idx) => ({ ...s, winner: winnerUserId ? s.userId === winnerUserId : idx === 0 }));
}

function determineStarter(st) {
  const human = st.players.find((p) => p.kind !== 'bot');
  if (human) return human.userId;
  return st.players.length > 0 ? st.players[0].userId : null;
}

function stateCardKeys(st) {
  const out = [];
  for (const userId of st.order) {
    for (const key of st.hands[userId] || []) out.push(String(key));
  }
  for (const key of st.stock || []) out.push(String(key));
  for (const key of st.discard || []) out.push(String(key));
  const table = st.table || {};
  for (const userId of Object.keys(table)) {
    for (const meld of table[userId] || []) {
      for (const key of meld) out.push(String(key));
    }
  }
  return out;
}

function assertTurn(st, userId, phase) {
  ok(st.currentUserId === userId, 'E_NOT_YOUR_TURN', 'not your turn');
  ok(st.turnPhase === phase, 'E_WRONG_PHASE', 'action is not allowed in the ' + st.turnPhase + ' phase');
}

function removeKeys(sortedKeys, toRemove) {
  const remove = new Set(toRemove);
  return sortedKeys.filter((k) => !remove.has(k));
}

function applySpec(st, spec) {
  applySpecInner(st, spec);
  return st;
}

function applySpecInner(st, spec) {
  switch (spec.moveType) {
    case 'join': {
      if (st.players.some((p) => p.userId === spec.userId)) return;
      st.players.push({
        userId: spec.userId,
        seat: spec.seat,
        kind: spec.kind || (isBot(spec.userId) ? 'bot' : 'human'),
        name: spec.name || null,
      });
      st.order.push(spec.userId);
      st.hands[spec.userId] = [];
      st.table[spec.userId] = [];
      st.version += 1;
      return;
    }
    case 'deal': {
      const handSize = spec.handSize || defaultHandSize(st.players.length);
      const deck = shuffleDeck(st.seed);
      const all = deck.map(cardKey);
      for (const player of st.players) {
        st.hands[player.userId] = sortHand(all.splice(0, handSize));
      }
      st.stock = all;
      st.discard = [];
      st.version += 1;
      return;
    }
    case 'start': {
      st.firstUserId = determineStarter(st);
      st.turnIndex = st.order.indexOf(st.firstUserId);
      st.currentUserId = st.firstUserId;
      st.turnPhase = 'draw';
      st.status = 'active';
      st.startedAt = spec.startedAt || nowIso();
      st.version += 1;
      return;
    }
    case 'draw': {
      assertTurn(st, spec.userId, 'draw');
      if (spec.skip === true) {
        st.turnPhase = 'discard';
        st.version += 1;
        return;
      }
      ok(DRAW_SOURCES.includes(spec.source), 'E_ARG', 'invalid draw source');
      const hand = st.hands[spec.userId] || [];
      if (spec.source === 'stock') {
        ok(st.stock.length > 0, 'E_STOCK_EMPTY', 'the stock is empty');
        ok(st.stock[st.stock.length - 1] === spec.card, 'E_DRAW_MISMATCH', 'drawn card does not match the stock top');
        st.stock.pop();
      } else {
        ok(st.discard.length > 0, 'E_DISCARD_EMPTY', 'the discard pile is empty');
        ok(st.discard[st.discard.length - 1] === spec.card, 'E_DRAW_MISMATCH', 'drawn card does not match the discard top');
        st.discard.pop();
      }
      st.hands[spec.userId] = sortHand([...hand, spec.card]);
      st.turnPhase = 'discard';
      st.version += 1;
      return;
    }
    case 'meld': {
      assertTurn(st, spec.userId, 'discard');
      const melds = spec.melds || [];
      ok(Array.isArray(melds) && melds.length > 0, 'E_MELDS_REQUIRED', 'at least one meld is required');
      const hand = st.hands[spec.userId] || [];
      assertMeldSetPlayable(hand, melds);
      const allKeys = keysInMelds(melds.map((m) => m.map((k) => parseCardKey(k))));
      const remaining = removeKeys(hand, allKeys);
      ok(remaining.length >= 1, 'E_NO_DISCARD', 'at least one card must stay in hand for the mandatory discard');
      st.hands[spec.userId] = remaining;
      st.table[spec.userId] = [...(st.table[spec.userId] || []), ...melds];
      st.version += 1;
      return;
    }
    case 'discard': {
      assertTurn(st, spec.userId, 'discard');
      const hand = st.hands[spec.userId] || [];
      assertCardInHand(hand, spec.card);
      st.hands[spec.userId] = hand.filter((k) => k !== spec.card);
      st.discard.push(spec.card);
      advance(st);
      st.version += 1;
      if ((st.hands[spec.userId] || []).length === 0) {
        st.status = 'finished';
        st.winnerUserId = spec.userId;
        st.endReason = 'hand_empty';
        st.scores = computeScores(st, spec.userId);
        st.finishedAt = nowIso();
        st.version += 1;
      }
      return;
    }
    case 'win': {
      st.status = 'finished';
      st.winnerUserId = spec.userId;
      st.endReason = 'hand_empty';
      st.scores = computeScores(st, spec.userId);
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
      delete st.table[spec.userId];
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
    st.turnPhase = 'draw';
    return;
  }
  st.turnIndex = (st.turnIndex + 1) % st.order.length;
  st.currentUserId = st.order[st.turnIndex];
  st.turnPhase = 'draw';
}

function buildRamiGame(deps) {
  const db = deps && deps.db;
  const repos = deps && deps.repos;
  const gameWallet = (deps && deps.gameWallet) || null;
  ok(db, 'E_ARG', 'rami game requires db');
  ok(repos, 'E_ARG', 'rami game requires repos');

  function getGame(id) {
    const row = db.prepare('SELECT * FROM rami_games WHERE id = ?').get(id);
    ok(row, 'E_NO_GAME', 'rami game not found: ' + id);
    return loadGame(row);
  }

  function loadGame(row) {
    const settings = JSON.parse(row.settings_json || '{}');
    const state = JSON.parse(row.state_json || '{}');
    const stateHash = row.state_hash;
    return { ...row, settings, state, state_hash: stateHash };
  }

  function gameForRoom(roomId) {
    const row = db.prepare('SELECT * FROM rami_games WHERE room_id = ? ORDER BY created_at ASC LIMIT 1').get(roomId);
    return row ? loadGame(row) : null;
  }

  function movesOf(gameId) {
    return db
      .prepare('SELECT * FROM rami_moves WHERE game_id = ? ORDER BY move_index ASC')
      .all(gameId)
      .map(parseMove);
  }

  function parseMove(row) {
    let detail = {};
    try {
      detail = JSON.parse(row.detail_json || '{}');
    } catch (_) {
      detail = {};
    }
    let cards = [];
    try {
      cards = JSON.parse(row.cards_json || '[]');
    } catch (_) {
      cards = [];
    }
    return { ...row, detail, cards };
  }

  function genesisHash(m) {
    return sha256hex(canonicalJson({ id: m.id, mode: m.mode, seed: m.seed, settings: m.settings || {} }));
  }

  function moveHash(m, spec, prevHash) {
    const payload = canonicalJson({
      game_id: m.id,
      move_index: spec.moveIndex,
      user_id: spec.userId,
      move_type: spec.moveType,
      source: spec.source === undefined ? null : spec.source,
      card: spec.card === undefined ? null : spec.card,
      melds: spec.melds || [],
    });
    return sha256hex(payload + '\x1f' + prevHash);
  }

  function persistGame(m) {
    m.state_hash = sha256hex(canonicalJson(m.state, IGNORED_CANONICAL));
    db.prepare(
      `UPDATE rami_games SET state_json = ?, state_hash = ?, status = ?, updated_at = ?, finished_at = ? WHERE id = ?`,
    ).run(safeMeta(m.state), m.state_hash, m.state.status, nowIso(), m.state.finishedAt || null, m.id);
  }

  function persistMove(m, spec, prevHash) {
    db.prepare(
      `INSERT INTO rami_moves (game_id, move_index, user_id, move_type, source, card, cards_json, hash, detail_json, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      m.id,
      spec.moveIndex,
      spec.userId,
      spec.moveType,
      spec.source === undefined ? null : spec.source,
      spec.card === undefined ? null : spec.card,
      spec.melds === undefined || spec.melds === null ? '[]' : JSON.stringify(spec.melds),
      spec.hash,
      safeMeta(spec.detail),
      nowIso(),
    );
  }

  function applyMoney(m, spec) {
    if (!gameWallet) return;
    const econ = m.settings && m.settings.economy;
    if (!econ) return;
    const st = m.state;
    if (econ.mode === 'crypto') {
      const cryptoInput = {
        gameKind: 'rami', gameId: m.id, players: st.players,
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
          gameKind: 'rami', gameId: m.id, players: st.players,
          economy: econ, commissionFraction: econ.commission_fraction,
          winnerUserId: st.winnerUserId, eventHash: spec.hash,
        });
      }
      return;
    }
    if (!Number.isSafeInteger(econ.entry_fee_milli) || econ.entry_fee_milli <= 0) return;
    if (spec.moveType === 'start') {
      gameWallet.chargeEntryFees({ gameKind: 'rami', gameId: m.id, players: st.players, entryFeeMilli: econ.entry_fee_milli, eventHash: spec.hash });
      return;
    }
    if (spec.moveType === 'cancel') {
      if (st.startedAt) gameWallet.refundEntries({ gameKind: 'rami', gameId: m.id, players: st.players, entryFeeMilli: econ.entry_fee_milli, eventHash: spec.hash });
      return;
    }
    if (st.status === 'finished') {
      gameWallet.settlePot({ gameKind: 'rami', gameId: m.id, players: st.players, entryFeeMilli: econ.entry_fee_milli, commissionFraction: econ.commission_fraction, winnerUserId: st.winnerUserId, eventHash: spec.hash });
    }
  }

  function runStep(m, spec) {
    db.exec('BEGIN IMMEDIATE');
    try {
      applySpec(m.state, spec);
      const prevHash = chainTail(m, spec.moveIndex - 1);
      spec.hash = moveHash(m, spec, prevHash);
      persistMove(m, spec, prevHash);
      persistGame(m);
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
    const row = db.prepare('SELECT hash FROM rami_moves WHERE game_id = ? AND move_index = ?').get(m.id, upToIndex);
    ok(row, 'E_NO_MOVE', 'move ' + upToIndex + ' not found for chain tail');
    return row.hash;
  }

  function findNextMoveIndex(gameId) {
    const row = db.prepare('SELECT MAX(move_index) AS n FROM rami_moves WHERE game_id = ?').get(gameId);
    return (row && row.n === null ? 0 : row.n) + 1;
  }

  function createGame(input) {
    const mode = input && input.mode;
    const userId = input && input.userId;
    const roomId = (input && input.roomId) || null;
    ok(mode === 'online' || mode === 'offline', 'E_ARG', 'mode must be online or offline');
    ok(typeof userId === 'string' && userId.length > 0, 'E_ARG', 'userId required');
    if (mode === 'online' && roomId) {
      const room = repos.getRoom(roomId);
      ok(room, 'E_ARG', 'room not found');
      const game = repos.getGame(room.game_id);
      ok(game.kind === 'rami', 'E_ARG', 'room does not belong to rami game');
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
      state: null,
    };
    m.state = freshState(m);
    m.state_hash = sha256hex(canonicalJson(m.state, IGNORED_CANONICAL));
    db.prepare(
      `INSERT INTO rami_games (id, user_id, room_id, mode, status, settings_json, seed, state_json, state_hash, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(id, userId, roomId, mode, 'scheduled', safeMeta(settings), seed, safeMeta(m.state), m.state_hash, ts, ts);
    if (mode === 'offline') {
      const botCount = Number.isInteger(settings.botCount) ? settings.botCount : 1;
      ok(botCount >= 1 && botCount <= 3, 'E_ARG', 'botCount must be between 1 and 3');
      for (let i = 1; i <= botCount; i += 1) {
        stepJoin(m, 'bot:' + i, i + 1, 'bot', 'Bot ' + i);
      }
      stepJoin(m, userId, 1, 'human', null);
      runStep(m, { moveIndex: findNextMoveIndex(m.id), userId, moveType: 'deal', handSize: handSize(m), detail: {} });
    }
    recordAudit(userId, 'rami.game.created', { mode, room_id: roomId });
    return getGame(id);
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
      recordAudit(userId, 'rami.game.joined', { game_id: m.id, seat });
    }
  }

  function joinGame(gameId, userId) {
    const m = getGame(gameId);
    ok(m.state.status === 'scheduled', 'E_GAME_ACTIVE', 'game is no longer in the lobby');
    if (m.state.players.some((p) => p.userId === userId)) {
      throw new DataError('E_ALREADY_JOINED', 'user already in game');
    }
    const seat = m.state.players.reduce((max, p) => Math.max(max, p.seat), 0) + 1;
    stepJoin(m, userId, seat, isBot(userId) ? 'bot' : 'human', null);
    return getGame(gameId);
  }

  function ensurePlayer(m, userId) {
    if (m.state.status !== 'scheduled' && !m.state.players.some((p) => p.userId === userId)) {
      throw new DataError('E_NOT_IN_GAME', 'user is not part of the running game');
    }
    if (m.state.players.some((p) => p.userId === userId)) return;
    const seat = m.state.players.reduce((max, p) => Math.max(max, p.seat), 0) + 1;
    stepJoin(m, userId, seat, isBot(userId) ? 'bot' : 'human', null);
  }

  function handSize(m) {
    const setting = m.settings.handSize;
    if (Number.isInteger(setting) && setting >= 3 && setting <= 15) return setting;
    return defaultHandSize(m.state.players.length);
  }

  function startGame(gameId, opts = {}) {
    const m = getGame(gameId);
    ok(m.state.status === 'scheduled', 'E_GAME_ACTIVE', 'game already started');
    const user = opts.byUserId;
    ok(typeof user === 'string' && user.length > 0, 'E_ARG', 'byUserId required');
    if (m.state.players.length < 2) {
      throw new DataError('E_CANNOT_START', 'need at least two players to start');
    }
    if (!m.state.players.some((p) => p.userId === user && p.kind === 'human')) {
      throw new DataError('E_FORBIDDEN', 'only a game player can start');
    }
    runStep(m, { moveIndex: findNextMoveIndex(m.id), userId: user, moveType: 'deal', handSize: handSize(m), detail: {} });
    runStep(m, { moveIndex: findNextMoveIndex(m.id), userId: user, moveType: 'start', startedAt: nowIso(), detail: {} });
    if (m.state.status === 'active') {
      runBots(m);
    }
    recordAudit(user, 'rami.game.started', { game_id: m.id });
    return getGame(gameId);
  }

  function applyAction(gameId, userId, action) {
    const m = getGame(gameId);
    const st = m.state;
    ok(st.status === 'active', 'E_GAME_NOT_ACTIVE', 'game is not active');
    ok(st.currentUserId === userId, 'E_NOT_YOUR_TURN', 'not your turn');
    ok(action && typeof action === 'object', 'E_ARG', 'action required');
    const spec = buildActionSpec(m, userId, action);
    runStep(m, spec);
    if (st.status === 'active') {
      runBots(m);
    }
    return getGame(gameId);
  }

  function buildActionSpec(m, userId, action) {
    const st = m.state;
    switch (action.type) {
      case 'draw': {
        assertTurn(st, userId, 'draw');
        const source = action.source === 'discard' ? 'discard' : action.source === 'stock' ? 'stock' : null;
        ok(source, 'E_ARG', 'source must be stock or discard');
        if (source === 'stock') {
          if (st.stock.length === 0) {
            return { moveIndex: findNextMoveIndex(m.id), userId, moveType: 'draw', skip: true, detail: { skip: true } };
          }
          return {
            moveIndex: findNextMoveIndex(m.id),
            userId,
            moveType: 'draw',
            source,
            card: st.stock[st.stock.length - 1],
            detail: { stock: st.stock.length - 1 },
          };
        }
        ok(st.discard.length > 0, 'E_DISCARD_EMPTY', 'the discard pile is empty');
        return {
          moveIndex: findNextMoveIndex(m.id),
          userId,
          moveType: 'draw',
          source,
          card: st.discard[st.discard.length - 1],
          detail: { discard: st.discard.length - 1 },
        };
      }
      case 'meld': {
        assertTurn(st, userId, 'discard');
        const melds = normalizeMelds(action.melds);
        assertMeldSetPlayable(st.hands[userId] || [], melds);
        return {
          moveIndex: findNextMoveIndex(m.id),
          userId,
          moveType: 'meld',
          melds,
          detail: { meld_count: melds.length, cards: keysInMelds(melds.map((md) => md.map(parseCardKey))) },
        };
      }
      case 'discard': {
        assertTurn(st, userId, 'discard');
        let card;
        try {
          card = cardKey(normalizeCard(action.card));
        } catch (_) {
          throw new DataError('E_CARD_NOT_IN_HAND', 'card is not in the player hand');
        }
        assertCardInHand(st.hands[userId] || [], card);
        return {
          moveIndex: findNextMoveIndex(m.id),
          userId,
          moveType: 'discard',
          card,
          detail: { remaining: (st.hands[userId] || []).length - 1 },
        };
      }
      default:
        throw new DataError('E_ARG', 'unknown action type: ' + action.type);
    }
  }

  function botDrawSpec(m, bot, hand) {
    const top = m.state.discard.length ? m.state.discard[m.state.discard.length - 1] : null;
    if (top && canUseCardInMeld(top, hand)) {
      return {
        moveIndex: findNextMoveIndex(m.id),
        userId: bot,
        moveType: 'draw',
        source: 'discard',
        card: top,
        detail: { bot: true },
      };
    }
    if (m.state.stock.length > 0) {
      return {
        moveIndex: findNextMoveIndex(m.id),
        userId: bot,
        moveType: 'draw',
        source: 'stock',
        card: m.state.stock[m.state.stock.length - 1],
        detail: { bot: true },
      };
    }
    return {
      moveIndex: findNextMoveIndex(m.id),
      userId: bot,
      moveType: 'draw',
      skip: true,
      detail: { bot: true, skip: true },
    };
  }

  function botDiscardSpec(m, bot, hand) {
    const melds = findMelds(hand);
    let toMeld = melds;
    while (toMeld.length > 0) {
      const used = new Set(keysInMelds(toMeld));
      if (hand.filter((k) => !used.has(k)).length >= 1) break;
      toMeld = toMeld.slice(0, -1);
    }
    let remaining = hand.slice();
    if (toMeld.length > 0) {
      const keys = keysInMelds(toMeld);
      const used = new Set(keys);
      remaining = hand.filter((k) => !used.has(k));
      runStep(m, {
        moveIndex: findNextMoveIndex(m.id),
        userId: bot,
        moveType: 'meld',
        melds: toMeld.map((md) => md.map(cardKey)),
        detail: { bot: true, meld_count: toMeld.length },
      });
    }
    if (remaining.length === 0) remaining = hand.slice();
    let worst = remaining[0];
    for (const k of remaining) {
      if (handPoints([parseCardKey(k)]) > handPoints([parseCardKey(worst)])) worst = k;
    }
    return {
      moveIndex: findNextMoveIndex(m.id),
      userId: bot,
      moveType: 'discard',
      card: worst,
      detail: { bot: true, remaining: remaining.length - 1 },
    };
  }

  function runBots(m) {
    while (m.state.status === 'active' && isBot(m.state.currentUserId)) {
      const bot = m.state.currentUserId;
      const hand = m.state.hands[bot] || [];
      if (m.state.turnPhase === 'draw') {
        const spec = botDrawSpec(m, bot, hand);
        if (!spec) break;
        runStep(m, spec);
      } else {
        const spec = botDiscardSpec(m, bot, hand);
        runStep(m, spec);
      }
    }
  }

  function cancelGame(gameId, userId) {
    const m = getGame(gameId);
    ok(m.state.status === 'scheduled' || m.state.status === 'active', 'E_GAME_CLOSED', 'game is already finished');
    ok(m.user_id === userId, 'E_FORBIDDEN', 'only the owner can cancel');
    runStep(m, { moveIndex: findNextMoveIndex(m.id), userId, moveType: 'cancel', detail: {} });
    recordAudit(userId, 'rami.game.cancelled', { game_id: m.id });
    return getGame(gameId);
  }

  function stateOf(gameId) {
    return getGame(gameId).state;
  }

  function listGames(options = {}) {
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
    const sql =
      'SELECT * FROM rami_games' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    return db.prepare(sql).all(...params, limit, offset).map(loadGame);
  }

  function verifyGame(gameId) {
    const m = getGame(gameId);
    const st = freshState(m);
    const moves = movesOf(gameId);
    let prev = genesisHash(m);
    for (const row of moves) {
      const expected = sha256hex(
        canonicalJson({
          game_id: row.game_id,
          move_index: row.move_index,
          user_id: row.user_id,
          move_type: row.move_type,
          source: row.source === undefined || row.source === null ? null : row.source,
          card: row.card === undefined || row.card === null ? null : row.card,
          melds: row.cards || [],
        }) + '\x1f' + prev,
      );
      if (expected !== row.hash) {
        throw new DataError('E_TAMPER', 'rami move hash mismatch at index ' + row.move_index);
      }
      prev = row.hash;
      const isSkipDraw = row.move_type === 'draw' && (row.source === null || row.source === undefined);
      applySpec(st, {
        userId: row.user_id,
        moveType: row.move_type,
        skip: isSkipDraw,
        handSize: m.settings.handSize || defaultHandSize(st.players.length > 0 ? st.players.length : 2),
        seat: row.detail ? row.detail.seat : undefined,
        kind: row.detail ? row.detail.kind : undefined,
        name: row.detail ? row.detail.name : undefined,
        source: row.source === null ? undefined : row.source,
        card: row.card === null ? undefined : row.card,
        melds: row.cards && row.cards.length ? row.cards : undefined,
      });
    }
    const replayed = canonicalJson(st, IGNORED_CANONICAL);
    const stored = canonicalJson(m.state, IGNORED_CANONICAL);
    if (replayed !== stored) {
      throw new DataError('E_TAMPER', 'rami final state does not match the move replay');
    }
    const expectedStateHash = sha256hex(canonicalJson(m.state, IGNORED_CANONICAL));
    if (m.state_hash !== expectedStateHash) {
      throw new DataError('E_TAMPER', 'rami state hash mismatch');
    }
    deckAudit(stateCardKeys(st));
    if (gameWallet) {
      gameWallet.verifyGameEconomy({
        gameKind: 'rami',
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
      gameKind: 'rami',
      gameId: m.id,
      players: m.state.players,
      entryFeeMilli: econ.entry_fee_milli,
      commissionFraction: econ.commission_fraction,
    });
  }

  function publicState(m, withUserId) {
    const st = m.state;
    const current = st.currentUserId ? st.players.find((p) => p.userId === st.currentUserId) : null;
    return {
      game_id: m.id,
      mode: m.mode,
      status: st.status,
      seed: m.seed,
      settings: m.settings,
      players: st.players.map((p) => ({
        user_id: p.kind === 'bot' ? null : p.userId,
        seat: p.seat,
        kind: p.kind,
        name: p.name,
        card_count: (st.hands[p.userId] || []).length,
        points: handPoints(st.hands[p.userId] || []),
      })),
      stock_count: st.stock.length,
      discard_count: st.discard.length,
      last_discard: st.discard.length ? st.discard[st.discard.length - 1] : null,
      turn_index: st.turnIndex,
      current_user_id: st.currentUserId,
      current_seat: current ? current.seat : null,
      turn_phase: st.turnPhase,
      table: st.table,
      own_hand: withUserId ? (st.hands[withUserId] || []).slice() : null,
      first_user_id: st.firstUserId,
      winner_user_id: st.winnerUserId,
      end_reason: st.endReason,
      scores: st.scores,
      economy: economySummary(m),
      version: st.version,
      started_at: st.startedAt,
      finished_at: st.finishedAt,
    };
  }

  function onGameEvent(roomId, userId, payload) {
    ok(typeof roomId === 'string' && roomId.length > 0, 'E_ARG', 'roomId required');
    ok(typeof userId === 'string' && userId.length > 0, 'E_ARG', 'userId required');
    ok(payload && typeof payload === 'object', 'E_ARG', 'game event payload required');
    const room = repos.getRoom(roomId);
    const game = repos.getGame(room.game_id);
    ok(game.kind === 'rami', 'E_ARG', 'room is not a rami room');
    const member = room.host_user_id === userId || repos.roomPlayers(roomId).some((p) => p.user_id === userId);
    ok(member, 'E_NOT_IN_GAME', 'user is not a member of this room');
    let m = gameForRoom(roomId);
    if (!m) {
      m = createGame({
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
        return { event: 'rami:state', payload: publicState(m, userId) };
      case 'start': {
        const started = startGame(m.id, { byUserId: userId });
        return { event: 'rami:started', payload: publicState(started, userId) };
      }
      case 'draw':
      case 'meld':
      case 'discard': {
        m = applyAction(m.id, userId, { type: action, source: payload.source, card: payload.card, melds: payload.melds });
        const finished = m.state.status === 'finished';
        return {
          event: finished ? 'rami:finished' : 'rami:state',
          payload: publicState(m, userId),
        };
      }
      case 'cancel': {
        const cancelled = cancelGame(m.id, userId);
        return { event: 'rami:cancelled', payload: publicState(cancelled, userId) };
      }
      default:
        throw new DataError('E_ARG', 'unknown rami action: ' + action);
    }
  }

  function recordAudit(userId, action, detail) {
    try {
      repos.recordAudit({
        actorType: 'user',
        actorId: userId,
        action,
        targetType: 'rami_game',
        targetId: detail.game_id || null,
        detail,
      });
    } catch (_) {
      // audit must never break the game loop
    }
  }

  return {
    createGame,
    getGame,
    gameForRoom,
    listGames,
    joinGame,
    startGame,
    applyAction,
    cancelGame,
    stateOf,
    movesOf,
    publicState,
    verifyGame,
    onGameEvent,
  };
}

module.exports = {
  buildRamiGame,
  MOVE_TYPES,
  GAME_STATUSES,
  defaultHandSize,
  normalizeCard,
  normalizeMelds,
  applySpec,
  freshState,
  computeScores,
  stateCardKeys,
  advance,
};