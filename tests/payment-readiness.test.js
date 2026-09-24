'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { buildProviderRegistry, evaluatePaymentsReadiness, safeBaseUrl } = require('../core/payments');

const COMPLETE = {
  mvola: { consumerKey: 'ck', consumerSecret: 'cs', merchantNumber: '0340000000', partnerName: 'ACEP', callbackSecret: 'mv-cb', baseUrl: 'https://api.mvola.example/' },
  airtel: { clientId: 'id', clientSecret: 'cs', country: 'MG', currency: 'MGA', callbackSecret: 'air-cb', baseUrl: 'https://openapi.airtel.example/' },
  orange: { clientId: 'id', clientSecret: 'cs', merchantKey: 'mk', callbackSecret: 'or-cb', baseUrl: 'https://api.orange.example/' },
  binance: { apiKey: 'ak', apiSecret: 'as', callbackSecret: 'bi-cb', baseUrl: 'https://api.binance.example/' },
  nowpayments: { apiKey: 'np-ak', callbackSecret: 'np-ipn', baseUrl: 'https://api.nowpayments.example/' },
};

test('production-safe HTTPS URL rejects sandbox/dev/test endpoints', () => {
  assert.equal(safeBaseUrl('https://api.example/payments').ok, true);
  assert.equal(safeBaseUrl('http://api.example/payments').reason, 'base_url_not_https');
  assert.equal(safeBaseUrl('https://pre-api.mvola.example/payments').reason, 'sandbox_or_dev_host');
  assert.equal(safeBaseUrl('https://api.example/dev/v1/payments').reason, 'sandbox_or_dev_path');
  assert.equal(safeBaseUrl('not-a-url').reason, 'base_url_invalid');
});

test('all providers are not production-ready when callback secrets or required credentials are absent', () => {
  const result = evaluatePaymentsReadiness(buildProviderRegistry(), {
    credentials: {},
    env: {},
    production: true,
  });
  assert.equal(result.ready, false);
  assert.equal(result.providers.length, 6);
  for (const row of result.providers) {
    if (row.name === 'nowpayments-sandbox') {
      assert.equal(row.ready, true);
      assert.ok(row.reasons.includes('sandbox_provider_excluded_from_production_gate'));
      continue;
    }
    assert.equal(row.callback_secret, 'ABSENT');
    assert.ok(row.reasons.includes('required_credentials_absent'));
    assert.ok(row.reasons.includes('callback_secret_absent'));
    assert.notEqual(JSON.stringify(row), JSON.stringify(COMPLETE));
  }
});

test('complete provider credentials and production-safe URLs clear readiness without contacting vendors', () => {
  const result = evaluatePaymentsReadiness(buildProviderRegistry(), {
    credentials: COMPLETE,
    env: {},
    production: true,
  });
  assert.equal(result.ready, true);
  for (const row of result.providers) {
    assert.equal(row.ready, true, row.name);
    assert.deepEqual(row.missing_credentials, []);
    if (row.name === 'nowpayments-sandbox') {
      assert.equal(row.callback_secret, 'N/A_SANDBOX');
    } else {
      assert.equal(row.callback_secret, 'SET');
    }
    assert.equal(row.callback, 'SUPPORTED');
    assert.equal(row.polling, 'SUPPORTED');
    if (row.name === 'nowpayments-sandbox') assert.deepEqual(row.reasons, ['sandbox_provider_excluded_from_production_gate']);
    else assert.equal(row.reasons.length, 0);
  }
});

test('a sandbox endpoint blocks an otherwise complete provider from production readiness', () => {
  const credentials = { ...COMPLETE, mvola: { ...COMPLETE.mvola, baseUrl: 'https://pre-api.mvola.example/' } };
  const result = evaluatePaymentsReadiness(buildProviderRegistry(), { credentials, production: true });
  const mvola = result.providers.find((row) => row.name === 'mvola');
  assert.equal(result.ready, false);
  assert.equal(mvola.ready, false);
  assert.ok(mvola.reasons.includes('sandbox_or_dev_host'));
});
