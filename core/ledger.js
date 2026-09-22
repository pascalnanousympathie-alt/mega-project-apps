'use strict';
const {
  DataError,
  ok,
  nowIso,
  genId,
  sha256hex,
  safeMeta,
  safeRollback,
  parseRow,
  toDataError,
  GENESIS_HASH,
} = require('./db');

const TX_TYPES = [
  'deposit', 'withdraw', 'transfer_in', 'transfer_out',
  'entry_fee', 'prize', 'commission', 'refund', 'adjustment',
];
const DIRECTIONS = ['credit', 'debit'];
const STATUSES = ['pending', 'committed', 'voided'];

const INSERT_LEDGER = `INSERT INTO ledger_entries
  (id, wallet_id, idempotency_key, tx_type, direction, amount_milli,
   balance_before_milli, balance_after_milli, status, prev_hash, hash, meta_json, created_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`;

function hashLedgerEntry(f) {
  const parts = [
    'ledger',
    f.id,
    f.wallet_id,
    f.idempotency_key,
    f.tx_type,
    f.direction,
    String(f.amount_milli),
    String(f.balance_before_milli),
    String(f.balance_after_milli),
    f.status,
    f.prev_hash,
    f.meta_json,
    f.created_at,
  ];
  return sha256hex(parts.join('\x1f'));
}

function validateInput(input) {
  ok(input && typeof input === 'object', 'E_ARG', 'ledger input required');
  ok(TX_TYPES.includes(input.tx_type), 'E_ARG', 'invalid tx_type: ' + input.tx_type);
  ok(DIRECTIONS.includes(input.direction), 'E_ARG', 'invalid direction: ' + input.direction);
  ok(STATUSES.includes(input.status || 'committed'), 'E_ARG', 'invalid ledger status');
  ok(
    Number.isSafeInteger(input.amount_milli) && input.amount_milli > 0,
    'E_ARG',
    'amount_milli must be a positive safe integer',
  );
  ok(
    typeof input.idempotency_key === 'string' && input.idempotency_key.length > 0,
    'E_ARG',
    'idempotency_key required',
  );
}

function appendWithinTx(db, input) {
  validateInput(input);
  const id = genId();
  const created_at = nowIso();
  const status = input.status || 'committed';
  const meta_json = safeMeta(input.meta);
  const wallet = db.prepare('SELECT * FROM wallets WHERE id = ?').get(input.wallet_id);
  if (!wallet) {
    throw new DataError('E_NO_WALLET', 'wallet not found: ' + input.wallet_id);
  }
  if (wallet.status !== 'active') {
    throw new DataError('E_WALLET_INACTIVE', 'wallet is not active: ' + wallet.status);
  }
  const existing = db
    .prepare('SELECT * FROM ledger_entries WHERE wallet_id = ? AND idempotency_key = ?')
    .get(input.wallet_id, input.idempotency_key);
  if (existing) {
    return { idempotent: true, entry: parseRow(existing) };
  }
  const before = wallet.balance_milli;
  const applies = status === 'committed';
  let after = before;
  if (applies) {
    if (input.direction === 'credit') {
      after = before + input.amount_milli;
    } else {
      after = before - input.amount_milli;
      if (after < 0) {
        throw new DataError('E_INSUFFICIENT_FUNDS', 'debit exceeds wallet balance');
      }
    }
  }
  const prevRow = db.prepare('SELECT hash FROM ledger_entries ORDER BY seq DESC LIMIT 1').get();
  const prev_hash = (prevRow && prevRow.hash) || GENESIS_HASH;
  const entry = {
    id,
    wallet_id: input.wallet_id,
    idempotency_key: input.idempotency_key,
    tx_type: input.tx_type,
    direction: input.direction,
    amount_milli: input.amount_milli,
    balance_before_milli: before,
    balance_after_milli: after,
    status,
    prev_hash,
    meta_json,
    created_at,
  };
  entry.hash = hashLedgerEntry(entry);
  db.prepare(INSERT_LEDGER).run(
    entry.id,
    entry.wallet_id,
    entry.idempotency_key,
    entry.tx_type,
    entry.direction,
    entry.amount_milli,
    entry.balance_before_milli,
    entry.balance_after_milli,
    entry.status,
    entry.prev_hash,
    entry.hash,
    entry.meta_json,
    entry.created_at,
  );
  if (applies) {
    db.prepare(
      'UPDATE wallets SET balance_milli = ?, version = version + 1, updated_at = ? WHERE id = ?',
    ).run(after, created_at, entry.wallet_id);
  }
  return { idempotent: false, entry: parseRow({ ...entry, meta: input.meta || {} }) };
}

function appendLedger(db, input) {
  db.exec('BEGIN');
  try {
    const result = appendWithinTx(db, input);
    db.exec('COMMIT');
    return result;
  } catch (err) {
    safeRollback(db);
    throw toDataError(err, 'E_LEDGER_APPEND', 'ledger append failed');
  }
}

function transfer(db, input) {
  ok(input && typeof input === 'object', 'E_ARG', 'transfer input required');
  ok(
    Number.isSafeInteger(input.amount_milli) && input.amount_milli > 0,
    'E_ARG',
    'amount_milli must be a positive safe integer',
  );
  ok(
    typeof input.idempotency_key === 'string' && input.idempotency_key.length > 0,
    'E_ARG',
    'idempotency_key required',
  );
  ok(
    input.from_wallet_id && input.to_wallet_id && input.from_wallet_id !== input.to_wallet_id,
    'E_ARG',
    'from_wallet_id and to_wallet_id are required and must differ',
  );
  const amount = input.amount_milli;
  const key = input.idempotency_key;
  const outMeta = { ...(input.from_meta || {}), transfer: true, transfer_key: key, counterpart_wallet_id: input.to_wallet_id };
  const inMeta = { ...(input.to_meta || {}), transfer: true, transfer_key: key, counterpart_wallet_id: input.from_wallet_id };
  db.exec('BEGIN');
  try {
    const out = appendWithinTx(db, {
      wallet_id: input.from_wallet_id,
      idempotency_key: key + ':out',
      tx_type: 'transfer_out',
      direction: 'debit',
      amount_milli: amount,
      status: 'committed',
      meta: outMeta,
    });
    const inn = appendWithinTx(db, {
      wallet_id: input.to_wallet_id,
      idempotency_key: key + ':in',
      tx_type: 'transfer_in',
      direction: 'credit',
      amount_milli: amount,
      status: 'committed',
      meta: inMeta,
    });
    db.exec('COMMIT');
    return { idempotent: out.idempotent && inn.idempotent, out: out.entry, in: inn.entry };
  } catch (err) {
    safeRollback(db);
    throw toDataError(err, 'E_TRANSFER', 'transfer failed');
  }
}

function entriesByWallet(db, walletId, options = {}) {
  const limit = Number.isSafeInteger(options.limit) ? options.limit : 50;
  const offset = Number.isSafeInteger(options.offset) ? options.offset : 0;
  return db
    .prepare('SELECT * FROM ledger_entries WHERE wallet_id = ? ORDER BY seq DESC LIMIT ? OFFSET ?')
    .all(walletId, limit, offset)
    .map(parseRow);
}

function listEntries(db, options = {}) {
  const limit = Number.isSafeInteger(options.limit) ? options.limit : 100;
  const offset = Number.isSafeInteger(options.offset) ? options.offset : 0;
  return db
    .prepare('SELECT * FROM ledger_entries ORDER BY seq DESC LIMIT ? OFFSET ?')
    .all(limit, offset)
    .map(parseRow);
}

function getEntry(db, id) {
  return parseRow(db.prepare('SELECT * FROM ledger_entries WHERE id = ?').get(id));
}

function byIdempotency(db, walletId, idempotencyKey) {
  return parseRow(
    db
      .prepare('SELECT * FROM ledger_entries WHERE wallet_id = ? AND idempotency_key = ?')
      .get(walletId, idempotencyKey),
  );
}

function verifyLedger(db) {
  const rows = db.prepare('SELECT * FROM ledger_entries ORDER BY seq ASC').all();
  let prev = GENESIS_HASH;
  const derived = {};
  for (const row of rows) {
    if (row.prev_hash !== prev) {
      throw new DataError(
        'E_LEDGER_LINK',
        'ledger chain broken at seq ' + row.seq + ': prev_hash mismatch',
      );
    }
    const computed = hashLedgerEntry(row);
    if (row.hash !== computed) {
      throw new DataError(
        'E_LEDGER_HASH',
        'ledger hash mismatch at seq ' + row.seq,
      );
    }
    prev = row.hash;
    if (row.status === 'committed') {
      derived[row.wallet_id] = (derived[row.wallet_id] || 0) +
        (row.direction === 'credit' ? row.amount_milli : -row.amount_milli);
    }
  }
  const wallets = db.prepare('SELECT * FROM wallets').all();
  const reconciliation = {};
  for (const w of wallets) {
    const derivedBalance = derived[w.id] || 0;
    const stored = w.balance_milli;
    reconciliation[w.id] = { derived: derivedBalance, stored, ok: derivedBalance === stored };
  }
  const okAll = Object.values(reconciliation).every((r) => r.ok);
  if (!okAll) {
    const bad = Object.entries(reconciliation)
      .filter(([, r]) => !r.ok)
      .map(([id]) => id)
      .join(',');
    throw new DataError('E_LEDGER_RECONCILE', 'wallet balance mismatch vs ledger: ' + bad);
  }
  return { ok: true, entries: rows.length, reconciliation };
}

module.exports = {
  TX_TYPES,
  DIRECTIONS,
  STATUSES,
  hashLedgerEntry,
  appendLedger,
  appendWithinTx,
  transfer,
  entriesByWallet,
  listEntries,
  getEntry,
  byIdempotency,
  verifyLedger,
};