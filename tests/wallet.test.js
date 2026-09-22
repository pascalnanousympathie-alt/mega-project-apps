'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { makeDataLayer, expectDataError } = require('./helpers');

function seed(layer, nameA, nameB) {
  const a = layer.createWallet(layer.createUser({ username: nameA }).id);
  const b = layer.createWallet(layer.createUser({ username: nameB }).id);
  return { a, b };
}

function deposit(layer, walletId, idem, amount) {
  return layer.ledger.append({
    wallet_id: walletId,
    idempotency_key: idem,
    tx_type: 'deposit',
    direction: 'credit',
    amount_milli: amount,
  });
}

test('central wallet snapshot reports committed, reserved and available balances', (t) => {
  const { layer } = makeDataLayer(t);
  const { a } = seed(layer, 'snap_a', 'snap_b');
  deposit(layer, a.id, 'snap-dep', 10000);
  const snap = layer.wallet.snapshot(a.id);
  assert.equal(snap.committed_milli, 10000);
  assert.equal(snap.reserved_debit_milli, 0);
  assert.equal(snap.available_milli, 10000);
  assert.equal(snap.stored_milli, 10000);
  assert.equal(snap.ok, true);
});

test('postPending reserves funds without moving stored balance', (t) => {
  const { layer } = makeDataLayer(t);
  const { a } = seed(layer, 'pend_a', 'pend_b');
  deposit(layer, a.id, 'pend-dep', 10000);
  const res = layer.wallet.postPending({
    wallet_id: a.id,
    idempotency_key: 'pend-1',
    tx_type: 'withdraw',
    direction: 'debit',
    amount_milli: 3000,
  });
  assert.equal(res.idempotent, false);
  assert.equal(res.entry.status, 'pending');
  assert.equal(layer.getWallet(a.id).balance_milli, 10000);
  const snap = layer.wallet.snapshot(a.id);
  assert.equal(snap.committed_milli, 10000);
  assert.equal(snap.reserved_debit_milli, 3000);
  assert.equal(snap.available_milli, 7000);
  assert.equal(snap.pending_milli, -3000);
  layer.wallet.verify();
});

test('confirmPending applies the balance change and releases the reservation', (t) => {
  const { layer } = makeDataLayer(t);
  const { a } = seed(layer, 'conf_a', 'conf_b');
  deposit(layer, a.id, 'conf-dep', 10000);
  const { entry: pending } = layer.wallet.postPending({
    wallet_id: a.id,
    idempotency_key: 'conf-1',
    tx_type: 'withdraw',
    direction: 'debit',
    amount_milli: 3000,
  });
  const settled = layer.wallet.confirmPending(pending.id);
  assert.equal(settled.idempotent, false);
  assert.equal(settled.entry.status, 'committed');
  assert.equal(settled.entry.balance_after_milli, 7000);
  const snap = layer.wallet.snapshot(a.id);
  assert.equal(snap.committed_milli, 7000);
  assert.equal(snap.reserved_debit_milli, 0);
  assert.equal(snap.available_milli, 7000);
  assert.equal(layer.getWallet(a.id).balance_milli, 7000);
  const replay = layer.wallet.confirmPending(pending.id);
  assert.equal(replay.idempotent, true);
  assert.equal(layer.getWallet(a.id).balance_milli, 7000);
  layer.wallet.verify();
});

test('voidPending releases the reservation without moving the balance', (t) => {
  const { layer } = makeDataLayer(t);
  const { a } = seed(layer, 'void_a', 'void_b');
  deposit(layer, a.id, 'void-dep', 10000);
  const { entry: pending } = layer.wallet.postPending({
    wallet_id: a.id,
    idempotency_key: 'void-1',
    tx_type: 'withdraw',
    direction: 'debit',
    amount_milli: 2000,
  });
  const outcome = layer.wallet.voidPending(pending.id);
  assert.equal(outcome.entry.status, 'voided');
  assert.equal(outcome.entry.balance_after_milli, 10000);
  assert.equal(layer.getWallet(a.id).balance_milli, 10000);
  const snap = layer.wallet.snapshot(a.id);
  assert.equal(snap.available_milli, 10000);
  assert.equal(snap.reserved_debit_milli, 0);
  const pendingList = layer.wallet.listPending(a.id);
  assert.equal(pendingList.length, 1);
  assert.equal(pendingList[0].settlement, 'voided');
  layer.wallet.voidPending(pending.id);
  assert.equal(layer.getWallet(a.id).balance_milli, 10000);
  layer.wallet.verify();
});

test('transfer moves funds atomically on both wallets and replays idempotently', (t) => {
  const { layer } = makeDataLayer(t);
  const { a, b } = seed(layer, 'txfer_a', 'txfer_b');
  deposit(layer, a.id, 'tf-dep', 10000);
  const result = layer.wallet.transfer({
    from_wallet_id: a.id,
    to_wallet_id: b.id,
    idempotency_key: 'tf-1',
    amount_milli: 4000,
  });
  assert.equal(result.out.wallet_id, a.id);
  assert.equal(result.out.direction, 'debit');
  assert.equal(result.in.wallet_id, b.id);
  assert.equal(result.in.direction, 'credit');
  assert.equal(layer.getWallet(a.id).balance_milli, 6000);
  assert.equal(layer.getWallet(b.id).balance_milli, 4000);
  const replay = layer.wallet.transfer({
    from_wallet_id: a.id,
    to_wallet_id: b.id,
    idempotency_key: 'tf-1',
    amount_milli: 999999,
  });
  assert.equal(replay.idempotent, true);
  assert.equal(layer.getWallet(a.id).balance_milli, 6000);
  assert.equal(layer.getWallet(b.id).balance_milli, 4000);
  layer.wallet.verify();
});

test('transfer rejects insufficient funds and rolls back both legs', (t) => {
  const { layer } = makeDataLayer(t);
  const { a, b } = seed(layer, 'roll_a', 'roll_b');
  deposit(layer, a.id, 'roll-dep', 1000);
  expectDataError(
    () =>
      layer.wallet.transfer({
        from_wallet_id: a.id,
        to_wallet_id: b.id,
        idempotency_key: 'roll-1',
        amount_milli: 5000,
      }),
    'E_INSUFFICIENT_FUNDS',
  );
  assert.equal(layer.getWallet(a.id).balance_milli, 1000);
  assert.equal(layer.getWallet(b.id).balance_milli, 0);
  assert.equal(layer.wallet.entriesByWallet(b.id).length, 0);
  layer.wallet.verify();
});

test('transfer requires distinct source and target wallets', (t) => {
  const { layer } = makeDataLayer(t);
  const { a } = seed(layer, 'same_a', 'same_b');
  deposit(layer, a.id, 'same-dep', 1000);
  expectDataError(
    () =>
      layer.wallet.transfer({
        from_wallet_id: a.id,
        to_wallet_id: a.id,
        idempotency_key: 'same-1',
        amount_milli: 100,
      }),
    'E_ARG',
  );
});

test('reverse of a committed entry corrects the balance and is idempotent', (t) => {
  const { layer } = makeDataLayer(t);
  const { a } = seed(layer, 'rev_a', 'rev_b');
  const dep = deposit(layer, a.id, 'rev-dep', 1000);
  const reversed = layer.wallet.reverse(dep.entry.id);
  assert.equal(reversed.entry.direction, 'debit');
  assert.equal(reversed.entry.tx_type, 'adjustment');
  assert.equal(layer.getWallet(a.id).balance_milli, 0);
  layer.wallet.reverse(dep.entry.id);
  assert.equal(layer.getWallet(a.id).balance_milli, 0);
  assert.equal(layer.wallet.entriesByWallet(a.id).length, 2);
  layer.wallet.verify();
});

test('reconcile report lists wallets, pending settlements and detects mismatch', (t) => {
  const { layer } = makeDataLayer(t);
  const { a, b } = seed(layer, 'rec_a', 'rec_b');
  deposit(layer, a.id, 'rec-dep', 1000);
  const report = layer.wallet.reconcile();
  assert.equal(report.ok, true);
  assert.equal(report.wallets.length, 2);
  assert.deepEqual(
    report.wallets.map((w) => w.wallet_id).sort(),
    [a.id, b.id].sort(),
  );
  layer.wallet.postPending({
    wallet_id: b.id,
    idempotency_key: 'rec-pend',
    tx_type: 'prize',
    direction: 'credit',
    amount_milli: 200,
  });
  const withPending = layer.wallet.reconcile();
  const row = withPending.wallets.find((w) => w.wallet_id === b.id);
  assert.equal(row.reserved_credit_milli, 200);
  assert.equal(row.pending.length, 1);
  assert.equal(row.pending[0].settlement, 'open');
  layer.db.prepare('UPDATE wallets SET balance_milli = balance_milli + 1 WHERE id = ?').run(a.id);
  const bad = layer.wallet.reconcile();
  assert.equal(bad.ok, false);
  assert.equal(bad.mismatches.length, 1);
  assert.equal(bad.mismatches[0].wallet_id, a.id);
  expectDataError(() => layer.wallet.verify(), 'E_LEDGER_RECONCILE');
});

test('lifecycle guards reject invalid operations', (t) => {
  const { layer } = makeDataLayer(t);
  const { a } = seed(layer, 'guard_a', 'guard_b');
  expectDataError(() => layer.wallet.snapshot('ghost'), 'E_NO_WALLET');
  expectDataError(
    () => layer.wallet.confirmPending('missing-id'),
    'E_NO_ENTRY',
  );
  const dep = deposit(layer, a.id, 'guard-dep', 1000);
  expectDataError(() => layer.wallet.confirmPending(dep.entry.id), 'E_NOT_PENDING');
  const { entry: pending } = layer.wallet.postPending({
    wallet_id: a.id,
    idempotency_key: 'guard-pend',
    tx_type: 'withdraw',
    direction: 'debit',
    amount_milli: 100,
  });
  layer.wallet.confirmPending(pending.id);
  expectDataError(() => layer.wallet.voidPending(pending.id), 'E_ALREADY_SETTLED');
  expectDataError(() => layer.wallet.reverse(pending.id), 'E_NOT_COMMITTED');
});

test('postPending rejects inactive wallets and invalid pending input', (t) => {
  const { layer } = makeDataLayer(t);
  const user = layer.createUser({ username: 'lock_pend' });
  const wallet = layer.createWallet(user.id);
  layer.setWalletStatus(wallet.id, 'locked');
  expectDataError(
    () =>
      layer.wallet.postPending({
        wallet_id: wallet.id,
        idempotency_key: 'lock-1',
        tx_type: 'withdraw',
        direction: 'debit',
        amount_milli: 100,
      }),
    'E_WALLET_INACTIVE',
  );
});