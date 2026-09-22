'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createDataLayer } = require('../core');
const { openDataLayer } = require('../core/db');
const { appendWithinTx, verifyLedger } = require('../core/ledger');
const { buildPaymentGateway } = require('../core/payments');

const CALLBACK_SECRET = 'callback-secret-value';
const CREDENTIALS = {
  mvola: {
    consumerKey: 'test-consumer-key',
    consumerSecret: 'test-consumer-secret',
    merchantNumber: '0340000000',
    partnerName: 'ACEP',
    callbackSecret: CALLBACK_SECRET,
    baseUrl: 'https://mvola.test',
  },
};

function childCrashAfterWrite(dataDir, walletId, markerPath) {
  const script = `
    const fs = require('node:fs');
    const { openDataLayer } = require(${JSON.stringify(require.resolve('../core/db'))});
    const { appendWithinTx } = require(${JSON.stringify(require.resolve('../core/ledger'))});
    const db = openDataLayer(${JSON.stringify(dataDir)}, { verifyOnOpen: false });
    db.exec('BEGIN IMMEDIATE');
    appendWithinTx(db, {
      wallet_id: ${JSON.stringify(walletId)},
      idempotency_key: 'p22-crash-uncommitted',
      tx_type: 'deposit',
      direction: 'credit',
      amount_milli: 777,
      status: 'committed',
    });
    fs.writeFileSync(${JSON.stringify(markerPath)}, 'ready');
    setInterval(() => {}, 1000);
  `;
  return spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'ignore', 'pipe'] });
}

async function waitForFile(file, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

function makeTransport(state) {
  return async (spec) => {
    if (spec.url.endsWith('/token')) {
      return { status: 200, ok: true, headers: {}, data: { access_token: 'test-access-token' } };
    }
    if (state.networkDown) {
      throw new Error('simulated network outage');
    }
    if (spec.method === 'GET') {
      return { status: 200, ok: true, headers: {}, data: { transactionStatus: 'success', serverCorrelationId: 'p22-ref-1' } };
    }
    return { status: 200, ok: true, headers: {}, data: { status: 'pending', serverCorrelationId: 'p22-ref-1' } };
  };
}

function makePaymentLayer(t, transport) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acep-p22-payment-'));
  const layer = createDataLayer({ dataDir: dir, payments: { credentials: CREDENTIALS, env: {}, transport, callbackUrl: 'https://acep.test/payments/callback' } });
  t.after(() => layer.close());
  return { layer, dir };
}

test('crash before COMMIT rolls back the open write transaction on restart', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acep-p22-crash-'));
  const layer = createDataLayer({ dataDir: dir });
  const user = layer.createUser({ username: 'p22_crash', password: 'S3cretpass!' });
  const wallet = layer.createWallet(user.id);
  layer.close();

  const marker = path.join(dir, 'crash-ready');
  const child = childCrashAfterWrite(dir, wallet.id, marker);
  t.after(() => { try { child.kill('SIGKILL'); } catch (_) {} });
  assert.equal(await waitForFile(marker), true);
  child.kill('SIGKILL');
  await new Promise((resolve) => child.once('close', resolve));

  const reopened = openDataLayer(dir);
  t.after(() => reopened.close());
  const row = reopened.prepare('SELECT COUNT(*) AS c FROM ledger_entries WHERE wallet_id = ?').get(wallet.id);
  const stored = reopened.prepare('SELECT balance_milli FROM wallets WHERE id = ?').get(wallet.id);
  assert.equal(row.c, 0);
  assert.equal(stored.balance_milli, 0);
  assert.equal(verifyLedger(reopened).ok, true);
});

test('duplicate callback after restart is idempotent and never double-credits', async (t) => {
  const state = { networkDown: false };
  const transport = makeTransport(state);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acep-p22-callback-'));
  let layer = createDataLayer({ dataDir: dir, payments: { credentials: CREDENTIALS, env: {}, transport, callbackUrl: 'https://acep.test/payments/callback' } });
  const user = layer.createUser({ username: 'p22_callback', password: 'S3cretpass!' });
  const wallet = layer.createWallet(user.id);
  const intent = (await layer.payments.initiatePayment({ provider: 'mvola', amount_milli: 25000, wallet_id: wallet.id, customer: { msisdn: '0340123022' }, idempotency_key: 'p22-callback-intent' })).intent;
  const first = layer.payments.handleCallback('mvola', { serverCorrelationId: 'p22-ref-1', transactionStatus: 'success', amount: '25000' }, { 'x-content-signature': CALLBACK_SECRET });
  assert.equal(first.outcome, 'applied');
  assert.equal(layer.getWallet(wallet.id).balance_milli, 25000);
  layer.close();
  layer = createDataLayer({ dataDir: dir, payments: { credentials: CREDENTIALS, env: {}, transport, callbackUrl: 'https://acep.test/payments/callback' } });
  t.after(() => layer.close());
  const duplicate = layer.payments.handleCallback('mvola', { serverCorrelationId: 'p22-ref-1', transactionStatus: 'success', amount: '25000' }, { 'x-content-signature': CALLBACK_SECRET });
  assert.equal(duplicate.outcome, 'duplicate');
  assert.equal(layer.getWallet(wallet.id).balance_milli, 25000);
  assert.equal(layer.payments.listCallbacks(intent.id).length, 1);
  assert.equal(layer.payments.verifyIntents().ok, true);
});

test('network outage leaves a pending payment recoverable by reconciliation', async (t) => {
  const state = { networkDown: false };
  const transport = makeTransport(state);
  const { layer } = makePaymentLayer(t, transport);
  const user = layer.createUser({ username: 'p22_network', password: 'S3cretpass!' });
  const wallet = layer.createWallet(user.id);
  const intent = (await layer.payments.initiatePayment({ provider: 'mvola', amount_milli: 25000, wallet_id: wallet.id, customer: { msisdn: '0340123023' }, idempotency_key: 'p22-network-intent' })).intent;
  assert.equal(intent.status, 'pending');
  state.networkDown = true;
  await assert.rejects(() => layer.payments.reconcileIntent(intent.id), (err) => err.code === 'E_PAYMENT_RECONCILE');
  assert.equal(layer.payments.getIntent(intent.id).status, 'pending');
  state.networkDown = false;
  const recovered = await layer.payments.reconcileIntent(intent.id);
  assert.equal(recovered.outcome, 'updated');
  assert.equal(recovered.intent.status, 'succeeded');
  assert.equal(layer.getWallet(wallet.id).balance_milli, 25000);
});
