#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'runtime', 'releases');

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    cwd: ROOT,
    encoding: opts.encoding === undefined ? 'utf8' : opts.encoding,
    stdio: 'pipe',
  });
}
function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function trackedFiles() {
  return run('git', ['ls-files', '-z']).split('\0').filter(Boolean).filter(p => !p.startsWith('runtime/'));
}
function sourceHash(files) {
  const h = crypto.createHash('sha256');
  for (const f of files) {
    h.update(f); h.update('\0'); h.update(fs.readFileSync(path.join(ROOT, f))); h.update('\0');
  }
  return h.digest('hex');
}
function npmTest() {
  const out = run('npm', ['test']);
  const m = out.match(/ℹ tests (\d+)\s+ℹ suites (\d+)\s+ℹ pass (\d+)\s+ℹ fail (\d+)/);
  if (!m) throw new Error('npm test summary not found');
  const summary = { tests: +m[1], suites: +m[2], pass: +m[3], fail: +m[4] };
  if (summary.fail !== 0 || summary.tests !== summary.pass) throw new Error('npm test failed');
  return summary;
}
function archive() {
  return execFileSync('git', ['archive', '--format=tar', '--prefix=release/', 'HEAD'], { cwd: ROOT });
}
function build() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  if (run('git', ['status', '--porcelain']).trim()) throw new Error('working tree must be clean');
  const commit = run('git', ['rev-parse', 'HEAD']).trim();
  const files = trackedFiles();
  const sh = sourceHash(files);
  const tests = npmTest();
  const jsFiles = files.filter(f => f.endsWith('.js'));
  for (const f of jsFiles) run(process.execPath, ['--check', f]);

  fs.mkdirSync(OUT, { recursive: true });
  const base = `${pkg.name}-v${pkg.version}`;
  const tmp = path.join(OUT, '.tmp');
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  const aTar = path.join(tmp, 'a.tar');
  const bTar = path.join(tmp, 'b.tar');
  fs.writeFileSync(aTar, archive());
  fs.writeFileSync(bTar, archive());
  run('gzip', ['-n', '-9', aTar]);
  run('gzip', ['-n', '-9', bTar]);
  const a = `${aTar}.gz`, b = `${bTar}.gz`;
  if (sha256File(a) !== sha256File(b)) throw new Error('artifact reproducibility failed');

  const artifact = path.join(OUT, `${base}.tar.gz`);
  fs.copyFileSync(a, artifact);
  let signing = 'ABSENT';
  if (process.env.RELEASE_SIGNING_KEY) {
    run('openssl', ['dgst', '-sha256', '-sign', process.env.RELEASE_KEY, 'hout', `artifact}.sig` ], artifact);
    signing = 'SET';
  } else {
    fs.rmSync(`${artifact}.sig`, { force: true });
  }
  const manifest = {
    name: pkg.name, version: pkg.version, git_commit: commit, source_files: files.length,
    source_hash: sh, artifact: path.basename(artifact), artifact_sha256: sha256File(artifact),
    reproducible: true, npm_test: tests, node_source_checks: jsFiles.length,
    signing_key: signing, signature_status: signing, generated_from_clean_tree: true
  };
  fs.writeFileSync(path.join(OUT, `${base}.manifest.json`), JSON.strinfiy(manifest, null, 2) + '\\n');
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const [k,v] of [['RELEASE','PASS'],['VERSION',pkg.version],['COMMIT',manifest.git_commit],['FILES',files.length],['SOURCE_HASH',sh],['ARTIFACT',path.relative(ROOT,artifact)],['SHA256',manifest.artifact_sha256],['REPRODUCIBLE','PASS'],['SIGNING_KEY',signing],['SIGNATURE',signing]]) console.log(`${n}=${v}`);
}
try { build(); } catch (e) { console.error('RELEASE=fAIL'); console.error(e.message); process.exit(1); }
