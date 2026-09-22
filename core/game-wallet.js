'use strict';
const { DataError, ok } = require('./db');
const { appendWithinTx } = require('./ledger');

const HOUSE_USERNAME = 'acep_house';
const HOUSE_DISPLAY_NAME = 'ACEP HOUSE';
const DEFAULT_COMMISSION = 0.1;
const BOT_PREFIX = 'bot:';
const GAME_KINDS = ['domino', 'loto', 'rami'];

function isBot(userId) {
  return typeof userId === 'string' && userId.startsWith(BOT_PREFIX);
}

function fractionOf(amount, fraction) {
  if (typeof fraction !== 'number' || !Number.isFinite(fraction) || fraction <= 0) return 0;
  if (fraction >= 1) return amount;
  return Math.floor(amount * fraction);
}

function normalizeCommission(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value >= 1) {
    return DEFAULT_COMMISSION;
  }
  return value;
}

function normalizeEconomy(input, mode) {
  const raw = input && typeof input === 'object' ? input : {};
  const entryFee =
    Number.isSafeInteger(raw.entryFee) && raw.entryFee >= 0 ? raw.entryFee : 0;
  let commission = raw.commission;
  if (commission === undefined && raw.payout && typeof raw.payout === 'object') {
    commission = raw.payout.commission;
  }
  return {
    entry_fee_milli: mode === 'online' ? entryFee : 0,
    commission_fraction: normalizeCommission(commission),
  };
}

function humanPlayers(players) {
  return (Array.isArray(players) ? players : []).filter(
    (p) => p && typeof p.userId === 'string' && p.kind !== 'bot' && !isBot(p.userId),
  );
}

function potBreakdown(entryFeeMilli, payers, commissionFraction) {
  const fee = Number.isSafeInteger(entryFeeMilli) && entryFeeMilli > 0 ? entryFeeMilli : 0;
  const count = Number.isSafeInteger(payers) && payers > 0 ? payers : 0;
  const pot = fee * count;
  const commission_milli = fractionOf(pot, normalizeCommission(commissionFraction));
  const prize_milli = pot - commission_milli;
  return { entry_fee_milli: fee, payers: count, pot_milli: pot, prize_milli, commission_milli };
}

function moneyKey(gameKind, kind, gameId, ref) {
  return [gameKind, kind, gameId, ref].join(':');
}

function buildGameWallet(deps) {
  const db = deps && deps.db;
  const repos = deps && deps.repos;
  const options = (deps && deps.options) || {};
  ok(db, 'E_ARG', 'game wallet requires db');
  ok(repos, 'E_ARG', 'game wallet requires repos');

  const houseEnabled = options.house !== false && options.disableHouse !== true;
  let cachedHouseWalletId = options.houseWalletId || null;

  function walletForUser(userId) {
    const row = db.prepare('SELECT * FROM wallets WHERE user_id = ?').get(userId);
    return row || null;
  }

  function houseWallet() {
    if (!houseEnabled) return null;
    if (cachedHouseWalletId) {
      const row = db.prepare('SELECT * FROM wallets WHERE id = ?').get(cachedHouseWalletId);
      if (row) return row;
      cachedHouseWalletId = null;
    }
    const username = options.houseUsername || HOUSE_USERNAME;
    let user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user) {
      try {
        user = repos.createUser({
          username,
          displayName: options.houseDisplayName || HOUSE_DISPLAY_NAME,
          role: 'support',
        });
      } catch (_) {
        user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
        if (!user) throw new DataError('E_NO_HOUSE_WALLET', 'unable to provision the house account');
      }
    }
    let wallet = walletForUser(user.id);
    if (!wallet) {
      wallet = repos.createWallet(user.id, { currency: 'MGA' });
    }
    cachedHouseWalletId = wallet.id;
    return wallet;
  }

  function houseWalletId() {
    const wallet = houseWallet();
    return wallet ? wallet.id : null;
  }

  function debit(input, idempotencyKey) {
    const result = appendWithinTx(db, {
      wallet_id: input.walletId,
      idempotency_key: idempotencyKey,
      tx_type: input.txType,
      direction: 'debit',
      amount_milli: input.amountMilli,
      status: 'committed',
      meta: { ...(input.meta || {}), game_kind: input.gameKind, game_id: input.gameId },
    });
    return result;
  }

  function credit(input, idempotencyKey) {
    const result = appendWithinTx(db, {
      wallet_id: input.walletId,
      idempotency_key: idempotencyKey,
      tx_type: input.txType,
      direction: 'credit',
      amount_milli: input.amountMilli,
      status: 'committed',
      meta: { ...(input.meta || {}), game_kind: input.gameKind, game_id: input.gameId },
    });
    return result;
  }

  function chargeEntryFee(input) {
    ok(input && typeof input === 'object', 'E_ARG', 'entry fee input required');
    ok(GAME_KINDS.includes(input.gameKind), 'E_ARG', 'invalid game kind: ' + input.gameKind);
    ok(typeof input.gameId === 'string' && input.gameId.length > 0, 'E_ARG', 'gameId required');
    ok(Number.isSafeInteger(input.amountMilli) && input.amountMilli > 0, 'E_ARG', 'entry fee must be positive');
    if (isBot(input.userId)) return { skipped: true, reason: 'bot' };
    const wallet = input.walletId
      ? db.prepare('SELECT * FROM wallets WHERE id = ?').get(input.walletId)
      : walletForUser(input.userId);
    ok(wallet, 'E_NO_WALLET', 'player has no wallet to pay the entry fee');
    const key =
      input.idempotencyKey || moneyKey(input.gameKind, 'entry', input.gameId, wallet.id);
    const result = debit(
      {
        walletId: wallet.id,
        txType: 'entry_fee',
        amountMilli: input.amountMilli,
        gameKind: input.gameKind,
        gameId: input.gameId,
        meta: { event_hash: input.eventHash || null, kind: 'game_entry_fee' },
      },
      key,
    );
    return { entry: result.entry, idempotent: result.idempotent, wallet_id: wallet.id };
  }

  function chargeEntryFees(input) {
    const players = humanPlayers(input && input.players);
    const amount = input && input.entryFeeMilli;
    const collected = [];
    for (const player of players) {
      collected.push({
        userId: player.userId,
        ...chargeEntryFee({
          gameKind: input.gameKind,
          gameId: input.gameId,
          userId: player.userId,
          amountMilli: amount,
          eventHash: input.eventHash,
        }),
      });
    }
    return collected;
  }

  function creditPrize(input) {
    ok(input && typeof input === 'object', 'E_ARG', 'prize input required');
    ok(GAME_KINDS.includes(input.gameKind), 'E_ARG', 'invalid game kind: ' + input.gameKind);
    ok(typeof input.gameId === 'string' && input.gameId.length > 0, 'E_ARG', 'gameId required');
    ok(Number.isSafeInteger(input.amountMilli) && input.amountMilli >= 0, 'E_ARG', 'prize must not be negative');
    if (input.amountMilli === 0 || isBot(input.userId)) {
      return { skipped: true, reason: input.amountMilli === 0 ? 'zero' : 'bot' };
    }
    const wallet = walletForUser(input.userId);
    ok(wallet, 'E_NO_WALLET', 'winner has no wallet for prize credit');
    const key =
      input.idempotencyKey ||
      moneyKey(input.gameKind, 'prize', input.gameId, input.userId);
    const result = credit(
      {
        walletId: wallet.id,
        txType: 'prize',
        amountMilli: input.amountMilli,
        gameKind: input.gameKind,
        gameId: input.gameId,
        meta: { event_hash: input.eventHash || null, kind: 'game_prize', ref: input.ref || null },
      },
      key,
    );
    return { entry: result.entry, idempotent: result.idempotent, wallet_id: wallet.id };
  }

  function creditCommission(input) {
    ok(input && typeof input === 'object', 'E_ARG', 'commission input required');
    ok(GAME_KINDS.includes(input.gameKind), 'E_ARG', 'invalid game kind: ' + input.gameKind);
    ok(typeof input.gameId === 'string' && input.gameId.length > 0, 'E_ARG', 'gameId required');
    ok(Number.isSafeInteger(input.amountMilli) && input.amountMilli >= 0, 'E_ARG', 'commission must not be negative');
    if (input.amountMilli === 0) return { skipped: true, reason: 'zero' };
    const wallet = houseWallet();
    if (!wallet) return { skipped: true, reason: 'house_disabled' };
    const key = input.idempotencyKey || moneyKey(input.gameKind, 'commission', input.gameId, 'house');
    const result = credit(
      {
        walletId: wallet.id,
        txType: 'commission',
        amountMilli: input.amountMilli,
        gameKind: input.gameKind,
        gameId: input.gameId,
        meta: { event_hash: input.eventHash || null, kind: 'game_commission' },
      },
      key,
    );
    return { entry: result.entry, idempotent: result.idempotent, wallet_id: wallet.id };
  }

  function refundEntry(input) {
    ok(input && typeof input === 'object', 'E_ARG', 'refund input required');
    ok(GAME_KINDS.includes(input.gameKind), 'E_ARG', 'invalid game kind: ' + input.gameKind);
    ok(typeof input.gameId === 'string' && input.gameId.length > 0, 'E_ARG', 'gameId required');
    if (input.amountMilli === 0 || isBot(input.userId)) {
      return { skipped: true, reason: 'noop' };
    }
    ok(Number.isSafeInteger(input.amountMilli) && input.amountMilli > 0, 'E_ARG', 'refund must be positive');
    const wallet = input.walletId
      ? db.prepare('SELECT * FROM wallets WHERE id = ?').get(input.walletId)
      : walletForUser(input.userId);
    ok(wallet, 'E_NO_WALLET', 'player has no wallet to refund');
    const key = input.idempotencyKey || moneyKey(input.gameKind, 'refund', input.gameId, wallet.id);
    const result = credit(
      {
        walletId: wallet.id,
        txType: 'refund',
        amountMilli: input.amountMilli,
        gameKind: input.gameKind,
        gameId: input.gameId,
        meta: { event_hash: input.eventHash || null, kind: 'game_refund' },
      },
      key,
    );
    return { entry: result.entry, idempotent: result.idempotent, wallet_id: wallet.id };
  }

  function refundEntries(input) {
    const players = humanPlayers(input && input.players);
    const amount = input && input.entryFeeMilli;
    const refunded = [];
    for (const player of players) {
      refunded.push({
        userId: player.userId,
        ...refundEntry({
          gameKind: input.gameKind,
          gameId: input.gameId,
          userId: player.userId,
          amountMilli: amount,
          eventHash: input.eventHash,
        }),
      });
    }
    return refunded;
  }

  function settlePot(input) {
    ok(input && typeof input === 'object', 'E_ARG', 'settle input required');
    const breakdown = potBreakdown(
      input.entryFeeMilli,
      humanPlayers(input.players).length,
      input.commissionFraction,
    );
    const prize = creditPrize({
      gameKind: input.gameKind,
      gameId: input.gameId,
      userId: input.winnerUserId,
      amountMilli: breakdown.prize_milli,
      eventHash: input.eventHash,
      ref: input.ref,
      idempotencyKey: input.prizeKey,
    });
    const commission = creditCommission({
      gameKind: input.gameKind,
      gameId: input.gameId,
      amountMilli: breakdown.commission_milli,
      eventHash: input.eventHash,
      idempotencyKey: input.commissionKey,
    });
    return { ...breakdown, prize, commission };
  }

  function safeParse(text) {
    try {
      return JSON.parse(text || '{}');
    } catch (_) {
      return {};
    }
  }

  function economyOf(m) {
    const econ = m && m.settings && m.settings.economy;
    if (!econ || !Number.isSafeInteger(econ.entry_fee_milli) || econ.entry_fee_milli <= 0) {
      return null;
    }
    return econ;
  }

  function verifyGameEconomy(input) {
    const econ = input && input.economy;
    if (!econ || econ.entry_fee_milli <= 0) return { ok: true, checked: 0 };
    const players = humanPlayers(input.players);
    const breakdown = potBreakdown(econ.entry_fee_milli, players.length, econ.commission_fraction);
    let checked = 0;
    const assertEntry = (walletId, kind, ref, amount, label) => {
      const row = db
        .prepare('SELECT * FROM ledger_entries WHERE wallet_id = ? AND idempotency_key = ?')
        .get(walletId, moneyKey(input.gameKind, kind, input.gameId, ref));
      if (!row || row.status !== 'committed') {
        throw new DataError('E_TAMPER', label + ' missing for game ' + input.gameId);
      }
      if (row.amount_milli !== amount) {
        throw new DataError('E_TAMPER', label + ' amount mismatch for game ' + input.gameId);
      }
      checked += 1;
    };
    for (const player of players) {
      const wallet = walletForUser(player.userId);
      if (!wallet) {
        if (input.started) throw new DataError('E_TAMPER', 'entry fee wallet missing for ' + player.userId);
        continue;
      }
      if (input.cancelled && input.started) {
        assertEntry(wallet.id, 'refund', wallet.id, econ.entry_fee_milli, 'refund ledgers');
      } else if (input.started) {
        assertEntry(wallet.id, 'entry', wallet.id, econ.entry_fee_milli, 'entry fee ledgers');
      }
    }
    if (input.finished && !input.cancelled) {
      if (breakdown.prize_milli > 0 && !isBot(input.winnerUserId)) {
        const wallet = walletForUser(input.winnerUserId);
        if (!wallet) throw new DataError('E_TAMPER', 'winner wallet missing for game ' + input.gameId);
        assertEntry(wallet.id, 'prize', input.winnerUserId, breakdown.prize_milli, 'prize ledgers');
      }
      if (breakdown.commission_milli > 0 && houseEnabled) {
        const wallet = houseWallet();
        if (!wallet) throw new DataError('E_TAMPER', 'house wallet missing for game ' + input.gameId);
        assertEntry(wallet.id, 'commission', 'house', breakdown.commission_milli, 'commission ledgers');
      }
    }
    return { ok: true, checked, breakdown };
  }

  function listGameEntries(gameKind, gameId) {
    ok(GAME_KINDS.includes(gameKind), 'E_ARG', 'invalid game kind: ' + gameKind);
    const rows = db
      .prepare("SELECT * FROM ledger_entries WHERE json_extract(meta_json, '$.game_kind') = ? AND json_extract(meta_json, '$.game_id') = ? ORDER BY seq ASC")
      .all(gameKind, gameId);
    return rows.map((row) => ({ ...row, meta: safeParse(row.meta_json) }));
  }

  function summary(input) {
    const breakdown = potBreakdown(
      input.entryFeeMilli,
      humanPlayers(input.players).length,
      input.commissionFraction,
    );
    return { ...breakdown, game_kind: input.gameKind, game_id: input.gameId };
  }

  return {
    normalizeEconomy,
    potBreakdown,
    houseWallet,
    houseWalletId,
    chargeEntryFee,
    chargeEntryFees,
    creditPrize,
    creditCommission,
    refundEntry,
    refundEntries,
    settlePot,
    economyOf,
    verifyGameEconomy,
    listGameEntries,
    summary,
    keys: { moneyKey, isBot, humanPlayers },
  };
}

module.exports = {
  buildGameWallet,
  normalizeEconomy,
  potBreakdown,
  fractionOf,
  moneyKey,
  humanPlayers,
  isBot,
  DEFAULT_COMMISSION,
  HOUSE_USERNAME,
};
