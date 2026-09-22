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
try {
  execFileSync(process.execPath, ['--test-concurrency=1', '--test', ...files], { stdio: 'inherit', cwd: root });
} catch (err) {
  process.exit(typeof err.status === 'number' ? err.status : 1);
}

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
