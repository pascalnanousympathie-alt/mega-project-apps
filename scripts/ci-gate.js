#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
function run(cmd, args, options = {}) {
  return execFileSync(cmd, args, { cwd: ROOT, encoding: options.encoding === undefined ? 'utf8' : options.encoding, stdio: options.stdio || 'pipe' });
}
function npmTest() {
  let output;
  try {
    output = run('npm', ['test']);
  } catch (error) {
    if (error && error.stdout) process.stdout.write(String(error.stdout));
    if (error && error.stderr) process.stderr.write(String(error.stderr));
    throw error;
  }
  const total = output.match(/ACEP_NODE_TESTS_TOTAL=(\d+)/);
  const pass = output.match(/ACEP_NODE_TESTS_PASS=(\d+)/);
  const fail = output.match(/ACEP_NODE_TESTS_FAIL=(\d+)/);
  const cancelled = output.match(/ACEP_NODE_TESTS_CANCELLED=(\d+)/);
  if (!total || !pass || !fail || !cancelled) throw new Error('npm test aggregate marker not found');
  const summary = { tests: +total[1], suites: null, pass: +pass[1], fail: +fail[1], cancelled: +cancelled[1] };
  if (summary.fail !== 0 || summary.tests !== summary.pass || summary.tests <= 0) {
    process.stdout.write('npm test diagnostic output:\n' + (output.length > 30000 ? output.slice(-30000) : output));
    throw new Error('npm test aggregate failed');
  }
  return summary;
}
function gate(name, fn) {
  try { const result = fn(); console.log(`${name}=PASS`); return result; }
  catch (error) { console.error(`${name}=FAIL`); throw error; }
}
try {
  const test = gate('TESTS', npmTest);
  gate('SECURITY', () => run(process.execPath, ['scripts/secret-scan.js'], { encoding: 'utf8' }));
  gate('DEPENDENCY_AUDIT', () => run('npm', ['audit', '--omit=dev', '--audit-level=high']));
  gate('PYTHON_COMPILE', () => run('python3', ['-m', 'compileall', '-q', 'agents', 'supervisor']));
  gate('URL_SECURITY_TESTS', () => run('python3', ['tests/url_safety.test.py']));
  gate('DIFF_CHECK', () => run('git', ['diff', '--check']));
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  if (!pkg.version || !/^\d+\.\d+\.\d+$/.test(pkg.version)) throw new Error('package version must be semantic x.y.z');
  console.log(`VERSION=${pkg.version}`);
  console.log(`TEST_COUNT=${test.tests}`);
  console.log('DEPLOYMENT=AUTO_DISABLED');
  console.log('CI_GATE=PASS');
} catch (error) {
  console.error('CI_GATE=FAIL');
  console.error(error && error.message ? error.message : String(error));
  process.exit(1);
}
