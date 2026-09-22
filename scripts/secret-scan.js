'use strict';
/**
 * P18 repository secret / hygiene scan (Security Auditor + DevOps gate).
 *
 * Fails when the working tree contains credential material, a real `.env`
 * file, non-hermetic tests that read `process.env`, or an accidental copy of
 * the protected LudoMada scope inside ACEP.
 *
 * The scan root is a parameter so the gate itself can be unit tested against a
 * synthetic tree (see tests/p18-tooling.test.js). The CLI always scans the
 * repository root.
 *
 * Usage: node scripts/secret-scan.js
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const EVIDENCE_DIR = process.env.ACEP_EVIDENCE_DIR || path.join(ROOT, 'runtime', 'evidence');

const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'runtime', '__pycache__', '.cache', 'data']);
const TEXT_EXT = new Set(['.js', '.cjs', '.mjs', '.py', '.sh', '.json', '.md', '.yml', '.yaml', '.txt', '.example', '.css', '.html']);
const MAX_BYTES = 1024 * 1024;

// Scope that must never be vendored into ACEP.
const PROTECTED_SCOPE = ['LudoMada', '.ludomada-agent'];

// High signal credential patterns. Test fixtures intentionally use values such
// as 'test-consumer-secret', which these expressions do not match.
const PATTERNS = [
  { id: 'private-key-block', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { id: 'aws-access-key-id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { id: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { id: 'stripe-live-key', re: /\bsk_live_[A-Za-z0-9]{16,}\b/ },
  { id: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: 'provider-account-sid', re: /\bAC[0-9a-f]{32}\b/ },
  { id: 'inline-credential-url', re: /[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@\s]+@[^\s/]+/ },
];

const ENV_READ_RE = /process\.env\s*[.[]/;

function isTextFile(name) {
  const ext = path.extname(name).toLowerCase();
  if (TEXT_EXT.has(ext)) return true;
  return name.startsWith('.env') && name !== '.env.example';
}

function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, out);
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      out.push(full);
    }
  }
  return out;
}

/** Scan a single text blob; returns the ids of the patterns that matched. */
function scanText(text) {
  const hits = [];
  for (const pattern of PATTERNS) {
    const global = new RegExp(pattern.re.source, pattern.re.flags.includes('g') ? pattern.re.flags : pattern.re.flags + 'g');
    if (global.test(text)) hits.push(pattern.id);
  }
  return hits;
}

/**
 * Scan a tree for credential material and hygiene violations.
 * @param {string} root directory to scan (default: repository root)
 * @param {string[]} protectedNames scope names that must not appear in `root`
 */
function scan(root = ROOT, protectedNames = PROTECTED_SCOPE) {
  const violations = [];
  const files = walk(root);
  let scanned = 0;

  for (const full of files) {
    const rel = path.relative(root, full);
    const base = path.basename(rel);
    if (base === '.env' || (base.startsWith('.env.') && base !== '.env.example')) {
      violations.push({ rule: 'committed-env-file', file: rel });
      continue;
    }
    if (!isTextFile(base)) continue;
    let stat;
    try {
      stat = fs.statSync(full);
    } catch (_) {
      continue;
    }
    if (!stat.isFile() || stat.size > MAX_BYTES) continue;
    let text;
    try {
      text = fs.readFileSync(full, 'utf8');
    } catch (_) {
      continue;
    }
    scanned += 1;
    for (const id of scanText(text)) violations.push({ rule: 'credential-pattern:' + id, file: rel });
    if (/\.test\.js$/.test(rel) && ENV_READ_RE.test(text)) {
      violations.push({ rule: 'non-hermetic-test-reads-process-env', file: rel });
    }
  }

  for (const protectedName of protectedNames) {
    if (fs.existsSync(path.join(root, protectedName))) {
      violations.push({ rule: 'protected-scope-inside-acep', file: protectedName });
    }
  }

  const gitignore = path.join(root, '.gitignore');
  if (fs.existsSync(gitignore)) {
    const ignored = fs.readFileSync(gitignore, 'utf8');
    if (!/^\.env$/m.test(ignored)) violations.push({ rule: 'gitignore-missing-dotenv-rule', file: '.gitignore' });
  } else {
    violations.push({ rule: 'gitignore-missing', file: '.gitignore' });
  }

  return { scanned_files: scanned, violations };
}

function main() {
  const result = scan();
  const artifact = {
    phase: 'P18',
    generated_at: new Date().toISOString(),
    command: 'node scripts/secret-scan.js',
    scanned_files: result.scanned_files,
    rules: [...PATTERNS.map((p) => p.id), 'committed-env-file', 'non-hermetic-test-reads-process-env', 'protected-scope-inside-acep'],
    violations: result.violations,
    status: result.violations.length === 0 ? 'PASS' : 'FAIL',
  };
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'P18-security.json'), JSON.stringify(artifact, null, 2) + '\n', 'utf8');
  process.stdout.write(`scanned_files=${result.scanned_files} violations=${result.violations.length}\n`);
  for (const violation of result.violations) {
    process.stdout.write(`  - ${violation.rule}: ${violation.file}\n`);
  }
  process.stdout.write(`status=${artifact.status} report=${path.relative(ROOT, path.join(EVIDENCE_DIR, 'P18-security.json'))}\n`);
  return artifact.status === 'PASS' ? 0 : 1;
}

if (require.main === module) process.exit(main());

module.exports = { scan, scanText, PATTERNS, PROTECTED_SCOPE, isTextFile, walk };
