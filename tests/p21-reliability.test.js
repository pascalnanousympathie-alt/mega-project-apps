'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createDataLayer } = require('../core');
const { openDataLayer } = require('../core/db');
const { verifyLedger } = require('../core/ledger');

function runChild(dataDir, walletId, prefix, count) {
  const script = `
    const { openDataLayer } = require(${JSON.stringify(require.resolve('../core/db'))});
    const { appendLedger, verifyLedger } = require(${JSON.stringify(require.resolve('../core/ledger'))});
    const db = openDataLayer(${JSON.stringify(dataDir)}, { verifyOnOpen: false });
    try {
      for (let i = 0; i < ${count}; i += 1) {
        appendLedger(db, {
          wallet_id: ${JSON.stringify(walletId)},
          idempotency_key: ${JSON.stringify(prefix)} + '-' + i,
          tx_type: 'deposit',
          direction: 'credit',
          amount_milli: 1,
        });
      }
      if (!verifyLedger(db).ok) throw new Error('child ledger verification failed');
    } finally {
      if (db.isOpen) db.close();
    }
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0) return resolve({ stdout, stderr });
      reject(new Error('child exit=' + code + ' signal=' + (signal || 'none') + ' stderr=' + stderr));
    });
  });
}

test('two real writer processes can commit without losing ledger entries', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acep-p21-concurrency-'));
  const layer = createDataLayer({ dataDir: dir });
  const user = layer.createUser({ username: 'p21_concurrent', password: 'S3cretpass!' });
  const wallet = layer.createWallet(user.id);
  layer.close();

  await Promise.all([
    runChild(dir, wallet.id, 'p21-a', 40),
    runChild(dir, wallet.id, 'p21-b', 40),
  ]);

  const db = openDataLayer(dir);
  t.after(() => db.close());
  const rows = db
    .prepare('SELECT COUNT(*) AS c, COALESCE(SUM(amount_milli),0) AS total FROM ledger_entries WHERE wallet_id = ?')
    .get(wallet.id);
  assert.equal(rows.c, 80);
  assert.equal(rows.total, 80);
  const stored = db.prepare('SELECT balance_milli FROM wallets WHERE id = ?').get(wallet.id);
  assert.equal(stored.balance_milli, 80);
  assert.equal(verifyLedger(db).ok, true);
});
