'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { DataError } = require('../core/db');
const {
  API_VERSION,
  API_VERSIONS,
  API_PREFIX,
  REST_ROUTES,
  WS_CLIENT_CONTRACTS,
  WS_SERVER_CONTRACTS,
  IdempotencyStore,
  apiPath,
  statusForCode,
  describeError,
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
} = require('../core/contracts');
const { makeDataLayer } = require('./helpers');

function expectValidationError(fn) {
  assert.throws(fn, (err) => err instanceof DataError && err.code === 'E_VALIDATION');
}

test('contract registry is versioned, unique and complete', () => {
  assert.equal(API_VERSION, 'v1');
  assert.deepEqual(API_VERSIONS, ['v1']);
  assert.equal(API_PREFIX, '/api/v1');
  assert.equal(apiPath('/health'), '/api/v1/health');
  assert.equal(apiPath('health'), '/api/v1/health');

  const ids = REST_ROUTES.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(REST_ROUTES.length >= 10);
  for (const route of REST_ROUTES) {
    assert.equal(route.version, API_VERSION);
    assert.match(route.method, /^[A-Z]+$/);
    assert.ok(route.path.startsWith('/'));
    assert.ok(['public', 'bearer', 'service'].includes(route.auth));
    assert.equal(typeof route.idempotent, 'boolean');
  }
  assert.equal(routeById('health.get').auth, 'public');
  assert.equal(routeById('wallets.transfers').idempotent, true);
  assert.ok(routeById('wallets.transfers').body.required.includes('amount_milli'));
  assert.equal(routeById('ledger.entries').auth, 'service');

  const view = surface();
  assert.equal(view.api_version, API_VERSION);
  assert.equal(view.api_prefix, API_PREFIX);
  assert.equal(view.rest.length, REST_ROUTES.length);
  assert.ok(view.websocket_client.includes('room:join'));
  assert.ok(view.websocket_server.includes('error'));
});

test('matchRoute resolves versioned paths and captures params', () => {
  assert.equal(matchRoute('v1', 'POST', '/auth/login').id, 'auth.login');
  assert.equal(matchRoute('v1', 'get', '/health?verbose=1').id, 'health.get');
  const wallet = matchRoute('v1', 'GET', '/wallets/abc-123');
  assert.equal(wallet.id, 'wallets.get');
  assert.equal(wallet.matched_params.walletId, 'abc-123');
  const entries = matchRoute('v1', 'GET', '/wallets/abc-123/entries');
  assert.equal(entries.id, 'wallets.entries');
  assert.equal(entries.matched_params.walletId, 'abc-123');
  assert.equal(matchRoute('v2', 'GET', '/health'), null);
  assert.equal(matchRoute('v1', 'GET', '/health/deep'), null);
  assert.equal(matchRoute('v1', 'DELETE', '/health'), null);
});

test('prefixed api paths resolve to the same versioned contracts', () => {
  assert.equal(pathVersion('/api/v1/health'), 'v1');
  assert.equal(pathVersion('/api/health'), null);
  assert.equal(pathVersion('/v1/health'), 'v1');
  assert.equal(pathVersion('/health'), null);
  assert.equal(stripVersionPrefix('v1', '/api/v1/health'), '/health');
  assert.equal(stripVersionPrefix('v1', '/v1/health'), '/health');
  assert.equal(stripVersionPrefix('v1', '/health'), '/health');

  assert.equal(matchRoute('v1', 'GET', apiPath('/health')).id, 'health.get');
  assert.equal(matchRoute('v1', 'POST', apiPath('/auth/login')).id, 'auth.login');
  const wallet = matchRoute('v1', 'GET', apiPath('/wallets/abc-123'));
  assert.equal(wallet.id, 'wallets.get');
  assert.equal(wallet.matched_params.walletId, 'abc-123');
  assert.equal(matchRoute('v1', 'GET', '/api/v2/health'), null);
  assert.equal(matchRoute('v1', 'GET', '/api/v1/health/deep'), null);
});

test('error responses follow the shared error schema', () => {
  assert.equal(statusForCode('E_NO_WALLET'), 404);
  assert.equal(statusForCode('E_RATE_LIMITED'), 429);
  assert.equal(statusForCode('E_NOT_IN_ROOM'), 409);
  assert.equal(statusForCode('E_MADE_UP_CODE'), 400);
  assert.equal(statusForCode('E_GATEWAY'), 500);

  const known = describeError(new DataError('E_INSUFFICIENT_FUNDS', 'not enough'));
  assert.deepEqual(known, { code: 'E_INSUFFICIENT_FUNDS', message: 'not enough', status: 409, retryable: false });
  const unknown = describeError(new Error('boom: internal detail'));
  assert.deepEqual(unknown, { code: 'E_INTERNAL', message: 'internal error', status: 500, retryable: false });

  const res = errorResponse(new DataError('E_FORBIDDEN', 'nope'), { requestId: 'req-1' });
  assert.equal(res.status, 403);
  assert.equal(res.headers['x-api-version'], API_VERSION);
  assert.equal(res.body.api_version, API_VERSION);
  assert.equal(res.body.meta.request_id, 'req-1');
  assert.equal(res.body.error.code, 'E_FORBIDDEN');
  assert.equal(res.body.error.status, 403);

  const ok = successResponse({ data: { hello: 'world' }, requestId: 'req-2' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.data.hello, 'world');
  assert.equal(ok.body.meta.request_id, 'req-2');

  const socketErr = toSocketError(new DataError('E_RATE_LIMITED', 'slow down'), { event: 'room:join', requestId: 'req-3' });
  assert.equal(socketErr.code, 'E_RATE_LIMITED');
  assert.equal(socketErr.retryable, true);
  assert.equal(socketErr.api_version, API_VERSION);
  assert.equal(socketErr.event, 'room:join');
  assert.equal(socketErr.request_id, 'req-3');
});

test('schema validation enforces types, required fields and bounds', () => {
  const schema = {
    type: 'object',
    required: ['name', 'amount_milli', 'mode'],
    properties: {
      name: { type: 'string', minLength: 2, maxLength: 10, pattern: '^[a-z]+$' },
      amount_milli: { type: 'integer', minimum: 1, maximum: 100 },
      mode: { type: 'string', enum: ['quick', 'classic'] },
      tags: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
    },
    additionalProperties: false,
  };
  assert.equal(validateSchema(schema, { name: 'abi', amount_milli: 5, mode: 'quick' }).name, 'abi');
  expectValidationError(() => validateSchema(schema, { amount_milli: 5, mode: 'quick' }));
  expectValidationError(() => validateSchema(schema, { name: 'abi', amount_milli: 0, mode: 'quick' }));
  expectValidationError(() => validateSchema(schema, { name: 'abi', amount_milli: 5, mode: 'other' }));
  expectValidationError(() => validateSchema(schema, { name: 'A', amount_milli: 5, mode: 'quick' }));
  expectValidationError(() => validateSchema(schema, { name: 'abi', amount_milli: 5, mode: 'quick', extra: 1 }));
  expectValidationError(() => validateSchema(schema, { name: 'abi', amount_milli: 5, mode: 'quick', tags: [] }));
  assert.equal(validateSchema(null, 'anything'), 'anything');
});

test('payment intent contract accepts supported fields and rejects credential-shaped extras', () => {
  const route = routeById('payments.create');
  const body = {
    provider: 'mvola',
    amount_milli: 25000,
    currency: 'MGA',
    reference: 'p20-ref-0001',
    idempotency_key: 'p20-idem-0001',
    customer: { msisdn: '0340123456' },
    description: 'P20 security test',
    return_url: 'https://example.test/return',
    cancel_url: 'https://example.test/cancel',
  };
  assert.equal(validateSchema(route.body, body), body);
  expectValidationError(() => validateSchema(route.body, { ...body, consumerSecret: 'should-not-enter-api' }));
  expectValidationError(() => validateSchema(route.body, { ...body, return_url: 'javascript:alert(1)' }));
  expectValidationError(() => validateSchema(route.body, { ...body, customer: { msisdn: '0340123456', apiKey: 'secret' } }));
});

test('websocket client events are validated against shared contracts', () => {
  assert.ok(WS_CLIENT_CONTRACTS['room:join']);
  assert.equal(validateClientEvent('gateway:ping'), true);
  assert.equal(validateClientEvent('room:join', { roomId: 'room-1' }), true);
  assert.equal(validateClientEvent('room:ready', { ready: true }), true);
  expectValidationError(() => validateClientEvent('room:join', {}));
  expectValidationError(() => validateClientEvent('room:ready', { ready: 'yes' }));
  assert.throws(
    () => validateClientEvent('bogus:event', {}),
    (err) => err instanceof DataError && err.code === 'E_INVALID_EVENT',
  );
  assert.throws(() => validateSchema(WS_SERVER_CONTRACTS.error.payload, {}), (err) => err.code === 'E_VALIDATION');
});

test('idempotency keys, fingerprints and store replay semantics', () => {
  assert.equal(idempotencyKeyFrom({}), null);
  assert.equal(idempotencyKeyFrom({ 'Idempotency-Key': '  key-12345  ' }), 'key-12345');
  assert.throws(
    () => idempotencyKeyFrom({ 'idempotency-key': 'short' }),
    (err) => err.code === 'E_IDEMPOTENCY_KEY_INVALID',
  );

  const a = fingerprintRequest('POST', '/api/v1/x', { b: 1, a: [2, { z: 3 }] });
  const b = fingerprintRequest('post', '/api/v1/x', { a: [2, { z: 3 }], b: 1 });
  assert.equal(a, b);
  assert.notEqual(a, fingerprintRequest('POST', '/api/v1/x', { a: 1, b: 1 }));
  assert.notEqual(a, fingerprintRequest('PUT', '/api/v1/x', { a: 1, b: 1 }));

  const store = new IdempotencyStore();
  const first = store.begin('key-aaaaaaaa', a);
  assert.equal(first.state, 'new');
  assert.throws(() => store.begin('key-aaaaaaaa', a), (err) => err.code === 'E_IDEMPOTENCY_IN_PROGRESS');
  store.complete('key-aaaaaaaa', a, { id: 7 });
  const replay = store.begin('key-aaaaaaaa', a);
  assert.equal(replay.state, 'replay');
  assert.deepEqual(replay.response, { id: 7 });
  assert.throws(
    () => store.begin('key-aaaaaaaa', fingerprintRequest('POST', '/api/v1/y', {})),
    (err) => err.code === 'E_IDEMPOTENCY_CONFLICT',
  );
  store.release('key-aaaaaaaa', a);
  assert.equal(store.begin('key-aaaaaaaa', a).state, 'new');

  const clock = { t: 1000 };
  const ttlStore = new IdempotencyStore({ ttlMs: 100, now: () => clock.t, maxEntries: 2 });
  ttlStore.begin('key-bbbbbbbb', 'fp');
  clock.t += 101;
  assert.equal(ttlStore.begin('key-bbbbbbbb', 'fp').state, 'new');
  ttlStore.begin('key-cccccccc', 'fp');
  ttlStore.begin('key-dddddddd', 'fp');
  assert.ok(ttlStore.size <= 2);
});

test('handleRestRequest wires validation, idempotency and error mapping', () => {
  const store = new IdempotencyStore();
  let calls = 0;
  const handler = (ctx) => {
    calls += 1;
    return { wallet_id: ctx.params.walletId, amount: ctx.body.amount_milli, request_id: ctx.requestId };
  };

  const created = handleRestRequest({
    method: 'POST',
    path: '/wallets/w1/transfers',
    headers: { 'idempotency-key': 'transfer-key-0001' },
    body: { target_wallet_id: 'w2', amount_milli: 500 },
    idempotency: store,
    handler,
  });
  assert.equal(created.status, 200);
  assert.equal(created.body.data.wallet_id, 'w1');
  assert.equal(created.body.data.amount, 500);
  assert.equal(calls, 1);

  const replayed = handleRestRequest({
    method: 'POST',
    path: '/wallets/w1/transfers',
    headers: { 'idempotency-key': 'transfer-key-0001' },
    body: { target_wallet_id: 'w2', amount_milli: 500 },
    idempotency: store,
    handler,
  });
  assert.equal(replayed.status, 200);
  assert.equal(replayed.body.meta.idempotent_replay, true);
  assert.equal(replayed.body.data.amount, 500);
  assert.equal(calls, 1);

  const missingKey = handleRestRequest({
    method: 'POST',
    path: '/wallets/w1/transfers',
    body: { target_wallet_id: 'w2', amount_milli: 500 },
    handler,
  });
  assert.equal(missingKey.status, 400);
  assert.equal(missingKey.body.error.code, 'E_IDEMPOTENCY_KEY_REQUIRED');

  const invalidBody = handleRestRequest({
    method: 'POST',
    path: '/wallets/w1/transfers',
    headers: { 'idempotency-key': 'transfer-key-0002' },
    body: { amount_milli: 0 },
    idempotency: store,
    handler,
  });
  assert.equal(invalidBody.status, 400);
  assert.equal(invalidBody.body.error.code, 'E_VALIDATION');

  const noRoute = handleRestRequest({ method: 'GET', path: '/wallets' });
  assert.equal(noRoute.status, 404);
  assert.equal(noRoute.body.error.code, 'E_NO_ROUTE');

  const wrongVersion = handleRestRequest({ version: 'v9', method: 'GET', path: '/health' });
  assert.equal(wrongVersion.status, 400);
  assert.equal(wrongVersion.body.error.code, 'E_UNSUPPORTED_VERSION');

  const prefixed = handleRestRequest({
    method: 'POST',
    path: apiPath('/wallets/w1/transfers'),
    headers: { 'idempotency-key': 'transfer-key-prefixed' },
    body: { target_wallet_id: 'w2', amount_milli: 5 },
    idempotency: new IdempotencyStore(),
    handler,
  });
  assert.equal(prefixed.status, 200);
  assert.equal(prefixed.body.data.wallet_id, 'w1');
  assert.equal(prefixed.body.data.amount, 5);

  const badPathVersion = handleRestRequest({ method: 'GET', path: '/api/v9/health' });
  assert.equal(badPathVersion.status, 400);
  assert.equal(badPathVersion.body.error.code, 'E_UNSUPPORTED_VERSION');

  let failed = 0;
  const flaky = (ctx) => {
    failed += 1;
    if (failed === 1) throw new DataError('E_INSUFFICIENT_FUNDS', 'no funds');
    return { ok: true, amount: ctx.body.amount_milli };
  };
  const failRes = handleRestRequest({
    method: 'POST',
    path: '/wallets/w1/transfers',
    headers: { 'idempotency-key': 'transfer-key-0003' },
    body: { target_wallet_id: 'w2', amount_milli: 10 },
    idempotency: store,
    handler: flaky,
  });
  assert.equal(failRes.status, 409);
  assert.equal(failRes.body.error.code, 'E_INSUFFICIENT_FUNDS');
  const retryRes = handleRestRequest({
    method: 'POST',
    path: '/wallets/w1/transfers',
    headers: { 'idempotency-key': 'transfer-key-0003' },
    body: { target_wallet_id: 'w2', amount_milli: 10 },
    idempotency: store,
    handler: flaky,
  });
  assert.equal(retryRes.status, 200);
  assert.equal(retryRes.body.data.ok, true);
});

test('data layer and gateway adopt the shared contracts', (t) => {
  const { layer } = makeDataLayer(t);
  assert.equal(layer.contracts.API_VERSION, API_VERSION);
  assert.ok(layer.idempotency instanceof IdempotencyStore);

  const user = layer.auth.register({ username: 'contract_user', password: 'S3cretpass!' });
  const { token } = layer.auth.createSession(user.id);
  const sent = [];
  const handlers = {};
  const socket = {
    id: 'sock-' + crypto.randomUUID(),
    token,
    resumeToken: null,
    ip: '192.0.2.9',
    userAgent: 'contract-test',
    emit(event, payload) {
      sent.push({ event, payload });
    },
    on(event, handler) {
      handlers[event] = handler;
    },
    disconnect() {},
  };
  assert.equal(layer.gateway.handleConnection(socket), true);

  layer.gateway.handleEvent(socket.id, 'bogus:event', {});
  const unknown = sent.filter((m) => m.event === 'error').pop().payload;
  assert.equal(unknown.code, 'E_INVALID_EVENT');
  assert.equal(unknown.api_version, API_VERSION);
  assert.equal(typeof unknown.request_id !== 'undefined', true);

  layer.gateway.handleEvent(socket.id, 'room:join', {});
  const invalid = sent.filter((m) => m.event === 'error').pop().payload;
  assert.equal(invalid.code, 'E_VALIDATION');

  const game = layer.createGame({ kind: 'domino' });
  const room = layer.createRoom({ gameId: game.id, hostUserId: user.id, name: 'Contract Room' });
  layer.gateway.handleEvent(socket.id, 'room:join', { roomId: room.id });
  const joined = sent.filter((m) => m.event === 'room:joined').pop().payload;
  assert.equal(joined.room.id, room.id);
  assert.equal(joined.players.length, 1);
});
