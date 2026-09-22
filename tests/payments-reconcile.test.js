'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { buildPaymentGateway, containsSecretLike } = require('../core/payments');
const { makeDataLayer, expectDataError } = require('./helpers');

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

function ok(data, status = 200) {
  return { status, ok: true, headers: {}, data };
}

function makeTransport(options = {}) {
  const calls = [];
  let postCount = 0;
  const transport = async (spec) => {
    calls.push(spec);
    if (options.respond) {
      const custom = options.respond(spec);
      if (custom) return custom;
    }
    if (/\/token$/.test(spec.url)) {
      return ok({ access_token: 'test-access-token', expires_in: 3600 });
    }
    if (spec.url.includes('merchantpay')) {
      if (spec.method === 'GET') {
        const ref = spec.headers && spec.headers['X-CorrelationID'];
        if (options.failRef && ref === options.failRef) {
          return { status: 500, ok: false, headers: {}, data: { message: 'provider down' } };
        }
        return ok({ transactionStatus: options.pollStatus || 'success', serverCorrelationId: ref });
      }
      postCount += 1;
      return ok({
        status: options.createStatus || 'pending',
        serverCorrelationId: options.staticRef || 'ref-' + postCount,
      });
    }
    return { status: 404, ok: false, headers: {}, data: { message: 'unmatched transport route' } };
  };
  transport.calls = calls;
  return transport;
}

function makePaymentLayer(t, options = {}) {
  const ctx = makeDataLayer(t);
  const layer = ctx.layer;
  layer.payments = buildPaymentGateway({
    db: layer.db,
    repos: layer,
    credentials: options.credentials || CREDENTIALS,
    env: {},
    transport: options.transport || makeTransport(options.transportOptions || {}),
    callbackUrl: 'https://acep.test/payments/callback',
  });
  return { layer, dir: ctx.dir };
}

function makeWallet(layer, name = 'recon_payer') {
  const user = layer.createUser({ username: name, phone: '+261340000123', email: name + '@example.mg' });
  return layer.createWallet(user.id);
}

async function makePendingIntent(layer, key = 'recon-key-0001', amount = 25000) {
  const wallet = makeWallet(layer, 'payer_' + key.replace(/[^A-Za-z0-9_]/g, '_'));
  const result = await layer.payments.initiatePayment({
    provider: 'mvola',
    amount_milli: amount,
    wallet_id: wallet.id,
    customer: { msisdn: '0340000001' },
    idempotency_key: key,
  });
  assert.equal(result.intent.status, 'pending');
  return result.intent;
}

function callback(overrides = {}) {
  return { transactionStatus: 'success', serverCorrelationId: 'ref-1', ...overrides };
}

function signed(payload, headers = {}) {
  return { payload, headers: { 'x-content-signature': CALLBACK_SECRET, ...headers } };
}

test('callback transitions a pending intent to succeeded exactly once', async (t) => {
  const { layer } = makePaymentLayer(t);
  const intent = await makePendingIntent(layer);

  const first = layer.payments.handleCallback('mvola', ...Object.values(signed(callback({ amount: '25000' }))));
  assert.equal(first.duplicate, false);
  assert.equal(first.applied, true);
  assert.equal(first.outcome, 'applied');
  assert.equal(first.accepted, true);
  assert.equal(first.intent.status, 'succeeded');
  assert.equal(layer.getWallet(intent.wallet_id).balance_milli, 25000);
  assert.equal(layer.ledger.entriesByWallet(intent.wallet_id).filter((e) => e.idempotency_key === 'payment:settlement:' + intent.id).length, 1);

  const events = layer.payments.listEvents(intent.id);
  assert.deepEqual(events.map((e) => e.status), ['created', 'pending', 'succeeded']);
  assert.equal(layer.payments.listCallbacks(intent.id).length, 1);
  assert.equal(layer.payments.verifyIntents().callbacks, 1);

  const redelivery = layer.payments.handleCallback('mvola', ...Object.values(signed(callback({ amount: '25000' }))));
  assert.equal(redelivery.duplicate, true);
  assert.equal(redelivery.applied, false);
  assert.equal(redelivery.outcome, 'duplicate');
  assert.equal(redelivery.callback.id, first.callback.id);
  assert.equal(layer.payments.listEvents(intent.id).length, 3);
  assert.equal(layer.getWallet(intent.wallet_id).balance_milli, 25000, 'duplicate callback never double-credits');
  assert.equal(layer.payments.verifyIntents().ok, true);

  const audit = layer.listAudit({ targetType: 'payment_intent', targetId: intent.id });
  assert.ok(audit.some((entry) => entry.action === 'payment.callback.applied'));
});

test('repeated equivalent status is recorded as no_change without touching state', async (t) => {
  const { layer } = makePaymentLayer(t);
  const intent = await makePendingIntent(layer, 'recon-key-0002');
  layer.payments.handleCallback('mvola', ...Object.values(signed(callback({ serverCorrelationId: 'ref-1' }))));

  const again = layer.payments.handleCallback(
    'mvola',
    ...Object.values(signed(callback({ serverCorrelationId: 'ref-1', event_id: 'evt-2' }))),
  );
  assert.equal(again.duplicate, false);
  assert.equal(again.outcome, 'no_change');
  assert.equal(again.applied, false);
  assert.equal(again.accepted, true);
  assert.equal(layer.payments.getIntent(intent.id).status, 'succeeded');
  assert.equal(layer.payments.listCallbacks(intent.id).length, 2);
});

test('callbacks reject amount mismatches and terminal conflicts', async (t) => {
  const { layer } = makePaymentLayer(t);
  const intent = await makePendingIntent(layer, 'recon-key-0003');

  const amount = layer.payments.handleCallback('mvola', ...Object.values(signed(callback({ amount: '999' }))));
  assert.equal(amount.outcome, 'rejected');
  assert.equal(amount.accepted, false);
  assert.equal(amount.error_code, 'E_PAYMENT_AMOUNT_MISMATCH');
  assert.equal(layer.payments.getIntent(intent.id).status, 'pending');

  const applied = layer.payments.handleCallback('mvola', ...Object.values(signed(callback({ amount: '25000' }))));
  assert.equal(applied.applied, true);
  const conflict = layer.payments.handleCallback(
    'mvola',
    ...Object.values(signed(callback({ transactionStatus: 'failed', serverCorrelationId: 'ref-1' }))),
  );
  assert.equal(conflict.outcome, 'rejected');
  assert.equal(conflict.error_code, 'E_PAYMENT_STATUS_CONFLICT');
  assert.equal(layer.payments.getIntent(intent.id).status, 'succeeded');
  assert.equal(layer.payments.listCallbacks(intent.id).length, 3);
});

test('callbacks fail closed when the provider callback secret is not configured', async (t) => {
  const credentials = { mvola: { ...CREDENTIALS.mvola, callbackSecret: undefined } };
  const { layer } = makePaymentLayer(t, { credentials });
  const intent = await makePendingIntent(layer, 'recon-key-no-secret', 25000);
  expectDataError(
    () => layer.payments.handleCallback(
      'mvola',
      callback({ serverCorrelationId: intent.provider_ref, amount: '25000' }),
      {},
    ),
    'E_PAYMENT_SIGNATURE',
  );
  assert.equal(layer.payments.getIntent(intent.id).status, 'pending');
  assert.equal(layer.getWallet(intent.wallet_id).balance_milli, 0);
  assert.equal(layer.payments.listCallbacks(intent.id).length, 0);
});

test('unmatched callbacks and bad signatures never persist or mutate state', async (t) => {
  const { layer } = makePaymentLayer(t);
  await makePendingIntent(layer, 'recon-key-0004');

  expectDataError(
    () => layer.payments.handleCallback('mvola', callback({ serverCorrelationId: 'unknown-ref' }), { 'x-content-signature': CALLBACK_SECRET }),
    'E_PAYMENT_CALLBACK_UNMATCHED',
  );
  assert.equal(layer.payments.listCallbacks(layer.payments.listIntents({ provider: 'mvola' })[0].id).length, 0);

  expectDataError(
    () => layer.payments.handleCallback('mvola', callback(), {}),
    'E_PAYMENT_SIGNATURE',
  );
  const intent = layer.payments.listIntents({ provider: 'mvola' })[0];
  assert.equal(layer.payments.getIntent(intent.id).status, 'pending');
  assert.equal(layer.payments.listCallbacks(intent.id).length, 0);
});

test('polling reconcileIntent advances pending state and records attempts', async (t) => {
  const { layer } = makePaymentLayer(t);
  const intent = await makePendingIntent(layer, 'recon-key-0005');

  const applied = await layer.payments.reconcileIntent(intent.id);
  assert.equal(applied.outcome, 'updated');
  assert.equal(applied.changed, true);
  assert.equal(applied.intent.status, 'succeeded');
  assert.equal(applied.attempt.attempt, 1);
  assert.equal(applied.attempt.status_before, 'pending');
  assert.equal(applied.attempt.status_after, 'succeeded');
  assert.equal(applied.attempt.outcome, 'updated');
  assert.equal(layer.getWallet(intent.wallet_id).balance_milli, 25000);
  assert.equal(layer.ledger.entriesByWallet(intent.wallet_id).filter((e) => e.idempotency_key === 'payment:settlement:' + intent.id).length, 1);

  const afterTerminal = await layer.payments.reconcileIntent(intent.id);
  assert.equal(afterTerminal.outcome, 'terminal');
  assert.equal(afterTerminal.changed, false);
  assert.equal(layer.payments.listReconciliations(intent.id).length, 1);
  assert.deepEqual(
    layer.payments.listReconciliations(intent.id).map((row) => row.outcome),
    ['updated'],
  );
});

test('polling reports no_change while the provider still sees a pending payment', async (t) => {
  const transport = makeTransport({ pollStatus: 'pending', staticRef: 'ref-pending' });
  const { layer } = makePaymentLayer(t, { transport });
  const intent = await makePendingIntent(layer, 'recon-key-0006');

  const result = await layer.payments.reconcileIntent(intent.id);
  assert.equal(result.outcome, 'no_change');
  assert.equal(result.changed, false);
  assert.equal(layer.payments.getIntent(intent.id).status, 'pending');
  assert.equal(layer.payments.listReconciliations(intent.id)[0].outcome, 'no_change');
});

test('reconcilePending sweeps pending intents, isolates errors and applies expiry', async (t) => {
  const transport = makeTransport({ failRef: 'ref-2' });
  const { layer } = makePaymentLayer(t, { transport });
  const first = await makePendingIntent(layer, 'recon-key-0007');
  const second = await makePendingIntent(layer, 'recon-key-0008');

  const sweep = await layer.payments.reconcilePending({ provider: 'mvola' });
  assert.equal(sweep.scanned, 2);
  assert.equal(sweep.updated, 1);
  assert.equal(sweep.errors, 1);
  assert.equal(layer.payments.getIntent(first.id).status, 'succeeded');
  assert.equal(layer.payments.getIntent(second.id).status, 'pending');
  const errorRow = layer.payments.listReconciliations(second.id)[0];
  assert.equal(errorRow.outcome, 'error');
  assert.equal(errorRow.error, 'E_PAYMENT_TRANSPORT');

  layer.db
    .prepare('UPDATE payment_intents SET updated_at = ? WHERE id = ?')
    .run(new Date(Date.now() - 60000).toISOString(), second.id);
  const expiry = await layer.payments.reconcilePending({ provider: 'mvola', expire_after_ms: 1000 });
  assert.equal(expiry.scanned, 1);
  assert.equal(expiry.updated, 1);
  assert.equal(expiry.results[0].outcome, 'expired');
  assert.equal(layer.payments.getIntent(second.id).status, 'expired');
  assert.equal(layer.payments.verifyIntents().ok, true);
});

test('callback and reconciliation records never persist secret material', async (t) => {
  const { layer } = makePaymentLayer(t);
  const intent = await makePendingIntent(layer, 'recon-key-0009');

  layer.payments.handleCallback(
    'mvola',
    callback({ amount: '25000', token: 'provider-raw-token-canary', apiSecret: 'provider-raw-secret-canary' }),
    { 'x-content-signature': CALLBACK_SECRET },
  );
  for (const record of layer.payments.listCallbacks(intent.id)) {
    assert.equal(record.payload_json.includes('canary'), false);
    assert.equal(containsSecretLike(JSON.parse(record.payload_json)), false);
  }
});

test('callback hash chain is tamper evident', async (t) => {
  const { layer } = makePaymentLayer(t);
  const intent = await makePendingIntent(layer, 'recon-key-0010');
  layer.payments.handleCallback('mvola', ...Object.values(signed(callback({ amount: '25000' }))));
  assert.equal(layer.payments.verifyIntents().ok, true);

  layer.db.prepare('UPDATE payment_callbacks SET hash = ? WHERE intent_id = ?').run('f'.repeat(64), intent.id);
  assert.throws(() => layer.payments.verifyIntents(), (err) => err.code === 'E_PAYMENT_CHAIN');
});
