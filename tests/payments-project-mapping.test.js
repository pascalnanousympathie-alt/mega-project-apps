'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { buildPaymentGateway, MVOLA_PROJECTS, mvolaProjectEnv, resolveMvolaProjectCredentials } = require('../core/payments');
const { makeDataLayer } = require('./helpers');

const SHARED = {
  MVOLA_MERCHANT_NUMBER: '0340000000',
  MVOLA_PARTNER_NAME: 'ACEP',
  MVOLA_BASE_URL: 'https://api.mvola.example',
};
const APP_ENV = {
  ...SHARED,
  DOMINOMADA_MVOLA_CONSUMER_KEY: 'domino-consumer',
  DOMINOMADA_MVOLA_CONSUMER_SECRET: 'domino-secret',
  DOMINOMADA_MVOLA_API_KEY: 'domino-api-key',
  LOTOMADA_MVOLA_CONSUMER_KEY: 'loto-consumer',
  LOTOMADA_MVOLA_CONSUMER_SECRET: 'loto-secret',
  LOTOMADA_MVOLA_API_KEY: 'loto-api-key',
  RAMIMADA_MVOLA_CONSUMER_KEY: 'rami-consumer',
  RAMIMADA_MVOLA_CONSUMER_SECRET: 'rami-secret',
  RAMIMADA_MVOLA_API_KEY: 'rami-api-key',
};

function ok(data) {
  return { status: 200, ok: true, headers: {}, data };
}

function basicPair(header) {
  return Buffer.from(String(header).replace(/^Basic\s+/i, ''), 'base64').toString('utf8');
}

test('MVola project map resolves the three app credential sets without exposing values', () => {
  assert.deepEqual(Object.keys(MVOLA_PROJECTS), ['domino', 'loto', 'rami']);
  assert.equal(mvolaProjectEnv('domino', 'consumerKey'), 'DOMINOMADA_MVOLA_CONSUMER_KEY');
  assert.equal(mvolaProjectEnv('loto', 'consumerSecret'), 'LOTOMADA_MVOLA_CONSUMER_SECRET');
  assert.equal(mvolaProjectEnv('rami', 'apiKey'), 'RAMIMADA_MVOLA_API_KEY');
  assert.equal(mvolaProjectEnv('unknown', 'apiKey'), null);

  const resolved = resolveMvolaProjectCredentials('domino', APP_ENV);
  assert.deepEqual(Object.keys(resolved).sort(), ['apiKey', 'consumerKey', 'consumerSecret', 'project'].sort());
  assert.equal(resolved.project, 'domino');
  assert.equal(resolved.consumerKey, 'domino-consumer');
  assert.equal(resolved.consumerSecret, 'domino-secret');
  assert.equal(resolved.apiKey, 'domino-api-key');
});

test('MVola gateway selects Domino, Loto and Rami credentials independently and persists project for polling', async (t) => {
  const { layer } = makeDataLayer(t);
  const calls = [];
  const transport = async (spec) => {
    calls.push(spec);
    if (/\/token$/.test(spec.url)) return ok({ access_token: 'shared-test-token' });
    if (/merchantpay\/1\.0\.0\/$/.test(spec.url)) {
      return ok({ status: 'pending', serverCorrelationId: 'ref-' + spec.headers['x-correlation-id'] });
    }
    if (/\/status\//.test(spec.url)) {
      return ok({ transactionStatus: 'success', serverCorrelationId: decodeURIComponent(spec.url.split('/status/')[1]) });
    }
    return { status: 404, ok: false, headers: {}, data: { message: 'unmatched test route' } };
  };

  const payments = buildPaymentGateway({
    db: layer.db,
    repos: layer,
    env: APP_ENV,
    transport,
  });

  const expectedPairs = {
    domino: 'domino-consumer:domino-secret',
    loto: 'loto-consumer:loto-secret',
    rami: 'rami-consumer:rami-secret',
  };

  for (const project of ['domino', 'loto', 'rami']) {
    const user = layer.createUser({ username: project + '_payer', phone: '+261340000010', email: project + '@example.mg' });
    const wallet = layer.createWallet(user.id);
    const result = await payments.initiatePayment({
      provider: 'mvola',
      project,
      amount_milli: 25000,
      wallet_id: wallet.id,
      customer: { msisdn: '0340000010' },
      idempotency_key: 'map-' + project,
    });
    assert.equal(result.intent.status, 'pending');
    assert.equal(JSON.parse(result.intent.request_json).project, project);
    const beforePoll = calls[calls.length - 2];
    assert.equal(basicPair(beforePoll.headers.authorization), expectedPairs[project]);

    const reconciled = await payments.reconcileIntent(result.intent.id);
    assert.equal(reconciled.outcome, 'updated');
    assert.equal(reconciled.intent.status, 'succeeded');
    const tokenCalls = calls.filter((spec) => /\/token$/.test(spec.url));
    assert.equal(basicPair(tokenCalls[tokenCalls.length - 1].headers.authorization), expectedPairs[project]);
  }
});

test('MVola project-scoped credentials fail closed when project is omitted', async (t) => {
  const { layer } = makeDataLayer(t);
  const payments = buildPaymentGateway({ db: layer.db, repos: layer, env: APP_ENV, transport: async () => ok({ access_token: 'x' }) });
  await assert.rejects(
    () => payments.initiatePayment({ provider: 'mvola', amount_milli: 25000, idempotency_key: 'map-no-project' }),
    (err) => err.code === 'E_PAYMENT_PROJECT_REQUIRED',
  );
});
