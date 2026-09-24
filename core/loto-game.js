'use strict';
const crypto = require('node:crypto');
const { DataError, ok, nowIso, genId, safeMeta, safeRollback } = require('./db');
const { canonicalJson, sha256hex } = require('./domino-game');
const { byIdempotency, appendWithinTx } = require('./ledger');
const {
  BALLS,
  assertValidTicket,
  generateTicket,
  buildDrawOrder,
  ticketHash,
  marksForTicket,
  winsForTicket,
  categoriesForTicket,
  computePayouts,
  CATEGORIES,
} = require('./loto');

const EVENT_TYPES = ['open', 'ticket', 'start', 'ball', 'settle', 'cancel'];
const DRAW_STATUSES = ['scheduled', 'active', 'finished', 'cancelled'];
const IGNORED_CANONICAL = new Set(['version', 'startedAt', 'finishedAt']);
const BOT_PREFIX = 'bot:';
const MODES = ['online', 'offline', 'sim'];

function isBot(userId) {
  return typeof userId === 'string' && userId.startsWith(BOT_PREFIX);
}

function normalizeSettings(input, mode) {
  const s = input && typeof input === 'object' ? { ...input } : {};
  const entryFee = Number.isSafeInteger(s.entryFee) && s.entryFee >= 0 ? s.entryFee : 0;
  return {
    maxBalls: Number.isInteger(s.maxBalls) ? Math.min(Math.max(s.maxBalls, 1), BALLS) : BALLS,
    stopOnCarton: s.stopOnCarton === true,
    entryFee: mode === 'online' ? entryFee : 0,
    payout: s.payout && typeof s.payout === 'object' ? { ...s.payout } : {},
  };
}

function validateExplicitBalls(balls) {
  if (!Array.isArray(balls)) return null;
  ok(balls.length >= 1 && balls.length <= BALLS, 'E_ARG', 'balls must contain between 1 and ' + BALLS + ' numbers');
  const seen = new Set();
  for (const n of balls) {
    ok(Number.isInteger(n) && n >= 1 && n <= BALLS, 'E_ARG', 'explicit draw balls must be integers 1..' + BALLS);
    ok(!seen.has(n), 'E_ARG', 'explicit draw balls must be unique');
    seen.add(n);
  }
  return balls.slice();
}

function freshState(m) {
  return {
    mode: m.mode,
    status: m.status,
    seed: m.seed,
    settings: m.settings,
    players: [],
    tickets: [],
    ticketByUser: {},
    pool_milli: 0,
    entry_fees_milli: 0,
    crypto_pool_usd_cents: 0,
    crypto_entry_count: 0,
    crypto_prize_usd_cents: 0,
    crypto_commission_usd_cents: 0,
    crypto_pool_remainder_usd_cents: 0,
    drawn_index: 0,
    drawn: [],
    marks: {},
    wins: [],
    winners: [],
    payouts: [],
    prize_milli: 0,
    commission_milli: 0,
    pool_remainder_milli: 0,
    version: 0,
    startedAt: null,
    finishedAt: null,
  };
}

function computeSettlement(st) {
  const byCategory = {};
  for (const category of CATEGORIES) byCategory[category] = [];
  for (const ticket of st.tickets) {
    const categories = st.marks[ticket.index] ? st.marks[ticket.index].categories : [];
    for (const category of categories) byCategory[category].push(ticket.index);
  }
  for (const category of CATEGORIES) byCategory[category].sort((a, b) => a - b);
  const cryptoMode = st.settings && st.settings.economy && st.settings.economy.mode === 'crypto';
  const pool = cryptoMode ? st.crypto_pool_usd_cents : st.pool_milli;
  const result = computePayouts(pool, byCategory, st.settings.payout);
  const userPrize = {};
  for (const p of result.prize) userPrize[p.ticketIndex] = (userPrize[p.ticketIndex] || 0) + p.amount_milli;
  const winners = st.tickets.map((t) => ({
    ticketIndex: t.index,
    userId: t.userId,
    categories: st.marks[t.index] ? st.marks[t.index].categories.slice() : [],
    prize_milli: cryptoMode ? 0 : (userPrize[t.index] || 0),
    prize_usd_cents: cryptoMode ? (userPrize[t.index] || 0) : 0,
  })).sort((a, b) => a.ticketIndex - b.ticketIndex);
  const payouts = result.prize.map((p) => {
    const t = st.tickets[p.ticketIndex];
    return { ...p, userId: t ? t.userId : null, amount_usd_cents: cryptoMode ? p.amount_milli : 0 };
  });
  return cryptoMode
    ? { winners, payouts, prize_milli: 0, commission_milli: 0, pool_remainder_milli: 0, prize_usd_cents: result.prize_milli, commission_usd_cents: result.commission_milli, pool_remainder_usd_cents: result.remainder_milli }
    : { winners, payouts, prize_milli: result.prize_milli, commission_milli: result.commission_milli, pool_remainder_milli: result.remainder_milli, prize_usd_cents: 0, commission_usd_cents: 0, pool_remainder_usd_cents: 0 };
}

function refreshMarks(st) {
  const drawnSet = new Set(st.drawn);
  st.marks = {};
  st.wins = [];
  for (const ticket of st.tickets) {
    st.marks[ticket.index] = {
      total: 0,
      perRow: [0, 0, 0],
      categories: [],
    };
    if (!ticket.grid) continue;
    const marks = marksForTicket(ticket.grid, drawnSet);
    const wins = winsForTicket(ticket.grid, st.drawn);
    st.marks[ticket.index] = {
      ...marks,
      categories: categoriesForTicket(ticket.grid, st.drawn),
    };
    for (const win of wins) {
      st.wins.push({ ...win, ticketIndex: ticket.index });
    }
  }
  st.wins.sort(
    (a, b) => a.ball_index - b.ball_index || a.ticketIndex - b.ticketIndex,
  );
}

function shouldAutoSettle(st) {
  if (st.settings.stopOnCarton && st.wins.some((w) => w.category === 'carton_plein')) return true;
  if (st.drawn.length >= st.settings.maxBalls) return true;
  return false;
}

function applySpec(st, spec) {
  switch (spec.eventType) {
    case 'open': {
      st.version += 1;
      return;
    }
    case 'ticket': {
      ok(
        spec.userId &&
          typeof spec.userId === 'string' &&
          !st.ticketByUser[spec.userId],
        'E_ALREADY_BOUGHT',
        'a ticket for this draw is already owned by ' + spec.userId,
      );
      const ticket = {
        index: st.tickets.length,
        userId: spec.userId,
        kind: spec.kind || (isBot(spec.userId) ? 'bot' : 'human'),
        ticket_hash: spec.ticketHash,
        grid: spec.grid,
        entry_fee_milli: spec.entryFee,
      };
      st.players.push({ userId: spec.userId, kind: ticket.kind, joinedAt: null });
      st.tickets.push(ticket);
      st.ticketByUser[spec.userId] = ticket.index;
      if (st.settings && st.settings.economy && st.settings.economy.mode === 'crypto') {
        st.crypto_pool_usd_cents += st.settings.economy.stake_usd_cents;
        st.crypto_entry_count += 1;
      } else {
        st.pool_milli += spec.entryFee;
        st.entry_fees_milli += spec.entryFee;
      }
      st.version += 1;
      return;
    }
    case 'start': {
      st.status = 'active';
      st.startedAt = spec.startedAt || nowIso();
      st.version += 1;
      return;
    }
    case 'ball': {
      ok(st.status === 'active', 'E_DRAW_NOT_ACTIVE', 'draw is not active');
      ok(Number.isInteger(spec.ball) && spec.ball >= 1 && spec.ball <= BALLS, 'E_ARG', 'ball required');
      ok(!st.drawn.includes(spec.ball), 'E_BALL_DUP', 'ball already drawn: ' + spec.ball);
      st.drawn.push(spec.ball);
      st.drawn_index += 1;
      refreshMarks(st);
      st.version += 1;
      return;
    }
    case 'settle': {
      ok(st.status === 'active', 'E_DRAW_NOT_ACTIVE', 'draw must be active to settle');
      const result = computeSettlement(st);
      st.winners = result.winners;
      st.payouts = result.payouts;
      st.prize_milli = result.prize_milli;
      st.commission_milli = result.commission_milli;
      st.pool_remainder_milli = result.pool_remainder_milli;
      st.crypto_prize_usd_cents = result.prize_usd_cents;
      st.crypto_commission_usd_cents = result.commission_usd_cents;
      st.crypto_pool_remainder_usd_cents = result.pool_remainder_usd_cents;
      st.status = 'finished';
      st.finishedAt = spec.finishedAt || nowIso();
      st.version += 1;
      return;
    }
    case 'cancel': {
      st.status = 'cancelled';
      st.finishedAt = spec.finishedAt || nowIso();
      st.version += 1;
      return;
    }
    default:
      throw new DataError('E_ARG', 'unknown event_type: ' + spec.eventType);
  }
}

function buildLotoGame(deps) {
  const db = deps && deps.db;
  const repos = deps && deps.repos;
  const gameWallet = (deps && deps.gameWallet) || null;
  const cryptoLedger = (deps && deps.cryptoLedger) || null;
  ok(db, 'E_ARG', 'loto game requires db');
  ok(repos, 'E_ARG', 'loto game requires repos');

  function getDraw(id) {
    const row = db.prepare('SELECT * FROM loto_draws WHERE id = ?').get(id);
    ok(row, 'E_NO_DRAW', 'loto draw not found: ' + id);
    return loadDraw(row);
  }

  function loadDraw(row) {
    const settings = JSON.parse(row.settings_json || '{}');
    const parsedState = JSON.parse(row.state_json || '{}');
    const state = { ...freshState({ ...row, settings }), ...parsedState };
    if (!Array.isArray(state.payouts)) state.payouts = [];
    if (!Array.isArray(state.winners)) state.winners = [];
    const stateHash = row.state_hash;
    return { ...row, settings, state, state_hash: stateHash };
  }

  function drawForRoom(roomId) {
    const row = db
      .prepare('SELECT * FROM loto_draws WHERE room_id = ? ORDER BY created_at ASC LIMIT 1')
      .get(roomId);
    return row ? loadDraw(row) : null;
  }

  function eventsOf(drawId) {
    return db
      .prepare('SELECT * FROM loto_events WHERE draw_id = ? ORDER BY event_index ASC')
      .all(drawId)
      .map(parseEvent);
  }

  function parseEvent(row) {
    let detail = {};
    try {
      detail = JSON.parse(row.detail_json || '{}');
    } catch (_) {
      detail = {};
    }
    return { ...row, detail };
  }

  function genesisHash(m) {
    return sha256hex(canonicalJson({ id: m.id, mode: m.mode, seed: m.seed, settings: m.settings }));
  }

  function eventHash(m, spec, prevHash) {
    const payload = canonicalJson({
      draw_id: m.id,
      event_index: spec.eventIndex,
      user_id: spec.userId,
      event_type: spec.eventType,
      ball: spec.ball === undefined ? null : spec.ball,
      ticket_index: spec.ticketIndex === undefined ? null : spec.ticketIndex,
      ticket_hash: spec.ticketHash === undefined ? null : spec.ticketHash,
    });
    return sha256hex(payload + '\x1f' + prevHash);
  }

  function persistDraw(m) {
    m.state_hash = sha256hex(canonicalJson(m.state, IGNORED_CANONICAL));
    db.prepare(
      `UPDATE loto_draws SET state_json = ?, state_hash = ?, status = ?, updated_at = ?, finished_at = ? WHERE id = ?`,
    ).run(safeMeta(m.state), m.state_hash, m.state.status, nowIso(), m.state.finishedAt || null, m.id);
  }

  function persistEvent(m, spec, prevHash) {
    db.prepare(
      `INSERT INTO loto_events (draw_id, event_index, user_id, event_type, ball, ticket_index, ticket_hash, hash, detail_json, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      m.id,
      spec.eventIndex,
      spec.userId,
      spec.eventType,
      spec.ball === undefined ? null : spec.ball,
      spec.ticketIndex === undefined ? null : spec.ticketIndex,
      spec.ticketHash === undefined ? null : spec.ticketHash,
      spec.hash,
      safeMeta(spec.detail),
      nowIso(),
    );
  }

  function chainTail(m, upToIndex) {
    if (upToIndex < 1) return genesisHash(m);
    const row = db
      .prepare('SELECT * FROM loto_events WHERE draw_id = ? AND event_index = ?')
      .get(m.id, upToIndex);
    ok(row, 'E_NO_EVENT', 'event ' + upToIndex + ' not found for chain tail');
    return row.hash;
  }

  function findNextEventIndex(drawId) {
    const row = db
      .prepare('SELECT MAX(event_index) AS n FROM loto_events WHERE draw_id = ?')
      .get(drawId);
    return (row && row.n === null ? 0 : row.n) + 1;
  }

  function runStep(m, spec) {
    db.exec('BEGIN IMMEDIATE');
    try {
      applySpec(m.state, spec);
      const prevHash = chainTail(m, spec.eventIndex - 1);
      spec.hash = eventHash(m, spec, prevHash);
      applyMoney(m, spec);
      persistEvent(m, spec, prevHash);
      persistDraw(m);
      db.exec('COMMIT');
      return m;
    } catch (err) {
      safeRollback(db);
      throw err;
    }
  }

  function walletFor(userId) {
    if (isBot(userId)) return null;
    return repos.getWalletByUser(userId);
  }

  function entryKey(drawId, userId) {
    return 'loto:ticket:' + drawId + ':' + userId;
  }

  function prizeKey(drawId, payout) {
    return 'loto:prize:' + drawId + ':' + payout.ticketIndex + ':' + payout.category;
  }

  function commissionKey(drawId) {
    return 'loto:commission:' + drawId + ':house';
  }

  function refundKey(drawId, userId) {
    return 'loto:refund:' + drawId + ':' + userId;
  }

  function applyMoney(m, spec) {
    const econ = m.state.settings && m.state.settings.economy;
    if (econ && econ.mode === 'crypto') {
      if (spec.eventType === 'ticket') {
        gameWallet.chargeCryptoEntryFeeWithinTx({
          gameKind: 'loto', gameId: m.id, userId: spec.userId,
          stakeUsdCents: econ.stake_usd_cents, asset: econ.asset, network: econ.network,
          eventHash: spec.hash,
        });
        return;
      }
      if (spec.eventType === 'settle') {
        for (const payout of m.state.payouts) {
          if (!(payout.amount_usd_cents > 0) || isBot(payout.userId)) continue;
          gameWallet.creditCryptoPrizeWithinTx({
            gameKind: 'loto', gameId: m.id, userId: payout.userId,
            amountUsdCents: payout.amount_usd_cents,
            asset: econ.asset, network: econ.network,
            ref: String(payout.ticketIndex) + ':' + String(payout.category), eventHash: spec.hash,
          });
        }
        const auditExists = db.prepare("SELECT id FROM audit_entries WHERE action = 'game.crypto_commission.credited' AND target_type = 'game' AND target_id = ? LIMIT 1").get(m.id);
        if (!auditExists) {
          repos.recordAudit({
            actorType: 'system',
            actorId: gameWallet.houseWallet().user_id,
            action: 'game.crypto_commission.credited',
            targetType: 'game',
            targetId: m.id,
            detail: {
              game_kind: 'loto',
              commission_fraction: 0.1,
              stake_usd_cents: econ.stake_usd_cents,
              pot_usd_cents: m.state.crypto_pool_usd_cents,
              commission_usd_cents: m.state.crypto_commission_usd_cents,
              prize_usd_cents: m.state.crypto_prize_usd_cents,
              asset: econ.asset,
              network: econ.network,
              admin_revenue: true,
            },
          });
        }
        return;
      }
      if (spec.eventType === 'cancel') {
        for (const ticket of m.state.tickets) {
          if (isBot(ticket.userId)) continue;
          gameWallet.refundCryptoEntryWithinTx({
            gameKind: 'loto', gameId: m.id, userId: ticket.userId,
            stakeUsdCents: econ.stake_usd_cents, asset: econ.asset, network: econ.network,
            eventHash: spec.hash,
          });
        }
        return;
      }
      return;
    }
    if (spec.eventType === 'ticket' && spec.entryFee > 0) {
      const wallet = walletFor(spec.userId);
      ok(wallet, 'E_NO_WALLET', 'player has no wallet to pay the entry fee');
      appendWithinTx(db, {
        wallet_id: wallet.id,
        idempotency_key: entryKey(m.id, spec.userId),
        tx_type: 'entry_fee',
        direction: 'debit',
        amount_milli: spec.entryFee,
        status: 'committed',
        meta: { draw_id: m.id, game_kind: 'loto', game_id: m.id, event_hash: spec.hash, kind: 'loto_entry_fee' },
      });
      return;
    }
    if (spec.eventType === 'settle') {
      for (const payout of m.state.payouts) {
        if (payout.amount_milli <= 0 || isBot(payout.userId)) continue;
        const wallet = walletFor(payout.userId);
        ok(wallet, 'E_NO_WALLET', 'winner has no wallet for prize credit: ' + payout.userId);
        appendWithinTx(db, {
          wallet_id: wallet.id,
          idempotency_key: prizeKey(m.id, payout),
          tx_type: 'prize',
          direction: 'credit',
          amount_milli: payout.amount_milli,
          status: 'committed',
          meta: {
            draw_id: m.id,
            game_kind: 'loto',
            game_id: m.id,
            ticket_index: payout.ticketIndex,
            category: payout.category,
            event_hash: spec.hash,
            kind: 'loto_prize',
          },
        });
      }
      if (gameWallet && m.state.commission_milli > 0) {
        gameWallet.creditCommission({
          gameKind: 'loto',
          gameId: m.id,
          amountMilli: m.state.commission_milli,
          eventHash: spec.hash,
          idempotencyKey: commissionKey(m.id),
        });
      }
      return;
    }
    if (spec.eventType === 'cancel' && m.state.entry_fees_milli > 0) {
      for (const ticket of m.state.tickets) {
        if (isBot(ticket.userId) || !(ticket.entry_fee_milli > 0)) continue;
        const wallet = walletFor(ticket.userId);
        ok(wallet, 'E_NO_WALLET', 'ticket holder has no wallet for refund: ' + ticket.userId);
        appendWithinTx(db, {
          wallet_id: wallet.id,
          idempotency_key: refundKey(m.id, ticket.userId),
          tx_type: 'refund',
          direction: 'credit',
          amount_milli: ticket.entry_fee_milli,
          status: 'committed',
          meta: { draw_id: m.id, game_kind: 'loto', game_id: m.id, event_hash: spec.hash, kind: 'loto_refund' },
        });
      }
      return;
    }
  }

  function createDraw(input) {
    const mode = input && input.mode;
    const userId = input && input.userId;
    const roomId = (input && input.roomId) || null;
    ok(MODES.includes(mode), 'E_ARG', 'mode must be one of ' + MODES.join('/'));
    ok(typeof userId === 'string' && userId.length > 0, 'E_ARG', 'userId required');
    if (mode === 'online') {
      const room = repos.getRoom(roomId);
      const game = repos.getGame(room.game_id);
      ok(game.kind === 'loto', 'E_ARG', 'room does not belong to loto game');
    } else if (roomId) {
      const room = repos.getRoom(roomId);
      const game = repos.getGame(room.game_id);
      ok(game.kind === 'loto', 'E_ARG', 'room does not belong to loto game');
    }
    const settings = normalizeSettings(input && input.settings, mode);
    if (gameWallet) {
      settings.economy = gameWallet.normalizeEconomy(input && input.settings, mode);
      if (settings.economy.mode === 'crypto') settings.entryFee = 0;
    }
    const explicitBalls = validateExplicitBalls((input && input.settings && input.settings.balls) || null);
    if (explicitBalls) settings.balls = explicitBalls.slice();
    const seed = settings.seed || genId() + ':' + crypto.randomBytes(8).toString('hex');
    delete settings.seed;
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
    m.state.drawOrder = buildDrawOrder(seed, explicitBalls);
    m.state_hash = sha256hex(canonicalJson(m.state, IGNORED_CANONICAL));
    db.prepare(
      `INSERT INTO loto_draws (id, user_id, room_id, mode, status, settings_json, seed, state_json, state_hash, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      id,
      userId,
      roomId,
      mode,
      'scheduled',
      safeMeta(settings),
      seed,
      safeMeta(m.state),
      m.state_hash,
      ts,
      ts,
    );
    runStep(m, { eventIndex: 1, userId, eventType: 'open', detail: { mode, room_id: roomId } });
    if (mode === 'offline') {
      for (let i = 1; i <= 2; i += 1) {
        buyTicketInternal(m, 'bot:' + i, null);
      }
      buyTicketInternal(m, userId, null);
    }
    recordAudit(userId, 'loto.draw.created', { mode, room_id: roomId, draw_id: id });
    return getDraw(id);
  }

  function ticketForUser(m, userId) {
    const index = m.state.ticketByUser[userId];
    if (index === undefined) return null;
    return m.state.tickets[index];
  }

  function buyTicketInternal(m, userId, gridOrNull) {
    const existing = ticketForUser(m, userId);
    if (existing) return { ticket: existing, idempotent: true };
    let grid;
    if (gridOrNull) {
      grid = assertValidTicket(gridOrNull);
    } else {
      const rngSeed = sha256hex(m.id + ':' + userId);
      grid = generateTicket(rngSeed);
    }
    const spec = {
      eventIndex: findNextEventIndex(m.id),
      userId,
      eventType: 'ticket',
      grid,
      ticketHash: ticketHash(grid),
      entryFee: m.state.settings.entryFee || 0,
      kind: isBot(userId) ? 'bot' : 'human',
      detail: {
        ticket_index: m.state.tickets.length,
        ticket_hash: ticketHash(grid),
        entry_fee_milli: m.state.settings.entryFee || 0,
        kind: isBot(userId) ? 'bot' : 'human',
        grid,
      },
      ticketIndex: m.state.tickets.length,
    };
    runStep(m, spec);
    recordAudit(userId, 'loto.ticket.bought', { draw_id: m.id, ticket_index: spec.ticketIndex });
    return { ticket: ticketForUser(m, userId), idempotent: false };
  }

  function purchaseTicket(drawId, userId, opts) {
    const m = getDraw(drawId);
    ok(m.state.status === 'scheduled' || m.state.status === 'active', 'E_DRAW_CLOSED', 'draw is not accepting tickets');
    ok(typeof userId === 'string' && userId.length > 0, 'E_ARG', 'userId required');
    ok(opts === undefined || opts === null || typeof opts === 'object', 'E_ARG', 'options must be an object');
    const result = buyTicketInternal(m, userId, opts && opts.grid || null);
    return { draw: getDraw(drawId), ...result };
  }

  function requireParticipant(m, userId) {
    const t = ticketForUser(m, userId);
    ok(t || m.user_id === userId, 'E_NOT_IN_DRAW', 'user is not part of this draw');
    return t;
  }

  function startDraw(drawId, byUserId) {
    const m = getDraw(drawId);
    ok(m.state.status === 'scheduled', 'E_DRAW_ACTIVE', 'draw already started');
    ok(typeof byUserId === 'string' && byUserId.length > 0, 'E_ARG', 'byUserId required');
    ok(m.state.players.length >= 1, 'E_NO_TICKETS', 'draw needs at least one ticket before starting');
    requireParticipant(m, byUserId);
    runStep(m, {
      eventIndex: findNextEventIndex(m.id),
      userId: byUserId,
      eventType: 'start',
      startedAt: nowIso(),
      detail: {},
    });
    recordAudit(byUserId, 'loto.draw.started', { draw_id: m.id });
    return getDraw(drawId);
  }

  function nextBall(drawId, byUserId) {
    const m = getDraw(drawId);
    const st = m.state;
    ok(st.status === 'active', 'E_DRAW_NOT_ACTIVE', 'draw is not active');
    requireParticipant(m, byUserId);
    ok(st.drawn_index < st.drawOrder.length, 'E_DRAW_ENDED', 'all balls have been drawn');
    const ball = st.drawOrder[st.drawn_index];
    runStep(m, {
      eventIndex: findNextEventIndex(m.id),
      userId: byUserId,
      eventType: 'ball',
      ball,
      detail: { position: st.drawn.length + 1 },
    });
    if (shouldAutoSettle(m.state)) {
      settleDraw(drawId, byUserId);
      return getDraw(drawId);
    }
    return getDraw(drawId);
  }

  function settleDraw(drawId, byUserId) {
    const m = getDraw(drawId);
    const st = m.state;
    ok(st.status === 'active', 'E_DRAW_NOT_ACTIVE', 'draw must be active to settle');
    requireParticipant(m, byUserId);
    const settlement = computeSettlement(st);
    runStep(m, {
      eventIndex: findNextEventIndex(m.id),
      userId: byUserId,
      eventType: 'settle',
      detail: {
        winners: settlement.winners.length,
        payouts: settlement.payouts.length,
        prize_milli: settlement.prize_milli,
        commission_milli: settlement.commission_milli,
        pool: st.pool_milli,
      },
    });
    recordAudit(byUserId, 'loto.draw.settled', {
      draw_id: m.id,
      prize_milli: settlement.prize_milli,
      payouts: settlement.payouts.length,
    });
    return getDraw(drawId);
  }

  function cancelDraw(drawId, userId) {
    const m = getDraw(drawId);
    ok(m.state.status === 'scheduled', 'E_DRAW_CLOSED', 'only a scheduled draw can be cancelled');
    ok(m.user_id === userId, 'E_FORBIDDEN', 'only the draw owner can cancel');
    ok(m.state.tickets.length === 0, 'E_HAS_TICKETS', 'draw with purchased tickets cannot be cancelled; use refundDraw');
    runStep(m, {
      eventIndex: findNextEventIndex(m.id),
      userId,
      eventType: 'cancel',
      detail: {},
    });
    recordAudit(userId, 'loto.draw.cancelled', { draw_id: m.id });
    return getDraw(drawId);
  }

  function refundDraw(drawId, userId) {
    const m = getDraw(drawId);
    ok(
      m.state.status === 'scheduled' || m.state.status === 'active',
      'E_DRAW_CLOSED',
      'draw is already finished or cancelled',
    );
    ok(m.user_id === userId, 'E_FORBIDDEN', 'only the draw owner can refund');
    ok(m.state.tickets.length > 0, 'E_NO_TICKETS', 'draw has no purchased tickets to refund');
    const refundable = m.state.tickets.filter((t) => !isBot(t.userId) && t.entry_fee_milli > 0);
    runStep(m, {
      eventIndex: findNextEventIndex(m.id),
      userId,
      eventType: 'cancel',
      detail: { refund: true, tickets: m.state.tickets.length, refundable: refundable.length },
    });
    recordAudit(userId, 'loto.draw.refunded', { draw_id: m.id, refundable: refundable.length });
    return getDraw(drawId);
  }

  function stateOf(drawId) {
    return getDraw(drawId).state;
  }

  function listDraws(options = {}) {
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
      'SELECT * FROM loto_draws' +
      (where.length ? ' WHERE ' + where.join(' AND ') : '') +
      ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    return db.prepare(sql).all(...params, limit, offset).map(loadDraw);
  }

  function verifyDraw(drawId) {
    const m = getDraw(drawId);
    const st = freshState(m);
    st.drawOrder = m.state.drawOrder.slice();
    const events = eventsOf(drawId);
    let prev = genesisHash(m);
    for (const row of events) {
      const expected = sha256hex(
        canonicalJson({
          draw_id: row.draw_id,
          event_index: row.event_index,
          user_id: row.user_id,
          event_type: row.event_type,
          ball: row.ball === undefined || row.ball === null ? null : row.ball,
          ticket_index: row.ticket_index === undefined || row.ticket_index === null ? null : row.ticket_index,
          ticket_hash: row.ticket_hash === undefined || row.ticket_hash === null ? null : row.ticket_hash,
        }) + '\x1f' + prev,
      );
      if (expected !== row.hash) {
        throw new DataError('E_TAMPER', 'loto event hash mismatch at index ' + row.event_index);
      }
      prev = row.hash;
      applySpec(st, {
        userId: row.user_id,
        eventType: row.event_type,
        ball: row.ball === null ? undefined : row.ball,
        kind: row.detail.kind,
        ticketIndex: row.ticket_index,
        ticketHash: row.ticket_hash,
        grid: row.detail.grid,
        entryFee: row.detail.entry_fee_milli || 0,
      });
    }
    const replayed = canonicalJson(st, IGNORED_CANONICAL);
    const stored = canonicalJson(m.state, IGNORED_CANONICAL);
    if (replayed !== stored) {
      throw new DataError('E_TAMPER', 'loto final state does not match the event replay');
    }
    const expectedStateHash = sha256hex(canonicalJson(m.state, IGNORED_CANONICAL));
    if (m.state_hash !== expectedStateHash) {
      throw new DataError('E_TAMPER', 'loto state hash mismatch');
    }
    verifyWalletHandshake(m);
    return { ok: true, events: events.length, state_hash: m.state_hash };
  }

  function requireEntry(drawId, walletId, key, amount, label) {
    const entry = byIdempotency(db, walletId, key);
    if (!entry || entry.status !== 'committed') {
      throw new DataError('E_TAMPER', label + ' ledger entry missing for draw ' + drawId);
    }
    if (entry.amount_milli !== amount) {
      throw new DataError('E_TAMPER', label + ' ledger amount mismatch for draw ' + drawId);
    }
  }

  function verifyWalletHandshake(m) {
    const econ = m.state.settings && m.state.settings.economy;
    if (econ && econ.mode === 'crypto') {
      ok(cryptoLedger, 'E_CRYPTO_ECONOMY', 'crypto ledger is unavailable');
      const humanTickets = m.state.tickets.filter((t) => !isBot(t.userId));
      for (const ticket of humanTickets) {
        const key = m.state.status === 'cancelled'
          ? 'loto:crypto-refund:' + m.id + ':' + ticket.userId
          : 'loto:crypto-stake:' + m.id + ':' + ticket.userId;
        const row = cryptoLedger.listEntries(cryptoLedger.getBalance(ticket.userId, econ.asset, econ.network)?.id || '', 500)
          .find((entry) => entry.idempotency_key === key);
        if (!row || (row.tx_type !== 'debit' && row.tx_type !== 'credit')) throw new DataError('E_TAMPER', 'crypto ticket ledger missing for ' + ticket.userId);
        if (cryptoLedger.normalizeDecimal(row.amount) !== cryptoLedger.normalizeDecimal(econ.amount_crypto)) throw new DataError('E_TAMPER', 'crypto ticket amount mismatch for draw ' + m.id);
      }
      const house = gameWallet ? gameWallet.houseWallet() : null;
      if (!house) throw new DataError('E_TAMPER', 'crypto house wallet missing for draw ' + m.id);
      for (const payout of m.state.payouts) {
        if (!(payout.amount_usd_cents > 0) || isBot(payout.userId)) continue;
        const ref = String(payout.ticketIndex) + ':' + String(payout.category);
        const entries = cryptoLedger.listEntries(cryptoLedger.getBalance(house.user_id, econ.asset, econ.network)?.id || '', 500);
        const debit = entries.find((entry) => entry.idempotency_key === 'loto:crypto-prize-pot:' + m.id + ':' + ref);
        const userBalance = cryptoLedger.getBalance(payout.userId, econ.asset, econ.network);
        const credit = userBalance ? cryptoLedger.listEntries(userBalance.id, 500).find((entry) => entry.idempotency_key === 'loto:crypto-prize:' + m.id + ':' + ref) : null;
        if (!debit || !credit) throw new DataError('E_TAMPER', 'crypto prize ledger missing for draw ' + m.id);
      }
      if (m.state.status === 'finished') {
        const expectedCommission = Math.floor(m.state.crypto_pool_usd_cents * 0.1);
        const audit = db.prepare("SELECT * FROM audit_entries WHERE action = 'game.crypto_commission.credited' AND target_type = 'game' AND target_id = ? LIMIT 1").get(m.id);
        if (!audit) throw new DataError('E_TAMPER', 'crypto commission audit missing for draw ' + m.id);
        let detail = {};
        try { detail = JSON.parse(audit.detail_json || '{}'); } catch (_) {}
        if (detail.commission_fraction !== 0.1 || detail.commission_usd_cents !== expectedCommission || detail.admin_revenue !== true) {
          throw new DataError('E_TAMPER', 'crypto commission audit mismatch for draw ' + m.id);
        }
      }
      const ledgerCheck = cryptoLedger.verify();
      return { ok: true, mode: 'crypto', ledger: ledgerCheck };
    }
    for (const payout of m.state.payouts) {
      if (payout.amount_milli <= 0 || isBot(payout.userId)) continue;
      const wallet = repos.getWalletByUser(payout.userId);
      requireEntry(m.id, wallet.id, prizeKey(m.id, payout), payout.amount_milli, 'prize');
    }
    if (m.state.entry_fees_milli > 0) {
      const cancelled = m.state.status === 'cancelled';
      for (const ticket of m.state.tickets) {
        if (isBot(ticket.userId) || !(ticket.entry_fee_milli > 0)) continue;
        const wallet = repos.getWalletByUser(ticket.userId);
        const key = cancelled ? refundKey(m.id, ticket.userId) : entryKey(m.id, ticket.userId);
        const label = cancelled ? 'refund' : 'entry fee';
        requireEntry(m.id, wallet.id, key, ticket.entry_fee_milli, label);
      }
    }
    if (gameWallet && m.state.commission_milli > 0) {
      const house = gameWallet.houseWallet();
      if (house) {
        requireEntry(m.id, house.id, commissionKey(m.id), m.state.commission_milli, 'commission');
      }
    }
  }

  function publicState(m, withUserId) {
    const st = m.state;
    const own = withUserId ? ticketForUser(m, withUserId) : null;
    return {
      draw_id: m.id,
      mode: m.mode,
      status: st.status,
      seed: m.seed,
      settings: st.settings,
      tickets: st.tickets.map((t) => {
        const prize = st.payouts
          .filter((p) => p.ticketIndex === t.index)
          .reduce((sum, p) => sum + p.amount_milli, 0);
        return {
          index: t.index,
          user_id: t.kind === 'bot' ? null : t.userId,
          kind: t.kind,
          ticket_hash: t.ticket_hash,
          entry_fee_milli: t.entry_fee_milli,
          marked: st.marks[t.index] ? st.marks[t.index].total : 0,
          categories: st.marks[t.index] ? st.marks[t.index].categories : [],
          prize_milli: prize,
        };
      }),
      own_grid: own ? own.grid : null,
      cagnotte_milli: st.pool_milli,
      balls_drawn: st.drawn_index,
      balls_total: st.drawOrder.length,
      drawn: st.drawn,
      next_ball: st.drawn_index < st.drawOrder.length ? st.drawOrder[st.drawn_index] : null,
      wins: st.wins,
      winners: st.winners,
      prize_milli: st.prize_milli,
      commission_milli: st.commission_milli,
      pool_remainder_milli: st.pool_remainder_milli,
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
    ok(game.kind === 'loto', 'E_ARG', 'room is not a loto room');
    const member = room.host_user_id === userId || repos.roomPlayers(roomId).some((p) => p.user_id === userId);
    ok(member, 'E_NOT_IN_DRAW', 'user is not a member of this room');
    let m = drawForRoom(roomId);
    if (!m) {
      m = createDraw({
        mode: 'online',
        userId: room.host_user_id,
        roomId,
        settings: payload.settings || (game.config && game.config.settings) || null,
      });
    }
    const action = payload.action;
    switch (action) {
      case 'status':
        return { event: 'loto:state', payload: publicState(m, userId) };
      case 'buy': {
        const bought = purchaseTicket(m.id, userId, { grid: payload.grid });
        const finished = bought.draw.state.status === 'finished';
        return {
          event: finished ? 'loto:finished' : 'loto:state',
          payload: publicState(bought.draw, userId),
        };
      }
      case 'start': {
        const d = startDraw(m.id, userId);
        return { event: 'loto:started', payload: publicState(d, userId) };
      }
      case 'ball': {
        const d = nextBall(m.id, userId);
        const finished = d.state.status === 'finished';
        return {
          event: finished ? 'loto:finished' : 'loto:ball',
          payload: publicState(d, userId),
        };
      }
      case 'settle': {
        const d = settleDraw(m.id, userId);
        return { event: 'loto:finished', payload: publicState(d, userId) };
      }
      case 'cancel': {
        const d = cancelDraw(m.id, userId);
        return { event: 'loto:cancelled', payload: publicState(d, userId) };
      }
      case 'refund': {
        const d = refundDraw(m.id, userId);
        return { event: 'loto:refunded', payload: publicState(d, userId) };
      }
      default:
        throw new DataError('E_ARG', 'unknown loto action: ' + action);
    }
  }

  function recordAudit(userId, action, detail) {
    try {
      repos.recordAudit({
        actorType: 'user',
        actorId: userId,
        action,
        targetType: 'loto_draw',
        targetId: detail.draw_id || null,
        detail,
      });
    } catch (_) {
      // audit must never break the game loop
    }
  }

  return {
    createDraw,
    getDraw,
    drawForRoom,
    listDraws,
    purchaseTicket,
    startDraw,
    nextBall,
    settleDraw,
    cancelDraw,
    refundDraw,
    stateOf,
    eventsOf,
    publicState,
    verifyDraw,
    onGameEvent,
  };
}

module.exports = {
  buildLotoGame,
  EVENT_TYPES,
  DRAW_STATUSES,
  normalizeSettings,
};