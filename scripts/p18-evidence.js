'use strict';
/**
 * P18 evidence runner (DevOps).
 *
 * Runs the phase gates in order and stores one machine-verifiable artefact:
 *   1. npm test              (node:test unit/integration + python supervisor tests)
 *   2. node scripts/test-coverage.js  (coverage floors for rules/wallet/payments/gateway)
 *   3. node scripts/secret-scan.js    (secret + hygiene gate)
 *   4. git diff --check / git status --short (workspace cleanliness)
 *
 * The artefact records a sha256 of the tested workspace (core/, server/,
 * client/, tests/, package.json). `--quick` skips re-running the expensive
 * coverage pass but only reports REUSED when the stored coverage artefact was
 * produced from the exact same workspace digest; otherwise it fails instead of
 * claiming coverage that no longer describes the tree.
 *
 * Usage: node scripts/p18-evidence.js [--quick]   (--quick reuses valid coverage)
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { sourceHash, EVIDENCE_DIR } = require('./test-coverage');

const ROOT = path.join(__dirname, '..');

function runFile(file, args, timeoutMs) {
  const started = Date.now();
  const proc = spawnSync(process.execPath, [file, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    timeout: timeoutMs,
  });
  return {
    cmd: 'node ' + [file, ...args].join(' '),
    exit: proc.status === null ? 124 : proc.status,
    duration_ms: Date.now() - started,
    stdout: (proc.stdout || '').slice(-4000),
    stderr: (proc.stderr || '').slice(-2000),
  };
}

function runRaw(cmd, args, timeoutMs = 60000) {
  const proc = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', timeout: timeoutMs });
  return {
    cmd: [cmd, ...args].join(' '),
    exit: proc.status === null ? 124 : proc.status,
    stdout: ((proc.stdout || '') + (proc.stderr || '')).slice(-4000),
  };
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

function main() {
  const quick = process.argv.includes('--quick');
  const steps = [];
  const workspace = sourceHash();
  const test = runRaw('npm', ['test'], 900000);
  steps.push(test);
  let coverage = { status: 'SKIPPED' };
  if (!quick) {
    const result = runFile(path.join('scripts', 'test-coverage.js'), [], 900000);
    steps.push(result);
    coverage = readJson(path.join(EVIDENCE_DIR, 'P18-coverage.json')) || { status: 'FAIL', violations: ['coverage artefact missing'] };
  } else {
    const stored = readJson(path.join(EVIDENCE_DIR, 'P18-coverage.json'));
    if (stored && stored.status === 'PASS' && stored.workspace && stored.workspace.hash === workspace.hash) {
      coverage = { ...stored, status: 'REUSED', stored_status: 'PASS' };
    } else if (stored && stored.status === 'PASS') {
      coverage = { status: 'STALE', violations: ['stored coverage workspace hash does not match the current tree'] };
    }
  }
  const securityRun = runFile(path.join('scripts', 'secret-scan.js'), [], 120000);
  steps.push(securityRun);
  const security = readJson(path.join(EVIDENCE_DIR, 'P18-security.json')) || { status: 'FAIL', violations: ['security artefact missing'] };
  const diffCheck = runRaw('git', ['diff', '--check']);
  steps.push(diffCheck);
  const gitStatus = runRaw('git', ['status', '--short']);
  steps.push(gitStatus);

  const artifact = {
    phase: 'P18',
    owner: 'Senior Developer + DevOps',
    objective: 'Unit/integration coverage for rules, wallet, payments and gateway.',
    generated_at: new Date().toISOString(),
    mode: quick ? 'quick' : 'full',
    tested_workspace: workspace,
    steps,
    tests: { exit: test.exit, summary: test.stdout.trim().split('\n').slice(-4) },
    coverage: {
      status: coverage.status,
      stored_status: coverage.stored_status,
      generated_at: coverage.generated_at,
      workspace_hash: coverage.workspace ? coverage.workspace.hash : null,
      summary: coverage.summary,
      totals: coverage.coverage ? coverage.coverage.totals : null,
      violations: coverage.violations,
    },
    security: { status: security.status, violations: security.violations, scanned_files: security.scanned_files },
    git: { diff_check_exit: diffCheck.exit, status: gitStatus.stdout.trim() },
  };
  const coverageOk = quick ? coverage.status === 'REUSED' : coverage.status === 'PASS';
  const ok = test.exit === 0 && coverageOk && security.status === 'PASS' && diffCheck.exit === 0;
  artifact.status = ok ? 'PASS' : 'FAIL';
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'P18-evidence.json'), JSON.stringify(artifact, null, 2) + '\n', 'utf8');
  for (const step of steps) {
    process.stdout.write(`[${step.exit === 0 ? 'PASS' : 'FAIL'}] ${step.cmd} (exit ${step.exit})\n`);
  }
  process.stdout.write(`tests: ${test.stdout.trim().split('\n').filter((l) => /^.\s?(tests|pass|fail)/.test(l)).join(' ')}\n`);
  process.stdout.write(`coverage: ${artifact.coverage.status}\n`);
  process.stdout.write(`security: ${artifact.security.status} (violations ${(artifact.security.violations || []).length})\n`);
  process.stdout.write(`git diff --check exit: ${diffCheck.exit}\n`);
  process.stdout.write(`tested_workspace=${workspace.hash} files=${workspace.files}\n`);
  if (!coverageOk && artifact.coverage.violations) {
    process.stdout.write('coverage violations:\n');
    for (const violation of artifact.coverage.violations) process.stdout.write('  - ' + violation + '\n');
  }
  process.stdout.write(`status=${artifact.status} report=${path.relative(ROOT, path.join(EVIDENCE_DIR, 'P18-evidence.json'))}\n`);
  return ok ? 0 : 1;
}

process.exit(main());
