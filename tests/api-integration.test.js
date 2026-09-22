'use strict';
/**
 * P18 integration coverage: real HTTP server + real data layer + stubbed
 * provider transport.
 *
 * These tests drive the production wiring (core data layer -> server/api
 * handlers -> server/http) over a listening socket, so the API contract,
 * authentication, central wallet ledger, payment intents/callbacks/
 * reconciliation, rooms and local records are exercised as one system instead
 * of as isolated units.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createDataLayer } = require('../core');
const ramiRules = require('../core/rami');
const contracts = require('../core/contracts');
const {
  GAME_LABELS,
  buildApiHandlers,
  handleApiRequest,
  paymentCustomer,
  publicEntry,
  publicIntent,
  publicRoom,
  publicUser,
  publicWallet,
  bearerOf,
  serviceKeyOf,
} = require('../server/api');
const { createHttpServer, MAX_BODY_BYTES } = require('../server/http');

const CLIENT_DIR = path.join(__dirname, '..', 'client');
const API = contracts.API_PREFIX;
const PASSWORD = 'Str0ng!Pass';
const CALLBACK_SECRET = 'callback-secret-value';

const MVOLA_CREDENTIALS = {
  mvola: {
    consumerKey: 'test-consumer-key',
    consumerSecret: 'test-consumer-secret',
    merchantNumber: '0340000000',
    partnerName: 'ACEP',
    callbackSecret: CALLBACK_SECRET,
    baseUrl: 'https://mvola.test',
  },
};

/** Deterministic provider transport stub recording every outbound call. */
function makeTransport(options = {}) {
  const calls = [];
  const transport = async (spec) => {
    calls.push(spec);
    if (options.respond) {
      const custom = options.respond(spec);
      if (custom) return custom;
    }
    if (/\/token$/.test(spec.url)) {
      return { status: 200, ok: true, headers: {}, data: { access_token: 'test-access-token', expires_in: 3600 } };
    }
    if (spec.url.includes('merchantpay')) {
      if (spec.method === 'GET') {
        return {
          status: 200,
          ok: true,
          headers: {},
          data: {
            transactionStatus: options.pollStatus || 'success',
            serverCorrelationId: spec.headers && spec.headers['x-correlation-id'],
          },
        };
      }
      return {
        status: 200,
        ok: true,
        headers: {},
        data: { status: options.createStatus || 'pending', serverCorrelationId: options.staticRef || 'mvola-ref-1' },
      };
    }
    return { status: 404, ok: false, headers: {}, data: { message: 'unmatched transport route' } };
  };
  transport.calls = calls;
  transport.merchantPayPosts = () =>
    calls.filter((entry) => entry.method === 'POST' && String(entry.url).includes('merchantpay'));
  return transport;
}

async function boot(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acep-p18-api-'));
  const transport = options.transport || makeTransport(options.transportOptions || {});
  const layer = createDataLayer({
    dataDir: dir,
    payments: {
      credentials: options.credentials || MVOLA_CREDENTIALS,
      env: {},
      transport,
      callbackUrl: 'https://acep.test/payments/callback',
    },
  });
  const api = buildApiHandlers(layer);
  const server = createHttpServer({ layer, api, clientDir: CLIENT_DIR });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const openGame = layer.createGame({
    kind: 'domino',
    config: { name: 'DominoMada Classic', settings: { entryFee: 5000, commission: 0.1 } },
  });
  const plainGame = layer.createGame({ kind: 'loto' });
  const closedGame = layer.createGame({ kind: 'rami', status: 'finished', config: { name: 'RamiMada Old' } });
  const ops = layer.auth.registerService({ name: 'acep-ops', scopes: ['ledger:read', 'payments:reconcile'] });
  const reader = layer.auth.registerService({ name: 'acep-reader', scopes: ['ledger:read'] });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    try {
      layer.close();
    } catch (_) {
      // already closed
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    layer,
    api,
    transport,
    origin,
    base: origin + API,
    openGame,
    plainGame,
    closedGame,
    opsKey: ops.key,
    readerKey: reader.key,
  };
}

async function call(base, method, pathname, options = {}) {
  const headers = Object.assign({ accept: 'application/json' }, options.headers || {});
  if (options.token) headers.authorization = 'Bearer ' + options.token;
  if (options.serviceKey) headers['x-service-key'] = options.serviceKey;
  if (options.idempotency) headers['idempotency-key'] = options.idempotency;
  let body;
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
  }
  const res = await fetch(base + pathname, { method, headers, body });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (_) {
    json = null;
  }
  return {
    status: res.status,
    headers: res.headers,
    text,
    json,
    data: json && json.data !== undefined ? json.data : null,
    error: json && json.error ? json.error : null,
    meta: json && json.meta ? json.meta : null,
  };
}

async function signUp(base, username, extra = {}) {
  const body = Object.assign({ username, password: PASSWORD }, extra);
  const registered = await call(base, 'POST', '/auth/register', { body });
  assert.equal(registered.status, 200, JSON.stringify(registered.json));
  const login = await call(base, 'POST', '/auth/login', { body: { identity: username, password: PASSWORD } });
  assert.equal(login.status, 200, JSON.stringify(login.json));
  return { token: login.data.token, user: registered.data.user };
}

function fund(layer, walletId, key, amount) {
  return layer.ledger.append({
    wallet_id: walletId,
    idempotency_key: key,
    tx_type: 'deposit',
    direction: 'credit',
    amount_milli: amount,
    meta: { kind: 'deposit', label: 'seed deposit' },
  });
}

test('HTTP integration: versioned envelope, security headers and unknown routes', async (t) => {
  const { base, origin } = await boot(t);

  const health = await call(base, 'GET', '/health');
  assert.equal(health.status, 200);
  assert.equal(health.json.api_version, 'v1');
  assert.equal(health.data.status, 'ok');
  assert.ok(health.meta.request_id, 'every response carries a request id');
  assert.equal(health.headers.get('x-api-version'), 'v1');
  assert.equal(health.headers.get('x-content-type-options'), 'nosniff');
  assert.match(health.headers.get('content-security-policy'), /default-src 'self'/);
  assert.ok(new Date(health.data.server_time).getTime() > 0);

  const unknown = await call(base, 'GET', '/nope');
  assert.equal(unknown.status, 404);
  assert.equal(unknown.error.code, 'E_NO_ROUTE');
  assert.ok(unknown.meta.request_id);

  const badVersion = await call(origin + '/api/v9', 'GET', '/health');
  assert.equal(badVersion.status, 404, 'a non-v1 api prefix is never routed to the api');
  assert.equal(badVersion.json, null, 'a non-v1 prefix returns the static 404 body');
});

test('HTTP integration: register, login, session guard, logout and catalog', async (t) => {
  const { base, layer, openGame, plainGame, closedGame } = await boot(t);

  const anonymous = await call(base, 'GET', '/users/me');
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.error.code, 'E_UNAUTHORIZED');

  const badBearer = await call(base, 'GET', '/users/me', { headers: { authorization: 'Token abc' } });
  assert.equal(badBearer.status, 401);
  assert.equal(badBearer.error.code, 'E_UNAUTHORIZED');

  const user = await signUp(base, 'p18_auth', { phone: '+261340000018', email: 'p18_auth@example.mg' });
  assert.equal(user.user.username, 'p18_auth');
  assert.equal(user.user.password_hash, undefined, 'password hashes never leave the API');

  const duplicate = await call(base, 'POST', '/auth/register', {
    body: { username: 'p18_auth', password: PASSWORD },
  });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.error.code, 'E_DUPLICATE');

  const wrongPassword = await call(base, 'POST', '/auth/login', {
    body: { identity: 'p18_auth', password: 'wrong-password' },
  });
  assert.equal(wrongPassword.status, 401);
  assert.equal(wrongPassword.error.code, 'E_BAD_CREDENTIALS');

  const weakPassword = await call(base, 'POST', '/auth/register', {
    body: { username: 'p18_weak', password: 'short' },
  });
  assert.equal(weakPassword.status, 400);
  assert.equal(weakPassword.error.code, 'E_VALIDATION');

  const me = await call(base, 'GET', '/users/me', { token: user.token });
  assert.equal(me.status, 200);
  assert.equal(me.data.user.id, user.user.id);
  assert.equal(me.data.wallet, null);
  assert.ok(me.data.session.expires_at);
  assert.deepEqual(
    me.data.games.map((game) => game.id).sort(),
    [openGame.id, plainGame.id].sort(),
    'only open games are listed',
  );
  assert.deepEqual(me.data.games.find((game) => game.id === openGame.id), {
    id: openGame.id,
    kind: 'domino',
    name: 'DominoMada Classic',
    status: 'scheduled',
    entry_fee_milli: 5000,
  });
  assert.equal(me.data.games.find((game) => game.id === plainGame.id).name, GAME_LABELS.loto);
  assert.equal(me.data.games.find((game) => game.id === plainGame.id).entry_fee_milli, 0);
  assert.ok(!me.data.games.some((game) => game.id === closedGame.id), 'finished games leave the catalog');

  const audit = layer.listAudit({ targetId: user.user.id });
  assert.equal(audit.filter((row) => row.action === 'auth.login').length, 1);
  assert.equal(audit.filter((row) => row.action === 'auth.login.failed').length, 1);
  assert.equal(audit.filter((row) => row.action === 'user.register').length, 1);

  const logout = await call(base, 'POST', '/auth/logout', { token: user.token, body: {} });
  assert.equal(logout.status, 200);
  assert.equal(logout.data.logged_out, true);
  const afterLogout = await call(base, 'GET', '/users/me', { token: user.token });
  assert.equal(afterLogout.status, 401);
  assert.equal(afterLogout.error.code, 'E_SESSION_REVOKED');
});

test('HTTP integration: wallet creation, snapshot, entries and ownership guards', async (t) => {
  const { base, layer } = await boot(t);
  const owner = await signUp(base, 'p18_wallet_owner');
  const stranger = await signUp(base, 'p18_wallet_stranger');

  const created = await call(base, 'POST', '/wallets', {
    token: owner.token,
    body: { currency: 'MGA' },
    idempotency: 'p18-wallet-create-1',
  });
  assert.equal(created.status, 200, JSON.stringify(created.json));
  assert.equal(created.data.existing, false);
  assert.equal(created.data.wallet.currency, 'MGA');
  assert.equal(created.data.wallet.balance_milli, 0);
  const walletId = created.data.wallet.id;

  const again = await call(base, 'POST', '/wallets', {
    token: owner.token,
    body: {},
    idempotency: 'p18-wallet-create-2',
  });
  assert.equal(again.status, 200);
  assert.equal(again.data.existing, true);
  assert.equal(again.data.wallet.id, walletId);

  fund(layer, walletId, 'p18-wallet-seed', 50000);

  const snapshot = await call(base, 'GET', '/wallets/' + walletId, { token: owner.token });
  assert.equal(snapshot.status, 200);
  assert.deepEqual(snapshot.data.balances, {
    committed_milli: 50000,
    stored_milli: 50000,
    reserved_milli: 0,
    pending_milli: 0,
    available_milli: 50000,
  });
  assert.equal(snapshot.data.integrity_ok, true);

  const entries = await call(base, 'GET', '/wallets/' + walletId + '/entries?limit=5', { token: owner.token });
  assert.equal(entries.status, 200);
  assert.equal(entries.data.length, 1);
  assert.equal(entries.data[0].direction, 'credit');
  assert.equal(entries.data[0].amount_milli, 50000);
  assert.equal(entries.data[0].label, 'seed deposit');
  assert.equal(entries.data[0].kind, 'deposit');

  const forbidden = await call(base, 'GET', '/wallets/' + walletId, { token: stranger.token });
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.error.code, 'E_FORBIDDEN');

  const forbiddenEntries = await call(base, 'GET', '/wallets/' + walletId + '/entries', { token: stranger.token });
  assert.equal(forbiddenEntries.status, 403);
  assert.equal(forbiddenEntries.error.code, 'E_FORBIDDEN');

  const missing = await call(base, 'GET', '/wallets/does-not-exist', { token: owner.token });
  assert.equal(missing.status, 404);
  assert.equal(missing.error.code, 'E_NO_WALLET');

  const badLimit = await call(base, 'GET', '/wallets/' + walletId + '/entries?limit=0', { token: owner.token });
  assert.equal(badLimit.status, 400);
  assert.equal(badLimit.error.code, 'E_VALIDATION');

  const strangerMe = await call(base, 'GET', '/users/me', { token: stranger.token });
  assert.equal(strangerMe.data.wallet, null);
});

test('HTTP integration: peer transfers are idempotent and enforce access and funds', async (t) => {
  const { base, layer } = await boot(t);
  const sender = await signUp(base, 'p18_send');
  const receiver = await signUp(base, 'p18_recv');
  const outsider = await signUp(base, 'p18_out');

  const senderWallet = (
    await call(base, 'POST', '/wallets', { token: sender.token, body: {}, idempotency: 'p18-send-wallet' })
  ).data.wallet;
  const receiverWallet = (
    await call(base, 'POST', '/wallets', { token: receiver.token, body: {}, idempotency: 'p18-recv-wallet' })
  ).data.wallet;
  const outsiderWallet = (
    await call(base, 'POST', '/wallets', { token: outsider.token, body: {}, idempotency: 'p18-out-wallet' })
  ).data.wallet;
  fund(layer, senderWallet.id, 'p18-send-seed', 50000);

  const transfer = await call(base, 'POST', '/wallets/' + senderWallet.id + '/transfers', {
    token: sender.token,
    idempotency: 'p18-transfer-0001',
    body: { target_wallet_id: receiverWallet.id, amount_milli: 20000 },
  });
  assert.equal(transfer.status, 200, JSON.stringify(transfer.json));
  assert.equal(transfer.data.idempotent, false);
  assert.equal(transfer.data.debit.amount_milli, 20000);
  assert.equal(transfer.data.debit.label, 'p2p transfer out');
  assert.equal(transfer.data.credit.label, 'p2p transfer in');
  assert.equal(transfer.data.balance_milli, 30000);

  const replay = await call(base, 'POST', '/wallets/' + senderWallet.id + '/transfers', {
    token: sender.token,
    idempotency: 'p18-transfer-0001',
    body: { target_wallet_id: receiverWallet.id, amount_milli: 20000 },
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.meta.idempotent_replay, true);
  assert.equal(replay.data.debit.id, transfer.data.debit.id);
  assert.equal(layer.getWallet(senderWallet.id).balance_milli, 30000, 'replay never moves funds twice');

  const receiverView = await call(base, 'GET', '/wallets/' + receiverWallet.id, { token: receiver.token });
  assert.equal(receiverView.data.balances.available_milli, 20000);

  const insufficient = await call(base, 'POST', '/wallets/' + senderWallet.id + '/transfers', {
    token: sender.token,
    idempotency: 'p18-transfer-0002',
    body: { target_wallet_id: receiverWallet.id, amount_milli: 100000 },
  });
  assert.equal(insufficient.status, 409);
  assert.equal(insufficient.error.code, 'E_INSUFFICIENT_FUNDS');
  assert.equal(layer.getWallet(senderWallet.id).balance_milli, 30000);

  const toSelf = await call(base, 'POST', '/wallets/' + senderWallet.id + '/transfers', {
    token: sender.token,
    idempotency: 'p18-transfer-0003',
    body: { target_wallet_id: senderWallet.id, amount_milli: 1000 },
  });
  assert.equal(toSelf.status, 400);
  assert.equal(toSelf.error.code, 'E_ARG');

  const noKey = await call(base, 'POST', '/wallets/' + senderWallet.id + '/transfers', {
    token: sender.token,
    body: { target_wallet_id: receiverWallet.id, amount_milli: 1000 },
  });
  assert.equal(noKey.status, 400);
  assert.equal(noKey.error.code, 'E_IDEMPOTENCY_KEY_REQUIRED');

  const shortKey = await call(base, 'POST', '/wallets/' + senderWallet.id + '/transfers', {
    token: sender.token,
    idempotency: 'short',
    body: { target_wallet_id: receiverWallet.id, amount_milli: 1000 },
  });
  assert.equal(shortKey.status, 400);
  assert.equal(shortKey.error.code, 'E_IDEMPOTENCY_KEY_INVALID');

  const foreignWallet = await call(base, 'POST', '/wallets/' + senderWallet.id + '/transfers', {
    token: outsider.token,
    idempotency: 'p18-transfer-0004',
    body: { target_wallet_id: outsiderWallet.id, amount_milli: 1000 },
  });
  assert.equal(foreignWallet.status, 403);
  assert.equal(foreignWallet.error.code, 'E_FORBIDDEN');

  assert.equal(layer.wallet.verify().ok, true, 'ledger chain stays valid after HTTP transfers');
});

test('HTTP integration: mvola deposit forwards the payer msisdn and stays idempotent', async (t) => {
  const { base, transport } = await boot(t);
  const payer = await signUp(base, 'p18_deposit');
  await call(base, 'POST', '/wallets', { token: payer.token, body: {}, idempotency: 'p18-dep-wallet' });

  const providers = await call(base, 'GET', '/payments/providers', { token: payer.token });
  assert.equal(providers.status, 200);
  const mvola = providers.data.find((entry) => entry.name === 'mvola');
  assert.ok(mvola, 'mvola is registered');
  assert.equal(mvola.configured, true);
  assert.equal(mvola.status, 'active');
  assert.ok(mvola.directions.includes('payin'));
  assert.equal(providers.text.includes('test-consumer-secret'), false, 'provider list never leaks credentials');

  const created = await call(base, 'POST', '/payments/intents', {
    token: payer.token,
    idempotency: 'p18-deposit-0001',
    body: { provider: 'mvola', amount_milli: 25000, currency: 'MGA', customer: { msisdn: '0340123456' } },
  });
  assert.equal(created.status, 200, JSON.stringify(created.json));
  assert.equal(created.data.idempotent, false);
  assert.equal(created.data.intent.provider, 'mvola');
  assert.equal(created.data.intent.status, 'pending');
  assert.equal(created.data.intent.amount_milli, 25000);
  assert.equal(created.data.intent.currency, 'MGA');
  assert.equal(created.data.intent.reference, '0340123456');
  assert.equal(created.data.payment_url, null);

  const posts = transport.merchantPayPosts();
  assert.equal(posts.length, 1, 'one provider call per intent');
  const posted = posts[0];
  assert.equal(posted.headers['x-correlation-id'], created.data.intent.id);
  assert.deepEqual(posted.body.debitParty, [{ key: 'msisdn', value: '0340123456' }]);
  assert.equal(posted.body.creditParty[0].value, '0340000000');
  assert.equal(posted.body.amount, '25000');

  const replay = await call(base, 'POST', '/payments/intents', {
    token: payer.token,
    idempotency: 'p18-deposit-0001',
    body: { provider: 'mvola', amount_milli: 25000, currency: 'MGA', customer: { msisdn: '0340123456' } },
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.meta.idempotent_replay, true);
  assert.equal(replay.data.intent.id, created.data.intent.id);
  assert.equal(transport.merchantPayPosts().length, 1, 'replayed deposit never re-charges the provider');

  const missingKey = await call(base, 'POST', '/payments/intents', {
    token: payer.token,
    body: { provider: 'mvola', amount_milli: 25000 },
  });
  assert.equal(missingKey.status, 400);
  assert.equal(missingKey.error.code, 'E_IDEMPOTENCY_KEY_REQUIRED');

  const tooSmall = await call(base, 'POST', '/payments/intents', {
    token: payer.token,
    idempotency: 'p18-deposit-0002',
    body: { provider: 'mvola', amount_milli: 10 },
  });
  assert.equal(tooSmall.status, 400);
  assert.equal(tooSmall.error.code, 'E_PAYMENT_LIMIT');

  const unknownProvider = await call(base, 'POST', '/payments/intents', {
    token: payer.token,
    idempotency: 'p18-deposit-0003',
    body: { provider: 'paypal', amount_milli: 25000 },
  });
  assert.equal(unknownProvider.status, 400);
  assert.equal(unknownProvider.error.code, 'E_VALIDATION');

  const noWalletYet = await signUp(base, 'p18_no_wallet');
  const withoutWallet = await call(base, 'POST', '/payments/intents', {
    token: noWalletYet.token,
    idempotency: 'p18-deposit-0004',
    body: { provider: 'mvola', amount_milli: 25000 },
  });
  assert.equal(withoutWallet.status, 404);
  assert.equal(withoutWallet.error.code, 'E_NO_WALLET');

  const ownerView = await call(base, 'GET', '/payments/intents/' + created.data.intent.id, { token: payer.token });
  assert.equal(ownerView.status, 200);
  assert.equal(ownerView.data.intent.id, created.data.intent.id);

  const strangerView = await call(base, 'GET', '/payments/intents/' + created.data.intent.id, {
    token: noWalletYet.token,
  });
  assert.equal(strangerView.status, 403);
  assert.equal(strangerView.error.code, 'E_FORBIDDEN');

  const unknownIntent = await call(base, 'GET', '/payments/intents/nope', { token: payer.token });
  assert.equal(unknownIntent.status, 404);
  assert.equal(unknownIntent.error.code, 'E_PAYMENT_NOT_FOUND');
});

test('HTTP integration: a payer without any msisdn is rejected instead of debited', async (t) => {
  const { base } = await boot(t);
  const payer = await signUp(base, 'p18_no_msisdn');
  await call(base, 'POST', '/wallets', { token: payer.token, body: {}, idempotency: 'p18-nomsd-wallet' });

  const refused = await call(base, 'POST', '/payments/intents', {
    token: payer.token,
    idempotency: 'p18-nomsd-0001',
    body: { provider: 'mvola', amount_milli: 25000 },
  });
  assert.equal(refused.status, 400);
  assert.equal(refused.error.code, 'E_ARG');
  assert.match(refused.error.message, /msisdn/);

  const explicit = await call(base, 'POST', '/payments/intents', {
    token: payer.token,
    idempotency: 'p18-nomsd-0002',
    body: { provider: 'mvola', amount_milli: 25000, msisdn: '0340999888' },
  });
  assert.equal(explicit.status, 200, JSON.stringify(explicit.json));
  assert.equal(explicit.data.intent.reference, '0340999888');
});

test('HTTP integration: mvola callbacks apply once and reconcile stays service scoped', async (t) => {
  const { base, layer, opsKey, readerKey } = await boot(t);
  const payer = await signUp(base, 'p18_callback');
  await call(base, 'POST', '/wallets', { token: payer.token, body: {}, idempotency: 'p18-cb-wallet' });

  const intent = (
    await call(base, 'POST', '/payments/intents', {
      token: payer.token,
      idempotency: 'p18-cb-intent01',
      body: { provider: 'mvola', amount_milli: 25000, customer: { msisdn: '0340555666' } },
    })
  ).data.intent;
  const callbackBody = { serverCorrelationId: 'mvola-ref-1', transactionStatus: 'success', amount: 25000 };
  const callbackPath = '/payments/callback/mvola';

  const unsigned = await call(base, 'POST', callbackPath, {
    idempotency: 'p18-cb-unsigned1',
    body: callbackBody,
  });
  assert.equal(unsigned.status, 401);
  assert.equal(unsigned.error.code, 'E_PAYMENT_SIGNATURE');

  const badSignature = await call(base, 'POST', callbackPath, {
    idempotency: 'p18-cb-badsig1',
    headers: { 'x-content-signature': 'not-the-secret' },
    body: callbackBody,
  });
  assert.equal(badSignature.status, 401);
  assert.equal(badSignature.error.code, 'E_PAYMENT_SIGNATURE');

  const applied = await call(base, 'POST', callbackPath, {
    idempotency: 'p18-cb-applied1',
    headers: { 'x-content-signature': CALLBACK_SECRET },
    body: callbackBody,
  });
  assert.equal(applied.status, 200, JSON.stringify(applied.json));
  assert.equal(applied.data.accepted, true);
  assert.equal(applied.data.outcome, 'applied');
  assert.equal(applied.data.duplicate, false);
  assert.equal(applied.data.intent_id, intent.id);
  assert.equal(applied.data.status, 'succeeded');
  assert.equal(layer.payments.getIntent(intent.id).status, 'succeeded');

  const duplicate = await call(base, 'POST', callbackPath, {
    idempotency: 'p18-cb-applied2',
    headers: { 'x-content-signature': CALLBACK_SECRET },
    body: callbackBody,
  });
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.data.duplicate, true);
  assert.equal(duplicate.data.outcome, 'duplicate');
  assert.equal(duplicate.data.accepted, true);

  const unmatched = await call(base, 'POST', callbackPath, {
    idempotency: 'p18-cb-unmatched1',
    headers: { 'x-content-signature': CALLBACK_SECRET },
    body: { serverCorrelationId: 'mvola-ref-unknown', transactionStatus: 'success', amount: 25000 },
  });
  assert.equal(unmatched.status, 404);
  assert.equal(unmatched.error.code, 'E_PAYMENT_CALLBACK_UNMATCHED');

  const mismatchIntent = (
    await call(base, 'POST', '/payments/intents', {
      token: payer.token,
      idempotency: 'p18-cb-intent02',
      body: { provider: 'mvola', amount_milli: 40000, customer: { msisdn: '0340555666' } },
    })
  ).data.intent;
  const mismatch = await call(base, 'POST', callbackPath, {
    idempotency: 'p18-cb-mismatch1',
    headers: { 'x-content-signature': CALLBACK_SECRET },
    body: { serverCorrelationId: 'mvola-ref-1', transactionStatus: 'success', amount: 99000 },
  });
  assert.equal(mismatch.status, 200);
  assert.equal(mismatch.data.accepted, false);
  assert.equal(mismatch.data.outcome, 'rejected');
  assert.equal(layer.payments.getIntent(mismatchIntent.id).status, 'pending', 'rejected callback never settles');

  const noServiceKey = await call(base, 'GET', '/payments/intents/' + intent.id + '/events', { token: payer.token });
  assert.equal(noServiceKey.status, 401);
  assert.equal(noServiceKey.error.code, 'E_UNAUTHORIZED');

  const wrongScope = await call(base, 'GET', '/payments/intents/' + intent.id + '/events', { serviceKey: readerKey });
  assert.equal(wrongScope.status, 403);
  assert.equal(wrongScope.error.code, 'E_FORBIDDEN');

  const events = await call(base, 'GET', '/payments/intents/' + intent.id + '/events', { serviceKey: opsKey });
  assert.equal(events.status, 200);
  assert.ok(events.data.some((event) => event.event_type === 'intent.created'));
  assert.ok(events.data.some((event) => event.event_type === 'status.changed'));
  assert.equal(events.text.includes('test-consumer-secret'), false, 'events never leak provider secrets');
  assert.equal(events.text.includes('test-access-token'), false);
  assert.equal(events.text.includes(CALLBACK_SECRET), false);

  const callbacks = await call(base, 'GET', '/payments/intents/' + intent.id + '/callbacks', { serviceKey: opsKey });
  assert.equal(callbacks.status, 200);
  assert.equal(callbacks.data.length, 1, 'the duplicate delivery is not stored twice');
  assert.equal(callbacks.data[0].outcome, 'applied');

  const mismatchCallbacks = await call(base, 'GET', '/payments/intents/' + mismatchIntent.id + '/callbacks', {
    serviceKey: opsKey,
  });
  assert.equal(mismatchCallbacks.data[0].error_code, 'E_PAYMENT_AMOUNT_MISMATCH');

  const reconcile = await call(base, 'POST', '/payments/intents/' + mismatchIntent.id + '/reconcile', {
    serviceKey: opsKey,
    idempotency: 'p18-recon-0001',
    body: {},
  });
  assert.equal(reconcile.status, 200, JSON.stringify(reconcile.json));
  assert.equal(reconcile.data.outcome, 'updated');
  assert.equal(reconcile.data.changed, true);
  assert.equal(reconcile.data.intent.status, 'succeeded');

  const reconciliations = await call(base, 'GET', '/payments/intents/' + mismatchIntent.id + '/reconciliations', {
    serviceKey: opsKey,
  });
  assert.equal(reconciliations.status, 200);
  assert.equal(reconciliations.data.length, 1);
  assert.equal(reconciliations.data[0].outcome, 'updated');
  assert.equal(reconciliations.data[0].status_after, 'succeeded');

  const terminal = await call(base, 'POST', '/payments/intents/' + mismatchIntent.id + '/reconcile', {
    serviceKey: opsKey,
    idempotency: 'p18-recon-0002',
    body: {},
  });
  assert.equal(terminal.data.outcome, 'terminal');
  assert.equal(terminal.data.changed, false);

  const reconcileWithoutKey = await call(base, 'POST', '/payments/intents/' + mismatchIntent.id + '/reconcile', {
    serviceKey: opsKey,
    body: {},
  });
  assert.equal(reconcileWithoutKey.status, 400);
  assert.equal(reconcileWithoutKey.error.code, 'E_IDEMPOTENCY_KEY_REQUIRED');

  const sweep = await call(base, 'POST', '/payments/reconcile', {
    serviceKey: opsKey,
    idempotency: 'p18-recon-sweep1',
    body: { limit: 10 },
  });
  assert.equal(sweep.status, 200);
  assert.equal(sweep.data.scanned, 0, 'no pending intents remain after the callback and reconcile');
});

test('HTTP integration: room lifecycle, lobby guards and audit trail', async (t) => {
  const { base, layer, openGame, closedGame } = await boot(t);
  const host = await signUp(base, 'p18_host');

  const created = await call(base, 'POST', '/rooms', {
    token: host.token,
    idempotency: 'p18-room-create1',
    body: { game_id: openGame.id, name: 'Table P18', capacity: 4 },
  });
  assert.equal(created.status, 200, JSON.stringify(created.json));
  assert.equal(created.data.room.name, 'Table P18');
  assert.equal(created.data.room.game_id, openGame.id);
  assert.equal(created.data.room.host_user_id, host.user.id);
  assert.equal(created.data.room.status, 'waiting');
  assert.equal(created.data.room.capacity, 4);
  assert.equal(created.data.room.players, 0);
  const roomId = created.data.room.id;

  const before = layer.roomPlayers(roomId).length;
  assert.equal(before, 0);
  layer.joinRoom(roomId, host.user.id);
  const listed = await call(base, 'GET', '/rooms', { token: host.token });
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.data.map((room) => room.id), [roomId]);
  assert.equal(listed.data[0].players, 1);

  const closed = await call(base, 'GET', '/rooms?status=closed', { token: host.token });
  assert.equal(closed.status, 200);
  assert.deepEqual(closed.data, []);

  const badStatus = await call(base, 'GET', '/rooms?status=ghost', { token: host.token });
  assert.equal(badStatus.status, 400);
  assert.equal(badStatus.error.code, 'E_VALIDATION');

  const closedGameRoom = await call(base, 'POST', '/rooms', {
    token: host.token,
    idempotency: 'p18-room-create2',
    body: { game_id: closedGame.id, name: 'Too late' },
  });
  assert.equal(closedGameRoom.status, 409);
  assert.equal(closedGameRoom.error.code, 'E_GAME_CLOSED');

  const oversizedCapacity = await call(base, 'POST', '/rooms', {
    token: host.token,
    idempotency: 'p18-room-create3',
    body: { game_id: openGame.id, name: 'Crowd', capacity: 99 },
  });
  assert.equal(oversizedCapacity.status, 400);
  assert.equal(oversizedCapacity.error.code, 'E_VALIDATION');

  const noKey = await call(base, 'POST', '/rooms', {
    token: host.token,
    body: { game_id: openGame.id, name: 'No key' },
  });
  assert.equal(noKey.status, 400);
  assert.equal(noKey.error.code, 'E_IDEMPOTENCY_KEY_REQUIRED');

  const anonymous = await call(base, 'GET', '/rooms');
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.error.code, 'E_UNAUTHORIZED');

  const audit = layer.listAudit({ targetId: roomId });
  assert.equal(audit.length, 1);
  assert.equal(audit[0].action, 'room.create');
  assert.equal(audit[0].actor_id, host.user.id);
  assert.deepEqual(audit[0].detail, { game_id: openGame.id, capacity: 4 });
});

test('HTTP integration: service-scoped ledger and game economy endpoints', async (t) => {
  const { base, layer, openGame, plainGame, opsKey, readerKey } = await boot(t);
  const owner = await signUp(base, 'p18_service');
  const wallet = (
    await call(base, 'POST', '/wallets', { token: owner.token, body: {}, idempotency: 'p18-svc-wallet' })
  ).data.wallet;
  fund(layer, wallet.id, 'p18-svc-seed', 12345);

  const anonymous = await call(base, 'GET', '/ledger/entries');
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.error.code, 'E_UNAUTHORIZED');

  const bogusKey = await call(base, 'GET', '/ledger/entries', { serviceKey: 'nope-nope-nope' });
  assert.equal(bogusKey.status, 401);
  assert.equal(bogusKey.error.code, 'E_INVALID_SERVICE_KEY');

  const ledger = await call(base, 'GET', '/ledger/entries?wallet_id=' + wallet.id, { serviceKey: opsKey });
  assert.equal(ledger.status, 200);
  assert.equal(ledger.data.length, 1);
  assert.equal(ledger.data[0].wallet_id, wallet.id);
  assert.equal(ledger.data[0].amount_milli, 12345);

  const all = await call(base, 'GET', '/ledger/entries', { serviceKey: readerKey });
  assert.equal(all.status, 200);
  assert.equal(all.data.length, 1);

  const unknownWallet = await call(base, 'GET', '/ledger/entries?wallet_id=ghost', { serviceKey: opsKey });
  assert.equal(unknownWallet.status, 200);
  assert.deepEqual(unknownWallet.data, []);

  const economy = await call(base, 'GET', '/games/' + openGame.id + '/economy?kind=domino', { serviceKey: opsKey });
  assert.equal(economy.status, 200);
  assert.deepEqual(economy.data.economy, {
    entry_fee_milli: 5000,
    payers: 1,
    pot_milli: 5000,
    prize_milli: 4500,
    commission_milli: 500,
  });

  const kindMismatch = await call(base, 'GET', '/games/' + openGame.id + '/economy?kind=rami', { serviceKey: opsKey });
  assert.equal(kindMismatch.status, 400);
  assert.equal(kindMismatch.error.code, 'E_ARG');

  const noEconomy = await call(base, 'GET', '/games/' + plainGame.id + '/economy', { serviceKey: opsKey });
  assert.equal(noEconomy.status, 200);
  assert.equal(noEconomy.data.economy.entry_fee_milli, 0);

  const missingGame = await call(base, 'GET', '/games/nope/economy', { serviceKey: opsKey });
  assert.equal(missingGame.status, 404);
  assert.equal(missingGame.error.code, 'E_NO_GAME');

  const serviceWithoutScope = await call(base, 'GET', '/games/' + openGame.id + '/economy', { serviceKey: readerKey });
  assert.equal(serviceWithoutScope.status, 200, 'reader keeps ledger:read which economy requires');

  const readerOnPayments = await call(base, 'GET', '/payments/intents/nope/events', { serviceKey: readerKey });
  assert.equal(readerOnPayments.status, 403);
  assert.equal(readerOnPayments.error.code, 'E_FORBIDDEN');
});

test('HTTP integration: manual and offline local records stay chained and idempotent', async (t) => {
  const { base, layer, opsKey } = await boot(t);
  const owner = await signUp(base, 'p18_records');
  const stranger = await signUp(base, 'p18_records_thief');

  const manual = {
    game_kind: 'domino',
    session_type: 'manual',
    rule: 'low',
    players: [
      { user_id: owner.user.id, seat: 1, name: 'Owner' },
      { user_id: 'bot:ana', seat: 2, name: 'Ana' },
    ],
    scores: [
      { user_id: owner.user.id, value: 40 },
      { user_id: 'bot:ana', value: 12 },
    ],
    client_ref: 'p18-manual-1',
  };

  const recorded = await call(base, 'POST', '/local-records', {
    token: owner.token,
    idempotency: 'p18-records-0001',
    body: manual,
  });
  assert.equal(recorded.status, 200, JSON.stringify(recorded.json));
  assert.equal(recorded.data.idempotent, false);
  assert.equal(recorded.data.record.session_type, 'manual');
  assert.equal(recorded.data.record.winner_user_id, 'bot:ana');
  assert.equal(recorded.data.record.prev_hash, '0'.repeat(64), 'the first record links to the genesis hash');

  const replay = await call(base, 'POST', '/local-records', {
    token: owner.token,
    idempotency: 'p18-records-0001',
    body: manual,
  });
  assert.equal(replay.meta.idempotent_replay, true);
  assert.equal(replay.data.record.id, recorded.data.record.id);

  const replayByClientRef = await call(base, 'POST', '/local-records', {
    token: owner.token,
    idempotency: 'p18-records-0002',
    body: manual,
  });
  assert.equal(replayByClientRef.data.idempotent, true);
  assert.equal(replayByClientRef.data.record.id, recorded.data.record.id);

  const wrongSessionType = await call(base, 'POST', '/local-records', {
    token: owner.token,
    idempotency: 'p18-records-0003',
    body: Object.assign({}, manual, { session_type: 'offline', client_ref: 'p18-manual-2' }),
  });
  assert.equal(wrongSessionType.status, 400);
  assert.equal(wrongSessionType.error.code, 'E_VALIDATION');

  const noToken = await call(base, 'GET', '/local-records');
  assert.equal(noToken.status, 401);
  assert.equal(noToken.error.code, 'E_UNAUTHORIZED');

  const mine = await call(base, 'GET', '/local-records?game_kind=domino&session_type=manual', { token: owner.token });
  assert.equal(mine.status, 200);
  assert.equal(mine.data.length, 1);
  assert.equal(mine.data[0].id, recorded.data.record.id);

  const offlineOnly = await call(base, 'GET', '/local-records?session_type=offline', { token: owner.token });
  assert.deepEqual(offlineOnly.data, []);

  const strangerList = await call(base, 'GET', '/local-records', { token: stranger.token });
  assert.deepEqual(strangerList.data, [], 'records are scoped to their owner');

  const verifyAnonymous = await call(base, 'GET', '/local-records/verify');
  assert.equal(verifyAnonymous.status, 401);
  assert.equal(verifyAnonymous.error.code, 'E_UNAUTHORIZED');

  const verified = await call(base, 'GET', '/local-records/verify', { serviceKey: opsKey });
  assert.equal(verified.status, 200);
  assert.equal(verified.data.ok, true);
  assert.equal(verified.data.records, 1);

  const match = layer.rami.createGame({ mode: 'offline', userId: owner.user.id, settings: { seed: 'p18-import' } });
  const onlineMatch = layer.rami.createGame({ mode: 'online', userId: owner.user.id });

  const tooEarly = await call(base, 'POST', '/local-records/import', {
    token: owner.token,
    idempotency: 'p18-import-0001',
    body: { game_kind: 'rami', match_id: match.id },
  });
  assert.equal(tooEarly.error.code, 'E_GAME_OPEN');

  const foreign = await call(base, 'POST', '/local-records/import', {
    token: stranger.token,
    idempotency: 'p18-import-0002',
    body: { game_kind: 'rami', match_id: match.id },
  });
  assert.equal(foreign.status, 403);
  assert.equal(foreign.error.code, 'E_FORBIDDEN');

  const missingMatch = await call(base, 'POST', '/local-records/import', {
    token: owner.token,
    idempotency: 'p18-import-0003',
    body: { game_kind: 'rami', match_id: 'nope' },
  });
  assert.equal(missingMatch.status, 404);
  assert.equal(missingMatch.error.code, 'E_NO_MATCH');

  const onlineImport = await call(base, 'POST', '/local-records/import', {
    token: owner.token,
    idempotency: 'p18-import-0004',
    body: { game_kind: 'rami', match_id: onlineMatch.id },
  });
  assert.equal(onlineImport.error.code, 'E_MATCH_ONLINE');

  let game = layer.rami.startGame(match.id, { byUserId: owner.user.id });
  let guard = 0;
  while (game.state.status === 'active' && guard < 800) {
    guard += 1;
    if (game.state.turnPhase === 'draw') {
      game = layer.rami.applyAction(match.id, owner.user.id, { type: 'draw', source: 'stock' });
      continue;
    }
    const hand = game.state.hands[owner.user.id] || [];
    const melds = ramiRules.findMelds(hand);
    if (melds.length > 0) {
      game = layer.rami.applyAction(match.id, owner.user.id, {
        type: 'meld',
        melds: melds.map((meld) => meld.map(ramiRules.cardKey)),
      });
      if (game.state.status !== 'active') break;
    }
    const remaining = game.state.hands[owner.user.id] || hand;
    game = layer.rami.applyAction(match.id, owner.user.id, {
      type: 'discard',
      card: remaining[remaining.length - 1],
    });
  }
  assert.equal(game.state.status, 'finished', 'the offline rami match terminates for import');

  const imported = await call(base, 'POST', '/local-records/import', {
    token: owner.token,
    idempotency: 'p18-import-0005',
    body: { game_kind: 'rami', match_id: match.id },
  });
  assert.equal(imported.status, 200, JSON.stringify(imported.json));
  assert.equal(imported.data.idempotent, false);
  assert.equal(imported.data.record.session_type, 'offline');
  assert.equal(imported.data.record.match_ref, match.id);
  assert.equal(imported.data.record.seed, 'p18-import');

  const importedAgain = await call(base, 'POST', '/local-records/import', {
    token: owner.token,
    idempotency: 'p18-import-0006',
    body: { game_kind: 'rami', match_id: match.id },
  });
  assert.equal(importedAgain.data.idempotent, true);
  assert.equal(importedAgain.data.record.id, imported.data.record.id);

  const finalVerify = await call(base, 'GET', '/local-records/verify', { serviceKey: opsKey });
  assert.equal(finalVerify.data.records, 2);
  assert.equal(finalVerify.data.ok, true);
});

test('HTTP integration: malformed and oversized bodies fail closed', async (t) => {
  const { base, origin, layer, opsKey } = await boot(t);

  const notJson = await call(base, 'POST', '/auth/register', { body: 'not-json{' });
  assert.equal(notJson.status, 400);
  assert.equal(notJson.error.code, 'E_VALIDATION');
  assert.match(notJson.error.message, /not valid JSON/);

  const asArray = await call(base, 'POST', '/auth/register', { body: '[1,2]' });
  assert.equal(asArray.status, 400);
  assert.equal(asArray.error.code, 'E_VALIDATION');
  assert.match(asArray.error.message, /must be a JSON object/);

  const noBody = await call(base, 'POST', '/auth/register', {});
  assert.equal(noBody.status, 400);
  assert.equal(noBody.error.code, 'E_VALIDATION');

  const emptyBody = await call(base, 'POST', '/auth/register', { body: '' });
  assert.equal(emptyBody.status, 400);
  assert.equal(emptyBody.error.code, 'E_VALIDATION');

  const paymentUnknownField = await call(base, 'POST', '/payments/intents', {
    idempotency: 'p20-validation-1',
    body: { provider: 'mvola', amount_milli: 25000, consumerSecret: 'must-not-be-accepted' },
  });
  assert.equal(paymentUnknownField.status, 400);
  assert.equal(paymentUnknownField.error.code, 'E_VALIDATION');

  const reconcileUnknownField = await call(base, 'POST', '/payments/reconcile', {
    serviceKey: opsKey,
    idempotency: 'p20-validation-2',
    body: { limit: 1, unknown: true },
  });
  assert.equal(reconcileUnknownField.status, 400);
  assert.equal(reconcileUnknownField.error.code, 'E_VALIDATION');

  const wrongProvider = await call(base, 'POST', '/payments/callback/paypal', {
    idempotency: 'p18-bad-provider',
    body: {},
  });
  assert.equal(wrongProvider.status, 400);
  assert.equal(wrongProvider.error.code, 'E_VALIDATION');

  const postToStatic = await call(origin, 'POST', '/');
  assert.equal(postToStatic.status, 404);
  assert.equal(postToStatic.error.code, 'E_NO_ROUTE');

  const trailingSegment = await call(base, 'GET', '/health/extra');
  assert.equal(trailingSegment.status, 404);
  assert.equal(trailingSegment.error.code, 'E_NO_ROUTE');

  let oversized;
  try {
    oversized = await call(base, 'POST', '/auth/register', {
      body: { username: 'p18_oversized', password: 'x'.repeat(MAX_BODY_BYTES + 2048) },
    });
  } catch (err) {
    oversized = { status: 0, thrown: err };
  }
  assert.ok(
    oversized.status === 400 || oversized.thrown,
    'an oversized body is rejected or the connection is aborted',
  );

  assert.equal(layer.listUsers().length, 0, 'no rejected request ever created a user');
});

test('API module: handler guards, envelope helpers and catalog projection', async (t) => {
  const { api, layer, openGame, plainGame, closedGame } = await boot(t);

  assert.throws(
    () => buildApiHandlers(null),
    (err) => err.code === 'E_ARG' && err.name === 'DataError',
  );
  assert.throws(
    () => buildApiHandlers({ auth: layer.auth, wallet: layer.wallet, repos: layer.repos }),
    (err) => err.code === 'E_ARG',
    'the api refuses a layer without the local records service',
  );

  const health = handleApiRequest(layer, api, {
    routeId: 'health.get',
    method: 'GET',
    path: '/api/v1/health',
    headers: {},
  });
  assert.equal(health.status, 200);
  assert.equal(health.body.api_version, contracts.API_VERSION);
  assert.equal(health.body.data.status, 'ok');
  assert.ok(health.body.meta.request_id);

  assert.throws(
    () => handleApiRequest(layer, api, { routeId: 'ghost.get', method: 'GET', path: '/api/v1/ghost' }),
    (err) => err.code === 'E_NO_HANDLER',
  );

  const missingKey = handleApiRequest(layer, api, {
    routeId: 'wallets.create',
    method: 'POST',
    path: '/api/v1/wallets',
    headers: {},
    body: {},
  });
  assert.equal(missingKey.status, 400);
  assert.equal(missingKey.body.error.code, 'E_IDEMPOTENCY_KEY_REQUIRED');

  const catalog = api.catalog();
  assert.deepEqual(catalog.map((game) => game.id).sort(), [openGame.id, plainGame.id].sort());
  assert.ok(!catalog.some((game) => game.id === closedGame.id));
  assert.equal(catalog.find((game) => game.id === plainGame.id).name, GAME_LABELS.loto);

  assert.equal(publicUser(null), null);
  assert.deepEqual(publicUser({ id: 'u1', username: 'u', password_hash: 'h', passwordHash: 'h' }), {
    id: 'u1',
    username: 'u',
  });

  assert.equal(publicWallet(null), null);
  assert.deepEqual(
    Object.keys(
      publicWallet({
        id: 'w1',
        user_id: 'u1',
        currency: 'MGA',
        balance_milli: 10,
        status: 'active',
        version: 1,
        created_at: 'c',
        updated_at: 'u',
        secret_note: 'dropped',
        meta: { internal: true },
      }),
    ).sort(),
    ['balance_milli', 'created_at', 'currency', 'id', 'status', 'updated_at', 'user_id', 'version'],
  );

  assert.equal(publicEntry(null), null);
  assert.equal(publicEntry({ id: 'e1', meta: { label: 'lbl', kind: 'deposit' } }).label, 'lbl');
  assert.equal(publicEntry({ id: 'e1' }).kind, null);

  assert.equal(publicIntent(null), null);
  assert.equal(publicIntent({ id: 'i1' }).payment_url, null);
  assert.equal(publicIntent({ id: 'i1' }, 'https://pay.test/x').payment_url, 'https://pay.test/x');
  assert.equal(publicIntent({ id: 'i1', customer_ref: '0340' }).reference, '0340');

  assert.equal(publicRoom(null), null);
  assert.deepEqual(publicRoom({ id: 'r1', players: 2 }).players, 2);

  assert.equal(bearerOf({ authorization: 'Bearer abc123' }), 'abc123');
  assert.equal(bearerOf({ Authorization: 'bearer  spaced-token ' }), 'spaced-token');
  assert.equal(bearerOf({ authorization: 'Basic abc' }), null);
  assert.equal(bearerOf({}), null);

  assert.equal(serviceKeyOf({ 'X-Service-Key': ' secret-key ' }), 'secret-key');
  assert.equal(serviceKeyOf({ 'x-service-key': 'k' }), 'k');
  assert.equal(serviceKeyOf({}), null);

  assert.equal(paymentCustomer({}, null), null);
  assert.deepEqual(paymentCustomer({ customer: { msisdn: '0340111222' } }, null), { msisdn: '0340111222' });
  assert.deepEqual(paymentCustomer({ msisdn: '0340111222' }, null), { msisdn: '0340111222' });
  assert.deepEqual(paymentCustomer({ phone: '0340111222' }, null), { msisdn: '0340111222' });
  assert.deepEqual(paymentCustomer({}, { phone: '0340111222' }), { msisdn: '0340111222' });
  assert.deepEqual(paymentCustomer({ customer: { account: 'ACCT-1' } }, null), { msisdn: 'ACCT-1', account: 'ACCT-1' });
  assert.deepEqual(GAME_LABELS, { domino: 'DominoMada', loto: 'LotoMada', rami: 'RamiMada' });
});
