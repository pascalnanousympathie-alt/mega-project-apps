'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {
  redact,
  stripSecrets,
  redactText,
  containsSecretLike,
  maskSecret,
  hmacSha256Hex,
  buildPaymentGateway,
  buildProviderRegistry,
} = require('../core/payments');
const { makeDataLayer, expectDataError } = require('./helpers');

const PAYMENT_DIR = path.join(__dirname, '..', 'core', 'payments');

function sourceFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

function buildPayments(layer, options) {
  return buildPaymentGateway({
    db: layer.db,
    repos: layer,
    credentials: options.credentials || {},
    env: options.env || {},
    transport: options.transport,
    callbackUrl: 'https://acep.test/payments/callback',
  });
}

test('payment sources never embed provider secrets or read raw process.env', () => {
  const files = sourceFiles(PAYMENT_DIR);
  assert.ok(files.length >= 8);
  const secretAssignment = /(MVOLA_CONSUMER_SECRET|AIRTEL_CLIENT_SECRET|ORANGE_MERCHANT_KEY|BINANCE_API_SECRET|MVOLA_CONSUMER_KEY|AIRTEL_CLIENT_ID|BINANCE_API_KEY)\s*[:=]\s*['"][^'"]{4,}['"]/;
  const credentialAssignment = /(apiSecret|clientSecret|consumerSecret|merchantKey|apiKey)\s*=\s*['"][^'"]{4,}['"]/;
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    assert.equal(secretAssignment.test(source), false, 'hardcoded secret material in ' + file);
    assert.equal(credentialAssignment.test(source), false, 'hardcoded credential in ' + file);
    assert.equal(source.includes('process.env'), false, 'payment code must receive env via injection: ' + file);
  }
  const registry = buildProviderRegistry();
  for (const provider of registry.values()) {
    for (const spec of provider.credentialSpec) {
      assert.ok(spec.key.length > 0 && spec.env.length > 0);
    }
  }
});

test('redact strips secret-like keys at every depth and keeps public data', () => {
  const input = {
    order: 'ord-1',
    amount: 1000,
    apiKey: 'raw-api-key',
    nested: {
      authorization: 'Bearer token-abc',
      token: 'abc',
      merchantKey: 'mk',
      safe: 'visible',
      list: [{ clientSecret: 'cs', note: 'ok' }],
    },
  };
  const clean = redact(input);
  assert.equal(clean.order, 'ord-1');
  assert.equal(clean.amount, 1000);
  assert.equal(clean.apiKey, '[REDACTED]');
  assert.equal(clean.nested.authorization, '[REDACTED]');
  assert.equal(clean.nested.token, '[REDACTED]');
  assert.equal(clean.nested.merchantKey, '[REDACTED]');
  assert.equal(clean.nested.safe, 'visible');
  assert.equal(clean.nested.list[0].clientSecret, '[REDACTED]');
  assert.equal(clean.nested.list[0].note, 'ok');
  assert.equal(containsSecretLike(clean), true);
  assert.equal(containsSecretLike(stripSecrets(input)), false);
  assert.equal(containsSecretLike(input), true);
  const text = redactText('authorization: Bearer abc123 apiKey=zzz9');
  assert.equal(text.includes('abc123'), false);
  assert.equal(text.includes('zzz9'), false);
  assert.equal(maskSecret('abcdefgh'), '****efgh');
  assert.equal(maskSecret('abc'), '****');
  assert.equal(maskSecret(null), null);
});

test('hmac signatures are deterministic and secret dependent', () => {
  const a = hmacSha256Hex('secret-one', 'merchantTradeNo=x&orderAmount=1');
  const b = hmacSha256Hex('secret-one', 'merchantTradeNo=x&orderAmount=1');
  const c = hmacSha256Hex('secret-two', 'merchantTradeNo=x&orderAmount=1');
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, c);
});

test('credential errors name missing env vars without leaking configured secrets', async (t) => {
  const ctx = makeDataLayer(t);
  const canary = 'leak-canary-secret-value';
  const layer = ctx.layer;
  const payments = buildPayments(layer, {
    credentials: {
      mvola: { consumerKey: 'ck', consumerSecret: canary, baseUrl: 'https://mvola.test' },
    },
  });
  await assert.rejects(
    () => payments.initiatePayment({ provider: 'mvola', amount_milli: 5000, idempotency_key: 'leak-key-0001' }),
    (err) => {
      assert.equal(err.code, 'E_PROVIDER_UNCONFIGURED');
      assert.equal(err.message.includes(canary), false);
      assert.ok(err.message.includes('MVOLA_MERCHANT_NUMBER'));
      return true;
    },
  );
});

test('stored intents and events never persist secret material', async (t) => {
  const ctx = makeDataLayer(t);
  const layer = ctx.layer;
  const transport = async (spec) => {
    if (/\/token$/.test(spec.url)) {
      return { status: 200, ok: true, headers: {}, data: { access_token: 'internal-token-value' } };
    }
    return {
      status: 200,
      ok: true,
      headers: {},
      data: {
        status: 'success',
        serverCorrelationId: 'ref-1',
        apiSecret: 'provider-raw-secret-canary',
        token: 'provider-raw-token-canary',
        authorization: 'Bearer provider-raw-auth-canary',
      },
    };
  };
  const payments = buildPayments(layer, {
    credentials: {
      mvola: {
        consumerKey: 'ck',
        consumerSecret: 'configured-secret-canary',
        merchantNumber: '0340000000',
        partnerName: 'ACEP',
        baseUrl: 'https://mvola.test',
      },
    },
    transport,
  });
  const user = layer.createUser({ username: 'sec_payer', phone: '+261340000999', email: 'sec@example.mg' });
  const wallet = layer.createWallet(user.id);
  const result = await payments.initiatePayment({
    provider: 'mvola',
    amount_milli: 25000,
    wallet_id: wallet.id,
    customer: { msisdn: '0340000009' },
    idempotency_key: 'store-key-0001',
  });
  const blobs = [result.intent.request_json, result.intent.response_json];
  for (const event of payments.listEvents(result.intent.id)) blobs.push(event.payload_json);
  const combined = blobs.join('\n');
  for (const canary of [
    'configured-secret-canary',
    'provider-raw-secret-canary',
    'provider-raw-token-canary',
    'provider-raw-auth-canary',
    'internal-token-value',
  ]) {
    assert.equal(combined.includes(canary), false, 'stored secret: ' + canary);
  }
  for (const blob of blobs) assert.equal(containsSecretLike(JSON.parse(blob)), false);
});

test('rejects unsafe and non-positive payment amounts', async (t) => {
  const ctx = makeDataLayer(t);
  const layer = ctx.layer;
  const transport = async (spec) =>
    /\/token$/.test(spec.url)
      ? { status: 200, ok: true, headers: {}, data: { access_token: 't' } }
      : { status: 200, ok: true, headers: {}, data: { status: 'success', serverCorrelationId: 'ref' } };
  const payments = buildPayments(layer, {
    credentials: {
      mvola: {
        consumerKey: 'ck',
        consumerSecret: 'cs',
        merchantNumber: '0340000000',
        partnerName: 'ACEP',
        baseUrl: 'https://mvola.test',
      },
    },
    transport,
  });
  for (const amount of [0, -1, 1.5, 2 ** 53, undefined, '1000']) {
    await assert.rejects(
      () => payments.initiatePayment({ provider: 'mvola', amount_milli: amount, idempotency_key: 'amount-key-' + String(amount) }),
      (err) => err.code === 'E_PAYMENT_AMOUNT' || err.code === 'E_PAYMENT_LIMIT' || err.code === 'E_ARG',
      'amount ' + String(amount),
    );
  }
});

test('unknown provider intents never reach the transport layer', async (t) => {
  const ctx = makeDataLayer(t);
  const layer = ctx.layer;
  let calls = 0;
  const payments = buildPayments(layer, {
    credentials: {},
    transport: async () => {
      calls += 1;
      return { status: 200, ok: true, headers: {}, data: {} };
    },
  });
  await assert.rejects(
    () => payments.initiatePayment({ provider: 'unknown', amount_milli: 5000, idempotency_key: 'nk-00000001' }),
    (err) => err.code === 'E_PROVIDER_UNKNOWN',
  );
  assert.equal(calls, 0);
  expectDataError(() => payments.getIntent('does-not-exist'), 'E_PAYMENT_NOT_FOUND');
});
