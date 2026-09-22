#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'runtime', 'releases');

function run(cmd, args, options = {}) {
  return execFileSync(cmd, args, {
    cwd: ROOT,
    encoding: options.encoding === undefined ? 'utf8' : options.encoding,
    maxBuffer: 64 * 1024 * 1024,
    stdio: 'pipe',
  });
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function trackedFiles() {
  return run('git', ['ls-files', '-z'])
    .split('\0')
    .filter(Boolean)
    .filter((file) => !file.startsWith('runtime/'));
}

function sourceHash(files) {
  const hash = crypto.createHash('sha256');
  for (const file of files) {
    hash.update(file);
    hash.update('\0');
    hash.update(fs.readFileSync(path.join(ROOT, file)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function verifiedTestReport(commit, source_hash) {
  const reportFile = path.join(ROOT, 'runtime', 'evidence', 'P23-build-test.json');
  if (!fs.existsSync(reportFile)) throw new Error('P23 build test evidence is missing');
  const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  if (report.status !== 'PASS') throw new Error('P23 build test evidence is not PASS');
  if (report.git_commit !== commit) throw new Error('P23 build test evidence does not match HEAD');
  if (report.source_hash !== source_hash) throw new Error('P23 build test evidence does not match source hash');
  if (!report.summary || report.summary.fail !== 0 || report.summary.tests !== report.summary.pass) {
    throw new Error('P23 build test evidence contains a failed test summary');
  }
  return report.summary;
}

function archive() {
  return execFileSync(
    'git',
    ['archive', '--format=tar', '--prefix=release/', 'HEAD'],
    { cwd: ROOT, encoding: null, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

function signArtifact(artifact) {
  const signingKey = process.env.RELEASE_SIGNING_KEY;
  if (!signingKey) return 'ABSENT';
  const signature = `${artifact}.sig`;
  run('openssl', ['dgst', '-sha256', '-sign', signingKey, '-out', signature, artifact]);
  return 'SET';
}

function build() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  if (run('git', ['status', '--porcelain']).trim()) {
    throw new Error('working tree must be clean');
  }

  const commit = run('git', ['rev-parse', 'HEAD']).trim();
  const files = trackedFiles();
  const source_hash = sourceHash(files);
  const npm_test = verifiedTestReport(commit, source_hash);
  const jsFiles = files.filter((file) => file.endsWith('.js'));
  for (const file of jsFiles) run(process.execPath, ['--check', file]);

  fs.mkdirSync(OUT, { recursive: true });
  const base = `${pkg.name}-v${pkg.version}`;
  const tmp = path.join(OUT, '.tmp');
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });

  const tar = archive();
  const gz = zlib.gzipSync(tar, { level: 9, mtime: 0 });
  const first = path.join(tmp, 'first.tar.gz');
  const second = path.join(tmp, 'second.tar.gz');
  fs.writeFileSync(first, gz);
  fs.writeFileSync(second, zlib.gzipSync(archive(), { level: 9, mtime: 0 }));
  const firstHash = sha256File(first);
  const secondHash = sha256File(second);
  if (firstHash !== secondHash) throw new Error('artifact reproducibility failed');

  const artifact = path.join(OUT, `${base}.tar.gz`);
  fs.copyFileSync(first, artifact);
  const signing = signArtifact(artifact);
  if (signing === 'ABSENT') fs.rmSync(`${artifact}.sig`, { force: true });

  const manifest = {
    name: pkg.name,
    version: pkg.version,
    git_commit: commit,
    source_files: files.length,
    source_hash,
    artifact: path.basename(artifact),
    artifact_sha256: sha256File(artifact),
    reproducible: true,
    npm_test,
    node_source_checks: jsFiles.length,
    signing_key: signing,
    signature_status: signing,
    generated_from_clean_tree: true,
  };
  fs.writeFileSync(
    path.join(OUT, `${base}.manifest.json`),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  fs.rmSync(tmp, { recursive: true, force: true });

  console.log(`RELEASE=PASS`);
  console.log(`VERSION=${pkg.version}`);
  console.log(`COMMIT=${commit}`);
  console.log(`FILES=${files.length}`);
  console.log(`SOURCE_HASH=${source_hash}`);
  console.log(`ARTIFACT=${path.relative(ROOT, artifact)}`);
  console.log(`SHA256=${manifest.artifact_sha256}`);
  console.log(`REPRODUCIBLE=PASS`);
  console.log(`SIGNING_KEY=${signing}`);
  console.log(`SIGNATURE=${signing}`);
}

try {
  build();
} catch (error) {
  console.error('RELEASE=FAIL');
  console.error(error && error.message ? error.message : String(error));
  process.exit(1);
}
