'use strict';
const {
  DataError,
  ok,
  nowIso,
  parseRow,
} = require('./db');
const {
  appendLedger,
  transfer,
  verifyLedger,
  entriesByWallet,
  listEntries,
  getEntry,
  byIdempotency,
  hashLedgerEntry,
} = require('./ledger');

function buildCentralWallet(db) {
  function allRows() {
    return db.prepare('SELECT * FROM ledger_entries ORDER BY seq ASC').all().map(parseRow);
  }

  function walletRows() {
    return db.prepare('SELECT * FROM wallets ORDER BY created_at ASC, id ASC').all();
  }

  function settlementMap(rows) {
    const settled = new Map();
    for (const row of rows) {
      if (!row.meta) continue;
      if (row.status === 'committed') {
        if (row.meta.settles_entry_id) settled.set(row.meta.settles_entry_id, 'committed');
        if (row.meta.reverses_entry_id && !settled.has(row.meta.reverses_entry_id)) {
          settled.set(row.meta.reverses_entry_id, 'reversed');
        }
      } else if (row.status === 'voided' && row.meta.voids_entry_id) {
        settled.set(row.meta.voids_entry_id, 'voided');
      }
    }
    return settled;
  }

  function summarize(rows) {
    const byWallet = new Map();
    for (const row of rows) {
      if (!byWallet.has(row.wallet_id)) byWallet.set(row.wallet_id, []);
      byWallet.get(row.wallet_id).push(row);
    }
    return byWallet;
  }

  function snapshot(walletId) {
    const wallet = db.prepare('SELECT * FROM wallets WHERE id = ?').get(walletId);
    ok(wallet, 'E_NO_WALLET', 'wallet not found: ' + walletId);
    const rows = db
      .prepare('SELECT * FROM ledger_entries WHERE wallet_id = ? ORDER BY seq ASC')
      .all(walletId)
      .map(parseRow);
    const settled = settlementMap(rows);
    let committed = 0;
    let reservedDebit = 0;
    let reservedCredit = 0;
    for (const row of rows) {
      if (row.status === 'committed') {
        committed += row.direction === 'credit' ? row.amount_milli : -row.amount_milli;
      } else if (row.status === 'pending' && !settled.has(row.id)) {
        if (row.direction === 'debit') reservedDebit += row.amount_milli;
        else reservedCredit += row.amount_milli;
      }
    }
    return {
      wallet,
      committed_milli: committed,
      reserved_debit_milli: reservedDebit,
      reserved_credit_milli: reservedCredit,
      pending_milli: reservedCredit - reservedDebit,
      reserved_milli: reservedDebit,
      available_milli: committed - reservedDebit,
      stored_milli: wallet.balance_milli,
      ok: committed === wallet.balance_milli,
    };
  }

  function postPending(input) {
    ok(input && typeof input === 'object', 'E_ARG', 'pending input required');
    const meta = { ...(input.meta || {}), kind: 'reservation' };
    const result = appendLedger(db, { ...input, status: 'pending', meta });
    return { entry: result.entry, idempotent: result.idempotent };
  }

  function settlementOf(pendingId) {
    const rows = db
      .prepare('SELECT * FROM ledger_entries WHERE status IN (?, ?)')
      .all('committed', 'voided')
      .map(parseRow);
    for (const row of rows) {
      if (!row.meta) continue;
      if (row.status === 'committed' && row.meta.settles_entry_id === pendingId) {
        return { kind: 'committed', entry: row };
      }
      if (row.status === 'voided' && row.meta.voids_entry_id === pendingId) {
        return { kind: 'voided', entry: row };
      }
    }
    return null;
  }

  function confirmPending(pendingId) {
    const pending = getEntry(db, pendingId);
    ok(pending, 'E_NO_ENTRY', 'entry not found: ' + pendingId);
    ok(pending.status === 'pending', 'E_NOT_PENDING', 'entry is not pending: ' + pending.status);
    const settled = settlementOf(pendingId);
    if (settled && settled.kind === 'committed') {
      return { pending, entry: settled.entry, idempotent: true };
    }
    if (settled && settled.kind === 'voided') {
      throw new DataError('E_ALREADY_SETTLED', 'pending entry is voided and cannot be confirmed');
    }
    const result = appendLedger(db, {
      wallet_id: pending.wallet_id,
      idempotency_key: 'settle:' + pending.id,
      tx_type: pending.tx_type,
      direction: pending.direction,
      amount_milli: pending.amount_milli,
      status: 'committed',
      meta: { settles_entry_id: pending.id, kind: 'settlement' },
    });
    return { pending, entry: result.entry, idempotent: result.idempotent };
  }

  function voidPending(pendingId) {
    const pending = getEntry(db, pendingId);
    ok(pending, 'E_NO_ENTRY', 'entry not found: ' + pendingId);
    ok(pending.status === 'pending', 'E_NOT_PENDING', 'entry is not pending: ' + pending.status);
    const settled = settlementOf(pendingId);
    if (settled && settled.kind === 'voided') {
      return { pending, entry: settled.entry, idempotent: true };
    }
    if (settled && settled.kind === 'committed') {
      throw new DataError('E_ALREADY_SETTLED', 'pending entry is confirmed and cannot be voided');
    }
    const result = appendLedger(db, {
      wallet_id: pending.wallet_id,
      idempotency_key: 'void:' + pending.id,
      tx_type: pending.tx_type,
      direction: pending.direction,
      amount_milli: pending.amount_milli,
      status: 'voided',
      meta: { voids_entry_id: pending.id, kind: 'void' },
    });
    return { pending, entry: result.entry, idempotent: result.idempotent };
  }

  function reverse(entryId) {
    const entry = getEntry(db, entryId);
    ok(entry, 'E_NO_ENTRY', 'entry not found: ' + entryId);
    ok(entry.status === 'committed', 'E_NOT_COMMITTED', 'only committed entries can be reversed');
    const result = appendLedger(db, {
      wallet_id: entry.wallet_id,
      idempotency_key: 'reverse:' + entry.id,
      tx_type: 'adjustment',
      direction: entry.direction === 'credit' ? 'debit' : 'credit',
      amount_milli: entry.amount_milli,
      status: 'committed',
      meta: { reverses_entry_id: entry.id, kind: 'reversal' },
    });
    return { entry: result.entry, idempotent: result.idempotent };
  }

  function listPending(walletId, options = {}) {
    const limit = Number.isSafeInteger(options.limit) ? options.limit : 100;
    const offset = Number.isSafeInteger(options.offset) ? options.offset : 0;
    const where = walletId ? 'WHERE wallet_id = ?' : '';
    const params = walletId ? [walletId] : [];
    const rows = db
      .prepare(
        'SELECT * FROM ledger_entries ' + where + ' ORDER BY seq DESC LIMIT ? OFFSET ?',
      )
      .all(...params, limit, offset)
      .map(parseRow);
    const settled = settlementMap(rows);
    return rows
      .filter((r) => r.status === 'pending')
      .map((r) => ({ ...r, settlement: settled.get(r.id) || 'open' }));
  }

  function reconcile() {
    const rows = allRows();
    let prevHash = '0'.repeat(64);
    for (const row of rows) {
      if (row.prev_hash !== prevHash) {
        throw new DataError('E_LEDGER_LINK', 'ledger chain broken at seq ' + row.seq);
      }
      const computed = hashLedgerEntry(row);
      if (row.hash !== computed) {
        throw new DataError('E_LEDGER_HASH', 'ledger hash mismatch at seq ' + row.seq);
      }
      prevHash = row.hash;
    }
    const settled = settlementMap(rows);
    const byWallet = summarize(rows);
    const wallets = walletRows().map((wallet) => {
      const entries = byWallet.get(wallet.id) || [];
      let committed = 0;
      let reservedDebit = 0;
      let reservedCredit = 0;
      const pending = [];
      for (const row of entries) {
        if (row.status === 'committed') {
          committed += row.direction === 'credit' ? row.amount_milli : -row.amount_milli;
        } else if (row.status === 'pending') {
          const settlement = settled.get(row.id) || 'open';
          pending.push({ id: row.id, tx_type: row.tx_type, direction: row.direction, amount_milli: row.amount_milli, settlement });
          if (settlement === 'open') {
            if (row.direction === 'debit') reservedDebit += row.amount_milli;
            else reservedCredit += row.amount_milli;
          }
        }
      }
      const okBalance = committed === wallet.balance_milli;
      return {
        wallet_id: wallet.id,
        currency: wallet.currency,
        status: wallet.status,
        version: wallet.version,
        stored_milli: wallet.balance_milli,
        committed_milli: committed,
        reserved_debit_milli: reservedDebit,
        reserved_credit_milli: reservedCredit,
        available_milli: committed - reservedDebit,
        ok: okBalance,
        pending,
      };
    });
    const mismatches = wallets.filter((w) => !w.ok);
    return {
      ok: mismatches.length === 0 && wallets.length > 0,
      generated_at: nowIso(),
      wallets,
      mismatches,
    };
  }

  return {
    snapshot,
    postPending,
    confirmPending,
    voidPending,
    reverse,
    transfer: (input) => transfer(db, input),
    listPending,
    reconcile,
    verify: () => verifyLedger(db),
    entriesByWallet: (walletId, opts) => entriesByWallet(db, walletId, opts),
    list: (opts) => listEntries(db, opts),
    get: (id) => getEntry(db, id),
    byIdempotency: (walletId, key) => byIdempotency(db, walletId, key),
  };
}

module.exports = { buildCentralWallet };