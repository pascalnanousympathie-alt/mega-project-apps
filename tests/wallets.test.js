'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { makeDataLayer, makeUser, expectDataError } = require('./helpers');

test('creates an empty active MGA wallet for a user', (t) => {
  const { layer } = makeDataLayer(t);
  const user = makeUser(layer, 'wallet_owner');
  const wallet = layer.createWallet(user.id);
  assert.equal(wallet.user_id, user.id);
  assert.equal(wallet.currency, 'MGA');
  assert.equal(wallet.balance_milli, 0);
  assert.equal(wallet.status, 'active');
  assert.equal(layer.getWalletByUser(user.id).id, wallet.id);
});

test('one wallet per user and currency', (t) => {
  const { layer } = makeDataLayer(t);
  const user = makeUser(layer, 'single_wallet');
  layer.createWallet(user.id);
  expectDataError(() => layer.createWallet(user.id), 'E_DUPLICATE');
  expectDataError(() => layer.createWallet(user.id, { currency: 'EUR' }), 'E_ARG');
});

test('wallet requires an existing user', (t) => {
  const { layer } = makeDataLayer(t);
  expectDataError(() => layer.createWallet('missing-user'), 'E_NO_USER');
  expectDataError(() => layer.getWalletByUser('missing-user'), 'E_NO_WALLET');
});

test('wallet status transitions and closed terminal state', (t) => {
  const { layer } = makeDataLayer(t);
  const user = makeUser(layer, 'wallet_lock');
  const wallet = layer.createWallet(user.id);
  const locked = layer.setWalletStatus(wallet.id, 'locked');
  assert.equal(locked.status, 'locked');
  assert.equal(layer.getWallet(wallet.id).version, 1);
  layer.setWalletStatus(wallet.id, 'active');
  layer.setWalletStatus(wallet.id, 'closed');
  expectDataError(() => layer.setWalletStatus(wallet.id, 'active'), 'E_WALLET_CLOSED');
  expectDataError(() => layer.setWalletStatus(wallet.id, 'locked'), 'E_WALLET_CLOSED');
  expectDataError(() => layer.setWalletStatus(wallet.id, 'weird'), 'E_ARG');
});