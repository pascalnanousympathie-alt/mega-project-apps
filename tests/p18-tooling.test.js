'use strict';
// P18 — tests for the phase gates themselves (coverage floor parser + secret
// scanner). A gate that silently passes on a broken report is worse than no
// gate, so every parser branch and every scanner rule is exercised here against
// synthetic data.
//
// Credential fixtures are assembled at runtime so this file never contains a
// literal secret pattern (the repository scan below must stay clean).
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const coverageGate = require('../scripts/test-coverage');
const secretScan = require('../scripts/secret-scan');

function tmpTree(prefix, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  return dir;
}

function cleanup(t, dir) {
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ------------------------------------------------------------- coverage ----

const TABLE = [
  'ℹ ---------------------------------------------------------------------------',
  'ℹ file                | line % | branch % | funcs % | uncovered lines',
  'ℹ ---------------------------------------------------------------------------',
  'ℹ core                |        |          |         |',
  'ℹ  domino.js          | 100.00 |    98.47 |  100.00 |',
  'ℹ  wallet.js          |  96.95 |    79.22 |   95.65 | 12-14 99',
  'ℹ payments            |        |          |         |',
  'ℹ  providers          |        |          |         |',
  'ℹ   mvola.js          | 100.00 |    65.38 |  100.00 |',
  'ℹ all files           |  96.13 |    80.84 |    94.90 |',
].join('\n');

test('coverage parser rebuilds nested module paths from the reporter table', () => {
  const report = coverageGate.parseCoverage(TABLE);
  assert.deepEqual(
    report.files.map((f) => f.file),
    ['core/domino.js', 'core/wallet.js', 'payments/providers/mvola.js'],
  );
  const wallet = report.files[1];
  assert.equal(wallet.lines, 96.95);
  assert.equal(wallet.branches, 79.22);
  assert.equal(wallet.functions, 95.65);
  assert.equal(wallet.uncovered, '12-14 99');
  assert.equal(report.totals.file, 'all files');
  assert.equal(report.totals.lines, 96.13);
  assert.equal(report.totals.branches, 80.84);
});

test('coverage parser ignores the header, blank cells and unrelated output', () => {
  const noisy = ['✔ some test passes (1.2ms)', 'ℹ tests 3', TABLE, 'ℹ not a coverage row'].join('\n');
  const report = coverageGate.parseCoverage(noisy);
  assert.equal(report.files.length, 3);
  assert.equal(report.files.some((f) => String(f.file).includes('%')), false);
  assert.deepEqual(coverageGate.parseCoverage('').files, []);
  assert.equal(coverageGate.parseCoverage('').totals, null);
});

test('coverage parser keeps directory rows out of the file list', () => {
  const report = coverageGate.parseCoverage(TABLE);
  assert.deepEqual(report.files.map((f) => f.lines), [100, 96.95, 100]);
  assert.equal(report.files.every((f) => typeof f.lines === 'number'), true);
});

test('summary parser reads tests/pass/fail/skipped and drops other counters', () => {
  const summary = coverageGate.parseSummary(
    ['ℹ tests 274', 'ℹ pass 274', 'ℹ fail 0', 'ℹ skipped 0', 'ℹ todo 0', 'ℹ duration_ms 265521'].join('\n'),
  );
  assert.deepEqual(summary, { tests: 274, pass: 274, fail: 0, skipped: 0 });
});

const COMPLIANT_FILES = [
  { file: 'core/domino.js', lines: 100, branches: 98.47, functions: 100 },
  { file: 'core/loto.js', lines: 100, branches: 98.35, functions: 100 },
  { file: 'core/rami.js', lines: 98.78, branches: 95, functions: 100 },
  { file: 'core/wallet.js', lines: 96.95, branches: 79.22, functions: 95.65 },
  { file: 'core/ledger.js', lines: 100, branches: 94.92, functions: 100 },
  { file: 'core/payments/base.js', lines: 96.59, branches: 67.27, functions: 86.67 },
  { file: 'core/payments/providers/mvola.js', lines: 100, branches: 65.38, functions: 100 },
  { file: 'core/gateway.js', lines: 95.12, branches: 79.47, functions: 96.08 },
  { file: 'core/socketio.js', lines: 94.95, branches: 80.49, functions: 88.89 },
];
const COMPLIANT_TOTALS = { file: 'all files', lines: 96.13, branches: 80.84, functions: 94.9 };

test('coverage gate accepts a report that clears every P18 scope floor', () => {
  assert.deepEqual(coverageGate.evaluate({ files: COMPLIANT_FILES, totals: COMPLIANT_TOTALS }), []);
});

test('coverage gate accepts exact-floor metrics because the floors are inclusive', () => {
  const atFloor = [
    { file: 'core/domino.js', lines: 88, branches: 78, functions: 85 },
    { file: 'core/wallet.js', lines: 92, branches: 78, functions: 88 },
    { file: 'core/payments/base.js', lines: 88, branches: 60, functions: 80 },
    { file: 'core/gateway.js', lines: 84, branches: 65, functions: 85 },
  ];
  assert.deepEqual(coverageGate.evaluate({ files: atFloor, totals: { lines: 88, branches: 72, functions: 85 } }), []);
});

test('coverage gate flags a module that drops below its floor', () => {
  const files = COMPLIANT_FILES.map((f) => (f.file === 'core/wallet.js' ? { ...f, branches: 40 } : f));
  const violations = coverageGate.evaluate({ files, totals: COMPLIANT_TOTALS });
  assert.deepEqual(violations, ['wallet-ledger: core/wallet.js branches 40 < 78']);
});

test('coverage gate fails closed when a scope matches no covered file', () => {
  const violations = coverageGate.evaluate({ files: [], totals: COMPLIANT_TOTALS });
  assert.equal(violations.length, coverageGate.SCOPE_THRESHOLDS.length);
  assert.equal(violations.every((v) => v.includes('no covered file matches')), true);
});

test('coverage gate flags a missing or weak global total', () => {
  assert.deepEqual(coverageGate.evaluate({ files: COMPLIANT_FILES, totals: null }), [
    'global: coverage totals missing from reporter output',
  ]);
  const weak = coverageGate.evaluate({ files: COMPLIANT_FILES, totals: { lines: 87.5, branches: 71, functions: 84 } });
  assert.deepEqual(weak, [
    'global: all files lines 87.5 < 88',
    'global: all files branches 71 < 72',
    'global: all files functions 84 < 85',
  ]);
});

test('sourceHash is stable, path sensitive and content sensitive', (t) => {
  const dir = cleanup(
    t,
    tmpTree('acep-p18-hash-', { 'src/a.js': 'module.exports = 1;\n', 'src/b.js': 'module.exports = 2;\n' }),
  );
  const first = coverageGate.sourceHash(dir, ['src']);
  assert.equal(first.algorithm, 'sha256');
  assert.equal(first.files, 2);
  assert.match(first.hash, /^[0-9a-f]{64}$/);
  assert.deepEqual(coverageGate.sourceHash(dir, ['src']), first);

  fs.writeFileSync(path.join(dir, 'src', 'b.js'), 'module.exports = 3;\n', 'utf8');
  const changed = coverageGate.sourceHash(dir, ['src']);
  assert.notEqual(changed.hash, first.hash);

  fs.renameSync(path.join(dir, 'src', 'b.js'), path.join(dir, 'src', 'c.js'));
  const renamed = coverageGate.sourceHash(dir, ['src']);
  assert.notEqual(renamed.hash, changed.hash);
  assert.equal(renamed.files, 2);
  assert.deepEqual(renamed.scope, ['src']);
});

// --------------------------------------------------------------- secrets ----

const CREDENTIAL_FIXTURES = [
  { id: 'private-key-block', value: ['-----', 'BEGIN ', 'RSA PRIVATE ', 'KEY-----'].join('') },
  { id: 'aws-access-key-id', value: ['AK', 'IA', 'AAAAAAAAAAAAAAAA'].join('') },
  { id: 'github-token', value: ['gh', 'p_', 'a'.repeat(36)].join('') },
  { id: 'slack-token', value: ['xo', 'xb-', '1234567890abc'].join('') },
  { id: 'stripe-live-key', value: ['sk', '_li', 've_', 'b'.repeat(24)].join('') },
  { id: 'google-api-key', value: ['AI', 'za', 'c'.repeat(35)].join('') },
  { id: 'provider-account-sid', value: ['AC', 'abcdef0123456789abcdef0123456789'].join('') },
  { id: 'inline-credential-url', value: 'https://' + 'user' + ':' + 'hunter2' + '@' + 'example.test/pay' },
];

test('secret scanner detects every credential family it claims to cover', () => {
  for (const fixture of CREDENTIAL_FIXTURES) {
    assert.deepEqual(secretScan.scanText('const x = "' + fixture.value + '";'), [fixture.id], fixture.id);
  }
  assert.deepEqual(
    secretScan.PATTERNS.map((p) => p.id),
    CREDENTIAL_FIXTURES.map((f) => f.id),
    'every declared rule needs a fixture',
  );
});

test('secret scanner leaves ordinary configuration values alone', () => {
  const benign = [
    'const secret = "test-consumer-secret";',
    'const url = "https://sandbox.example.test/callback";',
    'const sid = "AC" + "not-a-real-sid";',
  ].join('\n');
  assert.deepEqual(secretScan.scanText(benign), []);
});

test('secret scanner reports credentials, committed env files and non-hermetic tests', (t) => {
  const envRead = ['const v = ', 'process', '.env', '.PATH;'].join('');
  const dir = cleanup(
    t,
    tmpTree('acep-p18-scan-dirty-', {
      '.gitignore': 'node_modules/\n',
      '.env': 'MVOLA_CONSUMER_KEY=placeholder\n',
      '.env.example': 'MVOLA_CONSUMER_KEY=\n',
      'notes.js': 'const k = "' + CREDENTIAL_FIXTURES[1].value + '";\n',
      'leaky.test.js': envRead + '\n',
      'PROTECTED_FIXTURE/keep.txt': 'protected\n',
    }),
  );
  const result = secretScan.scan(dir, ['PROTECTED_FIXTURE']);
  const rules = result.violations.map((v) => v.rule + ':' + v.file).sort();
  assert.deepEqual(rules, [
    'committed-env-file:.env',
    'credential-pattern:aws-access-key-id:notes.js',
    'gitignore-missing-dotenv-rule:.gitignore',
    'non-hermetic-test-reads-process-env:leaky.test.js',
    'protected-scope-inside-acep:PROTECTED_FIXTURE',
  ]);
  assert.equal(result.scanned_files, 4, 'text files only: .gitignore, .env.example, notes.js, leaky.test.js');
});

test('secret scanner passes a clean tree and skips vendored directories', (t) => {
  const dir = cleanup(
    t,
    tmpTree('acep-p18-scan-clean-', {
      '.gitignore': 'node_modules/\n.env\n',
      'src/app.js': 'module.exports = 1;\n',
      'node_modules/pkg/index.js': 'const k = "' + CREDENTIAL_FIXTURES[1].value + '";\n',
    }),
  );
  const result = secretScan.scan(dir);
  assert.deepEqual(result.violations, []);
  const walked = secretScan.walk(dir).map((f) => path.relative(dir, f));
  assert.deepEqual(walked.sort(), ['.gitignore', 'src/app.js']);
});

test('the repository tree itself is free of credential material', () => {
  const result = secretScan.scan();
  assert.deepEqual(result.violations, []);
  assert.equal(result.scanned_files > 50, true, 'expected the whole workspace to be scanned');
});

test('stored coverage report fails closed when stale or incomplete', (t) => {
  const dir = cleanup(t, tmpTree('acep-p18-report-', {}));
  const evidenceDir = path.join(dir, 'evidence');
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(
    path.join(evidenceDir, 'P18-coverage.json'),
    JSON.stringify({
      phase: 'P18',
      generated_at: 'fixture',
      exit_code: 0,
      summary: { tests: 289, pass: 289, fail: 0, cancelled: 0 },
      workspace: { hash: '0'.repeat(64) },
      coverage: { totals: { lines: 95, branches: 80, functions: 94 } },
      violations: [],
      status: 'PASS',
    }),
    'utf8',
  );
  const proc = spawnSync(
    process.execPath,
    [path.join(__dirname, '..', 'scripts', 'test-coverage.js'), '--report'],
    { cwd: path.join(__dirname, '..'), env: { ...process.env, ACEP_EVIDENCE_DIR: evidenceDir }, encoding: 'utf8' },
  );
  assert.equal(proc.status, 1);
  const output = (proc.stdout || '') + (proc.stderr || '');
  assert.match(output, /status=STALE_OR_INCOMPLETE/);
  assert.equal(output.includes('TypeError'), false);
});
