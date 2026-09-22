'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { createDataLayer } = require('../core');
const { makeDataLayer, makeUser, expectDataError } = require('./helpers');

function tamperStore(layer) {
  const user = makeUser(layer, 'tamper_target');
  const wallet = layer.createWallet(user.id);
  layer.ledger.append({
    wallet_id: wallet.id,
    idempotency_key: 'tamper-1',
    tx_type: 'deposit',
    direction: 'credit',
    amount_milli: 1000,
  });
  layer.ledger.append({
    wallet_id: wallet.id,
    idempotency_key: 'tamper-2',
    tx_type: 'deposit',
    direction: 'credit',
    amount_milli: 2000,
  });
  return { wallet, user };
}

test('detects a tampered ledger amount via hash mismatch', (t) => {
  const { layer } = makeDataLayer(t);
  tamperStore(layer);
  layer.db
    .prepare("UPDATE ledger_entries SET balance_after_milli = balance_after_milli + 1 WHERE idempotency_key = 'tamper-2'")
    .run();
  assert.throws(() => layer.ledger.verify(), (err) => err.code === 'E_LEDGER_HASH');
});

test('detects a broken chain link via prev_hash mismatch', (t) => {
  const { layer } = makeDataLayer(t);
  tamperStore(layer);
  layer.db
    .prepare("UPDATE ledger_entries SET prev_hash = CASE WHEN substr(prev_hash,1,1)='0' THEN '1' ELSE '0' END || substr(prev_hash, 2) WHERE idempotency_key = 'tamper-2'")
    .run();
  assert.throws(() => layer.ledger.verify(), (err) => err.code === 'E_LEDGER_LINK');
});

test('detects wallet balance out of sync with the ledger', (t) => {
  const { layer } = makeDataLayer(t);
  const { wallet } = tamperStore(layer);
  layer.db
    .prepare('UPDATE wallets SET balance_milli = balance_milli + 500 WHERE id = ?')
    .run(wallet.id);
  assert.throws(() => layer.ledger.verify(), (err) => err.code === 'E_LEDGER_RECONCILE');
});

test('fails closed on open when the persistent store is corrupted', (t) => {
  const { layer, dir } = makeDataLayer(t);
  tamperStore(layer);
  layer.db.prepare('UPDATE ledger_entries SET amount_milli = amount_milli + 1 WHERE idempotency_key = ?').run('tamper-2');
  layer.close();
  assert.throws(
    () => createDataLayer({ dataDir: dir }),
    (err) => err.code === 'E_LEDGER_HASH' || err.code === 'E_LEDGER_LINK',
  );
  assert.ok(true, 'open raised integrity error from stored ledger');
});

test('re-open with verified ledger remains healthy', (t) => {
  const { layer, dir } = makeDataLayer(t);
  tamperStore(layer);
  const health = layer.ledger.verify();
  assert.equal(health.ok, true);
  layer.close();
  const reopened = createDataLayer({ dataDir: dir });
  assert.equal(reopened.ledger.verify().entries, 2);
  reopened.close();
});

test('createDataLayer honors a caller-supplied data dir', (t) => {
  const { layer, dir } = makeDataLayer(t);
  layer.close();
  assert.ok(dir.length > 0);
  assert.equal(path.basename(dir).startsWith('acep-p04-'), true);
});