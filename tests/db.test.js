'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { DataError, openDataLayer } = require('../core/db');
const { makeDataLayer } = require('./helpers');

test('creates database file with schema applied', (t) => {
  const { layer, dir } = makeDataLayer(t);
  assert.ok(fs.existsSync(path.join(dir, 'app.db')));
  const version = layer.db.prepare('SELECT version FROM schema_meta').get().version;
  assert.equal(version, 8);
  const tables = layer.db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => r.name);
  assert.deepEqual(tables, [
    'audit_entries',
    'auth_sessions',
    'domino_matches',
    'domino_moves',
    'games',
    'ledger_entries',
    'local_records',
    'loto_draws',
    'loto_events',
    'payment_callbacks',
    'payment_events',
    'payment_intents',
    'payment_provider_config',
    'payment_reconciliations',
    'rami_games',
    'rami_moves',
    'room_players',
    'rooms',
    'schema_meta',
    'service_credentials',
    'users',
    'wallets',
  ]);
});

test('reopening an existing database is idempotent', (t) => {
  const { layer, dir } = makeDataLayer(t);
  const user = layer.createUser({ username: 'reopen_user' });
  const wallet = layer.createWallet(user.id);
  layer.ledger.append({
    wallet_id: wallet.id,
    idempotency_key: 'reopen-tx-1',
    tx_type: 'deposit',
    direction: 'credit',
    amount_milli: 500,
  });
  layer.close();
  const reopened = openDataLayer(dir);
  try {
    assert.equal(reopened.prepare('SELECT version FROM schema_meta').get().version, 8);
    assert.equal(
      reopened.prepare('SELECT COUNT(*) AS c FROM users').get().c,
      1,
    );
  } finally {
    reopened.close();
  }
});

test('DataError carries stable code and name', (t) => {
  const err = new DataError('E_ARG', 'boom');
  assert.ok(err instanceof Error);
  assert.equal(err.code, 'E_ARG');
  assert.equal(err.name, 'DataError');
});