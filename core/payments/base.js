'use strict';
const { DataError, ok, sha256hex } = require('../db');

const CANONICAL_STATUSES = ['created', 'pending', 'succeeded', 'failed', 'cancelled', 'expired'];
const TERMINAL_STATUSES = ['succeeded', 'failed', 'cancelled', 'expired'];
const DIRECTIONS = ['payin', 'payout'];

const STATUS_TRANSITIONS = {
  created: ['pending', 'succeeded', 'failed', 'cancelled'],
  pending: ['succeeded', 'failed', 'cancelled', 'expired'],
  succeeded: [],
  failed: [],
  cancelled: [],
  expired: [],
};

function canTransition(from, to) {
  if (from === to) return true;
  return (STATUS_TRANSITIONS[from] || []).includes(to);
}

function normalizeStatus(raw, statusMap) {
  if (raw === undefined || raw === null || raw === '') return 'pending';
  const key = String(raw).trim().toLowerCase();
  const map = statusMap || {};
  if (Object.prototype.hasOwnProperty.call(map, key)) return map[key];
  if (CANONICAL_STATUSES.includes(key)) return key;
  return 'pending';
}

function createProvider(definition) {
  ok(definition && typeof definition === 'object', 'E_ARG', 'provider definition required');
  const name = String(definition.name || '').trim();
  ok(/^[a-z][a-z0-9_-]{1,30}$/.test(name), 'E_ARG', 'invalid provider name: ' + definition.name);
  ok(typeof definition.displayName === 'string' && definition.displayName.length > 0, 'E_ARG', 'provider displayName required');
  const currency = String(definition.currency || 'MGA').toUpperCase();
  const directions = Array.isArray(definition.directions) ? definition.directions : ['payin'];
  for (const direction of directions) {
    ok(DIRECTIONS.includes(direction), 'E_ARG', 'invalid provider direction: ' + direction);
  }
  const limits = definition.limits || {};
  const min = limits.min_milli === undefined ? 1 : limits.min_milli;
  const max = limits.max_milli === undefined ? Number.MAX_SAFE_INTEGER : limits.max_milli;
  ok(Number.isSafeInteger(min) && min >= 1, 'E_ARG', 'provider min_milli must be a positive safe integer');
  ok(Number.isSafeInteger(max) && max >= min, 'E_ARG', 'provider max_milli must be >= min_milli');
  ok(typeof definition.createPayment === 'function', 'E_ARG', 'provider createPayment required');
  ok(typeof definition.getPayment === 'function', 'E_ARG', 'provider getPayment required');
  ok(typeof definition.parseCallback === 'function', 'E_ARG', 'provider parseCallback required');
  const credentialSpec = Array.isArray(definition.credentialSpec) ? definition.credentialSpec : [];
  for (const spec of credentialSpec) {
    ok(spec && typeof spec.key === 'string' && spec.key.length > 0, 'E_ARG', 'credential spec key required');
    ok(typeof spec.env === 'string' && spec.env.length > 0, 'E_ARG', 'credential spec env required');
  }
  return Object.freeze({
    name,
    displayName: definition.displayName,
    currency,
    directions: [...directions],
    capabilities: { callback: true, polling: true, payout: directions.includes('payout'), refund: false, ...(definition.capabilities || {}) },
    credentialSpec: credentialSpec.map((spec) => ({ required: true, secret: true, ...spec })),
    limits: { min_milli: min, max_milli: max },
    statusMap: { ...(definition.statusMap || {}) },
    defaultBaseUrl: definition.defaultBaseUrl || null,
    createPayment: definition.createPayment,
    getPayment: definition.getPayment,
    parseCallback: definition.parseCallback,
  });
}

function missingCredentials(provider, credentials) {
  const source = credentials || {};
  const missing = [];
  for (const spec of provider.credentialSpec) {
    if (spec.required === false) continue;
    const value = source[spec.key];
    if (value === undefined || value === null || String(value).length === 0) {
      missing.push(spec.env || spec.key);
    }
  }
  return missing;
}

function resolveCredentials(provider, input = {}) {
  const configured = input.credentials || {};
  const env = input.env || {};
  const resolved = {};
  for (const spec of provider.credentialSpec) {
    if (Object.prototype.hasOwnProperty.call(configured, spec.key)) {
      resolved[spec.key] = configured[spec.key];
    } else if (Object.prototype.hasOwnProperty.call(env, spec.env)) {
      resolved[spec.key] = env[spec.env];
    }
  }
  const baseUrl = resolved.baseUrl || configured.baseUrl || env[providerCredentialEnv(provider, 'baseUrl')] || provider.defaultBaseUrl;
  if (baseUrl) resolved.baseUrl = baseUrl;
  return resolved;
}

function providerCredentialEnv(provider, key) {
  const spec = provider.credentialSpec.find((entry) => entry.key === key);
  if (spec) return spec.env;
  return String(provider.name).toUpperCase() + '_' + String(key).replace(/[A-Z]/g, (c) => '_' + c).toUpperCase();
}

function validateAmount(provider, amountMilli, currency) {
  ok(Number.isSafeInteger(amountMilli) && amountMilli > 0, 'E_PAYMENT_AMOUNT', 'amount_milli must be a positive safe integer');
  ok(amountMilli >= provider.limits.min_milli, 'E_PAYMENT_LIMIT', 'amount below provider minimum');
  ok(amountMilli <= provider.limits.max_milli, 'E_PAYMENT_LIMIT', 'amount above provider maximum');
  if (currency) {
    ok(String(currency).toUpperCase() === provider.currency, 'E_PAYMENT_CURRENCY', 'provider only supports ' + provider.currency);
  }
}

function hashPaymentEvent(fields) {
  return sha256hex(
    [
      'payment',
      fields.intent_id,
      String(fields.event_index),
      fields.event_type,
      fields.status,
      fields.provider_ref || '',
      fields.payload_json,
      fields.prev_hash,
      fields.created_at,
    ].join('\x1f'),
  );
}

function hashPaymentCallback(fields) {
  return sha256hex(
    [
      'payment-callback',
      fields.intent_id,
      fields.provider,
      fields.delivery_key,
      fields.status,
      fields.outcome,
      fields.error_code || '',
      fields.payload_json,
      fields.prev_hash,
      fields.created_at,
    ].join('\x1f'),
  );
}

function isTerminal(status) {
  return TERMINAL_STATUSES.includes(status);
}

function assertKnownStatus(status) {
  ok(CANONICAL_STATUSES.includes(status), 'E_PAYMENT_STATUS', 'invalid payment status: ' + status);
  return status;
}

function defineProviderError(provider, code, message) {
  return new DataError(code, '[' + provider.name + '] ' + message);
}

module.exports = {
  CANONICAL_STATUSES,
  TERMINAL_STATUSES,
  DIRECTIONS,
  STATUS_TRANSITIONS,
  canTransition,
  normalizeStatus,
  createProvider,
  missingCredentials,
  resolveCredentials,
  validateAmount,
  hashPaymentEvent,
  hashPaymentCallback,
  isTerminal,
  assertKnownStatus,
  defineProviderError,
};
