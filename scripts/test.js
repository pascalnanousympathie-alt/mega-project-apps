'use strict';
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const testDir = path.join(root, 'tests');
const files = fs
  .readdirSync(testDir)
  .filter((f) => f.endsWith('.test.js'))
  .map((f) => path.join(testDir, f))
  .sort();
if (!files.length) {
  process.stderr.write('no test files found in tests/\n');
  process.exit(1);
}
let totalTests = 0;
let totalPass = 0;
let totalFail = 0;
let totalCancelled = 0;

for (const file of files) {
  let output = '';
  try {
    output = execFileSync(
      process.execPath,
      ['--test-concurrency=1', '--test-force-exit', '--test', file],
      { encoding: 'utf8', cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (err) {
    output = `${err.stdout || ''}${err.stderr || ''}`;
    process.stdout.write(output);
    process.stderr.write(`test file failed: ${file}\n`);
    process.exit(typeof err.status === 'number' ? err.status : 1);
  }
  process.stdout.write(output);
  const tests = Number((output.match(/ℹ tests (\d+)/) || [])[1] || 0);
  const pass = Number((output.match(/ℹ pass (\d+)/) || [])[1] || 0);
  const fail = Number((output.match(/ℹ fail (\d+)/) || [])[1] || 0);
  const cancelled = Number((output.match(/ℹ cancelled (\d+)/) || [])[1] || 0);
  totalTests += tests;
  totalPass += pass;
  totalFail += fail;
  totalCancelled += cancelled;
  if (fail || cancelled || tests !== pass) {
    process.stderr.write(`test file failed gate: ${file} tests=${tests} pass=${pass} fail=${fail} cancelled=${cancelled}\n`);
    process.exit(1);
  }
}

process.stdout.write(`\nℹ tests ${totalTests}\nℹ pass ${totalPass}\nℹ fail ${totalFail}\nℹ cancelled ${totalCancelled}\n`);


// Supervisor/agent guard tests (unittest scripts in tests/*.py). They are run
// only when a python3 interpreter is present so the node suite stays runnable
// on hosts without one; the skip is printed instead of silently swallowed.
const pythonFiles = fs
  .readdirSync(testDir)
  .filter((f) => f.endsWith('.py'))
  .sort();
if (pythonFiles.length) {
  const probe = spawnSync('python3', ['--version'], { cwd: root, encoding: 'utf8' });
  if (probe.error || probe.status !== 0) {
    process.stderr.write('python3 not available: skipped ' + pythonFiles.join(', ') + '\n');
  } else {
    for (const file of pythonFiles) {
      try {
        execFileSync('python3', [path.join('tests', file)], { stdio: 'inherit', cwd: root });
      } catch (err) {
        process.exit(typeof err.status === 'number' ? err.status : 1);
      }
    }
  }
}
