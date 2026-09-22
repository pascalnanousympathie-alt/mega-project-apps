'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { makeDataLayer, makeUser, expectDataError } = require('./helpers');

test('records and reads back an audit entry', (t) => {
  const { layer } = makeDataLayer(t);
  const user = makeUser(layer, 'audit_actor');
  const entry = layer.recordAudit({
    actorType: 'user',
    actorId: user.id,
    action: 'user.login',
    targetType: 'user',
    targetId: user.id,
    detail: { ip: '192.0.2.1' },
    ledgerHash: 'a'.repeat(64),
  });
  assert.equal(entry.action, 'user.login');
  assert.deepEqual(entry.detail, { ip: '192.0.2.1' });
  assert.equal(entry.ledger_hash, 'a'.repeat(64));
  assert.equal(layer.getAudit(entry.id).id, entry.id);
});

test('audit links money movement to the ledger hash', (t) => {
  const { layer } = makeDataLayer(t);
  const user = makeUser(layer, 'money_audit');
  const wallet = layer.createWallet(user.id);
  const app = layer.ledger.append({
    wallet_id: wallet.id,
    idempotency_key: 'audit-linked-1',
    tx_type: 'prize',
    direction: 'credit',
    amount_milli: 2500,
  });
  layer.recordAudit({
    actorType: 'system',
    action: 'prize.credited',
    targetType: 'wallet',
    targetId: wallet.id,
    detail: { entryId: app.entry.id },
    ledgerHash: app.entry.hash,
  });
  const hits = layer.listAudit({ targetType: 'wallet', targetId: wallet.id });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].ledger_hash, app.entry.hash);
});

test('filters audit by actor and lists newest first', (t) => {
  const { layer } = makeDataLayer(t);
  const user = makeUser(layer, 'filter_actor');
  layer.recordAudit({ actorType: 'system', action: 'system.boot', targetType: 'app', targetId: 'core' });
  layer.recordAudit({ actorType: 'user', actorId: user.id, action: 'wallet.view', targetType: 'wallet', targetId: 'w1' });
  layer.recordAudit({ actorType: 'user', actorId: user.id, action: 'game.join', targetType: 'room', targetId: 'r1' });
  const byActor = layer.listAudit({ actorId: user.id });
  assert.equal(byActor.length, 2);
  assert.equal(byActor[0].action, 'game.join');
  const system = layer.listAudit({ actorType: 'system' });
  assert.equal(system.length, 1);
});

test('rejects invalid audit actor and missing fields', (t) => {
  const { layer } = makeDataLayer(t);
  expectDataError(() => layer.recordAudit({ actorType: 'robot', action: 'x', targetType: 'y' }), 'E_ARG');
  expectDataError(() => layer.recordAudit({ actorType: 'system', action: '', targetType: 'y' }), 'E_ARG');
  expectDataError(() => layer.recordAudit({ actorType: 'system', action: 'x', targetType: '' }), 'E_ARG');
});