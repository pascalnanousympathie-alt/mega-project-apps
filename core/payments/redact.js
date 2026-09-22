'use strict';

const SECRET_KEY_RE = /(secret|token|password|passwd|authorization|api[_-]?key|merchant[_-]?key|signature|private[_-]?key|credential|pin|otp|cookie|session)/i;
const REDACTED = '[REDACTED]';
const MAX_DEPTH = 8;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function redact(value, depth = 0) {
  if (depth > MAX_DEPTH) return REDACTED;
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (!isPlainObject(value)) return value;
  const out = {};
  for (const key of Object.keys(value)) {
    if (SECRET_KEY_RE.test(key)) {
      out[key] = REDACTED;
    } else {
      out[key] = redact(value[key], depth + 1);
    }
  }
  return out;
}

function stripSecrets(value, depth = 0) {
  if (depth > MAX_DEPTH) return null;
  if (Array.isArray(value)) return value.map((item) => stripSecrets(item, depth + 1));
  if (!isPlainObject(value)) return value;
  const out = {};
  for (const key of Object.keys(value)) {
    if (SECRET_KEY_RE.test(key)) continue;
    out[key] = stripSecrets(value[key], depth + 1);
  }
  return out;
}

function redactText(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(/(authorization\s*[:=]\s*)((?:bearer\s+)?[^\s,;]+)/gi, '$1' + REDACTED)
    .replace(/((?:secret|token|password|api[_-]?key|merchant[_-]?key|signature)\s*[:=]\s*)([^\s,;&]+)/gi, '$1' + REDACTED);
}

function containsSecretLike(value) {
  if (Array.isArray(value)) return value.some(containsSecretLike);
  if (!isPlainObject(value)) return false;
  for (const key of Object.keys(value)) {
    if (SECRET_KEY_RE.test(key)) return true;
    if (containsSecretLike(value[key])) return true;
  }
  return false;
}

module.exports = { SECRET_KEY_RE, REDACTED, redact, stripSecrets, redactText, containsSecretLike };
