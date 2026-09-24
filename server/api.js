'use strict';
const { DataError, ok } = require('../core/db');
const contracts = require('../core/contracts');
const { readiness } = require('../core/observability');

const GAME_LABELS = {
  domino: 'DominoMada',
  loto: 'LotoMada',
  rami: 'RamiMada',
};

function publicUser(user) {
  if (!user) return null;
  const out = { ...user };
  delete out.password_hash;
  delete out.passwordHash;
  return out;
}

function publicWallet(wallet) {
  if (!wallet) return null;
  return {
    id: wallet.id,
    user_id: wallet.user_id,
    currency: wallet.currency,
    balance_milli: wallet.balance_milli,
    status: wallet.status,
    version: wallet.version,
    created_at: wallet.created_at,
    updated_at: wallet.updated_at,
  };
}

function publicCryptoWallet(wallet) {
  if (!wallet) return null;
  return {
    id: wallet.id,
    user_id: wallet.user_id,
    provider: wallet.provider,
    asset: wallet.asset,
    network: wallet.network,
    address: wallet.address,
    address_memo: wallet.address_memo || null,
    label: wallet.label || null,
    status: wallet.status,
    created_at: wallet.created_at,
    updated_at: wallet.updated_at,
  };
}

function publicEntry(entry) {
  if (!entry) return null;
  return {
    id: entry.id,
    wallet_id: entry.wallet_id,
    seq: entry.seq,
    direction: entry.direction,
    tx_type: entry.tx_type,
    amount_milli: entry.amount_milli,
    currency: entry.currency,
    status: entry.status,
    label: (entry.meta && entry.meta.label) || null,
    kind: (entry.meta && entry.meta.kind) || null,
    created_at: entry.created_at,
  };
}

function publicRoom(room) {
  if (!room) return null;
  return {
    id: room.id,
    name: room.name,
    game_id: room.game_id,
    host_user_id: room.host_user_id,
    capacity: room.capacity,
    status: room.status,
    players: room.players,
    created_at: room.created_at,
    updated_at: room.updated_at,
  };
}

function publicIntent(intent, paymentUrl) {
  if (!intent) return null;
  return {
    id: intent.id,
    provider: intent.provider,
    direction: intent.direction,
    wallet_id: intent.wallet_id,
    amount_milli: intent.amount_milli,
    currency: intent.currency,
    status: intent.status,
    provider_ref: intent.provider_ref || null,
    reference: intent.customer_ref || null,
    payment_url: paymentUrl === undefined ? null : paymentUrl,
    created_at: intent.created_at,
    updated_at: intent.updated_at,
  };
}

function bearerOf(headers) {
  const raw = (headers || {})['authorization'] || (headers || {})['Authorization'] || '';
  const match = /^Bearer\s+(.+)$/i.exec(String(raw));
  return match ? match[1].trim() : null;
}

function serviceKeyOf(headers) {
  const src = headers || {};
  const raw = src['x-service-key'] || src['X-Service-Key'] || src['service-key'];
  return raw ? String(raw).trim() : null;
}

function headerValue(headers, name) {
  const src = headers || {};
  const lower = String(name).toLowerCase();
  for (const key of Object.keys(src)) {
    if (key.toLowerCase() === lower) return src[key];
  }
  return undefined;
}

/**
 * Resolve the payer identity for a mobile-money payin.
 *
 * MVola/Airtel/Orange debit an MSISDN, so the intent needs the payer's number:
 * an explicit `customer` object (or a top-level `msisdn`/`phone` body field)
 * wins, otherwise the authenticated user's registered phone is used. When none
 * of those exist this returns null and the provider layer rejects the request
 * with E_ARG instead of debiting a wrong number.
 */
function paymentCustomer(body, user) {
  const source = body && typeof body === 'object' ? body : {};
  const explicit = source.customer && typeof source.customer === 'object' ? source.customer : {};
  const value =
    explicit.msisdn ||
    explicit.phone ||
    explicit.account ||
    source.msisdn ||
    source.phone ||
    (user && user.phone) ||
    null;
  if (!value) return null;
  const customer = { msisdn: String(value) };
  if (explicit.account) customer.account = String(explicit.account);
  return customer;
}

function buildApiHandlers(layer) {
  ok(layer && layer.auth && layer.wallet && layer.repos, 'E_ARG', 'api requires a data layer');
  const repos = layer.repos || layer;

  function session(ctx) {
    const token = bearerOf(ctx.headers);
    ok(token, 'E_UNAUTHORIZED', 'bearer token required');
    const result = layer.auth.authenticateToken(token);
    return { ...result, token };
  }

  function service(ctx, scope) {
    const key = serviceKeyOf(ctx.headers);
    ok(key, 'E_UNAUTHORIZED', 'service key required');
    const wanted = scope || ctx.route.scope;
    const result = layer.auth.authenticateService(key, wanted);
    return { ...result, key };
  }

  function ownWallet(userId) {
    try {
      return repos.getWalletByUser(userId) || null;
    } catch (_) {
      return null;
    }
  }

  function assertWalletAccess(userId, walletId) {
    const wallet = repos.getWallet(walletId);
    ok(wallet.user_id === userId, 'E_FORBIDDEN', 'wallet does not belong to this user');
    return wallet;
  }

  function catalog() {
    return repos
      .listGames({ limit: 50 })
      .filter((game) => game.status === 'scheduled' || game.status === 'active')
      .map((game) => ({
        id: game.id,
        kind: game.kind,
        name: (game.config && game.config.name) || GAME_LABELS[game.kind] || game.kind,
        status: game.status,
        entry_fee_milli:
          game.config && game.config.settings && Number.isSafeInteger(game.config.settings.entryFee)
            ? game.config.settings.entryFee
            : 0,
      }));
  }

  const handlers = {};

  handlers['health.get'] = () => ({
    status: 'ok',
    api_version: contracts.API_VERSION,
    server_time: new Date().toISOString(),
    uptime_seconds: layer.observability ? layer.observability.snapshot().uptime_seconds : 0,
  });

  handlers['ready.get'] = () => readiness(layer);

  handlers['metrics.get'] = (ctx) => {
    service(ctx, 'metrics:read');
    return layer.observability ? layer.observability.snapshot() : { uptime_seconds: 0, total_requests: 0, total_errors: 0 };
  };

  handlers['auth.register'] = (ctx) => {
    const user = layer.auth.register(ctx.body);
    return { user: publicUser(user) };
  };

  handlers['auth.login'] = (ctx) => {
    const result = layer.auth.login(ctx.body.identity, ctx.body.password, {
      ip: headerValue(ctx.headers, 'x-forwarded-for') || headerValue(ctx.headers, 'x-real-ip') || null,
      userAgent: headerValue(ctx.headers, 'user-agent') || null,
    });
    return {
      token: result.token,
      expires_at: result.session.expires_at,
      session_id: result.session.id,
      user: publicUser(result.user),
    };
  };

  handlers['auth.logout'] = (ctx) => {
    const { user, token } = session(ctx);
    layer.auth.logout(user.id, token);
    return { logged_out: true };
  };

  handlers['users.me'] = (ctx) => {
    const { user, session: sess } = session(ctx);
    const wallet = ownWallet(user.id);
    return {
      user: publicUser(user),
      session: { id: sess.id, expires_at: sess.expires_at },
      wallet: wallet ? publicWallet(wallet) : null,
      crypto_wallets: repos.listCryptoWallets(user.id).map(publicCryptoWallet),
      games: catalog(),
    };
  };

  handlers['wallets.create'] = (ctx) => {
    const { user } = session(ctx);
    const existing = ownWallet(user.id);
    if (existing) return { wallet: publicWallet(existing), existing: true };
    const wallet = repos.createWallet(user.id, { currency: ctx.body.currency || 'MGA' });
    return { wallet: publicWallet(wallet), existing: false };
  };

  handlers['wallets.get'] = (ctx) => {
    const { user } = session(ctx);
    assertWalletAccess(user.id, ctx.params.walletId);
    const snap = layer.wallet.snapshot(ctx.params.walletId);
    return {
      wallet: publicWallet(snap.wallet),
      balances: {
        committed_milli: snap.committed_milli,
        stored_milli: snap.stored_milli,
        reserved_milli: snap.reserved_milli,
        pending_milli: snap.pending_milli,
        available_milli: snap.available_milli,
      },
      integrity_ok: snap.ok,
    };
  };

  handlers['wallets.entries'] = (ctx) => {
    const { user } = session(ctx);
    assertWalletAccess(user.id, ctx.params.walletId);
    const limit = Number.isSafeInteger(ctx.query.limit) ? ctx.query.limit : 25;
    return layer.wallet
      .entriesByWallet(ctx.params.walletId, { limit })
      .map(publicEntry);
  };

  handlers['wallets.transfers'] = (ctx) => {
    const { user } = session(ctx);
    const source = assertWalletAccess(user.id, ctx.params.walletId);
    const key = contracts.idempotencyKeyFrom(ctx.headers);
    ok(key, 'E_IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header is required');
    const target = repos.getWallet(ctx.body.target_wallet_id);
    ok(target.user_id !== source.user_id, 'E_ARG', 'transfers between own wallets are not allowed');
    ok(target.id !== source.id, 'E_ARG', 'source and target wallets must differ');
    ok(target.status === 'active', 'E_WALLET_INACTIVE', 'target wallet is not active');
    const result = layer.wallet.transfer({
      from_wallet_id: source.id,
      to_wallet_id: target.id,
      amount_milli: ctx.body.amount_milli,
      idempotency_key: key,
      from_meta: { kind: 'transfer', label: 'p2p transfer out' },
      to_meta: { kind: 'transfer', label: 'p2p transfer in' },
    });
    return {
      idempotent: result.idempotent,
      debit: publicEntry(result.out),
      credit: publicEntry(result.in),
      balance_milli: repos.getWallet(source.id).balance_milli,
    };
  };

  handlers['crypto-wallets.list'] = (ctx) => {
    const { user } = session(ctx);
    return repos.listCryptoWallets(user.id).map(publicCryptoWallet);
  };

  handlers['crypto-wallets.create'] = (ctx) => {
    const { user } = session(ctx);
    const wallet = repos.createCryptoWallet(user.id, {
      provider: ctx.body.provider,
      asset: ctx.body.asset,
      network: ctx.body.network,
      address: ctx.body.address,
      addressMemo: ctx.body.address_memo,
      label: ctx.body.label,
    });
    try {
      repos.recordAudit({
        actorType: 'user',
        actorId: user.id,
        action: 'crypto_wallet.create',
        targetType: 'crypto_wallet',
        targetId: wallet.id,
        detail: { provider: wallet.provider, asset: wallet.asset, network: wallet.network },
      });
    } catch (_) {
      // audit must not break wallet registration
    }
    return { wallet: publicCryptoWallet(wallet), created: true };
  };

  handlers['crypto-wallets.disable'] = (ctx) => {
    const { user } = session(ctx);
    const wallet = repos.disableCryptoWallet(user.id, ctx.params.cryptoWalletId);
    try {
      repos.recordAudit({
        actorType: 'user',
        actorId: user.id,
        action: 'crypto_wallet.disable',
        targetType: 'crypto_wallet',
        targetId: wallet.id,
        detail: { provider: wallet.provider, asset: wallet.asset, network: wallet.network },
      });
    } catch (_) {
      // audit must not break wallet disabling
    }
    return { wallet: publicCryptoWallet(wallet), disabled: wallet.status === 'disabled' };
  };

  handlers['ledger.entries'] = (ctx) => {
    service(ctx);
    const walletId = ctx.query.wallet_id;
    if (walletId) {
      return layer.wallet.entriesByWallet(walletId, { limit: 200 }).map(publicEntry);
    }
    return layer.wallet.list({ limit: 200 }).map(publicEntry);
  };

  handlers['rooms.list'] = (ctx) => {
    session(ctx);
    const status = ctx.query.status;
    const wanted = status ? [status] : ['waiting', 'active'];
    const seen = new Set();
    const rooms = [];
    for (const st of wanted) {
      for (const room of repos.listRooms({ status: st, limit: 100 })) {
        if (seen.has(room.id)) continue;
        seen.add(room.id);
        rooms.push(publicRoom(room));
      }
    }
    return rooms;
  };

  handlers['rooms.create'] = (ctx) => {
    const { user } = session(ctx);
    const game = repos.getGame(ctx.body.game_id);
    ok(game.status === 'scheduled' || game.status === 'active', 'E_GAME_CLOSED', 'game is not open for rooms');
    const room = repos.createRoom({
      gameId: game.id,
      name: ctx.body.name,
      hostUserId: user.id,
      capacity: ctx.body.capacity,
    });
    try {
      repos.recordAudit({
        actorType: 'user',
        actorId: user.id,
        action: 'room.create',
        targetType: 'room',
        targetId: room.id,
        detail: { game_id: game.id, capacity: room.capacity },
      });
    } catch (_) {
      // audit must not break room creation
    }
    return { room: publicRoom({ ...room, players: repos.roomPlayers(room.id).length }) };
  };

  handlers['payments.providers'] = (ctx) => {
    session(ctx);
    return layer.payments.listProviders({ project: ctx.query.project || null });
  };

  handlers['payments.create'] = async (ctx) => {
    const { user } = session(ctx);
    const key = contracts.idempotencyKeyFrom(ctx.headers);
    ok(key, 'E_IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header is required');
    let walletId = ctx.body.wallet_id;
    if (!walletId) {
      const own = ownWallet(user.id);
      ok(own, 'E_NO_WALLET', 'create a wallet before depositing');
      walletId = own.id;
    } else {
      assertWalletAccess(user.id, walletId);
    }
    const result = await layer.payments.initiatePayment({
      provider: ctx.body.provider,
      direction: 'payin',
      amount_milli: ctx.body.amount_milli,
      currency: ctx.body.currency,
      wallet_id: walletId,
      project: ctx.body.project,
      reference: ctx.body.reference,
      idempotency_key: key,
      user_id: user.id,
      customer: paymentCustomer(ctx.body, user),
    });
    return {
      intent: publicIntent(result.intent),
      payment_url: result.payment_url || null,
      idempotent: result.idempotent === true,
    };
  };

  handlers['payments.get'] = (ctx) => {
    const { user } = session(ctx);
    const intent = layer.payments.getIntent(ctx.params.intentId);
    ok(intent.user_id === user.id, 'E_FORBIDDEN', 'payment intent does not belong to this user');
    if (intent.wallet_id) {
      const wallet = repos.getWallet(intent.wallet_id);
      ok(wallet.user_id === user.id, 'E_FORBIDDEN', 'payment wallet does not belong to this user');
    }
    return { intent: publicIntent(intent) };
  };

  handlers['payments.events'] = (ctx) => {
    service(ctx);
    return layer.payments.listEvents(ctx.params.intentId);
  };

  handlers['payments.callback'] = (ctx) => {
    const result = layer.payments.handleCallback(ctx.params.provider, ctx.body, ctx.headers);
    return {
      provider: result.provider,
      intent_id: result.intent_id,
      status: result.intent ? result.intent.status : null,
      outcome: result.outcome,
      duplicate: result.duplicate === true,
      accepted: result.accepted === true,
    };
  };

  handlers['payments.callbacks'] = (ctx) => {
    service(ctx);
    return layer.payments.listCallbacks(ctx.params.intentId);
  };

  handlers['payments.reconciliations'] = (ctx) => {
    service(ctx);
    return layer.payments.listReconciliations(ctx.params.intentId);
  };

  handlers['payments.reconcile'] = (ctx) => service(ctx) && layer.payments.reconcileIntent(ctx.params.intentId);

  handlers['payments.reconcilePending'] = (ctx) => {
    service(ctx);
    return layer.payments.reconcilePending(ctx.body || {});
  };

  handlers['games.economy'] = (ctx) => {
    service(ctx);
    const game = repos.getGame(ctx.params.gameId);
    if (ctx.query.kind) ok(game.kind === ctx.query.kind, 'E_ARG', 'game kind mismatch');
    const settings = (game.config && game.config.settings) || {};
    const breakdown = layer.gameWallet.potBreakdown(settings.entryFee || 0, 1, settings.commission);
    return {
      game_id: game.id,
      kind: game.kind,
      status: game.status,
      economy: { ...breakdown, entry_fee_milli: settings.entryFee || 0 },
    };
  };

  handlers['loto.refund'] = (ctx) => {
    const { user } = session(ctx);
    const draw = layer.loto.refundDraw(ctx.params.drawId, user.id);
    return { draw: layer.loto.publicState(draw, user.id) };
  };

  function publicRecord(record) {
    if (!record) return null;
    return {
      id: record.id,
      game_kind: record.game_kind,
      session_type: record.session_type,
      match_ref: record.match_ref,
      seed: record.seed,
      rule: record.rule,
      players: record.players,
      scores: record.scores,
      ranking: record.ranking,
      winner_user_id: record.winner_user_id,
      prev_hash: record.prev_hash,
      hash: record.hash,
      created_at: record.created_at,
    };
  }

  ok(
    layer.localRecords,
    'E_ARG',
    'api requires the local records service (P17 offline/manual modes)',
  );

  handlers['localRecords.list'] = (ctx) => {
    const { user } = session(ctx);
    return layer.localRecords
      .listSessions({
        userId: user.id,
        gameKind: ctx.query.game_kind,
        sessionType: ctx.query.session_type,
        limit: Number.isSafeInteger(ctx.query.limit) ? ctx.query.limit : 50,
      })
      .map(publicRecord);
  };

  handlers['localRecords.record'] = (ctx) => {
    const { user } = session(ctx);
    ok(ctx.body.session_type === 'manual', 'E_ARG', 'session_type must be manual');
    const headerKey = contracts.idempotencyKeyFrom(ctx.headers);
    const result = layer.localRecords.recordManual({
      userId: user.id,
      gameKind: ctx.body.game_kind,
      rule: ctx.body.rule,
      players: ctx.body.players,
      scores: ctx.body.scores,
      seed: ctx.body.seed || null,
      clientRef: ctx.body.client_ref || headerKey || null,
    });
    return { record: publicRecord(result.record), idempotent: result.idempotent };
  };

  handlers['localRecords.import'] = (ctx) => {
    const { user } = session(ctx);
    const result = layer.localRecords.importOffline({
      userId: user.id,
      gameKind: ctx.body.game_kind,
      matchId: ctx.body.match_id,
    });
    return { record: publicRecord(result.record), idempotent: result.idempotent };
  };

  handlers['localRecords.verify'] = (ctx) => {
    service(ctx);
    return layer.localRecords.verifyChain();
  };

  return {
    handlers,
    catalog,
    session,
    service,
    publicUser,
    publicWallet,
    publicRoom,
    publicIntent,
    publicEntry,
    publicRecord,
    bearerOf,
    serviceKeyOf,
  };
}

function handleApiRequest(layer, api, request = {}) {
  const routeId = request.routeId;
  const handler = api.handlers[routeId];
  ok(handler, 'E_NO_HANDLER', 'no handler for route: ' + routeId);
  return contracts.handleRestRequest({
    version: request.version || contracts.API_VERSION,
    method: request.method,
    path: request.path,
    params: request.params,
    query: request.query,
    body: request.body,
    headers: request.headers,
    requestId: request.requestId,
    idempotency: layer.idempotency,
    handler,
  });
}

module.exports = {
  GAME_LABELS,
  buildApiHandlers,
  handleApiRequest,
  publicUser,
  publicWallet,
  publicRoom,
  publicIntent,
  publicEntry,
  bearerOf,
  serviceKeyOf,
  headerValue,
  paymentCustomer,
};
