'use strict';

const { DataError, ok, nowIso, genId, sha256hex, safeMeta, safeRollback, toDataError, GENESIS_HASH } = require('./db');

function decimalParts(value) {
  const text = String(value === undefined || value === null ? '' : value).trim();
  if (!/^\d+(?:\.\d{1,18})?$/.test(text)) throw new DataError('E_CRYPTO_AMOUNT', 'invalid crypto decimal amount');
  let [whole, fraction = ''] = text.split('.');
  whole = whole.replace(/^0+(?=\d)/, '');
  fraction = fraction.replace(/0+$/, '');
  return { whole, fraction, scale: fraction.length };
}

function normalizeDecimal(value) {
  const p = decimalParts(value);
  return p.scale ? p.whole + '.' + p.fraction : p.whole;
}

function scaledParts(value, scale) {
  const p = decimalParts(value);
  const s = Math.max(p.scale, scale);
  return BigInt(p.whole + p.fraction.padEnd(s, '0'));
}

function decimalOp(a, b, sign) {
  const pa = decimalParts(a); const pb = decimalParts(b);
  const scale = Math.max(pa.scale, pb.scale);
  const av = scaledParts(a, scale); const bv = scaledParts(b, scale);
  const result = sign === -1 ? av - bv : av + bv;
  if (result < 0n) throw new DataError('E_CRYPTO_INSUFFICIENT_FUNDS', 'crypto balance is insufficient');
  const raw = result.toString().padStart(scale + 1, '0');
  if (!scale) return raw;
  const whole = raw.slice(0, -scale).replace(/^0+(?=\d)/, '') || '0';
  const fraction = raw.slice(-scale).replace(/0+$/, '');
  return fraction ? whole + '.' + fraction : whole;
}

function addDecimal(a, b) { return decimalOp(a, b, 1); }
function subtractDecimal(a, b) { return decimalOp(a, b, -1); }

function compareDecimal(a, b) {
  const pa = decimalParts(a); const pb = decimalParts(b);
  const scale = Math.max(pa.scale, pb.scale);
  const av = scaledParts(a, scale); const bv = scaledParts(b, scale);
  return av < bv ? -1 : av > bv ? 1 : 0;
}

function cryptoAmount(value) {
  const normalized = normalizeDecimal(value);
  if (normalized === '0') throw new DataError('E_CRYPTO_AMOUNT', 'crypto amount must be positive');
  return normalized;
}

function hashCryptoEntry(row) {
  return sha256hex([
    'crypto-ledger', row.id, row.balance_id, row.idempotency_key, row.tx_type,
    row.asset, row.network, row.amount, row.available_before, row.available_after,
    row.reserved_before, row.reserved_after, row.status, row.prev_hash,
    row.meta_json, row.created_at,
  ].join('\x1f'));
}

function buildCryptoLedger(db) {
  function getBalance(userId, asset, network) {
    return db.prepare('SELECT * FROM crypto_balances WHERE user_id = ? AND asset = ? AND network = ?')
      .get(userId, asset, network) || null;
  }

  function ensureBalanceWithinTx(userId, asset, network) {
    let row = getBalance(userId, asset, network);
    if (row) return row;
    const id = genId(); const ts = nowIso();
    db.prepare(
      'INSERT INTO crypto_balances (id,user_id,asset,network,available_amount,reserved_amount,status,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,0,?,?)'
    ).run(id, userId, asset, network, '0', '0', 'active', ts, ts);
    return db.prepare('SELECT * FROM crypto_balances WHERE id = ?').get(id);
  }

  function appendWithinTx(input) {
    ok(input && typeof input === 'object', 'E_ARG', 'crypto ledger input required');
    const amount = cryptoAmount(input.amount);
    const balance = ensureBalanceWithinTx(input.user_id, input.asset, input.network);
    ok(balance.status === 'active', 'E_CRYPTO_BALANCE_LOCKED', 'crypto balance is not active');
    const existing = db.prepare('SELECT * FROM crypto_ledger_entries WHERE balance_id = ? AND idempotency_key = ?')
      .get(balance.id, input.idempotency_key);
    if (existing) return { idempotent: true, entry: existing };
    const availableBefore = normalizeDecimal(balance.available_amount);
    const reservedBefore = normalizeDecimal(balance.reserved_amount);
    let availableAfter = availableBefore;
    let reservedAfter = reservedBefore;
    if (input.tx_type === 'deposit') {
      availableAfter = addDecimal(availableBefore, amount);
    } else if (input.tx_type === 'withdrawal_reserve') {
      availableAfter = subtractDecimal(availableBefore, amount);
      reservedAfter = addDecimal(reservedBefore, amount);
    } else if (input.tx_type === 'withdrawal_release') {
      ok(compareDecimal(reservedBefore, amount) >= 0, 'E_CRYPTO_WITHDRAWAL_STATUS', 'cannot release more than reserved amount');
      availableAfter = addDecimal(availableBefore, amount);
      reservedAfter = subtractDecimal(reservedBefore, amount);
    } else if (input.tx_type === 'withdrawal_settlement') {
      ok(compareDecimal(reservedBefore, amount) >= 0, 'E_CRYPTO_WITHDRAWAL_STATUS', 'cannot settle more than reserved amount');
      reservedAfter = subtractDecimal(reservedBefore, amount);
    } else {
      throw new DataError('E_ARG', 'invalid crypto ledger tx_type');
    }
    const id = genId(); const createdAt = nowIso();
    const prev = db.prepare('SELECT hash FROM crypto_ledger_entries ORDER BY seq DESC LIMIT 1').get();
    const row = {
      id, balance_id: balance.id, user_id: input.user_id, asset: input.asset, network: input.network,
      idempotency_key: input.idempotency_key, tx_type: input.tx_type, amount,
      available_before: availableBefore, available_after: availableAfter,
      reserved_before: reservedBefore, reserved_after: reservedAfter, status: 'committed',
      prev_hash: (prev && prev.hash) || GENESIS_HASH, meta_json: safeMeta(input.meta || {}), created_at: createdAt,
    };
    row.hash = hashCryptoEntry(row);
    db.prepare(
      'INSERT INTO crypto_ledger_entries (id,balance_id,user_id,asset,network,idempotency_key,tx_type,amount,available_before,available_after,reserved_before,reserved_after,status,prev_hash,hash,meta_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
    ).run(row.id,row.balance_id,row.user_id,row.asset,row.network,row.idempotency_key,row.tx_type,row.amount,row.available_before,row.available_after,row.reserved_before,row.reserved_after,row.status,row.prev_hash,row.hash,row.meta_json,row.created_at);
    db.prepare('UPDATE crypto_balances SET available_amount=?, reserved_amount=?, version=version+1, updated_at=? WHERE id=?')
      .run(availableAfter, reservedAfter, createdAt, balance.id);
    return { idempotent: false, entry: row };
  }

  function withTx(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const out = fn(); db.exec('COMMIT'); return out; }
    catch (err) { safeRollback(db); throw toDataError(err, 'E_CRYPTO_LEDGER', 'crypto ledger transaction failed'); }
  }

  function credit(input) {
    return withTx(() => appendWithinTx({
      ...input, tx_type: 'deposit',
      idempotency_key: input.idempotency_key,
    }));
  }
  function reserve(input) {
    return withTx(() => appendWithinTx({
      ...input, tx_type: 'withdrawal_reserve',
      idempotency_key: input.idempotency_key,
    }));
  }

  function release(input) {
    return withTx(() => appendWithinTx({
      ...input, tx_type: 'withdrawal_release',
      idempotency_key: input.idempotency_key,
    }));
  }

  function settle(input) {
    return withTx(() => appendWithinTx({
      ...input, tx_type: 'withdrawal_settlement',
      idempotency_key: input.idempotency_key,
    }));
  }

  function listBalances(userId) {
    return db.prepare('SELECT * FROM crypto_balances WHERE user_id = ? ORDER BY asset ASC, network ASC')
      .all(userId);
  }

  function listEntries(balanceId, limit = 100) {
    const n = Number.isSafeInteger(limit) ? Math.min(Math.max(limit, 1), 500) : 100;
    return db.prepare('SELECT * FROM crypto_ledger_entries WHERE balance_id = ? ORDER BY seq DESC LIMIT ?')
      .all(balanceId, n);
  }

  function verify() {
    const rows = db.prepare('SELECT * FROM crypto_ledger_entries ORDER BY seq ASC').all();
    let prev = GENESIS_HASH;
    const derived = {};
    for (const row of rows) {
      if (row.prev_hash !== prev) throw new DataError('E_CRYPTO_LEDGER_LINK', 'crypto ledger chain broken at seq ' + row.seq);
      if (hashCryptoEntry(row) !== row.hash) throw new DataError('E_CRYPTO_LEDGER_HASH', 'crypto ledger hash mismatch at seq ' + row.seq);
      prev = row.hash;
      const key = row.balance_id;
      derived[key] = { available: row.available_after, reserved: row.reserved_after };
    }
    const balances = db.prepare('SELECT * FROM crypto_balances').all();
    for (const b of balances) {
      const d = derived[b.id] || { available: '0', reserved: '0' };
      if (normalizeDecimal(d.available) !== normalizeDecimal(b.available_amount) || normalizeDecimal(d.reserved) !== normalizeDecimal(b.reserved_amount)) {
        throw new DataError('E_CRYPTO_LEDGER_RECONCILE', 'crypto balance mismatch: ' + b.id);
      }
    }
    return { ok: true, entries: rows.length, balances: balances.length };
  }
  function createWithdrawal(input) {
    return withTx(() => {
      const ts = nowIso(); const id = genId();
      db.prepare(
        'INSERT INTO crypto_withdrawals (id,user_id,balance_id,crypto_wallet_id,provider,asset,network,payout_currency,amount,status,provider_ref,error,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
      ).run(id,input.user_id,input.balance_id,input.crypto_wallet_id,input.provider,input.asset,input.network,input.payout_currency,input.amount,'requested',null,null,ts,ts);
      return getWithdrawal(id);
    });
  }

  function getWithdrawal(id) {
    const row = db.prepare('SELECT * FROM crypto_withdrawals WHERE id = ?').get(String(id || ''));
    if (!row) throw new DataError('E_CRYPTO_WITHDRAWAL_NOT_FOUND', 'crypto withdrawal not found: ' + id);
    return row;
  }

  function listWithdrawals(userId, limit = 100) {
    const n = Number.isSafeInteger(limit) ? Math.min(Math.max(limit, 1), 500) : 100;
    return db.prepare('SELECT * FROM crypto_withdrawals WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?')
      .all(userId, n);
  }

  function updateWithdrawal(id, patch) {
    const current = getWithdrawal(id);
    const status = patch.status || current.status;
    const allowed = ['requested','awaiting_2fa','processing','succeeded','failed','cancelled'];
    if (!allowed.includes(status)) throw new DataError('E_CRYPTO_WITHDRAWAL_STATUS', 'invalid crypto withdrawal status');
    const ts = nowIso();
    db.prepare(
      'UPDATE crypto_withdrawals SET status=?, provider_ref=COALESCE(?,provider_ref), error=?, updated_at=? WHERE id=?'
    ).run(status, patch.provider_ref || null, patch.error || null, ts, id);
    return getWithdrawal(id);
  }

  return {
    normalizeDecimal, addDecimal, subtractDecimal, compareDecimal, cryptoAmount,
    getBalance, listBalances, listEntries, credit, reserve, release, settle,
    creditWithinTx: appendWithinTx,
    reserveWithinTx: appendWithinTx,
    releaseWithinTx: appendWithinTx,
    settleWithinTx: appendWithinTx,
    withTx, verify, createWithdrawal, getWithdrawal, listWithdrawals, updateWithdrawal,
  };
}

module.exports = {
  decimalParts, normalizeDecimal, addDecimal, subtractDecimal, compareDecimal, cryptoAmount,
  buildCryptoLedger, hashCryptoEntry,
};
