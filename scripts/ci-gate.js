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
  const output = run('npm', ['test']);
  const matches = [...output.matchAll(/ℹ tests (\d+)\s+ℹ suites (\d+)\s+ℹ pass (\d+)\s+ℹ fail (\d+)/g)];
  const match = matches.at(-1);
  if (!match) throw new Error('npm test aggregate summary not found');
  const summary = { tests: +match[1], suites: +match[2], pass: +match[3], fail: +match[4] };
  if (summary.fail !== 0 || summary.tests !== summary.pass || summary.tests <= 0) throw new Error('npm test aggregate failed');
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
