'use strict';
// P18 — payment provider adapters (core/payments/providers/*).
//
// The gateway tests drive createPayment through the unified API; these tests
// exercise the adapter surface directly so every vendor mapping is pinned:
// token acquisition, polling (getPayment) envelopes, status-code tables and
// callback parsing/normalization with signature enforcement. No test performs
// a network call: every adapter receives an injected transport double, and the
// ambient environment is never read directly.
const { test } = require('node:test');
const assert = require('node:assert');
const {
  createMvolaProvider,
  createAirtelProvider,
  createOrangeProvider,
  createBinanceProvider,
  createNowPaymentsProvider,
  hmacSha512Hex,
} = require('../core/payments');
const { buildPaymentGateway } = require('../core/payments');
const { makeDataLayer, expectDataError } = require('./helpers');

const CALLBACK_SECRET = 'callback-secret-value';

const BASE_CREDENTIALS = {
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
    callbackSecret: 'callback-secret-value',
    callbackUrl: 'https://acep.test/payments/callback/nowpayments',
    payCurrency: 'usdttrc20',
    baseUrl: 'https://nowpayments.test',
  },
};

function ok(data, status = 200) {
  return { status, ok: true, headers: {}, data };
}

/** Transport double: the first matching [RegExp, responder] pair answers the call. */
function routeTransport(routes) {
  const calls = [];
  const transport = async (spec) => {
    calls.push(spec);
    for (const [pattern, responder] of routes) {
      if (!pattern.test(spec.url)) continue;
      const response = typeof responder === 'function' ? responder(spec) : responder;
      if (response) return response;
    }
    return { status: 404, ok: false, headers: {}, data: { message: 'unmatched route ' + spec.url } };
  };
  transport.calls = calls;
  return transport;
}

function makeCtx(name, options = {}) {
  const credentials = { ...BASE_CREDENTIALS[name], ...(options.credentials || {}) };
  if (options.accessToken) credentials.accessToken = options.accessToken;
  return {
    credentials,
    transport: options.transport,
    nowIso: () => '2026-01-01T00:00:00.000Z',
    callbackUrl: 'https://acep.test/payments/callback',
  };
}

test('airtel getPayment fetches a token, unwraps envelopes and maps status codes', async () => {
  const provider = createAirtelProvider();
  const transport = routeTransport([
    [
      /oauth2\/token/,
      (spec) => {
        assert.equal(spec.method, 'POST');
        assert.deepEqual(spec.body, {
          client_id: 'test-client-id',
          client_secret: 'test-client-secret',
          grant_type: 'client_credentials',
        });
        return ok({ access_token: 'airtel-token', expires_in: 3600 });
      },
    ],
    [
      /\/standard\/v1\/payments\//,
      (spec) => {
        assert.equal(spec.method, 'GET');
        assert.equal(spec.headers.authorization, 'Bearer airtel-token');
        assert.equal(spec.headers['x-country'], 'MG');
        assert.equal(spec.headers['x-currency'], 'MGA');
        return ok({ data: { transaction: { id: 'airtel-ref-1', status: 'TS' } } });
      },
    ],
  ]);
  const result = await provider.getPayment('ref 1/2', makeCtx('airtel', { transport }));
  assert.equal(result.status, 'succeeded');
  assert.equal(result.raw.data.transaction.id, 'airtel-ref-1');
  assert.equal(transport.calls.length, 2, 'token + poll');
  assert.ok(transport.calls[1].url.endsWith('/standard/v1/payments/ref%201%2F2'), 'reference is url encoded');
});

test('airtel getPayment reuses a prefetched token and treats empty bodies as pending', async () => {
  const provider = createAirtelProvider();
  const transport = routeTransport([
    [/\/standard\/v1\/payments\//, ok({ status: { result_code: 'TF' }, transaction: { id: 'airtel-ref-2' } })],
  ]);
  const failed = await provider.getPayment('airtel-ref-2', makeCtx('airtel', { transport, accessToken: 'prefetched' }));
  assert.equal(failed.status, 'failed');
  assert.equal(transport.calls.length, 1, 'prefetched token avoids the token route');

  const empty = routeTransport([[/\/standard\/v1\/payments\//, ok(null)]]);
  const pending = await provider.getPayment('airtel-ref-3', makeCtx('airtel', { transport: empty, accessToken: 't' }));
  assert.equal(pending.status, 'pending');
});

test('airtel rejects a token response without access_token', async () => {
  const provider = createAirtelProvider();
  const transport = routeTransport([[/oauth2\/token/, ok({ token_type: 'bearer' })]]);
  await assert.rejects(
    () => provider.getPayment('airtel-ref-4', makeCtx('airtel', { transport })),
    (err) => err.code === 'E_PAYMENT_TRANSPORT' && /\[airtel\] token response missing access_token/.test(err.message),
  );
});

test('airtel parseCallback requires the configured signature and normalizes payloads', () => {
  const provider = createAirtelProvider();
  expectDataError(() => provider.parseCallback(null, {}, { credentials: {} }), 'E_ARG');

  expectDataError(
    () => provider.parseCallback({ transaction: { id: 'cb-1', status: 'ts', amount: 25000 } }, {}, { credentials: {} }),
    'E_PAYMENT_SIGNATURE',
  );

  const ctx = { credentials: { callbackSecret: CALLBACK_SECRET } };
  expectDataError(() => provider.parseCallback({ transaction: { id: 'cb-1' } }, {}, ctx), 'E_PAYMENT_SIGNATURE');

  const signed = provider.parseCallback(
    { data: { transaction: { id: 'cb-2' } }, status: 'TF' },
    { 'x-signature': CALLBACK_SECRET },
    ctx,
  );
  assert.equal(signed.provider_ref, 'cb-2');
  assert.equal(signed.status, 'failed');
  assert.equal(signed.amount_milli, null);

  const topLevel = provider.parseCallback(
    { id: 'cb-3', status: 'TA', amount: 'not-a-number' },
    { 'X-Signature': CALLBACK_SECRET },
    ctx,
  );
  assert.equal(topLevel.provider_ref, 'cb-3');
  assert.equal(topLevel.status, 'pending');
  assert.equal(topLevel.amount_milli, null);
});

test('orange getPayment uses a form-encoded basic-auth token and maps status codes', async () => {
  const provider = createOrangeProvider();
  const transport = routeTransport([
    [
      /oauth\/v3\/token/,
      (spec) => {
        assert.equal(spec.method, 'POST');
        assert.equal(spec.encoding, 'form');
        assert.match(spec.headers.authorization, /^Basic /);
        assert.deepEqual(spec.body, { grant_type: 'client_credentials' });
        return ok({ access_token: 'orange-token' });
      },
    ],
    [
      /transactionstatus/,
      (spec) => {
        assert.equal(spec.method, 'GET');
        assert.equal(spec.headers.authorization, 'Bearer orange-token');
        return ok({ status: 'failed' });
      },
    ],
  ]);
  const result = await provider.getPayment('ORDER 42', makeCtx('orange', { transport }));
  assert.equal(result.status, 'failed');
  assert.equal(transport.calls.length, 2);
  assert.ok(transport.calls[1].url.includes('order_id=ORDER%2042'), 'reference is url encoded');

  const blank = routeTransport([[/transactionstatus/, ok(undefined)]]);
  const pending = await provider.getPayment('ORDER-43', makeCtx('orange', { transport: blank, accessToken: 't' }));
  assert.equal(pending.status, 'pending');
});

test('orange rejects a token response without access_token', async () => {
  const provider = createOrangeProvider();
  const transport = routeTransport([[/oauth\/v3\/token/, ok({})]]);
  await assert.rejects(
    () => provider.getPayment('ORDER-44', makeCtx('orange', { transport })),
    (err) => err.code === 'E_PAYMENT_TRANSPORT' && /\[orange\] token response missing access_token/.test(err.message),
  );
});

test('orange parseCallback checks the signature and normalizes callback payloads', () => {
  const provider = createOrangeProvider();
  const ctx = { credentials: { callbackSecret: CALLBACK_SECRET } };
  expectDataError(() => provider.parseCallback('not-an-object', {}, ctx), 'E_ARG');
  expectDataError(
    () => provider.parseCallback({ order_id: 'O-1' }, { 'x-orange-signature': 'wrong' }, ctx),
    'E_PAYMENT_SIGNATURE',
  );

  const signed = provider.parseCallback(
    { txnid: 'orange-cb-1', status: 'success', amount: 25000 },
    { 'x-orange-signature': CALLBACK_SECRET },
    ctx,
  );
  assert.equal(signed.provider_ref, 'orange-cb-1');
  assert.equal(signed.status, 'succeeded');
  assert.equal(signed.amount_milli, 25000);
  assert.equal(signed.currency, 'MGA');

  const fallbacks = provider.parseCallback(
    { order_id: 'ORDER-9', status: 'expired', amount: 'n/a' },
    { 'X-Orange-Signature': CALLBACK_SECRET },
    ctx,
  );
  assert.equal(fallbacks.provider_ref, 'ORDER-9');
  assert.equal(fallbacks.status, 'expired');
  assert.equal(fallbacks.amount_milli, null);

  const notif = provider.parseCallback(
    { notif_token: 'notif-1', status: 'initiated' },
    { 'x-orange-signature': CALLBACK_SECRET },
    ctx,
  );
  assert.equal(notif.provider_ref, 'notif-1');
  assert.equal(notif.status, 'pending');

  expectDataError(
    () => provider.parseCallback({ order_id: 'ORDER-10', status: 'success' }, {}, { credentials: {} }),
    'E_PAYMENT_SIGNATURE',
  );
});

test('binance getPayment signs the query and maps envelope codes', async () => {
  const provider = createBinanceProvider();
  const transport = routeTransport([
    [
      /\/sapi\/v1\/pay\/transactions/,
      (spec) => {
        assert.equal(spec.method, 'GET');
        assert.equal(spec.headers['x-mbx-apikey'], 'test-api-key');
        assert.match(spec.url, /[?&]merchantTradeNo=BINANCE-1&/);
        assert.match(spec.url, /[?&]timestamp=\d+&/);
        assert.match(spec.url, /&signature=[0-9a-f]{64}$/);
        return ok({ code: '000000', data: { status: 'PAID' } });
      },
    ],
  ]);
  const paid = await provider.getPayment('BINANCE-1', makeCtx('binance', { transport }));
  assert.equal(paid.status, 'succeeded');

  // getPayment passes the vendor code straight through the table; only the
  // callback path translates the PAY_SUCCESS/PAY_FAIL aliases.
  const biz = routeTransport([[/\/sapi\/v1\/pay\/transactions/, ok({ data: { bizStatus: 'fail' } })]]);
  assert.equal((await provider.getPayment('BINANCE-2', makeCtx('binance', { transport: biz }))).status, 'failed');

  const flat = routeTransport([[/\/sapi\/v1\/pay\/transactions/, ok({ status: 'EXPIRED' })]]);
  assert.equal((await provider.getPayment('BINANCE-3', makeCtx('binance', { transport: flat }))).status, 'expired');
});

test('binance rejects a provider envelope error code before returning a status', async () => {
  const provider = createBinanceProvider();
  const transport = routeTransport([[/\/sapi\/v1\/pay\/transactions/, ok({ code: '40004', msg: 'rejected' })]]);
  await assert.rejects(
    () => provider.getPayment('BINANCE-4', makeCtx('binance', { transport })),
    (err) => err.code === 'E_PAYMENT_TRANSPORT' && err.message.includes('40004'),
  );
});

test('binance parseCallback verifies the signature and maps biz status codes', () => {
  const provider = createBinanceProvider();
  const ctx = { credentials: { callbackSecret: CALLBACK_SECRET } };
  expectDataError(() => provider.parseCallback(null, {}, ctx), 'E_ARG');
  expectDataError(
    () => provider.parseCallback({ bizStatus: 'PAY_SUCCESS' }, { 'binancepay-signature': 'bad' }, ctx),
    'E_PAYMENT_SIGNATURE',
  );

  const paid = provider.parseCallback(
    { bizStatus: 'PAY_SUCCESS', data: { prepayId: 'binance-cb-1', orderAmount: '50000' } },
    { 'BinancePay-Signature': CALLBACK_SECRET },
    ctx,
  );
  assert.equal(paid.provider_ref, 'binance-cb-1');
  assert.equal(paid.status, 'succeeded');
  assert.equal(paid.amount_milli, 50000);
  assert.equal(paid.currency, 'USDT');

  const failed = provider.parseCallback(
    { data: { merchantTradeNo: 'MTN-1', bizStatus: 'PAY_FAIL', orderAmount: 'n/a' } },
    { 'binancepay-signature': CALLBACK_SECRET },
    ctx,
  );
  assert.equal(failed.provider_ref, 'MTN-1');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.amount_milli, null);

  const other = provider.parseCallback(
    { data: { status: 'PENDING' } },
    { 'binancepay-signature': CALLBACK_SECRET },
    ctx,
  );
  assert.equal(other.provider_ref, null);
  assert.equal(other.status, 'pending');

  expectDataError(
    () => provider.parseCallback(
      { bizStatus: 'PAY_SUCCESS', data: { prepayId: 'no-secret' } },
      {},
      { credentials: {} },
    ),
    'E_PAYMENT_SIGNATURE',
  );
});

test('mvola callback parsing fails closed without a configured signature', () => {
  const provider = createMvolaProvider();
  expectDataError(
    () => provider.parseCallback({ serverCorrelationId: 'cb-mv-1', transactionStatus: 'success', amount: '25000' }, {}, { credentials: {} }),
    'E_PAYMENT_SIGNATURE',
  );
  const signed = provider.parseCallback(
    { serverCorrelationId: 'cb-mv-1', transactionStatus: 'success', amount: '25000' },
    { 'x-content-signature': CALLBACK_SECRET },
    { credentials: { callbackSecret: CALLBACK_SECRET } },
  );
  assert.equal(signed.provider_ref, 'cb-mv-1');
  assert.equal(signed.status, 'succeeded');
  assert.equal(signed.amount_milli, 25000);
});

test('mvola getPayment polls with a correlation header and maps transaction status', async () => {
  const provider = createMvolaProvider();
  const transport = routeTransport([
    [
      /merchantpay\/1\.0\.0\/status\//,
      (spec) => {
        assert.equal(spec.method, 'GET');
        assert.equal(spec.headers['X-CorrelationID'], 'mvola-ref-7');
        assert.equal(spec.headers['Cache-Control'], 'no-cache');
        return ok({ status: 'completed', serverCorrelationId: 'mvola-ref-7' });
      },
    ],
  ]);
  const result = await provider.getPayment('mvola-ref-7', makeCtx('mvola', { transport, accessToken: 'mvola-token' }));
  assert.equal(result.status, 'succeeded');
  assert.equal(result.raw.serverCorrelationId, 'mvola-ref-7');
});

test('mvola createPayment requires a correlation id for pending provider responses', async () => {
  const provider = createMvolaProvider();
  const transport = routeTransport([[/merchantpay/, ok({ status: 'pending' })]]);
  const ctx = makeCtx('mvola', { transport, accessToken: 'mvola-token' });
  await assert.rejects(
    () =>
      provider.createPayment(
        { intent: { id: 'intent-1' }, amount_milli: 25000, customer: { msisdn: '034 000 0000' } },
        ctx,
      ),
    (err) => err.code === 'E_PAYMENT_TRANSPORT' && /\[mvola\] unexpected provider response without correlation id/.test(err.message),
  );
});

test('mobile money adapters require a customer msisdn before contacting the provider', async () => {
  const transport = routeTransport([]);
  for (const provider of [createMvolaProvider(), createAirtelProvider()]) {
    await assert.rejects(
      () =>
        provider.createPayment(
          { intent: { id: 'intent-2' }, amount_milli: 25000 },
          makeCtx(provider.name, { transport, accessToken: 't' }),
        ),
      (err) => err.code === 'E_ARG' && /msisdn\/phone is required/.test(err.message),
      provider.name,
    );
  }
  assert.equal(transport.calls.length, 0, 'no provider call without a customer');
});

test('gateway polling reconciles a non-mvola provider end to end', async (t) => {
  const ctx = makeDataLayer(t);
  const layer = ctx.layer;
  const transport = routeTransport([
    [
      /oauth2\/token/,
      (spec) => {
        assert.equal(spec.method, 'POST');
        return ok({ access_token: 'airtel-token' });
      },
    ],
    [
      /\/merchant\/v1\/payments\//,
      (spec) => {
        assert.equal(spec.method, 'POST');
        assert.equal(spec.headers.authorization, 'Bearer airtel-token');
        return ok({ data: { transaction: { id: 'airtel-ref-9', status: 'TA' } } });
      },
    ],
    [
      /\/standard\/v1\/payments\//,
      (spec) => {
        assert.equal(spec.method, 'GET');
        assert.ok(spec.url.endsWith('/standard/v1/payments/airtel-ref-9'));
        return ok({ data: { transaction: { id: 'airtel-ref-9', status: 'TF' } } });
      },
    ],
  ]);
  layer.payments = buildPaymentGateway({
    db: layer.db,
    repos: layer,
    credentials: { airtel: { ...BASE_CREDENTIALS.airtel } },
    env: {},
    transport,
    callbackUrl: 'https://acep.test/payments/callback',
  });
  const user = layer.createUser({ username: 'airtel_payer', phone: '+261340000777', email: 'airtel_payer@example.mg' });
  const wallet = layer.createWallet(user.id);

  const created = await layer.payments.initiatePayment({
    provider: 'airtel',
    amount_milli: 25000,
    currency: 'MGA',
    wallet_id: wallet.id,
    customer: { msisdn: '0340000009' },
    idempotency_key: 'airtel-recon-0001',
  });
  assert.equal(created.intent.status, 'pending');
  assert.equal(created.intent.provider_ref, 'airtel-ref-9');

  const outcome = await layer.payments.reconcileIntent(created.intent.id);
  assert.equal(outcome.outcome, 'updated');
  assert.equal(outcome.changed, true);
  assert.equal(outcome.intent.status, 'failed');
  assert.equal(outcome.attempt.provider_ref, 'airtel-ref-9');
  assert.equal(layer.payments.verifyIntents().ok, true);
});
test('nowpayments creates payments, polls status and verifies IPN signatures', async () => {
  const provider = createNowPaymentsProvider();
  const transport = routeTransport([
    [/\/v1\/payment$/, (spec) => {
      assert.equal(spec.method, 'POST');
      assert.equal(spec.headers['x-api-key'], 'test-now-api-key');
      assert.equal(spec.body.price_amount, 25.5);
      assert.equal(spec.body.price_currency, 'usd');
      assert.equal(spec.body.pay_currency, 'usdttrc20');
      return ok({
        payment_id: 991,
        payment_status: 'waiting',
        price_amount: 25.5,
        price_currency: 'USD',
        pay_amount: 25.5,
        pay_currency: 'USDTTRC20',
        pay_address: 'T' + '9'.repeat(33),
      });
    }],
    [/\/v1\/payment\/991$/, (spec) => {
      assert.equal(spec.method, 'GET');
      assert.equal(spec.headers['x-api-key'], 'test-now-api-key');
      return ok({
        payment_id: 991,
        payment_status: 'finished',
        price_amount: '25.500',
        price_currency: 'USD',
      });
    }],
  ]);
  const ctx = makeCtx('nowpayments', { transport });
  const created = await provider.createPayment({
    reference: 'NP-1',
    amount_milli: 25500,
    description: 'ACEP crypto test',
    intent: { id: 'intent-np-1' },
  }, ctx);
  assert.equal(created.provider_ref, '991');
  assert.equal(created.status, 'pending');
  assert.equal(transport.calls[0].body.ipn_callback_url, 'https://acep.test/payments/callback/nowpayments');
  assert.equal(created.raw.pay_address, 'T' + '9'.repeat(33));

  const paid = await provider.getPayment('991', ctx);
  assert.equal(paid.status, 'succeeded');
  assert.equal(paid.amount_milli, 25500);
  assert.equal(paid.currency, 'USD');

  const payload = {
    payment_id: 991,
    order_id: 'NP-1',
    payment_status: 'finished',
    price_amount: '25.500',
    price_currency: 'USD',
    pay_amount: '25.500',
    pay_currency: 'USDTTRC20',
  };
  const signature = hmacSha512Hex(CALLBACK_SECRET, JSON.stringify({
    order_id: 'NP-1',
    pay_amount: '25.500',
    pay_currency: 'USDTTRC20',
    payment_id: 991,
    payment_status: 'finished',
    price_amount: '25.500',
    price_currency: 'USD',
  }));
  const parsed = provider.parseCallback(
    payload,
    { 'x-nowpayments-sig': signature },
    { credentials: { callbackSecret: CALLBACK_SECRET } },
  );
  assert.equal(parsed.provider_ref, '991');
  assert.equal(parsed.status, 'succeeded');
  assert.equal(parsed.amount_milli, 25500);
  assert.equal(parsed.currency, 'USD');

  expectDataError(
    () => provider.parseCallback(payload, { 'x-nowpayments-sig': 'bad' }, { credentials: { callbackSecret: CALLBACK_SECRET } }),
    'E_PAYMENT_SIGNATURE',
  );
});
