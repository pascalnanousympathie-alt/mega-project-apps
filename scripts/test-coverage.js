'use strict';
/**
 * P18 coverage runner + gate (Senior Developer + DevOps).
 *
 * Runs the node:test suite with the built-in V8 coverage reporter, writes a
 * machine-readable artefact plus the raw log, and fails when either a test
 * fails or a coverage floor for the P18 scope (rules, wallet, payments,
 * gateway) is not met.
 *
 * Every artefact carries a sha256 of the tested workspace (core/, server/,
 * client/, tests/, package.json) so a later phase can tell whether a stored
 * PASS is still valid for the current tree instead of re-running blindly.
 *
 * Usage:
 *   node scripts/test-coverage.js            # run, print report, enforce gate
 *   node scripts/test-coverage.js --report   # print the last stored report
 */
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const TEST_DIR = path.join(ROOT, 'tests');
const EVIDENCE_DIR = process.env.ACEP_EVIDENCE_DIR || path.join(ROOT, 'runtime', 'evidence');

const GLOBAL_THRESHOLDS = { lines: 88, branches: 72, functions: 85 };

// Floors for the modules the P18 objective names explicitly. Values are kept
// below the achieved numbers on purpose: they are regression floors, not targets.
const SCOPE_THRESHOLDS = [
  { scope: 'core-rules', match: /^core\/(domino|loto|rami)\.js$/, lines: 88, branches: 78, functions: 85 },
  { scope: 'wallet-ledger', match: /^core\/(wallet|ledger)\.js$/, lines: 92, branches: 78, functions: 88 },
  { scope: 'payments', match: /^core\/payments\//, lines: 88, branches: 60, functions: 80 },
  { scope: 'gateway', match: /^core\/(gateway|socketio)\.js$/, lines: 84, branches: 65, functions: 85 },
];

// Workspace whose contents decide whether a stored coverage artefact is still
// representative. Directories are walked in a stable order and joined with the
// file paths, so a rename changes the digest even when the bytes are equal.
const SOURCE_SCOPE = ['core', 'server', 'client', 'tests', 'package.json'];
const HASH_SKIP_DIRS = new Set(['node_modules', '__pycache__', '.venv', 'data', 'runtime', '.git']);

function metric(value) {
  // Directory rows and the header leave the numeric cells blank. Number('')
  // is 0, which used to classify those rows as files with 0% coverage.
  const text = String(value === undefined || value === null ? '' : value)
    .replace('%', '')
    .trim();
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

/** Parse the `--experimental-test-coverage` table into a file list and totals. */
function parseCoverage(output) {
  const lines = String(output || '').split(/\r?\n/);
  const stack = [];
  const files = [];
  let totals = null;
  for (const line of lines) {
    if (!line.startsWith('\u2139')) continue;
    const columns = line.slice(1).split('|');
    if (columns.length < 5) continue;
    // The reporter prefixes every row with the marker plus one separating
    // space before the (indented) name; that separator must not count as a
    // nesting level, otherwise every entry is nested one level too deep, the
    // reconstructed path becomes 'file/...' and the scope floors below never
    // match a real file.
    const rawName = columns[0].startsWith(' ') ? columns[0].slice(1) : columns[0];
    const indent = (rawName.match(/^ */) || [''])[0].length;
    const name = rawName.trim();
    if (!name) continue;
    // Table header row ('file | line % | branch % | funcs %').
    if (String(columns[1] || '').includes('%')) continue;
    const values = [metric(columns[1]), metric(columns[2]), metric(columns[3])];
    if (values.some((v) => v === null)) {
      stack[indent] = name;
      stack.length = indent + 1;
      continue;
    }
    const entry = {
      file: indent === 0 ? name : stack.slice(0, indent).concat(name).filter(Boolean).join('/'),
      lines: values[0],
      branches: values[1],
      functions: values[2],
      uncovered: (columns[4] || '').trim(),
    };
    if (entry.file === 'all files') totals = entry;
    else files.push(entry);
  }
  return { files, totals };
}

/** Parse the `ℹ tests/pass/fail` summary block. */
function parseSummary(output) {
  const summary = { tests: null, pass: null, fail: null, skipped: null };
  for (const line of String(output || '').split(/\r?\n/)) {
    const m = line.match(/^\u2139 (\w+) (\d+)/);
    if (!m) continue;
    if (Object.prototype.hasOwnProperty.call(summary, m[1])) summary[m[1]] = Number(m[2]);
  }
  return summary;
}

/** Evaluate the coverage floors; returns a list of human readable violations. */
function evaluate(report) {
  const violations = [];
  for (const rule of SCOPE_THRESHOLDS) {
    let matched = 0;
    for (const file of report.files || []) {
      if (!rule.match.test(file.file)) continue;
      matched += 1;
      for (const key of ['lines', 'branches', 'functions']) {
        const floor = rule[key];
        if (floor === undefined) continue;
        if (file[key] === null || file[key] < floor) {
          violations.push(`${rule.scope}: ${file.file} ${key} ${file[key]} < ${floor}`);
        }
      }
    }
    // A renamed or deleted module would otherwise turn the floor into a no-op.
    if (matched === 0) violations.push(`${rule.scope}: no covered file matches ${rule.match}`);
  }
  const totals = report.totals;
  if (!totals) {
    violations.push('global: coverage totals missing from reporter output');
    return violations;
  }
  for (const key of ['lines', 'branches', 'functions']) {
    if (totals[key] === null || totals[key] < GLOBAL_THRESHOLDS[key]) {
      violations.push(`global: all files ${key} ${totals[key]} < ${GLOBAL_THRESHOLDS[key]}`);
    }
  }
  return violations;
}

function testFiles() {
  return fs
    .readdirSync(TEST_DIR)
    .filter((f) => f.endsWith('.test.js'))
    .sort()
    .map((f) => path.join('tests', f));
}

function walkFiles(target, out = []) {
  let stat;
  try {
    stat = fs.statSync(target);
  } catch (_) {
    return out;
  }
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(target, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (entry.isDirectory()) {
        if (HASH_SKIP_DIRS.has(entry.name)) continue;
        walkFiles(path.join(target, entry.name), out);
      } else if (entry.isFile()) {
        out.push(path.join(target, entry.name));
      }
    }
  } else if (stat.isFile()) {
    out.push(target);
  }
  return out;
}

/**
 * sha256 over the tested workspace: sorted relative paths plus file contents.
 * Used to prove that a stored coverage PASS still describes the current tree.
 */
function sourceHash(root = ROOT, scope = SOURCE_SCOPE) {
  const files = [];
  for (const entry of scope) walkFiles(path.join(root, entry), files);
  const relative = files
    .map((f) => path.relative(root, f).split(path.sep).join('/'))
    .sort();
  const hash = crypto.createHash('sha256');
  for (const rel of relative) {
    hash.update(rel);
    hash.update('\0');
    hash.update(fs.readFileSync(path.join(root, rel)));
    hash.update('\0');
  }
  return { algorithm: 'sha256', files: relative.length, scope: [...scope], hash: hash.digest('hex') };
}

function format(entry) {
  return [
    String(entry.file).padEnd(28),
    String(entry.lines).padStart(7),
    String(entry.branches).padStart(9),
    String(entry.functions).padStart(9),
  ].join(' | ');
}

function printReport(report) {
  process.stdout.write('file                         |   line% | branch% |  funcs%\n');
  for (const file of report.files) process.stdout.write(format(file) + '\n');
  if (report.totals) process.stdout.write(format({ ...report.totals, file: 'all files' }) + '\n');
}

function run() {
  const files = testFiles();
  if (!files.length) {
    process.stderr.write('no test files found in tests/\n');
    return 1;
  }
  const started = Date.now();
  const args = ['--test', '--experimental-test-coverage', ...files];
  const proc = spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env },
  });
  const output = (proc.stdout || '') + (proc.stderr || '');
  const report = parseCoverage(output);
  const summary = parseSummary(output);
  const violations = evaluate(report);
  const artifact = {
    phase: 'P18',
    generated_at: new Date().toISOString(),
    command: 'node ' + args.join(' '),
    duration_ms: Date.now() - started,
    exit_code: proc.status,
    summary,
    workspace: sourceHash(),
    thresholds: { global: GLOBAL_THRESHOLDS, scopes: SCOPE_THRESHOLDS.map((r) => ({ ...r, match: String(r.match) })) },
    coverage: { totals: report.totals, files: report.files },
    violations,
    status: proc.status === 0 && summary.fail === 0 && violations.length === 0 ? 'PASS' : 'FAIL',
  };
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'P18-coverage.txt'), output, 'utf8');
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'P18-coverage.json'), JSON.stringify(artifact, null, 2) + '\n', 'utf8');
  printReport(report);
  process.stdout.write(
    `tests=${summary.tests} pass=${summary.pass} fail=${summary.fail} duration_ms=${artifact.duration_ms}\n`,
  );
  if (violations.length) {
    process.stdout.write('coverage violations:\n');
    for (const violation of violations) process.stdout.write('  - ' + violation + '\n');
  }
  process.stdout.write(`workspace_hash=${artifact.workspace.hash}\n`);
  process.stdout.write(`status=${artifact.status} report=${path.relative(ROOT, path.join(EVIDENCE_DIR, 'P18-coverage.json'))}\n`);
  return artifact.status === 'PASS' ? 0 : 1;
}

function showLastReport() {
  const file = path.join(EVIDENCE_DIR, 'P18-coverage.json');
  if (!fs.existsSync(file)) {
    process.stderr.write('no stored coverage report at ' + path.relative(ROOT, file) + '\n');
    return 1;
  }
  const artifact = JSON.parse(fs.readFileSync(file, 'utf8'));
  const coverage = artifact.coverage && typeof artifact.coverage === 'object' ? artifact.coverage : {};
  const files = Array.isArray(coverage.files) ? coverage.files : [];
  const totals = coverage.totals || null;
  printReport({ files, totals });
  const currentHash = sourceHash().hash;
  const storedHash = artifact.workspace && artifact.workspace.hash;
  const complete = files.length > 0 && totals && typeof totals.lines === 'number' && typeof totals.branches === 'number' && typeof totals.functions === 'number';
  const fresh = storedHash === currentHash;
  const reportStatus = artifact.status === 'PASS' && artifact.exit_code === 0 && fresh && complete ? 'PASS' : 'STALE_OR_INCOMPLETE';
  process.stdout.write(`status=${reportStatus} generated_at=${artifact.generated_at} tests=${artifact.summary.tests} workspace_hash=${storedHash || 'ABSENT'} current_workspace_hash=${currentHash}\n`);
  return reportStatus === 'PASS' ? 0 : 1;
}

if (require.main === module) {
  process.exit(process.argv.includes('--report') ? showLastReport() : run());
}

module.exports = {
  parseCoverage,
  parseSummary,
  evaluate,
  sourceHash,
  GLOBAL_THRESHOLDS,
  SCOPE_THRESHOLDS,
  SOURCE_SCOPE,
  EVIDENCE_DIR,
};
