'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { buildPaymentGateway, MVOLA_PROJECTS, mvolaProjectEnv, resolveMvolaProjectCredentials } = require('../core/payments');
const { makeDataLayer } = require('./helpers');

const SHARED = {
  MVOLA_MERCHANT_NUMBER: '0340000000',
  MVOLA_PARTNER_NAME: 'ACEP',
  MVOLA_PARTNER_MSISDN: '0340000000',
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

test('MVola project map resolves the three app credential sets without exposing values', () => {
  assert.deepEqual(Object.keys(MVOLA_PROJECTS), ['domino', 'loto', 'rami']);
  assert.equal(mvolaProjectEnv('domino', 'consumerKey'), 'DOMINOMADA_MVOLA_CONSUMER_KEY');
  assert.equal(mvolaProjectEnv('loto', 'consumerSecret'), 'LOTOMADA_MVOLA_CONSUMER_SECRET');
  assert.equal(mvolaProjectEnv('rami', 'apiKey'), 'RAMIMADA_MVOLA_API_KEY');
  assert.equal(mvolaProjectEnv('unknown', 'apiKey'), null);

  const resolved = resolveMvolaProjectCredentials('domino', APP_ENV);
  assert.deepEqual(Object.keys(resolved).sort(), ['apiKey', 'consumerKey', 'consumerSecret', 'merchantNumber', 'partnerName', 'project'].sort());
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
      return ok({ status: 'pending', serverCorrelationId: 'ref-' + spec.headers['X-CorrelationID'] });
    }
    if (/\/status\//.test(spec.url)) {
      const correlation = decodeURIComponent(spec.url.split('/status/')[1]);
      return ok({ transactionStatus: 'completed', serverCorrelationId: correlation, objectReference: 'tx-' + correlation });
    }
    if (/merchantpay\/1\.0\.0\/tx-/.test(spec.url)) {
      return ok({ transactionStatus: 'completed', amount: '25000', currency: 'Ar' });
    }
    return { status: 404, ok: false, headers: {}, data: { message: 'unmatched test route' } };
  };

  const payments = buildPaymentGateway({
    db: layer.db,
    repos: layer,
    env: APP_ENV,
    transport,
  });

  const expectedApiKeys = {
    domino: 'domino-api-key',
    loto: 'loto-api-key',
    rami: 'rami-api-key',
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
    const createCalls = calls.filter((spec) => spec.method === 'POST' && /merchantpay\/1\.0\.0\/$/.test(spec.url));
    const createCall = createCalls[createCalls.length - 1];
    assert.equal(createCall.headers.apikey, expectedApiKeys[project]);
    assert.equal(createCall.headers.UserAccountIdentifier, 'msisdn;0340000000');
    assert.equal(createCall.headers.partnerName, project === 'domino' ? 'DominoMada' : project === 'loto' ? 'LotoMada' : 'RamiMada');

    const reconciled = await payments.reconcileIntent(result.intent.id);
    assert.equal(reconciled.outcome, 'updated');
    assert.equal(reconciled.intent.status, 'succeeded');
    const detailCalls = calls.filter((spec) => spec.method === 'GET' && /merchantpay\/1\.0\.0\/tx-/.test(spec.url));
    const detailCall = detailCalls[detailCalls.length - 1];
    assert.ok(detailCall, 'transaction details endpoint was called');
    assert.equal(detailCall.headers.apikey, expectedApiKeys[project]);
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
