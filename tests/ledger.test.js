'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { makeDataLayer, makeUser, expectDataError } = require('./helpers');

function seedWallet(layer) {
  const user = makeUser(layer, 'player_' + Math.random().toString(36).slice(2, 8));
  return layer.createWallet(user.id);
}

test('applies credits and debits with correct balances', (t) => {
  const { layer } = makeDataLayer(t);
  const wallet = seedWallet(layer);
  const deposit = layer.ledger.append({
    wallet_id: wallet.id,
    idempotency_key: 'tx-dep-1',
    tx_type: 'deposit',
    direction: 'credit',
    amount_milli: 10000,
    meta: { method: 'mvola' },
  });
  assert.equal(deposit.entry.balance_before_milli, 0);
  assert.equal(deposit.entry.balance_after_milli, 10000);
  const spend = layer.ledger.append({
    wallet_id: wallet.id,
    idempotency_key: 'tx-spend-1',
    tx_type: 'entry_fee',
    direction: 'debit',
    amount_milli: 2500,
  });
  assert.equal(spend.entry.balance_before_milli, 10000);
  assert.equal(spend.entry.balance_after_milli, 7500);
  assert.equal(layer.getWallet(wallet.id).balance_milli, 7500);
  assert.equal(layer.getWallet(wallet.id).version, 2);
});

test('rejects a debit that exceeds the balance', (t) => {
  const { layer } = makeDataLayer(t);
  const wallet = seedWallet(layer);
  expectDataError(
    () =>
      layer.ledger.append({
        wallet_id: wallet.id,
        idempotency_key: 'tx-overdraft',
        tx_type: 'withdraw',
        direction: 'debit',
        amount_milli: 500,
      }),
    'E_INSUFFICIENT_FUNDS',
  );
});

test('idempotency key replays return the original entry without double apply', (t) => {
  const { layer } = makeDataLayer(t);
  const wallet = seedWallet(layer);
  const first = layer.ledger.append({
    wallet_id: wallet.id,
    idempotency_key: 'idem-1',
    tx_type: 'deposit',
    direction: 'credit',
    amount_milli: 5000,
  });
  const replay = layer.ledger.append({
    wallet_id: wallet.id,
    idempotency_key: 'idem-1',
    tx_type: 'deposit',
    direction: 'credit',
    amount_milli: 999999,
  });
  assert.equal(replay.idempotent, true);
  assert.equal(replay.entry.id, first.entry.id);
  assert.equal(replay.entry.amount_milli, first.entry.amount_milli);
  assert.equal(layer.getWallet(wallet.id).balance_milli, 5000);
  assert.equal(layer.ledger.byIdempotency(wallet.id, 'idem-1').id, first.entry.id);
  assert.equal(layer.ledger.entriesByWallet(wallet.id).length, 1);
});

test('rejects invalid amounts, types and directions', (t) => {
  const { layer } = makeDataLayer(t);
  const wallet = seedWallet(layer);
  const base = { wallet_id: wallet.id, idempotency_key: 'x', tx_type: 'deposit', direction: 'credit' };
  expectDataError(() => layer.ledger.append({ ...base, amount_milli: 0 }), 'E_ARG');
  expectDataError(() => layer.ledger.append({ ...base, amount_milli: -1 }), 'E_ARG');
  expectDataError(() => layer.ledger.append({ ...base, amount_milli: 1.5 }), 'E_ARG');
  expectDataError(() => layer.ledger.append({ ...base, amount_milli: 1, tx_type: 'gift' }), 'E_ARG');
  expectDataError(() => layer.ledger.append({ ...base, amount_milli: 1, direction: 'both' }), 'E_ARG');
  expectDataError(() => layer.ledger.append({ ...base, amount_milli: 1, idempotency_key: '' }), 'E_ARG');
});

test('rejects unknown and inactive wallets', (t) => {
  const { layer } = makeDataLayer(t);
  const wallet = seedWallet(layer);
  expectDataError(
    () => layer.ledger.append({
      wallet_id: 'ghost', idempotency_key: 'a', tx_type: 'deposit', direction: 'credit', amount_milli: 1,
    }),
    'E_NO_WALLET',
  );
  layer.setWalletStatus(wallet.id, 'locked');
  expectDataError(
    () => layer.ledger.append({
      wallet_id: wallet.id, idempotency_key: 'b', tx_type: 'deposit', direction: 'credit', amount_milli: 1,
    }),
    'E_WALLET_INACTIVE',
  );
});

test('builds an immutable hash chain and verifies balances', (t) => {
  const { layer } = makeDataLayer(t);
  const w1 = seedWallet(layer);
  const w2 = seedWallet(layer);
  layer.ledger.append({ wallet_id: w1.id, idempotency_key: 'c1', tx_type: 'deposit', direction: 'credit', amount_milli: 300 });
  layer.ledger.append({ wallet_id: w1.id, idempotency_key: 'c2', tx_type: 'commission', direction: 'credit', amount_milli: 50 });
  layer.ledger.append({ wallet_id: w2.id, idempotency_key: 'c3', tx_type: 'deposit', direction: 'credit', amount_milli: 100 });
  layer.ledger.append({ wallet_id: w2.id, idempotency_key: 'c4', tx_type: 'withdraw', direction: 'debit', amount_milli: 40 });
  const result = layer.ledger.verify();
  assert.equal(result.ok, true);
  assert.equal(result.entries, 4);
  assert.equal(result.reconciliation[w1.id].derived, 350);
  assert.equal(result.reconciliation[w2.id].derived, 60);
  const history = layer.ledger.entriesByWallet(w2.id);
  assert.equal(history.length, 2);
  assert.equal(history[0].amount_milli, 40);
  assert.equal(layer.getWallet(w1.id).balance_milli, 350);
  assert.equal(layer.getWallet(w2.id).balance_milli, 60);
});