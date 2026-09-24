'use strict';
const { DataError, ok } = require('./db');
const { appendWithinTx } = require('./ledger');
const { buildCryptoEconomy, STAKE_USD_CENTS, centsToUsd, usdToCrypto, resolveUsdRate } = require('./crypto-economy');

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

function normalizeCommission(_value) {
  // The platform commission is fixed at 10% for every online money game.
  return DEFAULT_COMMISSION;
}

function normalizeEconomy(input, mode, cryptoEconomy = null) {
  const raw = input && typeof input === 'object' ? input : {};
  const entryFee = Number.isSafeInteger(raw.entryFee) && raw.entryFee >= 0 ? raw.entryFee : 0;
  const commission = DEFAULT_COMMISSION;
  const cryptoMode = mode === 'online' && (raw.mode === 'crypto' || String(raw.currency || '').toUpperCase() === 'CRYPTO');
  if (cryptoMode) {
    const stakeCents = Number(raw.stakeUsdCents !== undefined ? raw.stakeUsdCents : raw.stake_usd_cents);
    const asset = raw.asset || raw.crypto_asset || 'USDT';
    const network = raw.network || raw.crypto_network || 'tron';
    ok(cryptoEconomy && typeof cryptoEconomy.stake === 'function', 'E_CRYPTO_ECONOMY', 'crypto game economy is not available');
    const quote = cryptoEconomy.stake(stakeCents, asset, network);
    return {
      mode: 'crypto',
      currency: 'CRYPTO',
      entry_fee_milli: 0,
      commission_fraction: normalizeCommission(commission),
      stake_usd_cents: quote.stake_usd_cents,
      stake_usd: quote.stake_usd,
      asset: quote.asset,
      network: quote.network,
      usd_rate: quote.usd_rate,
      amount_crypto: quote.amount_crypto,
    };
  }
  return {
    mode: 'mga',
    currency: 'MGA',
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
  const cryptoLedger = (deps && deps.cryptoLedger) || null;
  const env = (deps && deps.env) || process.env;
  const cryptoEconomy = (deps && deps.cryptoEconomy) || buildCryptoEconomy({ env });
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
        meta: { event_hash: input.eventHash || null, kind: 'game_commission', commission_fraction: DEFAULT_COMMISSION },
      },
      key,
    );
    if (!result.idempotent) {
      repos.recordAudit({
        actorType: 'system',
        actorId: wallet.user_id,
        action: 'game.commission.credited',
        targetType: 'game',
        targetId: input.gameId,
        ledgerHash: result.entry.hash,
        detail: { game_kind: input.gameKind, commission_fraction: DEFAULT_COMMISSION, commission_milli: input.amountMilli },
      });
    }
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

  function cryptoHouseUserId() {
    const wallet = houseWallet();
    ok(wallet, 'E_NO_HOUSE_WALLET', 'crypto house account is unavailable');
    return wallet.user_id;
  }

  function cryptoStakeAmount(input) {
    ok(cryptoLedger, 'E_CRYPTO_ECONOMY', 'crypto ledger is unavailable');
    ok(STAKE_USD_CENTS.includes(Number(input.stakeUsdCents)), 'E_STAKE_AMOUNT', 'crypto game stake is outside the allowed USD amounts');
    return cryptoEconomy.stake(input.stakeUsdCents, input.asset, input.network);
  }

  function cryptoUsdAmount(input) {
    ok(cryptoLedger, 'E_CRYPTO_ECONOMY', 'crypto ledger is unavailable');
    const cents = Number(input.stakeUsdCents);
    ok(Number.isInteger(cents) && cents > 0, 'E_STAKE_AMOUNT', 'USD cents amount must be positive');
    const asset = String(input.asset || '');
    const network = String(input.network || '');
    const rate = resolveUsdRate(asset, network, env);
    return { stake_usd_cents: cents, stake_usd: centsToUsd(cents), asset: asset.toUpperCase(), network: network.toLowerCase(), usd_rate: rate, amount_crypto: usdToCrypto(centsToUsd(cents), rate) };
  }

  function chargeCryptoEntryFeeWithinTx(input) {
    ok(input && typeof input === 'object', 'E_ARG', 'crypto stake input required');
    ok(GAME_KINDS.includes(input.gameKind), 'E_ARG', 'invalid game kind: ' + input.gameKind);
    ok(typeof input.gameId === 'string' && input.gameId.length > 0, 'E_ARG', 'gameId required');
    if (isBot(input.userId)) return { skipped: true, reason: 'bot' };
    const quote = cryptoStakeAmount(input);
    const balance = cryptoLedger.getBalance(input.userId, quote.asset, quote.network);
    ok(balance, 'E_CRYPTO_BALANCE_NOT_FOUND', 'player has no ' + quote.asset + '/' + quote.network + ' balance');
    ok(cryptoLedger.compareDecimal(balance.available_amount, quote.amount_crypto) >= 0, 'E_CRYPTO_INSUFFICIENT_FUNDS', 'insufficient crypto funds for the stake');
    const houseUserId = cryptoHouseUserId();
    const debitKey = moneyKey(input.gameKind, 'crypto-stake', input.gameId, input.userId);
    const houseKey = moneyKey(input.gameKind, 'crypto-pot', input.gameId, input.userId);
    const debit = cryptoLedger.debitWithinTx({
      user_id: input.userId, asset: quote.asset, network: quote.network, amount: quote.amount_crypto,
      idempotency_key: debitKey, meta: { kind: 'game_crypto_stake', game_kind: input.gameKind, game_id: input.gameId, stake_usd_cents: quote.stake_usd_cents, usd_rate: quote.usd_rate, event_hash: input.eventHash || null },
    });
    const pool = cryptoLedger.creditWithinTx({
      user_id: houseUserId, asset: quote.asset, network: quote.network, amount: quote.amount_crypto,
      idempotency_key: houseKey, tx_type: 'credit', meta: { kind: 'game_crypto_pot', game_kind: input.gameKind, game_id: input.gameId, user_id: input.userId, event_hash: input.eventHash || null },
    });
    return { quote, debit: debit.entry, pool: pool.entry, idempotent: debit.idempotent && pool.idempotent };
  }

  function chargeCryptoEntryFeesWithinTx(input) {
    return humanPlayers(input && input.players).map((player) => ({
      userId: player.userId,
      ...chargeCryptoEntryFeeWithinTx({ ...input, userId: player.userId }),
    }));
  }

  function refundCryptoEntryWithinTx(input) {
    if (isBot(input.userId)) return { skipped: true, reason: 'bot' };
    const quote = cryptoStakeAmount(input);
    const houseUserId = cryptoHouseUserId();
    const userKey = moneyKey(input.gameKind, 'crypto-refund', input.gameId, input.userId);
    const houseKey = moneyKey(input.gameKind, 'crypto-refund-pot', input.gameId, input.userId);
    const debit = cryptoLedger.debitWithinTx({
      user_id: houseUserId, asset: quote.asset, network: quote.network, amount: quote.amount_crypto,
      idempotency_key: houseKey, meta: { kind: 'game_crypto_refund_pool', game_kind: input.gameKind, game_id: input.gameId, user_id: input.userId, event_hash: input.eventHash || null },
    });
    const credit = cryptoLedger.creditWithinTx({
      user_id: input.userId, asset: quote.asset, network: quote.network, amount: quote.amount_crypto,
      idempotency_key: userKey, tx_type: 'credit', meta: { kind: 'game_crypto_refund', game_kind: input.gameKind, game_id: input.gameId, event_hash: input.eventHash || null },
    });
    return { quote, debit: debit.entry, credit: credit.entry, idempotent: debit.idempotent && credit.idempotent };
  }

  function creditCryptoPrizeWithinTx(input) {
    ok(input && typeof input === 'object', 'E_ARG', 'crypto prize input required');
    if (isBot(input.userId) || !(Number.isInteger(Number(input.amountUsdCents)) && Number(input.amountUsdCents) > 0)) return { skipped: true, reason: 'noop' };
    const quote = cryptoUsdAmount({ stakeUsdCents: Number(input.amountUsdCents), asset: input.asset, network: input.network });
    const houseUserId = cryptoHouseUserId();
    const ref = String(input.ref || input.userId);
    const debit = cryptoLedger.debitWithinTx({
      user_id: houseUserId, asset: quote.asset, network: quote.network, amount: quote.amount_crypto,
      idempotency_key: moneyKey(input.gameKind, 'crypto-prize-pot', input.gameId, ref),
      meta: { kind: 'game_crypto_prize_pool', game_kind: input.gameKind, game_id: input.gameId, ref, amount_usd_cents: input.amountUsdCents, event_hash: input.eventHash || null },
    });
    const credit = cryptoLedger.creditWithinTx({
      user_id: input.userId, asset: quote.asset, network: quote.network, amount: quote.amount_crypto,
      idempotency_key: moneyKey(input.gameKind, 'crypto-prize', input.gameId, ref), tx_type: 'credit',
      meta: { kind: 'game_crypto_prize', game_kind: input.gameKind, game_id: input.gameId, ref, amount_usd_cents: input.amountUsdCents, event_hash: input.eventHash || null },
    });
    return { quote, debit: debit.entry, credit: credit.entry, idempotent: debit.idempotent && credit.idempotent };
  }

  function settleCryptoPot(input) {
    const players = humanPlayers(input && input.players);
    const quote = cryptoStakeAmount(input);
    const potUsdCents = quote.stake_usd_cents * players.length;
    const commissionUsdCents = Math.floor(potUsdCents * normalizeCommission(input.commissionFraction) + 1e-9);
    const prizeUsdCents = potUsdCents - commissionUsdCents;
    const houseUserId = cryptoHouseUserId();
    const prizeQuote = cryptoUsdAmount({ ...input, stakeUsdCents: prizeUsdCents });
    const housePrizeKey = moneyKey(input.gameKind, 'crypto-prize-pot', input.gameId, input.winnerUserId || 'none');
    let prize = { skipped: true, reason: 'zero' };
    if (prizeUsdCents > 0 && input.winnerUserId && !isBot(input.winnerUserId)) {
      const debit = cryptoLedger.debitWithinTx({
        user_id: houseUserId, asset: quote.asset, network: quote.network, amount: prizeQuote.amount_crypto,
        idempotency_key: housePrizeKey, meta: { kind: 'game_crypto_prize_pool', game_kind: input.gameKind, game_id: input.gameId, prize_usd_cents: prizeUsdCents, event_hash: input.eventHash || null },
      });
      const credit = cryptoLedger.creditWithinTx({
        user_id: input.winnerUserId, asset: quote.asset, network: quote.network, amount: prizeQuote.amount_crypto,
        idempotency_key: moneyKey(input.gameKind, 'crypto-prize', input.gameId, input.winnerUserId), tx_type: 'credit',
        meta: { kind: 'game_crypto_prize', game_kind: input.gameKind, game_id: input.gameId, prize_usd_cents: prizeUsdCents, event_hash: input.eventHash || null },
      });
      prize = { amount_crypto: prizeQuote.amount_crypto, amount_usd_cents: prizeUsdCents, debit: debit.entry, credit: credit.entry, idempotent: debit.idempotent && credit.idempotent };
    }
    const commissionAudit = db.prepare("SELECT id FROM audit_entries WHERE action = 'game.crypto_commission.credited' AND target_type = 'game' AND target_id = ? LIMIT 1").get(input.gameId);
    if (!commissionAudit) {
      repos.recordAudit({
        actorType: 'system',
        actorId: houseUserId,
        action: 'game.crypto_commission.credited',
        targetType: 'game',
        targetId: input.gameId,
        ledgerHash: prize.debit ? prize.debit.hash : null,
        detail: {
          game_kind: input.gameKind,
          commission_fraction: DEFAULT_COMMISSION,
          stake_usd_cents: quote.stake_usd_cents,
          pot_usd_cents: potUsdCents,
          commission_usd_cents: commissionUsdCents,
          prize_usd_cents: prizeUsdCents,
          asset: quote.asset,
          network: quote.network,
          admin_revenue: true,
        },
      });
    }
    return { mode: 'crypto', asset: quote.asset, network: quote.network, stake_usd_cents: quote.stake_usd_cents, pot_usd_cents: potUsdCents, prize_usd_cents: prizeUsdCents, commission_usd_cents: commissionUsdCents, prize, house_user_id: houseUserId };
  }

  function settlePot(input) {
    ok(input && typeof input === 'object', 'E_ARG', 'settle input required');
    if (input.economy && input.economy.mode === 'crypto') return settleCryptoPot({
      ...input,
      stakeUsdCents: input.economy.stake_usd_cents,
      asset: input.economy.asset,
      network: input.economy.network,
    });
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
    if (!econ) return null;
    if (econ.mode === 'crypto') return econ;
    if (!Number.isSafeInteger(econ.entry_fee_milli) || econ.entry_fee_milli <= 0) return null;
    return econ;
  }

  function verifyGameEconomy(input) {
    const econ = input && input.economy;
    if (!econ) return { ok: true, checked: 0 };
    if (econ.mode === 'crypto') {
      ok(cryptoLedger, 'E_CRYPTO_ECONOMY', 'crypto ledger is unavailable');
      const players = humanPlayers(input.players);
      const quote = cryptoStakeAmount({ stakeUsdCents: econ.stake_usd_cents, asset: econ.asset, network: econ.network });
      let checked = 0;
      const assertCrypto = (userId, key, amount, label) => {
        const row = db.prepare('SELECT * FROM crypto_ledger_entries WHERE user_id = ? AND idempotency_key = ?').get(userId, key);
        if (!row || row.tx_type !== 'debit' && row.tx_type !== 'credit') throw new DataError('E_TAMPER', label + ' missing for game ' + input.gameId);
        if (cryptoLedger.normalizeDecimal(row.amount) !== cryptoLedger.normalizeDecimal(amount)) throw new DataError('E_TAMPER', label + ' amount mismatch for game ' + input.gameId);
        checked += 1;
      };
      const houseUserId = cryptoHouseUserId();
      for (const player of players) {
        if (input.started) {
          if (input.cancelled) assertCrypto(player.userId, moneyKey(input.gameKind, 'crypto-refund', input.gameId, player.userId), quote.amount_crypto, 'crypto refund');
          else assertCrypto(player.userId, moneyKey(input.gameKind, 'crypto-stake', input.gameId, player.userId), quote.amount_crypto, 'crypto stake');
        }
      }
      if (input.started) {
        for (const player of players) {
          const poolKey = input.cancelled
            ? moneyKey(input.gameKind, 'crypto-refund-pot', input.gameId, player.userId)
            : moneyKey(input.gameKind, 'crypto-pot', input.gameId, player.userId);
          assertCrypto(houseUserId, poolKey, quote.amount_crypto, input.cancelled ? 'crypto refund pool' : 'crypto pot');
        }
      }
      if (input.finished && !input.cancelled) {
        const potUsdCents = quote.stake_usd_cents * players.length;
        const commissionUsdCents = Math.floor(potUsdCents * DEFAULT_COMMISSION + 1e-9);
        const audit = db.prepare("SELECT * FROM audit_entries WHERE action = 'game.crypto_commission.credited' AND target_type = 'game' AND target_id = ? LIMIT 1").get(input.gameId);
        if (!audit) throw new DataError('E_TAMPER', 'crypto commission audit missing for game ' + input.gameId);
        const detail = safeParse(audit.detail_json);
        if (detail.commission_fraction !== DEFAULT_COMMISSION || detail.commission_usd_cents !== commissionUsdCents || detail.admin_revenue !== true) {
          throw new DataError('E_TAMPER', 'crypto commission audit mismatch for game ' + input.gameId);
        }
        checked += 1;
        if (input.winnerUserId && !isBot(input.winnerUserId)) {
          const prizeUsdCents = potUsdCents - commissionUsdCents;
          if (prizeUsdCents > 0) {
            const prizeQuote = cryptoUsdAmount({ stakeUsdCents: prizeUsdCents, asset: econ.asset, network: econ.network });
            assertCrypto(houseUserId, moneyKey(input.gameKind, 'crypto-prize-pot', input.gameId, input.winnerUserId), prizeQuote.amount_crypto, 'crypto prize pool');
            assertCrypto(input.winnerUserId, moneyKey(input.gameKind, 'crypto-prize', input.gameId, input.winnerUserId), prizeQuote.amount_crypto, 'crypto prize');
          }
        }
      }
      const ledgerCheck = cryptoLedger.verify();
      return { ok: true, checked: checked + ledgerCheck.entries, mode: 'crypto', ledger: ledgerCheck, asset: quote.asset, network: quote.network, stake_usd_cents: quote.stake_usd_cents };
    }
    if (econ.entry_fee_milli <= 0) return { ok: true, checked: 0 };
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
    normalizeEconomy: (input, mode) => normalizeEconomy(input, mode, cryptoEconomy),
    potBreakdown,
    houseWallet,
    houseWalletId,
    chargeEntryFee,
    chargeEntryFees,
    creditPrize,
    creditCommission,
    refundEntry,
    refundEntries,
    chargeCryptoEntryFeeWithinTx,
    chargeCryptoEntryFeesWithinTx,
    refundCryptoEntryWithinTx,
    creditCryptoPrizeWithinTx,
    settleCryptoPot,
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
