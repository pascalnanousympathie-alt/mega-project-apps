'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { makeDataLayer, makeUser, expectDataError } = require('./helpers');

test('crypto ledger credits, reserves and settles atomically', (t) => {
  const { layer } = makeDataLayer(t);
  const user = makeUser(layer, 'crypto_ledger_owner');
  const credited = layer.cryptoLedger.credit({
    user_id: user.id, asset: 'USDT', network: 'tron', amount: '12.5',
    idempotency_key: 'deposit-1', meta: { kind: 'test_deposit' },
  });
  assert.equal(credited.entry.amount, '12.5');
  let balance = layer.cryptoLedger.getBalance(user.id, 'USDT', 'tron');
  assert.equal(balance.available_amount, '12.5');
  assert.equal(balance.reserved_amount, '0');

  const replay = layer.cryptoLedger.credit({
    user_id: user.id, asset: 'USDT', network: 'tron', amount: '12.5',
    idempotency_key: 'deposit-1',
  });
  assert.equal(replay.idempotent, true);
  const reserved = layer.cryptoLedger.reserve({
    user_id: user.id, asset: 'USDT', network: 'tron', amount: '2.5',
    idempotency_key: 'withdrawal-reserve-1',
    meta: { kind: 'test_withdrawal' },
  });
  assert.equal(reserved.entry.tx_type, 'withdrawal_reserve');
  balance = layer.cryptoLedger.getBalance(user.id, 'USDT', 'tron');
  assert.equal(balance.available_amount, '10');
  assert.equal(balance.reserved_amount, '2.5');

  layer.cryptoLedger.settle({
    user_id: user.id, asset: 'USDT', network: 'tron', amount: '2.5',
    idempotency_key: 'withdrawal-settle-1',
  });
  balance = layer.cryptoLedger.getBalance(user.id, 'USDT', 'tron');
  assert.equal(balance.available_amount, '10');
  assert.equal(balance.reserved_amount, '0');
  assert.equal(layer.cryptoLedger.verify().ok, true);
});
test('crypto ledger rejects overspending and supports release', (t) => {
  const { layer } = makeDataLayer(t);
  const user = makeUser(layer, 'crypto_ledger_release');
  layer.cryptoLedger.credit({
    user_id: user.id, asset: 'USDC', network: 'polygon', amount: '3.25',
    idempotency_key: 'deposit-2',
  });
  expectDataError(() => layer.cryptoLedger.reserve({
    user_id: user.id, asset: 'USDC', network: 'polygon', amount: '4',
    idempotency_key: 'withdrawal-reserve-2',
  }), 'E_CRYPTO_INSUFFICIENT_FUNDS');

  layer.cryptoLedger.reserve({
    user_id: user.id, asset: 'USDC', network: 'polygon', amount: '1.25',
    idempotency_key: 'withdrawal-reserve-3',
  });
  layer.cryptoLedger.release({
    user_id: user.id, asset: 'USDC', network: 'polygon', amount: '1.25',
    idempotency_key: 'withdrawal-release-3',
  });
  const balance = layer.cryptoLedger.getBalance(user.id, 'USDC', 'polygon');
  assert.equal(balance.available_amount, '3.25');
  assert.equal(balance.reserved_amount, '0');
  assert.equal(layer.cryptoLedger.verify().ok, true);
});

test('crypto ledger decimal arithmetic is exact', (t) => {
  const { layer } = makeDataLayer(t);
  const user = makeUser(layer, 'crypto_decimal');
  layer.cryptoLedger.credit({
    user_id: user.id, asset: 'BTC', network: 'bitcoin', amount: '0.00012345',
    idempotency_key: 'deposit-3',
  });
  layer.cryptoLedger.reserve({
    user_id: user.id, asset: 'BTC', network: 'bitcoin', amount: '0.00002345',
    idempotency_key: 'reserve-3',
  });
  const balance = layer.cryptoLedger.getBalance(user.id, 'BTC', 'bitcoin');
  assert.equal(balance.available_amount, '0.0001');
  assert.equal(balance.reserved_amount, '0.00002345');
  assert.equal(layer.cryptoLedger.verify().ok, true);
});
