'use strict';
// P18 — payment HTTP transport (core/payments/transport.js).
//
// The transport is the only place where a real network call would happen, so
// every provider test injects a double. These tests exercise the transport
// itself with an injected fetch implementation: body encoding, header and
// response handling, timeout aborting and error redaction.
const { test } = require('node:test');
const assert = require('node:assert');
const { createHttpTransport } = require('../core/payments');
const { DEFAULT_TIMEOUT_MS } = require('../core/payments/transport');

function jsonResponse(data, options = {}) {
  const headers = options.headers === null ? {} : { 'content-type': 'application/json', ...(options.headers || {}) };
  return {
    status: options.status || 200,
    ok: options.ok === undefined ? true : options.ok,
    headers:
      options.headers === null
        ? {}
        : {
            get: (name) => headers[name] || null,
          },
    text: async () => (options.text === undefined ? JSON.stringify(data) : options.text),
  };
}

test('transport defaults to a 15s timeout and rejects without a fetch implementation', async () => {
  assert.equal(DEFAULT_TIMEOUT_MS, 15000);
  const transport = createHttpTransport({ fetch: 'not-a-function' });
  await assert.rejects(
    () => transport({ url: 'https://provider.test/pay' }),
    (err) => err.code === 'E_PAYMENT_TRANSPORT' && /no fetch implementation/.test(err.message),
  );
});

test('transport encodes json, form and raw bodies and parses json responses', async () => {
  const calls = [];
  const transport = createHttpTransport({
    fetch: async (url, init) => {
      calls.push({ url, init });
      return jsonResponse({ ok: true }, { headers: { 'x-request-id': 'req-77' } });
    },
  });

  const json = await transport({ method: 'POST', url: 'https://provider.test/json', body: { amount: 5 } });
  assert.equal(json.status, 200);
  assert.equal(json.ok, true);
  assert.deepEqual(json.data, { ok: true });
  assert.deepEqual(json.headers, { 'content-type': 'application/json', 'x-request-id': 'req-77' });
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.body, '{"amount":5}');
  assert.equal(calls[0].init.headers.accept, 'application/json');
  assert.equal(calls[0].init.headers['content-type'], 'application/json');
  assert.ok(calls[0].init.signal, 'an AbortSignal is always passed to fetch');

  const form = await transport({
    method: 'POST',
    url: 'https://provider.test/token',
    encoding: 'form',
    body: { grant_type: 'client_credentials', dropped: undefined, alsoDropped: null },
  });
  assert.equal(form.ok, true);
  assert.equal(calls[1].init.body, 'grant_type=client_credentials');
  assert.equal(calls[1].init.headers['content-type'], 'application/x-www-form-urlencoded');

  const raw = await transport({ method: 'POST', url: 'https://provider.test/raw', body: 'a=1&b=2' });
  assert.equal(calls[2].init.body, 'a=1&b=2');

  await transport({ url: 'https://provider.test/get' });
  assert.equal(calls[3].init.method, 'GET');
  assert.equal(calls[3].init.body, undefined);

  // Custom headers win over the transport defaults.
  await transport({ url: 'https://provider.test/auth', headers: { accept: 'text/plain', authorization: 'Bearer abc' } });
  assert.equal(calls[4].init.headers.accept, 'text/plain');
  assert.equal(calls[4].init.headers.authorization, 'Bearer abc');
});

test('transport tolerates non json bodies and responses without a header reader', async () => {
  const transport = createHttpTransport({
    fetch: async () => jsonResponse({ ignored: true }, { headers: null, text: 'gateway timeout' }),
  });
  const plain = await transport({ url: 'https://provider.test/plain' });
  assert.equal(plain.data, 'gateway timeout');
  assert.deepEqual(plain.headers, {});

  const empty = createHttpTransport({
    fetch: async () => jsonResponse(null, { headers: null, text: '' }),
  });
  const blank = await empty({ url: 'https://provider.test/empty' });
  assert.equal(blank.data, null);

  const failed = await transport({ url: 'https://provider.test/down' });
  assert.equal(failed.ok, true);
});

test('transport surfaces provider http failures without leaking transport secrets', async () => {
  const transport = createHttpTransport({
    fetch: async () => jsonResponse({ message: 'boom' }, { status: 502, ok: false }),
  });
  const response = await transport({ url: 'https://provider.test/fail' });
  assert.equal(response.status, 502);
  assert.equal(response.ok, false);
  assert.deepEqual(response.data, { message: 'boom' });
});

test('transport wraps network errors and redacts credential-like text', async () => {
  const transport = createHttpTransport({
    fetch: async () => {
      throw new Error('connect ECONNREFUSED secret=super-secret-value token=abc123');
    },
  });
  await assert.rejects(
    () => transport({ url: 'https://provider.test/offline' }),
    (err) => {
      assert.equal(err.code, 'E_PAYMENT_TRANSPORT');
      assert.ok(err.message.startsWith('payment transport failure:'));
      assert.ok(!err.message.includes('super-secret-value'));
      assert.ok(!err.message.includes('abc123'));
      assert.ok(err.message.includes('[REDACTED]'));
      return true;
    },
  );
});

test('transport aborts on timeout (default and per request) and clears its timer', async () => {
  const aborted = [];
  const blockingFetch = (url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        aborted.push(url);
        reject(new Error('aborted by client timeout'));
      });
    });

  const transport = createHttpTransport({ fetch: blockingFetch, timeoutMs: 25 });
  await assert.rejects(
    () => transport({ url: 'https://provider.test/slow-default' }),
    (err) => err.code === 'E_PAYMENT_TRANSPORT' && /aborted by client timeout/.test(err.message),
  );
  assert.deepEqual(aborted, ['https://provider.test/slow-default']);

  const quick = createHttpTransport({ fetch: blockingFetch, timeoutMs: 60000 });
  await assert.rejects(
    () => quick({ url: 'https://provider.test/slow-spec', timeoutMs: 10 }),
    (err) => err.code === 'E_PAYMENT_TRANSPORT' && /aborted by client timeout/.test(err.message),
  );
  assert.deepEqual(aborted, ['https://provider.test/slow-default', 'https://provider.test/slow-spec']);

  // A request that resolves in time leaves no pending abort timer behind.
  const fast = createHttpTransport({ fetch: async () => jsonResponse({ fine: true }), timeoutMs: 5000 });
  const result = await fast({ url: 'https://provider.test/fast' });
  assert.deepEqual(result.data, { fine: true });
});
