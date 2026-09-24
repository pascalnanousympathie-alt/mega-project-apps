'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { makeDataLayer, makeUser, expectDataError } = require('./helpers');
const contracts = require('../core/contracts');

const ADDR_BTC = 'bc1q' + 'a'.repeat(35);
const ADDR_ETH = '0x' + '1'.repeat(40);
const ADDR_TRON = 'T' + '2'.repeat(33);
const ADDR_SOL = '3'.repeat(44);

test('crypto wallet registry supports multiple public wallets per user', (t) => {
  const { layer } = makeDataLayer(t);
  const user = makeUser(layer, 'crypto_owner');
  const btc = layer.createCryptoWallet(user.id, {
    provider: 'ledger',
    asset: 'BTC',
    network: 'bitcoin',
    address: ADDR_BTC,
    label: 'cold BTC',
  });
  const eth = layer.createCryptoWallet(user.id, {
    provider: 'metamask',
    asset: 'ETH',
    network: 'ethereum',
    address: ADDR_ETH,
    label: 'MetaMask ETH',
  });
  assert.equal(btc.status, 'active');
  assert.equal(eth.status, 'active');
  assert.equal(layer.listCryptoWallets(user.id).length, 2);
  assert.equal(layer.getCryptoWallet(eth.id).address, ADDR_ETH);
});

test('crypto wallet rejects unsupported networks and duplicate addresses', (t) => {
  const { layer } = makeDataLayer(t);
  const user = makeUser(layer, 'crypto_validation');
  expectDataError(
    () => layer.createCryptoWallet(user.id, {
      provider: 'trust_wallet',
      asset: 'BTC',
      network: 'tron',
      address: ADDR_BTC,
    }),
    'E_CRYPTO_WALLET_INVALID',
  );
  layer.createCryptoWallet(user.id, {
    provider: 'trust_wallet',
    asset: 'USDT',
    network: 'tron',
    address: ADDR_TRON,
  });
  expectDataError(
    () => layer.createCryptoWallet(user.id, {
      provider: 'trust_wallet',
      asset: 'USDT',
      network: 'tron',
      address: ADDR_TRON,
    }),
    'E_DUPLICATE',
  );
});

test('crypto wallet can be disabled and cannot be changed by another user', (t) => {
  const { layer } = makeDataLayer(t);
  const owner = makeUser(layer, 'crypto_owner2');
  const other = makeUser(layer, 'crypto_other');
  const wallet = layer.createCryptoWallet(owner.id, {
    provider: 'coinbase_wallet',
    asset: 'USDC',
    network: 'polygon',
    address: '0x' + '3'.repeat(40),
  });
  expectDataError(() => layer.disableCryptoWallet(other.id, wallet.id), 'E_FORBIDDEN');
  const disabled = layer.disableCryptoWallet(owner.id, wallet.id);
  assert.equal(disabled.status, 'disabled');
  assert.deepEqual(layer.listCryptoWallets(owner.id), []);
});
test('crypto wallet REST routes are exposed with authenticated contracts', () => {
  assert.ok(contracts.matchRoute('v1', 'GET', '/api/v1/crypto/wallets'));
  assert.ok(contracts.matchRoute('v1', 'GET', '/api/v1/crypto/currencies'));
  assert.ok(contracts.matchRoute('v1', 'POST', '/api/v1/crypto/wallets'));
  const route = contracts.matchRoute('v1', 'DELETE', '/api/v1/crypto/wallets/test-id');
  assert.ok(route);
  assert.equal(route.matched_params.cryptoWalletId, 'test-id');
  assert.equal(route.idempotent, false);
  assert.equal(contracts.surface().rest.some((r) => r.path === '/crypto/wallets'), true);
});

test('crypto wallet data never contains private-key or seed fields', (t) => {
  const { layer } = makeDataLayer(t);
  const user = makeUser(layer, 'crypto_public_only');
  const wallet = layer.createCryptoWallet(user.id, {
    provider: 'metamask',
    asset: 'SOL',
    network: 'solana',
    address: ADDR_SOL,
    label: 'public receive',
  });
  assert.equal(Object.prototype.hasOwnProperty.call(wallet, 'private_key'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(wallet, 'seed'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(wallet, 'secret'), false);
});
