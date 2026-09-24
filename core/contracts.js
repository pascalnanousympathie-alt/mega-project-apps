'use strict';
const { DataError, ok, sha256hex } = require('./db');

const API_VERSION = 'v1';
const API_VERSIONS = ['v1'];
const API_PREFIX = '/api/' + API_VERSION;
const CONTRACTS_REVISION = 2;

const ERROR_STATUS = {
  E_ARG: 400,
  E_VALIDATION: 400,
  E_UNSUPPORTED_VERSION: 400,
  E_NO_ROUTE: 404,
  E_IDEMPOTENCY_KEY_REQUIRED: 400,
  E_IDEMPOTENCY_KEY_INVALID: 400,
  E_IDEMPOTENCY_CONFLICT: 409,
  E_IDEMPOTENCY_IN_PROGRESS: 409,
  E_DUPLICATE: 409,
  E_CONSTRAINT: 400,
  E_REFERENCE: 409,
  E_UNAUTHORIZED: 401,
  E_INVALID_TOKEN: 401,
  E_INVALID_SERVICE_KEY: 401,
  E_SESSION_REVOKED: 401,
  E_SESSION_EXPIRED: 401,
  E_NO_SESSION: 401,
  E_BAD_CREDENTIALS: 401,
  E_SERVICE_REVOKED: 403,
  E_FORBIDDEN: 403,
  E_USER_INACTIVE: 403,
  E_NO_USER: 404,
  E_NO_WALLET: 404,
  E_WALLET_INACTIVE: 409,
  E_WALLET_CLOSED: 409,
  E_CRYPTO_WALLET_NOT_FOUND: 404,
  E_CRYPTO_WALLET_INVALID: 400,
  E_CRYPTO_WALLET_CREATE: 409,
  E_NO_ENTRY: 404,
  E_NOT_PENDING: 409,
  E_ALREADY_SETTLED: 409,
  E_NOT_COMMITTED: 409,
  E_INSUFFICIENT_FUNDS: 409,
  E_BALANCE_OVERFLOW: 409,
  E_NO_GAME: 404,
  E_GAME_CLOSED: 409,
  E_NO_ROOM: 404,
  E_ROOM_CLOSED: 409,
  E_ROOM_FULL: 409,
  E_ALREADY_JOINED: 409,
  E_NOT_IN_ROOM: 409,
  E_INVALID_EVENT: 400,
  E_NOT_CONNECTED: 409,
  E_ALREADY_CONNECTED: 409,
  E_RATE_LIMITED: 429,
  E_NO_HANDLER: 501,
  E_NOT_IMPLEMENTED: 501,
  E_LAST_ADMIN: 409,
  E_LEDGER_LINK: 500,
  E_LEDGER_HASH: 500,
  E_GATEWAY: 500,
  E_PROVIDER_UNKNOWN: 400,
  E_PROVIDER_DISABLED: 409,
  E_PROVIDER_UNCONFIGURED: 503,
  E_PAYMENT_NOT_FOUND: 404,
  E_PAYMENT_AMOUNT: 400,
  E_PAYMENT_CURRENCY: 400,
  E_PAYMENT_LIMIT: 400,
  E_PAYMENT_STATUS: 409,
  E_PAYMENT_TRANSPORT: 502,
  E_PAYMENT_SIGNATURE: 401,
  E_PAYMENT_AMOUNT_MISMATCH: 409,
  E_PAYMENT_STATUS_CONFLICT: 409,
  E_PAYMENT_CALLBACK_UNMATCHED: 404,
  E_PAYMENT_RECONCILE: 502,
  E_PAYMENT_SECRET_LEAK: 500,
  E_PAYMENT_PROJECT_REQUIRED: 400,
  E_PAYMENT_PROJECT_INVALID: 400,
  E_NO_HOUSE_WALLET: 500,
  E_GAME_ECONOMY: 409,
  E_NO_TICKETS: 409,
  E_TAMPER: 500,
  E_NO_DRAW: 404,
  E_NO_MATCH: 404,
  E_INTERNAL: 500,
};

const RETRYABLE_CODES = new Set([
  'E_RATE_LIMITED',
  'E_IDEMPOTENCY_IN_PROGRESS',
  'E_GATEWAY',
  'E_PAYMENT_TRANSPORT',
  'E_PROVIDER_UNCONFIGURED',
  'E_PAYMENT_RECONCILE',
]);

function apiPath(pathname) {
  const suffix = String(pathname || '');
  return API_PREFIX + (suffix && suffix[0] === '/' ? suffix : '/' + suffix);
}

function statusForCode(code) {
  if (Object.prototype.hasOwnProperty.call(ERROR_STATUS, code)) return ERROR_STATUS[code];
  if (typeof code === 'string' && code.startsWith('E_')) return 400;
  return 500;
}

function isRetryable(code) {
  return RETRYABLE_CODES.has(code) || statusForCode(code) === 503;
}

function describeError(err) {
  if (err instanceof DataError) {
    const code = err.code || 'E_INTERNAL';
    return { code, message: String(err.message || code), status: statusForCode(code), retryable: isRetryable(code) };
  }
  const rawCode = err && typeof err.code === 'string' ? err.code : null;
  if (rawCode && Object.prototype.hasOwnProperty.call(ERROR_STATUS, rawCode)) {
    return {
      code: rawCode,
      message: String((err && err.message) || rawCode),
      status: statusForCode(rawCode),
      retryable: isRetryable(rawCode),
    };
  }
  return { code: 'E_INTERNAL', message: 'internal error', status: 500, retryable: false };
}

function createRequestId() {
  try {
    return require('node:crypto').randomUUID();
  } catch (_) {
    return 'req-' + Date.now();
  }
}

function successResponse(input = {}) {
  const version = input.version || API_VERSION;
  const body = { api_version: version, meta: { request_id: input.requestId || null }, data: input.data === undefined ? null : input.data };
  if (input.replayed) body.meta.idempotent_replay = true;
  return {
    status: input.status || 200,
    headers: { 'content-type': 'application/json', 'x-api-version': version },
    body,
  };
}

function errorResponse(err, input = {}) {
  const version = input.version || API_VERSION;
  const requestId = input.requestId || null;
  const info = describeError(err);
  return {
    status: info.status,
    headers: { 'content-type': 'application/json', 'x-api-version': version },
    body: {
      api_version: version,
      meta: { request_id: requestId },
      error: { code: info.code, message: info.message, status: info.status, retryable: info.retryable },
    },
  };
}

function toSocketError(err, input = {}) {
  const version = input.version || API_VERSION;
  const info = describeError(err);
  return {
    code: info.code,
    message: info.message,
    retryable: info.retryable,
    request_id: input.requestId || null,
    api_version: version,
    ...(input.event ? { event: input.event } : {}),
  };
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateSchema(schema, value, path = '$') {
  if (!schema || typeof schema !== 'object') return value;
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    throw new DataError('E_VALIDATION', path + ' must be one of: ' + schema.enum.join(', '));
  }
  const type = schema.type;
  if (type === 'object') {
    ok(isObject(value), 'E_VALIDATION', path + ' must be an object');
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      ok(Object.prototype.hasOwnProperty.call(value, key) && value[key] !== undefined, 'E_VALIDATION', path + '.' + key + ' is required');
    }
    const properties = schema.properties || {};
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        ok(Object.prototype.hasOwnProperty.call(properties, key), 'E_VALIDATION', path + '.' + key + ' is not allowed');
      }
    }
    for (const key of Object.keys(properties)) {
      if (Object.prototype.hasOwnProperty.call(value, key) && value[key] !== undefined) {
        validateSchema(properties[key], value[key], path + '.' + key);
      }
    }
    return value;
  }
  if (type === 'array') {
    ok(Array.isArray(value), 'E_VALIDATION', path + ' must be an array');
    if (Number.isInteger(schema.minItems)) ok(value.length >= schema.minItems, 'E_VALIDATION', path + ' needs at least ' + schema.minItems + ' items');
    if (Number.isInteger(schema.maxItems)) ok(value.length <= schema.maxItems, 'E_VALIDATION', path + ' allows at most ' + schema.maxItems + ' items');
    if (schema.items) value.forEach((item, i) => validateSchema(schema.items, item, path + '[' + i + ']'));
    return value;
  }
  if (type === 'string') {
    ok(typeof value === 'string', 'E_VALIDATION', path + ' must be a string');
    if (Number.isInteger(schema.minLength)) ok(value.length >= schema.minLength, 'E_VALIDATION', path + ' must be at least ' + schema.minLength + ' chars');
    if (Number.isInteger(schema.maxLength)) ok(value.length <= schema.maxLength, 'E_VALIDATION', path + ' must be at most ' + schema.maxLength + ' chars');
    if (schema.pattern) ok(new RegExp(schema.pattern).test(value), 'E_VALIDATION', path + ' format is invalid');
    return value;
  }
  if (type === 'integer') {
    ok(Number.isInteger(value), 'E_VALIDATION', path + ' must be an integer');
    if (Number.isInteger(schema.minimum)) ok(value >= schema.minimum, 'E_VALIDATION', path + ' must be >= ' + schema.minimum);
    if (Number.isInteger(schema.maximum)) ok(value <= schema.maximum, 'E_VALIDATION', path + ' must be <= ' + schema.maximum);
    return value;
  }
  if (type === 'number') {
    ok(typeof value === 'number' && Number.isFinite(value), 'E_VALIDATION', path + ' must be a number');
    if (typeof schema.minimum === 'number') ok(value >= schema.minimum, 'E_VALIDATION', path + ' must be >= ' + schema.minimum);
    if (typeof schema.maximum === 'number') ok(value <= schema.maximum, 'E_VALIDATION', path + ' must be <= ' + schema.maximum);
    return value;
  }
  if (type === 'boolean') {
    ok(typeof value === 'boolean', 'E_VALIDATION', path + ' must be a boolean');
    return value;
  }
  if (type === 'null') {
    ok(value === null, 'E_VALIDATION', path + ' must be null');
    return value;
  }
  return value;
}

const AUTH_BODY = {
  type: 'object',
  required: ['identity', 'password'],
  properties: {
    identity: { type: 'string', minLength: 3, maxLength: 120 },
    password: { type: 'string', minLength: 8, maxLength: 128 },
  },
  additionalProperties: false,
};

const WALLET_ID_PARAMS = {
  type: 'object',
  required: ['walletId'],
  properties: { walletId: { type: 'string', minLength: 1 } },
};

const CRYPTO_WALLET_ID_PARAMS = {
  type: 'object',
  required: ['cryptoWalletId'],
  properties: { cryptoWalletId: { type: 'string', minLength: 1 } },
};

const CRYPTO_WALLET_BODY = {
  type: 'object',
  required: ['provider', 'asset', 'network', 'address'],
  properties: {
    provider: { type: 'string', enum: ['metamask', 'trust_wallet', 'coinbase_wallet', 'walletconnect', 'ledger', 'trezor', 'other'] },
    asset: { type: 'string', pattern: '^[A-Z][A-Z0-9._-]{1,31}$' },
    network: { type: 'string', enum: ['bitcoin', 'ethereum', 'tron', 'polygon', 'bsc', 'arbitrum', 'optimism', 'base', 'solana'] },
    address: { type: 'string', minLength: 20, maxLength: 160 },
    address_memo: { type: 'string', maxLength: 120 },
    label: { type: 'string', maxLength: 80 },
  },
  additionalProperties: false,
};

const REST_ROUTES = [
  {
    id: 'health.get',
    version: API_VERSION,
    method: 'GET',
    path: '/health',
    auth: 'public',
    idempotent: false,
    query: { type: 'object' },
    response: { type: 'object' },
  },
  {
    id: 'ready.get',
    version: API_VERSION,
    method: 'GET',
    path: '/ready',
    auth: 'public',
    idempotent: false,
    query: { type: 'object' },
    response: { type: 'object' },
  },
  {
    id: 'metrics.get',
    version: API_VERSION,
    method: 'GET',
    path: '/metrics',
    auth: 'service',
    scope: 'metrics:read',
    idempotent: false,
    query: { type: 'object' },
    response: { type: 'object' },
  },
  {
    id: 'auth.register',
    version: API_VERSION,
    method: 'POST',
    path: '/auth/register',
    auth: 'public',
    idempotent: false,
    body: {
      type: 'object',
      required: ['username', 'password'],
      properties: {
        username: { type: 'string', pattern: '^[A-Za-z0-9_.]{3,32}$' },
        password: { type: 'string', minLength: 8, maxLength: 128 },
        phone: { type: 'string', pattern: '^\\+?[0-9]{8,15}$' },
        email: { type: 'string', pattern: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$' },
      },
      additionalProperties: false,
    },
    response: { type: 'object' },
  },
  {
    id: 'auth.login',
    version: API_VERSION,
    method: 'POST',
    path: '/auth/login',
    auth: 'public',
    idempotent: false,
    body: AUTH_BODY,
    response: { type: 'object' },
  },
  {
    id: 'auth.logout',
    version: API_VERSION,
    method: 'POST',
    path: '/auth/logout',
    auth: 'bearer',
    idempotent: false,
    body: { type: 'object', additionalProperties: false },
    response: { type: 'object' },
  },
  {
    id: 'users.me',
    version: API_VERSION,
    method: 'GET',
    path: '/users/me',
    auth: 'bearer',
    idempotent: false,
    query: { type: 'object' },
    response: { type: 'object' },
  },
  {
    id: 'wallets.create',
    version: API_VERSION,
    method: 'POST',
    path: '/wallets',
    auth: 'bearer',
    idempotent: true,
    body: { type: 'object', properties: { currency: { type: 'string', enum: ['MGA'] } }, additionalProperties: false },
    response: { type: 'object' },
  },
  {
    id: 'wallets.get',
    version: API_VERSION,
    method: 'GET',
    path: '/wallets/:walletId',
    auth: 'bearer',
    idempotent: false,
    params: WALLET_ID_PARAMS,
    response: { type: 'object' },
  },
  {
    id: 'wallets.entries',
    version: API_VERSION,
    method: 'GET',
    path: '/wallets/:walletId/entries',
    auth: 'bearer',
    idempotent: false,
    params: WALLET_ID_PARAMS,
    query: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 500 } } },
    response: { type: 'array' },
  },
  {
    id: 'wallets.transfers',
    version: API_VERSION,
    method: 'POST',
    path: '/wallets/:walletId/transfers',
    auth: 'bearer',
    idempotent: true,
    params: WALLET_ID_PARAMS,
    body: {
      type: 'object',
      required: ['target_wallet_id', 'amount_milli'],
      properties: {
        target_wallet_id: { type: 'string', minLength: 1 },
        amount_milli: { type: 'integer', minimum: 1 },
        idempotency_key: { type: 'string', minLength: 1 },
      },
      additionalProperties: false,
    },
    response: { type: 'object' },
  },
  {
    id: 'crypto-wallets.list',
    version: API_VERSION,
    method: 'GET',
    path: '/crypto/wallets',
    auth: 'bearer',
    idempotent: false,
    query: { type: 'object' },
    response: { type: 'array' },
  },
  {
    id: 'crypto.currencies',
    version: API_VERSION,
    method: 'GET',
    path: '/crypto/currencies',
    auth: 'bearer',
    idempotent: false,
    query: { type: 'object' },
    response: { type: 'object' },
  },
  {
    id: 'crypto-wallets.create',
    version: API_VERSION,
    method: 'POST',
    path: '/crypto/wallets',
    auth: 'bearer',
    idempotent: true,
    body: CRYPTO_WALLET_BODY,
    response: { type: 'object' },
  },
  {
    id: 'crypto-wallets.disable',
    version: API_VERSION,
    method: 'DELETE',
    path: '/crypto/wallets/:cryptoWalletId',
    auth: 'bearer',
    idempotent: false,
    params: CRYPTO_WALLET_ID_PARAMS,
    body: { type: 'object', additionalProperties: false },
    response: { type: 'object' },
  },
  {
    id: 'ledger.entries',
    version: API_VERSION,
    method: 'GET',
    path: '/ledger/entries',
    auth: 'service',
    scope: 'ledger:read',
    idempotent: false,
    query: { type: 'object', properties: { wallet_id: { type: 'string', minLength: 1 } } },
    response: { type: 'array' },
  },
  {
    id: 'rooms.list',
    version: API_VERSION,
    method: 'GET',
    path: '/rooms',
    auth: 'bearer',
    idempotent: false,
    query: { type: 'object', properties: { status: { type: 'string', enum: ['waiting', 'active', 'closed'] } } },
    response: { type: 'array' },
  },
  {
    id: 'rooms.create',
    version: API_VERSION,
    method: 'POST',
    path: '/rooms',
    auth: 'bearer',
    idempotent: true,
    body: {
      type: 'object',
      required: ['game_id', 'name'],
      properties: {
        game_id: { type: 'string', minLength: 1 },
        name: { type: 'string', minLength: 1, maxLength: 60 },
        capacity: { type: 'integer', minimum: 1, maximum: 30 },
      },
      additionalProperties: false,
    },
    response: { type: 'object' },
  },
  {
    id: 'payments.providers',
    version: API_VERSION,
    method: 'GET',
    path: '/payments/providers',
    auth: 'bearer',
    idempotent: false,
    query: { type: 'object', properties: { project: { type: 'string', enum: ['domino', 'loto', 'rami'] } } },
    response: { type: 'array' },
  },
  {
    id: 'payments.create',
    version: API_VERSION,
    method: 'POST',
    path: '/payments/intents',
    auth: 'bearer',
    idempotent: true,
    body: {
      type: 'object',
      required: ['provider', 'amount_milli'],
      properties: {
        provider: { type: 'string', enum: ['mvola', 'airtel', 'orange', 'binance', 'nowpayments', 'nowpayments-sandbox'] },
        project: { type: 'string', enum: ['domino', 'loto', 'rami'] },
        direction: { type: 'string', enum: ['payin'] },
        amount_milli: { type: 'integer', minimum: 1 },
        currency: { type: 'string', enum: ['MGA', 'USD', 'USDT'] },
        pay_currency: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]{1,31}$' },
        wallet_id: { type: 'string', minLength: 1 },
        reference: { type: 'string', minLength: 1, maxLength: 128 },
        idempotency_key: { type: 'string', minLength: 1, maxLength: 128 },
        customer: {
          type: 'object',
          properties: {
            msisdn: { type: 'string', minLength: 8, maxLength: 20 },
            phone: { type: 'string', minLength: 8, maxLength: 20 },
            account: { type: 'string', minLength: 1, maxLength: 80 },
          },
          additionalProperties: false,
        },
        msisdn: { type: 'string', minLength: 8, maxLength: 20 },
        phone: { type: 'string', minLength: 8, maxLength: 20 },
        description: { type: 'string', minLength: 1, maxLength: 240 },
        return_url: { type: 'string', minLength: 1, maxLength: 2048, pattern: '^https?://[^\\s]+$' },
        cancel_url: { type: 'string', minLength: 1, maxLength: 2048, pattern: '^https?://[^\\s]+$' },
      },
      additionalProperties: false,
    },
    response: { type: 'object' },
  },
  {
    id: 'payments.get',
    version: API_VERSION,
    method: 'GET',
    path: '/payments/intents/:intentId',
    auth: 'bearer',
    idempotent: false,
    params: {
      type: 'object',
      required: ['intentId'],
      properties: { intentId: { type: 'string', minLength: 1 } },
    },
    response: { type: 'object' },
  },
  {
    id: 'payments.events',
    version: API_VERSION,
    method: 'GET',
    path: '/payments/intents/:intentId/events',
    auth: 'service',
    scope: 'payments:reconcile',
    idempotent: false,
    params: {
      type: 'object',
      required: ['intentId'],
      properties: { intentId: { type: 'string', minLength: 1 } },
    },
    response: { type: 'array' },
  },
  {
    id: 'payments.callback',
    version: API_VERSION,
    method: 'POST',
    path: '/payments/callback/:provider',
    auth: 'public',
    idempotent: false,
    params: {
      type: 'object',
      required: ['provider'],
      properties: { provider: { type: 'string', enum: ['mvola', 'airtel', 'orange', 'binance', 'nowpayments', 'nowpayments-sandbox'] } },
    },
    body: { type: 'object', additionalProperties: true },
    response: { type: 'object' },
  },
  {
    id: 'payments.callbacks',
    version: API_VERSION,
    method: 'GET',
    path: '/payments/intents/:intentId/callbacks',
    auth: 'service',
    scope: 'payments:reconcile',
    idempotent: false,
    params: {
      type: 'object',
      required: ['intentId'],
      properties: { intentId: { type: 'string', minLength: 1 } },
    },
    response: { type: 'array' },
  },
  {
    id: 'payments.reconciliations',
    version: API_VERSION,
    method: 'GET',
    path: '/payments/intents/:intentId/reconciliations',
    auth: 'service',
    scope: 'payments:reconcile',
    idempotent: false,
    params: {
      type: 'object',
      required: ['intentId'],
      properties: { intentId: { type: 'string', minLength: 1 } },
    },
    response: { type: 'array' },
  },
  {
    id: 'payments.reconcile',
    version: API_VERSION,
    method: 'POST',
    path: '/payments/intents/:intentId/reconcile',
    auth: 'service',
    scope: 'payments:reconcile',
    idempotent: true,
    params: {
      type: 'object',
      required: ['intentId'],
      properties: { intentId: { type: 'string', minLength: 1 } },
    },
    body: { type: 'object', additionalProperties: false },
    response: { type: 'object' },
  },
  {
    id: 'payments.reconcilePending',
    version: API_VERSION,
    method: 'POST',
    path: '/payments/reconcile',
    auth: 'service',
    scope: 'payments:reconcile',
    idempotent: true,
    body: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 500 },
        provider: { type: 'string', enum: ['mvola', 'airtel', 'orange', 'binance', 'nowpayments', 'nowpayments-sandbox'] },
        expire_after_ms: { type: 'integer', minimum: 1, maximum: 31536000000 },
      },
      additionalProperties: false,
    },
    response: { type: 'object' },
  },
  {
    id: 'games.economy',
    version: API_VERSION,
    method: 'GET',
    path: '/games/:gameId/economy',
    auth: 'service',
    scope: 'ledger:read',
    idempotent: false,
    params: {
      type: 'object',
      required: ['gameId'],
      properties: { gameId: { type: 'string', minLength: 1 } },
    },
    query: { type: 'object', properties: { kind: { type: 'string', enum: ['domino', 'loto', 'rami'] } } },
    response: { type: 'object' },
  },
  {
    id: 'loto.refund',
    version: API_VERSION,
    method: 'POST',
    path: '/loto/draws/:drawId/refund',
    auth: 'bearer',
    idempotent: true,
    params: {
      type: 'object',
      required: ['drawId'],
      properties: { drawId: { type: 'string', minLength: 1 } },
    },
    body: { type: 'object', additionalProperties: false },
    response: { type: 'object' },
  },
  {
    id: 'localRecords.list',
    version: API_VERSION,
    method: 'GET',
    path: '/local-records',
    auth: 'bearer',
    idempotent: false,
    query: {
      type: 'object',
      properties: {
        game_kind: { type: 'string', enum: ['domino', 'loto', 'rami'] },
        session_type: { type: 'string', enum: ['offline', 'manual'] },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
      },
    },
    response: { type: 'array' },
  },
  {
    id: 'localRecords.record',
    version: API_VERSION,
    method: 'POST',
    path: '/local-records',
    auth: 'bearer',
    idempotent: true,
    body: {
      type: 'object',
      required: ['game_kind', 'session_type', 'rule', 'players', 'scores'],
      properties: {
        game_kind: { type: 'string', enum: ['domino', 'loto', 'rami'] },
        session_type: { type: 'string', enum: ['manual'] },
        rule: { type: 'string', enum: ['high', 'low'] },
        players: {
          type: 'array',
          minItems: 2,
          maxItems: 8,
          items: {
            type: 'object',
            required: ['user_id', 'seat'],
            properties: {
              user_id: { type: 'string', minLength: 1, maxLength: 80 },
              seat: { type: 'integer', minimum: 1, maximum: 30 },
              name: { type: 'string', minLength: 1, maxLength: 40 },
            },
            additionalProperties: false,
          },
        },
        scores: {
          type: 'array',
          minItems: 2,
          maxItems: 8,
          items: {
            type: 'object',
            required: ['user_id', 'value'],
            properties: {
              user_id: { type: 'string', minLength: 1, maxLength: 80 },
              value: { type: 'integer', minimum: -1000000, maximum: 1000000 },
            },
            additionalProperties: false,
          },
        },
        seed: { type: 'string', minLength: 1, maxLength: 128 },
        client_ref: { type: 'string', minLength: 1, maxLength: 80 },
      },
      additionalProperties: false,
    },
    response: { type: 'object' },
  },
  {
    id: 'localRecords.import',
    version: API_VERSION,
    method: 'POST',
    path: '/local-records/import',
    auth: 'bearer',
    idempotent: true,
    body: {
      type: 'object',
      required: ['game_kind', 'match_id'],
      properties: {
        game_kind: { type: 'string', enum: ['domino', 'loto', 'rami'] },
        match_id: { type: 'string', minLength: 1, maxLength: 80 },
      },
      additionalProperties: false,
    },
    response: { type: 'object' },
  },
  {
    id: 'localRecords.verify',
    version: API_VERSION,
    method: 'GET',
    path: '/local-records/verify',
    auth: 'service',
    scope: 'ledger:read',
    idempotent: false,
    query: { type: 'object' },
    response: { type: 'object' },
  },
];

const WS_CLIENT_CONTRACTS = {
  'gateway:ping': { payload: null, summary: 'liveness probe answered with gateway:pong' },
  'room:list': { payload: null, summary: 'list waiting rooms' },
  'room:join': {
    summary: 'join or resume a room seat',
    payload: {
      type: 'object',
      required: ['roomId'],
      properties: { roomId: { type: 'string', minLength: 1 }, resume: { type: 'boolean' } },
      additionalProperties: true,
    },
  },
  'room:leave': { payload: null, summary: 'leave the current room' },
  'room:ready': {
    summary: 'set the authoritative ready flag',
    payload: { type: 'object', required: ['ready'], properties: { ready: { type: 'boolean' } }, additionalProperties: true },
  },
  'room:start': { payload: null, summary: 'host starts the room' },
  'room:close': { payload: null, summary: 'host closes the room' },
  'room:state': { payload: null, summary: 'pull authoritative room state' },
  'game:event': {
    summary: 'authoritative game action forwarded to the room engine',
    payload: { type: 'object' },
  },
};

const WS_SERVER_CONTRACTS = {
  connected: { payload: { type: 'object', required: ['connection_id', 'user_id', 'resumed', 'reconnect_token'] } },
  error: { payload: { type: 'object', required: ['code', 'message'] } },
  'gateway:pong': { payload: { type: 'object', required: ['ts'] } },
  'room:list': { payload: { type: 'object', required: ['rooms'] } },
  'room:joined': { payload: { type: 'object', required: ['room', 'players', 'state'] } },
  'room:left': { payload: { type: 'object', required: ['room_id'] } },
  'room:closed': { payload: { type: 'object', required: ['room_id'] } },
  'room:presence': { payload: { type: 'object', required: ['room_id', 'players'] } },
  'room:state': { payload: { type: 'object', required: ['room', 'players', 'state'] } },
  'room:started': { payload: { type: 'object', required: ['room', 'players', 'state'] } },
};

function routeById(id) {
  return REST_ROUTES.find((r) => r.id === id) || null;
}

function splitPath(value) {
  return String(value || '/')
    .replace(/[?#].*$/, '')
    .split('/')
    .filter(Boolean);
}

function pathVersion(pathname) {
  const parts = splitPath(pathname);
  if (parts[0] === 'api' && parts.length > 1 && /^v[0-9]+$/.test(parts[1])) return parts[1];
  if (parts.length > 1 && API_VERSIONS.includes(parts[0])) return parts[0];
  return null;
}

function stripVersionPrefix(version, pathname) {
  const parts = splitPath(pathname);
  if (parts[0] === 'api' && parts[1] === version) return '/' + parts.slice(2).join('/');
  if (parts[0] === version && API_VERSIONS.includes(parts[0])) return '/' + parts.slice(1).join('/');
  return pathname;
}

function matchRoute(version, method, pathname) {
  const want = splitPath(stripVersionPrefix(version, pathname));
  const verb = String(method || '').toUpperCase();
  for (const route of REST_ROUTES) {
    if (route.version !== version) continue;
    if (route.method !== verb) continue;
    const segments = splitPath(route.path);
    if (segments.length !== want.length) continue;
    const matched = {};
    let hit = true;
    for (let i = 0; i < segments.length; i += 1) {
      if (segments[i].charAt(0) === ':') {
        matched[segments[i].slice(1)] = decodeURIComponent(want[i]);
      } else if (segments[i] !== want[i]) {
        hit = false;
        break;
      }
    }
    if (hit) return { ...route, matched_params: matched };
  }
  return null;
}

function validateClientEvent(event, payload) {
  const contract = WS_CLIENT_CONTRACTS[event];
  if (!contract) throw new DataError('E_INVALID_EVENT', 'unknown event: ' + event);
  if (contract.payload) {
    const value = payload === undefined || payload === null ? {} : payload;
    validateSchema(contract.payload, value, 'payload');
  }
  return true;
}

const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_.:-]{8,128}$/;

function idempotencyKeyFrom(headers) {
  const source = headers || {};
  const raw =
    source['idempotency-key'] !== undefined
      ? source['idempotency-key']
      : source['Idempotency-Key'];
  if (raw === undefined || raw === null || raw === '') return null;
  const key = String(raw).trim();
  if (!IDEMPOTENCY_KEY_RE.test(key)) {
    throw new DataError('E_IDEMPOTENCY_KEY_INVALID', 'idempotency key must be 8-128 url-safe characters');
  }
  return key;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isObject(value)) {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
    return out;
  }
  return value === undefined ? null : value;
}

function fingerprintRequest(method, pathname, body) {
  return sha256hex(JSON.stringify([String(method || '').toUpperCase(), String(pathname || ''), canonicalize(body)]));
}

class IdempotencyStore {
  constructor(options = {}) {
    this.ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs > 0 ? options.ttlMs : 24 * 60 * 60 * 1000;
    this.maxEntries = Number.isInteger(options.maxEntries) && options.maxEntries > 0 ? options.maxEntries : 10000;
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.entries = new Map();
  }

  get size() {
    return this.entries.size;
  }

  gc() {
    const cutoff = this.now() - this.ttlMs;
    for (const [key, entry] of this.entries) {
      if (entry.at <= cutoff) this.entries.delete(key);
    }
    if (this.entries.size > this.maxEntries) {
      const overflow = this.entries.size - this.maxEntries;
      let removed = 0;
      for (const key of this.entries.keys()) {
        this.entries.delete(key);
        removed += 1;
        if (removed >= overflow) break;
      }
    }
    return this.entries.size;
  }

  begin(key, fingerprint) {
    ok(typeof key === 'string' && key.length > 0, 'E_ARG', 'idempotency key required');
    ok(typeof fingerprint === 'string' && fingerprint.length > 0, 'E_ARG', 'request fingerprint required');
    this.gc();
    const existing = this.entries.get(key);
    if (!existing) {
      this.entries.set(key, { fingerprint, state: 'in_progress', at: this.now(), response: null });
      this.gc();
      return { state: 'new' };
    }
    if (existing.fingerprint !== fingerprint) {
      throw new DataError('E_IDEMPOTENCY_CONFLICT', 'idempotency key reused with a different request');
    }
    if (existing.state === 'in_progress') {
      throw new DataError('E_IDEMPOTENCY_IN_PROGRESS', 'a request with this idempotency key is already in progress');
    }
    return { state: 'replay', response: existing.response };
  }

  complete(key, fingerprint, response) {
    const entry = this.entries.get(key);
    if (!entry || entry.fingerprint !== fingerprint) {
      throw new DataError('E_IDEMPOTENCY_CONFLICT', 'idempotency key is not reserved for this request');
    }
    entry.state = 'completed';
    entry.response = response === undefined ? null : response;
    entry.at = this.now();
    return entry.response;
  }

  release(key, fingerprint) {
    const entry = this.entries.get(key);
    if (entry && entry.fingerprint === fingerprint) this.entries.delete(key);
    return true;
  }
}

function handleRestRequest(input = {}) {
  const requestId = input.requestId || createRequestId();
  const version = input.version || API_VERSION;
  try {
    ok(API_VERSIONS.includes(version), 'E_UNSUPPORTED_VERSION', 'unsupported api version: ' + version);
    const pathVer = pathVersion(input.path);
    ok(
      !pathVer || API_VERSIONS.includes(pathVer),
      'E_UNSUPPORTED_VERSION',
      'unsupported api version in path: ' + pathVer,
    );
    const route = matchRoute(version, input.method, input.path);
    ok(route, 'E_NO_ROUTE', 'no route for ' + String(input.method || '').toUpperCase() + ' ' + String(input.path || ''));
    const params = input.params || route.matched_params || {};
    const query = input.query || {};
    const body = input.body === undefined ? {} : input.body;
    validateSchema(route.params || null, params, 'params');
    validateSchema(route.query || null, query, 'query');
    validateSchema(route.body || null, body, 'body');

    let idempotencyKey = null;
    if (route.idempotent) {
      idempotencyKey = idempotencyKeyFrom(input.headers);
      ok(idempotencyKey, 'E_IDEMPOTENCY_KEY_REQUIRED', 'this route requires an Idempotency-Key header');
    }

    const context = { route, params, query, body, headers: input.headers || {}, requestId, version };
    const runHandler = () =>
      typeof input.handler === 'function' ? input.handler(context) : undefined;
    const isThenable = (value) => !!value && typeof value.then === 'function';

    if (!idempotencyKey || !input.idempotency) {
      const sync = runHandler();
      if (!isThenable(sync)) {
        return successResponse({ version, requestId, data: sync });
      }
      return Promise.resolve(sync).then(
        (data) => successResponse({ version, requestId, data }),
        (err) => errorResponse(err, { version, requestId }),
      );
    }

    const fingerprint = fingerprintRequest(input.method, route.path, body);
    const begin = input.idempotency.begin(idempotencyKey, fingerprint);
    if (begin.state === 'replay') {
      return successResponse({ version, requestId, data: begin.response, replayed: true });
    }
    const finishAsync = (pending) =>
      Promise.resolve(pending).then(
        (data) => {
          input.idempotency.complete(idempotencyKey, fingerprint, data === undefined ? null : data);
          return successResponse({ version, requestId, data });
        },
        (err) => {
          input.idempotency.release(idempotencyKey, fingerprint);
          return errorResponse(err, { version, requestId });
        },
      );
    let data;
    try {
      data = runHandler();
    } catch (err) {
      input.idempotency.release(idempotencyKey, fingerprint);
      throw err;
    }
    if (isThenable(data)) return finishAsync(data);
    try {
      input.idempotency.complete(idempotencyKey, fingerprint, data === undefined ? null : data);
    } catch (err) {
      input.idempotency.release(idempotencyKey, fingerprint);
      throw err;
    }
    return successResponse({ version, requestId, data });
  } catch (err) {
    return errorResponse(err, { version, requestId });
  }
}

function surface() {
  return {
    api_version: API_VERSION,
    api_versions: [...API_VERSIONS],
    api_prefix: API_PREFIX,
    revision: CONTRACTS_REVISION,
    rest: REST_ROUTES.map((r) => ({ id: r.id, version: r.version, method: r.method, path: r.path, auth: r.auth, idempotent: r.idempotent })),
    websocket_client: Object.keys(WS_CLIENT_CONTRACTS),
    websocket_server: Object.keys(WS_SERVER_CONTRACTS),
  };
}

function createIdempotencyStore(options) {
  return new IdempotencyStore(options);
}

module.exports = {
  API_VERSION,
  API_VERSIONS,
  API_PREFIX,
  CONTRACTS_REVISION,
  ERROR_STATUS,
  REST_ROUTES,
  WS_CLIENT_CONTRACTS,
  WS_SERVER_CONTRACTS,
  IdempotencyStore,
  apiPath,
  statusForCode,
  isRetryable,
  describeError,
  createRequestId,
  successResponse,
  errorResponse,
  toSocketError,
  validateSchema,
  routeById,
  matchRoute,
  pathVersion,
  stripVersionPrefix,
  validateClientEvent,
  idempotencyKeyFrom,
  fingerprintRequest,
  handleRestRequest,
  surface,
  createIdempotencyStore,
};
