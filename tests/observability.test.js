'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDataLayer } = require('../core');
const { createObservability, readiness } = require('../core/observability');

test('observability records bounded request metrics and recent errors', () => {
  const obs = createObservability();
  obs.recordRequest({ route: 'health.get', method: 'GET', status: 200, durationMs: 4 });
  obs.recordRequest({ route: 'metrics.get', method: 'GET', status: 401, durationMs: 2 });
  obs.recordError({ route: 'metrics.get', method: 'GET', status: 401, code: 'E_UNAUTHORIZED' });
  for (let i = 0; i < 60; i += 1) obs.recordError({ route: 'test.get', status: 500, code: 'E_TEST' });
  const snap = obs.snapshot();
  assert.equal(snap.total_requests, 2);
  assert.equal(snap.total_errors, 61);
  assert.equal(snap.routes['health.get'], 1);
  assert.equal(snap.routes['metrics.get'], 1);
  assert.equal(snap.status_classes['2xx'], 1);
  assert.equal(snap.status_classes['4xx'], 1);
  assert.equal(snap.recent_errors.length, 50);
  assert.equal(snap.recent_errors[0].code, 'E_TEST');
});

test('observability logs use an allowlist and never print secret-shaped fields', () => {
  const obs = createObservability();
  const original = process.stderr.write;
  let output = '';
  process.stderr.write = (chunk) => { output += String(chunk); return true; };
  try {
    obs.log('error', 'request.failed', {
      request_id: 'req-1', route: 'payments.create', method: 'POST', status: 401, code: 'E_UNAUTHORIZED',
      authorization: 'Bearer SECRET-TOKEN', apiKey: 'SECRET-API-KEY', consumerSecret: 'SECRET',
    });
  } finally {
    process.stderr.write = original;
  }
  assert.match(output, /request.failed/);
  assert.match(output, /req-1/);
  assert.equal(output.includes('SECRET-TOKEN'), false);
  assert.equal(output.includes('SECRET-API-KEY'), false);
  assert.equal(output.includes('consumerSecret'), false);
});

test('readiness fails closed when the database or ledger is unavailable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acep-p25-ready-'));
  const layer = createDataLayer({ dataDir: dir });
  try {
    assert.deepEqual(readiness(layer), { status: 'ready', checks: { database: 'ok', ledger: 'ok' } });
    layer.close();
    const check = readiness(layer);
    assert.equal(check.status, 'not_ready');
    assert.equal(check.checks.database, 'down');
  } finally {
    try { layer.close(); } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
