'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const {
  CANONICAL_STATUSES,
  normalizeStatus,
  buildProviderRegistry,
  createMvolaProvider,
  createAirtelProvider,
  createOrangeProvider,
  createBinanceProvider,
  createNowPaymentsProvider,
} = require('../core/payments');
const { makeDataLayer, expectDataError } = require('./helpers');

const CREDENTIALS = {
  mvola: {
    consumerKey: 'test-consumer-key',
    consumerSecret: 'test-consumer-secret',
    merchantNumber: '0340000000',
    partnerName: 'ACEP',
    baseUrl: 'https://mvola.test',
  },
  airtel: {
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    country: 'MG',
    currency: 'MGA',
    baseUrl: 'https://airtel.test',
  },
  orange: {
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    merchantKey: 'test-merchant-key',
    baseUrl: 'https://orange.test',
  },
  binance: {
    apiKey: 'test-api-key',
    apiSecret: 'test-api-secret',
    baseUrl: 'https://binance.test',
  },
  nowpayments: {
    apiKey: 'test-now-api-key',
    callbackSecret: 'test-now-ipn-secret',
    payCurrency: 'usdttrc20',
    baseUrl: 'https://nowpayments.test',
  },
};

function ok(data, status = 200) {
  return { status, ok: true, headers: {}, data };
}

function makeFakeTransport(overrides = {}) {
  const calls = [];
  const transport = async (spec) => {
    calls.push(spec);
    if (overrides.respond) {
      const custom = overrides.respond(spec);
      if (custom) return custom;
    }
    if (/\/token$|oauth2\/token|oauth\/v3\/token/.test(spec.url)) {
      return ok({ access_token: 'test-access-token', expires_in: 3600 });
    }
    if (spec.url.includes('merchantpay')) {
      return ok({ status: 'success', serverCorrelationId: 'mvola-ref-1' });
    }
    if (spec.url.includes('/merchant/v1/payments/')) {
      return ok({ status: { result_code: 'TS' }, data: { transaction: { id: 'airtel-ref-1', status: 'TS' } } });
    }
    if (spec.url.includes('webpayment')) {
      return ok({ status: 'success', pay_token: 'orange-pay-token', payment_url: 'https://pay.orange.test/checkout' }, 201);
    }
    if (spec.url.includes('/sapi/v1/pay/transactions')) {
      return ok({ code: '000000', data: { prepayId: 'binance-ref-1', status: 'PAID', checkoutUrl: 'https://pay.binance.test/checkout' } });
    }
    if (spec.url.includes('nowpayments.test/v1/payment/') || spec.url.endsWith('nowpayments.test/v1/payment')) {
      return ok({
        payment_id: 991,
        payment_status: 'finished',
        price_amount: 25.5,
        price_currency: 'USD',
        pay_amount: 25.5,
        pay_currency: 'USDTTRC20',
        pay_address: 'T' + '9'.repeat(33),
      });
    }
    return { status: 404, ok: false, headers: {}, data: { message: 'unmatched transport route' } };
  };
  transport.calls = calls;
  return transport;
}

function makePaymentLayer(t, options = {}) {
  const ctx = makeDataLayer(t);
  const transport = options.transport || makeFakeTransport(options.overrides || {});
  const layer = ctx.layer;
  layer.payments = require('../core/payments').buildPaymentGateway({
    db: layer.db,
    repos: layer,
    credentials: options.credentials || CREDENTIALS,
    env: {},
    transport,
    callbackUrl: 'https://acep.test/payments/callback',
  });
  return { layer, transport, dir: ctx.dir };
}

function makeWallet(layer, name = 'payer') {
  const user = layer.createUser({ username: name, phone: '+261340000123', email: name + '@example.mg' });
  const wallet = layer.createWallet(user.id);
  return { user, wallet };
}

test('all payment providers are registered behind one uniform interface', () => {
  const registry = buildProviderRegistry();
  assert.deepEqual([...registry.keys()].sort(), ['airtel', 'binance', 'mvola', 'nowpayments', 'orange']);
  for (const provider of registry.values()) {
    assert.equal(typeof provider.name, 'string');
    assert.equal(typeof provider.displayName, 'string');
    assert.equal(typeof provider.createPayment, 'function');
    assert.equal(typeof provider.getPayment, 'function');
    assert.equal(typeof provider.parseCallback, 'function');
    assert.ok(Array.isArray(provider.directions));
    assert.ok(provider.credentialSpec.length > 0);
    assert.ok(provider.credentialSpec.every((spec) => typeof spec.key === 'string' && typeof spec.env === 'string'));
    assert.ok(provider.limits.min_milli >= 1);
    assert.ok(provider.limits.max_milli >= provider.limits.min_milli);
    assert.ok(CANONICAL_STATUSES.includes(normalizeStatus('pending', provider.statusMap)));
  }
  assert.deepEqual(
    [createMvolaProvider(), createAirtelProvider(), createOrangeProvider(), createBinanceProvider(), createNowPaymentsProvider()].map((p) => p.name),
    ['mvola', 'airtel', 'orange', 'binance', 'nowpayments'],
  );
});

test('provider status maps normalize vendor-specific codes', () => {
  const airtel = createAirtelProvider();
  assert.equal(normalizeStatus('TS', airtel.statusMap), 'succeeded');
  assert.equal(normalizeStatus('TF', airtel.statusMap), 'failed');
  assert.equal(normalizeStatus('TIP', airtel.statusMap), 'pending');
  const binance = createBinanceProvider();
  assert.equal(normalizeStatus('PAID', binance.statusMap), 'succeeded');
  assert.equal(normalizeStatus('EXPIRED', binance.statusMap), 'expired');
  const mvola = createMvolaProvider();
  assert.equal(normalizeStatus('success', mvola.statusMap), 'succeeded');
  const orange = createOrangeProvider();
  assert.equal(normalizeStatus('initiated', orange.statusMap), 'pending');
  const nowpayments = createNowPaymentsProvider();
  assert.equal(normalizeStatus('waiting', nowpayments.statusMap), 'pending');
  assert.equal(normalizeStatus('finished', nowpayments.statusMap), 'succeeded');
  assert.equal(normalizeStatus('expired', nowpayments.statusMap), 'expired');
  assert.equal(normalizeStatus(null, mvola.statusMap), 'pending');
});

test('gateway lists provider capabilities without leaking credentials', (t) => {
  const { layer } = makePaymentLayer(t);
  const providers = layer.payments.listProviders();
  assert.equal(providers.length, 5);
  for (const provider of providers) {
    assert.equal(provider.configured, true, provider.name + ' should be configured');
    assert.deepEqual(provider.missing_credentials, []);
    assert.ok(provider.capabilities.callback);
  }
  const serialized = JSON.stringify(providers);
  assert.ok(!serialized.includes('test-api-secret'));
  assert.ok(!serialized.includes('test-consumer-secret'));
});

test('unconfigured and unknown providers are rejected before any transport call', async (t) => {
  const { layer, transport } = makePaymentLayer(t, { credentials: {} });
  await assert.rejects(
    () => layer.payments.initiatePayment({ provider: 'mvola', amount_milli: 5000, idempotency_key: 'unconf-0001' }),
    (err) => err.code === 'E_PROVIDER_UNCONFIGURED' && err.message.includes('MVOLA_CONSUMER_KEY'),
  );
  await assert.rejects(
    () => layer.payments.initiatePayment({ provider: 'paypal', amount_milli: 5000, idempotency_key: 'unknown-0001' }),
    (err) => err.code === 'E_PROVIDER_UNKNOWN',
  );
  assert.equal(transport.calls.length, 0);
});

test('disabled providers are rejected even when credentials exist', async (t) => {
  const { layer } = makePaymentLayer(t);
  layer.db
    .prepare('INSERT INTO payment_provider_config (provider, status, config_json, updated_at) VALUES (?,?,?,?)')
    .run('mvola', 'disabled', '{}', new Date().toISOString());
  await assert.rejects(
    () => layer.payments.initiatePayment({ provider: 'mvola', amount_milli: 5000, idempotency_key: 'disabled-0001' }),
    (err) => err.code === 'E_PROVIDER_DISABLED',
  );
});

test('initiates a payment through the unified gateway and persists an auditable intent', async (t) => {
  const { layer } = makePaymentLayer(t);
  const { wallet } = makeWallet(layer);
  const result = await layer.payments.initiatePayment({
    provider: 'mvola',
    amount_milli: 25000,
    wallet_id: wallet.id,
    customer: { msisdn: '0340000001' },
    idempotency_key: 'mvola-key-0001',
  });
  assert.equal(result.idempotent, false);
  assert.equal(result.provider, 'mvola');
  assert.equal(result.intent.status, 'succeeded');
  assert.equal(result.intent.provider_ref, 'mvola-ref-1');
  assert.equal(result.intent.wallet_id, wallet.id);
  assert.equal(result.intent.amount_milli, 25000);
  assert.equal(result.intent.currency, 'MGA');

  const events = layer.payments.listEvents(result.intent.id);
  assert.deepEqual(events.map((e) => e.event_type), ['intent.created', 'status.changed']);
  assert.deepEqual(events.map((e) => e.status), ['created', 'succeeded']);
  assert.equal(layer.payments.verifyIntents().ok, true);
  assert.equal(layer.payments.listIntents({ wallet_id: wallet.id }).length, 1);

  const audit = layer.listAudit({ targetType: 'payment_intent', targetId: result.intent.id });
  assert.ok(audit.some((entry) => entry.action === 'payment.intent.created'));
  assert.ok(audit.some((entry) => entry.action === 'payment.intent.succeeded'));
});

test('every provider adapter satisfies the same gateway contract', async (t) => {
  const cases = [
    { provider: 'mvola', amount_milli: 25000, currency: 'MGA', ref: 'mvola-ref-1' },
    { provider: 'airtel', amount_milli: 25000, currency: 'MGA', ref: 'airtel-ref-1' },
    { provider: 'orange', amount_milli: 25000, currency: 'MGA', ref: 'orange-pay-token' },
    { provider: 'binance', amount_milli: 50000, currency: 'USDT', ref: 'binance-ref-1' },
    { provider: 'nowpayments', amount_milli: 25500, currency: 'USD', ref: '991' },
  ];
  for (const scenario of cases) {
    const { layer } = makePaymentLayer(t);
    const { wallet } = makeWallet(layer, 'payer_' + scenario.provider);
    const result = await layer.payments.initiatePayment({
      provider: scenario.provider,
      amount_milli: scenario.amount_milli,
      currency: scenario.currency,
      wallet_id: ['binance', 'nowpayments'].includes(scenario.provider) ? undefined : wallet.id,
      customer: ['binance', 'nowpayments'].includes(scenario.provider) ? undefined : { msisdn: '0340000002' },
      idempotency_key: scenario.provider + '-key-0001',
    });
    assert.equal(result.intent.status, 'succeeded', scenario.provider);
    assert.equal(result.intent.provider_ref, scenario.ref, scenario.provider);
    assert.equal(result.intent.currency, scenario.currency, scenario.provider);
    assert.equal(layer.payments.verifyIntents().ok, true, scenario.provider);
  }
});

test('idempotent replay returns the stored intent and calls the provider once', async (t) => {
  const { layer, transport } = makePaymentLayer(t);
  const { wallet } = makeWallet(layer);
  const request = {
    provider: 'mvola',
    amount_milli: 25000,
    wallet_id: wallet.id,
    customer: { msisdn: '0340000003' },
    idempotency_key: 'idem-key-0001',
  };
  const first = await layer.payments.initiatePayment(request);
  const callsAfterFirst = transport.calls.length;
  const second = await layer.payments.initiatePayment(request);
  assert.equal(second.idempotent, true);
  assert.equal(second.intent.id, first.intent.id);
  assert.equal(transport.calls.length, callsAfterFirst);
  assert.equal(layer.payments.listIntents({ provider: 'mvola' }).length, 1);
});

test('gateway enforces provider limits, currency and wallet state', async (t) => {
  const { layer } = makePaymentLayer(t);
  const { wallet } = makeWallet(layer);
  await assert.rejects(
    () => layer.payments.initiatePayment({ provider: 'mvola', amount_milli: 500, wallet_id: wallet.id, idempotency_key: 'limit-key-0001' }),
    (err) => err.code === 'E_PAYMENT_LIMIT',
  );
  await assert.rejects(
    () => layer.payments.initiatePayment({ provider: 'binance', amount_milli: 5000, currency: 'MGA', idempotency_key: 'cur-key-0001' }),
    (err) => err.code === 'E_PAYMENT_CURRENCY',
  );
  await assert.rejects(
    () => layer.payments.initiatePayment({ provider: 'mvola', amount_milli: 5000, idempotency_key: '' }),
    (err) => err.code === 'E_ARG',
  );
  layer.setWalletStatus(wallet.id, 'locked');
  await assert.rejects(
    () => layer.payments.initiatePayment({ provider: 'mvola', amount_milli: 5000, wallet_id: wallet.id, idempotency_key: 'wallet-key-0001' }),
    (err) => err.code === 'E_WALLET_INACTIVE',
  );
  await assert.rejects(
    () => layer.payments.initiatePayment({ provider: 'mvola', amount_milli: 5000, wallet_id: 'missing-wallet', idempotency_key: 'wallet-key-0002' }),
    (err) => err.code === 'E_NO_WALLET',
  );
});

test('payment state machine rejects invalid and terminal transitions', async (t) => {
  const pendingTransport = makeFakeTransport({
    respond(spec) {
      if (spec.url.includes('merchantpay')) {
        return ok({ status: 'pending', serverCorrelationId: 'mvola-pending-1' });
      }
      return null;
    },
  });
  const { layer } = makePaymentLayer(t, { transport: pendingTransport });
  const { wallet } = makeWallet(layer);
  const created = await layer.payments.initiatePayment({
    provider: 'mvola',
    amount_milli: 25000,
    wallet_id: wallet.id,
    customer: { msisdn: '0340000004' },
    idempotency_key: 'state-key-0001',
  });
  assert.equal(created.intent.status, 'pending');
  const failed = layer.payments.applyProviderStatus(created.intent.id, 'failed', { reason: 'declined' }, 'mvola-pending-1');
  assert.equal(failed.status, 'failed');
  expectDataError(() => layer.payments.applyProviderStatus(created.intent.id, 'succeeded', {}), 'E_PAYMENT_STATUS');
  expectDataError(() => layer.payments.applyProviderStatus(created.intent.id, 'bogus', {}), 'E_PAYMENT_STATUS');
});

test('adapter transport errors fail the intent safely', async (t) => {
  const failingTransport = makeFakeTransport({
    respond(spec) {
      if (spec.url.includes('merchantpay')) return { status: 500, ok: false, headers: {}, data: { message: 'provider down' } };
      return null;
    },
  });
  const { layer } = makePaymentLayer(t, { transport: failingTransport });
  const { wallet } = makeWallet(layer);
  await assert.rejects(
    () =>
      layer.payments.initiatePayment({
        provider: 'mvola',
        amount_milli: 25000,
        wallet_id: wallet.id,
        customer: { msisdn: '0340000005' },
        idempotency_key: 'fail-key-0001',
      }),
    (err) => err.code === 'E_PAYMENT_TRANSPORT',
  );
  const intents = layer.payments.listIntents({ provider: 'mvola' });
  assert.equal(intents.length, 1);
  assert.equal(intents[0].status, 'failed');
  assert.equal(layer.payments.verifyIntents().ok, true);
});

test('callback parsing normalizes payloads and enforces signatures', (t) => {
  const { layer } = makePaymentLayer(t, {
    credentials: {
      ...CREDENTIALS,
      mvola: { ...CREDENTIALS.mvola, callbackSecret: 'callback-secret-value' },
    },
  });
  const parsed = layer.payments.parseCallback(
    'mvola',
    { transactionStatus: 'success', serverCorrelationId: 'cb-ref-1', amount: '25000' },
    { 'x-content-signature': 'callback-secret-value' },
  );
  assert.equal(parsed.status, 'succeeded');
  assert.equal(parsed.provider_ref, 'cb-ref-1');
  assert.equal(parsed.amount_milli, 25000);
  expectDataError(
    () => layer.payments.parseCallback('mvola', { transactionStatus: 'success' }, {}),
    'E_PAYMENT_SIGNATURE',
  );
  const signed = layer.payments.parseCallback(
    'mvola',
    { transactionStatus: 'failed', serverCorrelationId: 'cb-ref-2' },
    { 'x-content-signature': 'callback-secret-value' },
  );
  assert.equal(signed.status, 'failed');
});

test('payment event chain is hash-linked and tamper evident', async (t) => {
  const { layer } = makePaymentLayer(t);
  const { wallet } = makeWallet(layer);
  const result = await layer.payments.initiatePayment({
    provider: 'orange',
    amount_milli: 25000,
    wallet_id: wallet.id,
    idempotency_key: 'chain-key-0001',
  });
  assert.equal(layer.payments.verifyIntents().ok, true);
  layer.db
    .prepare('UPDATE payment_events SET hash = ? WHERE intent_id = ? AND event_index = 1')
    .run('f'.repeat(64), result.intent.id);
  assert.throws(() => layer.payments.verifyIntents(), (err) => err.code === 'E_PAYMENT_CHAIN');
});
test('nowpayments uses crypto checkout without ever crediting the MGA wallet', async (t) => {
  const { layer, transport } = makePaymentLayer(t);
  const user = layer.createUser({ username: 'payer_now', phone: '+261340000130', email: 'payer_now@example.mg' });
  const wallet = layer.createWallet(user.id);

  await assert.rejects(
    () => layer.payments.initiatePayment({
      provider: 'nowpayments',
      amount_milli: 25500,
      currency: 'USD',
      wallet_id: wallet.id,
      idempotency_key: 'now-wallet-0001',
    }),
    (err) => err.code === 'E_PAYMENT_CURRENCY',
  );
  assert.equal(transport.calls.length, 0);

  const result = await layer.payments.initiatePayment({
    provider: 'nowpayments',
    amount_milli: 25500,
    currency: 'USD',
    user_id: user.id,
    idempotency_key: 'now-pay-0001',
    description: 'USDT TRC20 wallet top-up',
  });
  assert.equal(result.intent.status, 'succeeded');
  assert.equal(result.intent.wallet_id, null);
  assert.equal(result.intent.currency, 'USD');
  assert.equal(result.intent.provider_ref, '991');
  assert.equal(layer.getWallet(wallet.id).balance_milli, 0);
  assert.equal(layer.payments.verifyIntents().ok, true);
});
