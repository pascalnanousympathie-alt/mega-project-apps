'use strict';
const {
  DataError,
  ok,
  nowIso,
  genId,
  sha256hex,
  safeMeta,
  parseRow,
  safeRollback,
  toDataError,
} = require('../db');
const {
  CANONICAL_STATUSES,
  TERMINAL_STATUSES,
  DIRECTIONS,
  canTransition,
  missingCredentials,
  resolveCredentials,
  validateAmount,
  hashPaymentEvent,
  hashPaymentCallback,
  assertKnownStatus,
} = require('./base');
const { buildProviderRegistry } = require('./providers');
const { normalizeMvolaProject, resolveMvolaProjectCredentials } = require('./project-map');
const { appendWithinTx } = require('../ledger');
const { stripSecrets, redactText, containsSecretLike } = require('./redact');
const { createHttpTransport } = require('./transport');

const GENESIS_HASH = '0'.repeat(64);

const INSERT_INTENT = `INSERT INTO payment_intents
  (id, provider, direction, user_id, wallet_id, amount_milli, currency, status,
   provider_ref, idempotency_key, customer_ref, request_json, response_json, created_at, updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;

const INSERT_CALLBACK = `INSERT INTO payment_callbacks
  (id, intent_id, provider, provider_ref, status, delivery_key, outcome, error_code,
   payload_json, prev_hash, hash, created_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`;

const INSERT_RECONCILIATION = `INSERT INTO payment_reconciliations
  (id, intent_id, provider, attempt, status_before, status_after, outcome, provider_ref, error, created_at)
  VALUES (?,?,?,?,?,?,?,?,?,?)`;

function buildPaymentGateway(input = {}) {
  const db = input.db;
  ok(db, 'E_ARG', 'payment gateway requires a database');
  const repos = input.repos || null;
  const now = typeof input.now === 'function' ? input.now : nowIso;
  const transport = input.transport || createHttpTransport(input.transportOptions || {});
  const providerCredentials = input.credentials || {};
  const env = input.env || {};
  const callbackUrl = input.callbackUrl || null;
  const providers = normalizeProviders(input.providers);

  function normalizeProviders(source) {
    if (!source) return buildProviderRegistry();
    if (source instanceof Map) return source;
    if (Array.isArray(source)) {
      const registry = new Map();
      for (const provider of source) registry.set(provider.name, provider);
      return registry;
    }
    return buildProviderRegistry();
  }

  function providerConfigRow(name) {
    try {
      return db.prepare('SELECT * FROM payment_provider_config WHERE provider = ?').get(name) || null;
    } catch (_) {
      return null;
    }
  }

  function getProvider(name) {
    const key = String(name || '').trim();
    ok(key.length > 0, 'E_ARG', 'provider is required');
    const provider = providers.get(key);
    ok(provider, 'E_PROVIDER_UNKNOWN', 'unknown payment provider: ' + key);
    const config = providerConfigRow(key);
    if (config && config.status === 'disabled') {
      throw new DataError('E_PROVIDER_DISABLED', 'payment provider is disabled: ' + key);
    }
    return provider;
  }

  function missingProviderCredentials(provider, credentials) {
    if (provider.name !== 'mvola') return missingCredentials(provider, credentials);
    const source = credentials || {};
    const missing = [];
    const hasApiKey = String(source.apiKey || '').trim().length > 0;
    const hasOAuthPair = String(source.consumerKey || '').trim().length > 0 && String(source.consumerSecret || '').trim().length > 0;
    if (!hasApiKey && !hasOAuthPair) missing.push('MVOLA_API_KEY or MVOLA_CONSUMER_KEY+MVOLA_CONSUMER_SECRET');
    if (!String(source.merchantNumber || '').trim()) missing.push('MVOLA_MERCHANT_NUMBER or MVOLA_PARTNER_MSISDN');
    if (!String(source.partnerName || '').trim()) missing.push('MVOLA_PARTNER_NAME');
    return missing;
  }

  function credentialsFor(provider, project = null) {
    const scoped = providerCredentials && typeof providerCredentials === 'object' && !Array.isArray(providerCredentials)
      ? providerCredentials[provider.name] || {}
      : {};
    const resolved = resolveCredentials(provider, { credentials: scoped, env });
    if (provider.name === 'mvola' && project) {
      const projectCredentials = resolveMvolaProjectCredentials(project, env);
      if (!projectCredentials) throw new DataError('E_PAYMENT_PROJECT_INVALID', 'unknown MVola project: ' + project);
      Object.assign(resolved, projectCredentials);
    }
    return resolved;
  }

  function resolveRequestedMvolaProject(request) {
    if (!request || request.provider !== 'mvola') return null;
    const project = normalizeMvolaProject(request.project);
    const genericKey = (providerCredentials.mvola || {}).consumerKey || env.MVOLA_CONSUMER_KEY;
    const appScopedConfigured = Object.keys(env).some((key) => /^(DOMINOMADA|LOTOMADA|RAMIMADA)_MVOLA_(CONSUMER_KEY|CONSUMER_SECRET|API_KEY)$/.test(key) && String(env[key] || '').length > 0);
    if (!project && appScopedConfigured && !genericKey) {
      throw new DataError('E_PAYMENT_PROJECT_REQUIRED', 'project is required for MVola app-scoped credentials');
    }
    if (request.project && !project) {
      throw new DataError('E_PAYMENT_PROJECT_INVALID', 'unknown MVola project: ' + request.project);
    }
    return project;
  }

  function intentProject(intent) {
    try {
      const data = typeof intent.request_json === 'string' ? JSON.parse(intent.request_json) : intent.request_json;
      return data && normalizeMvolaProject(data.project);
    } catch (_) {
      return null;
    }
  }

  function describeProvider(provider, project = null) {
    const credentials = credentialsFor(provider, project);
    const missing = missingProviderCredentials(provider, credentials);
    const config = providerConfigRow(provider.name);
    return {
      name: provider.name,
      display_name: provider.displayName,
      currency: provider.currency,
      directions: [...provider.directions],
      capabilities: { ...provider.capabilities },
      limits: { ...provider.limits },
      status: config && config.status === 'disabled' ? 'disabled' : 'active',
      configured: missing.length === 0,
      missing_credentials: missing,
    };
  }

  function listProviders(options = {}) {
    const project = options && options.project ? normalizeMvolaProject(options.project) : null;
    if (options && options.project && !project) throw new DataError('E_PAYMENT_PROJECT_INVALID', 'unknown MVola project: ' + options.project);
    return [...providers.values()].map((provider) => describeProvider(provider, provider.name === 'mvola' ? project : null));
  }

  function appendEvent(intent, eventType, status, providerRef, payload) {
    const prevRow = db
      .prepare('SELECT hash FROM payment_events WHERE intent_id = ? ORDER BY event_index DESC LIMIT 1')
      .get(intent.id);
    const prev_hash = (prevRow && prevRow.hash) || GENESIS_HASH;
    const maxRow = db
      .prepare('SELECT MAX(event_index) AS max_index FROM payment_events WHERE intent_id = ?')
      .get(intent.id);
    const event_index = (maxRow && Number.isInteger(maxRow.max_index) ? maxRow.max_index : -1) + 1;
    const payload_json = safeMeta(stripSecrets(payload || {}));
    if (containsSecretLike(JSON.parse(payload_json))) {
      throw new DataError('E_PAYMENT_SECRET_LEAK', 'refusing to persist secret-like payment payload');
    }
    const created_at = now();
    const hash = hashPaymentEvent({
      intent_id: intent.id,
      event_index,
      event_type: eventType,
      status,
      provider_ref: providerRef || '',
      payload_json,
      prev_hash,
      created_at,
    });
    db.prepare(
      `INSERT INTO payment_events
        (intent_id, event_index, event_type, status, provider_ref, payload_json, prev_hash, hash, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run(intent.id, event_index, eventType, status, providerRef || null, payload_json, prev_hash, hash, created_at);
    return parseRow(db.prepare('SELECT * FROM payment_events WHERE hash = ?').get(hash));
  }

  function recordAudit(action, intent, detail) {
    if (!repos || typeof repos.recordAudit !== 'function') return null;
    try {
      return repos.recordAudit({
        actorType: 'system',
        action,
        targetType: 'payment_intent',
        targetId: intent.id,
        detail: { provider: intent.provider, status: intent.status, ...detail },
      });
    } catch (_) {
      return null;
    }
  }

  function getIntent(id) {
    const row = db.prepare('SELECT * FROM payment_intents WHERE id = ?').get(String(id || ''));
    if (!row) throw new DataError('E_PAYMENT_NOT_FOUND', 'payment intent not found: ' + id);
    return parseRow(row);
  }

  function listIntents(options = {}) {
    const limit = Number.isSafeInteger(options.limit) ? Math.min(Math.max(options.limit, 1), 500) : 100;
    const offset = Number.isSafeInteger(options.offset) && options.offset >= 0 ? options.offset : 0;
    const where = [];
    const params = [];
    if (options.provider) { where.push('provider = ?'); params.push(String(options.provider)); }
    if (options.wallet_id) { where.push('wallet_id = ?'); params.push(String(options.wallet_id)); }
    if (options.status) { where.push('status = ?'); params.push(String(options.status)); }
    if (options.idempotency_key) { where.push('idempotency_key = ?'); params.push(String(options.idempotency_key)); }
    let sql = 'SELECT * FROM payment_intents';
    if (where.length) sql += ' WHERE ' + where.join(' AND ');
    sql += ' ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);
    return db.prepare(sql).all(...params).map(parseRow);
  }

  function listEvents(intentId) {
    return db
      .prepare('SELECT * FROM payment_events WHERE intent_id = ? ORDER BY event_index ASC')
      .all(String(intentId || ''))
      .map(parseRow);
  }

  function verifyIntents() {
    const intents = db.prepare('SELECT id FROM payment_intents ORDER BY created_at ASC').all();
    let events = 0;
    for (const { id } of intents) {
      const rows = db.prepare('SELECT * FROM payment_events WHERE intent_id = ? ORDER BY event_index ASC').all(id);
      let prev = GENESIS_HASH;
      for (const row of rows) {
        if (row.prev_hash !== prev) {
          throw new DataError('E_PAYMENT_CHAIN', 'payment event chain broken for intent ' + id + ' at index ' + row.event_index);
        }
        const computed = hashPaymentEvent({
          intent_id: row.intent_id,
          event_index: row.event_index,
          event_type: row.event_type,
          status: row.status,
          provider_ref: row.provider_ref,
          payload_json: row.payload_json,
          prev_hash: row.prev_hash,
          created_at: row.created_at,
        });
        if (computed !== row.hash) {
          throw new DataError('E_PAYMENT_CHAIN', 'payment event hash mismatch for intent ' + id + ' at index ' + row.event_index);
        }
        prev = row.hash;
        events += 1;
      }
    }
    let callbacks = 0;
    let prevCallbackHash = GENESIS_HASH;
    const callbackRows = db.prepare('SELECT * FROM payment_callbacks ORDER BY seq ASC').all();
    for (const row of callbackRows) {
      if (row.prev_hash !== prevCallbackHash) {
        throw new DataError('E_PAYMENT_CHAIN', 'payment callback chain broken at seq ' + row.seq);
      }
      const computed = hashPaymentCallback({
        intent_id: row.intent_id,
        provider: row.provider,
        delivery_key: row.delivery_key,
        status: row.status,
        outcome: row.outcome,
        error_code: row.error_code,
        payload_json: row.payload_json,
        prev_hash: row.prev_hash,
        created_at: row.created_at,
      });
      if (computed !== row.hash) {
        throw new DataError('E_PAYMENT_CHAIN', 'payment callback hash mismatch at seq ' + row.seq);
      }
      prevCallbackHash = row.hash;
      callbacks += 1;
    }
    return { ok: true, intents: intents.length, events, callbacks };
  }


  function existingIntent(providerName, idempotencyKey) {
    const row = db
      .prepare('SELECT * FROM payment_intents WHERE provider = ? AND idempotency_key = ?')
      .get(providerName, idempotencyKey);
    return row ? parseRow(row) : null;
  }

  function validateWallet(walletId) {
    if (!walletId) return null;
    ok(typeof walletId === 'string' && walletId.length > 0, 'E_ARG', 'wallet_id must be a string');
    if (!repos || typeof repos.getWallet !== 'function') return null;
    const wallet = repos.getWallet(walletId);
    ok(wallet.status === 'active', 'E_WALLET_INACTIVE', 'wallet is not active: ' + wallet.status);
    return wallet;
  }

  async function initiatePayment(request = {}) {
    ok(request && typeof request === 'object', 'E_ARG', 'payment request required');
    const provider = getProvider(request.provider);
    const direction = request.direction || 'payin';
    ok(DIRECTIONS.includes(direction), 'E_ARG', 'invalid payment direction: ' + direction);
    ok(provider.directions.includes(direction), 'E_ARG', 'provider does not support direction: ' + direction);

    const amountMilli = request.amount_milli;
    const currency = String(request.currency || provider.currency).toUpperCase();
    validateAmount(provider, amountMilli, currency);

    const idempotencyKey = request.idempotency_key;
    ok(typeof idempotencyKey === 'string' && idempotencyKey.trim().length > 0, 'E_ARG', 'idempotency_key is required');
    const key = idempotencyKey.trim();

    const wallet = validateWallet(request.wallet_id);
    const userId = request.user_id || (wallet ? wallet.user_id : null);
    if (userId && repos && typeof repos.getById === 'function' && !wallet) repos.getById(userId);

    const replay = existingIntent(provider.name, key);
    if (replay) {
      return { intent: replay, idempotent: true, provider: provider.name, payment_url: null };
    }

    const paymentProject = resolveRequestedMvolaProject(request);
    const credentials = credentialsFor(provider, paymentProject);
    const missing = missingProviderCredentials(provider, credentials);
    if (missing.length > 0) {
      throw new DataError(
        'E_PROVIDER_UNCONFIGURED',
        'payment provider ' + provider.name + ' is missing credentials: ' + missing.join(', '),
      );
    }

    const id = genId();
    const created_at = now();
    const reference = String(request.reference || id);
    const storedRequest = stripSecrets({
      amount_milli: amountMilli,
      currency,
      direction,
      reference,
      customer: request.customer || null,
      ...(paymentProject ? { project: paymentProject } : {}),
    });
    const intent = {
      id,
      provider: provider.name,
      direction,
      user_id: userId || null,
      wallet_id: wallet ? wallet.id : null,
      amount_milli: amountMilli,
      currency,
      status: 'created',
      provider_ref: null,
      idempotency_key: key,
      customer_ref: request.customer ? String(request.customer.msisdn || request.customer.phone || request.customer.account || '') || null : null,
      request_json: safeMeta(storedRequest),
      response_json: '{}',
      created_at,
      updated_at: created_at,
    };

    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(INSERT_INTENT).run(
        intent.id, intent.provider, intent.direction, intent.user_id, intent.wallet_id,
        intent.amount_milli, intent.currency, intent.status, intent.provider_ref,
        intent.idempotency_key, intent.customer_ref, intent.request_json, intent.response_json,
        intent.created_at, intent.updated_at,
      );
      appendEvent(intent, 'intent.created', 'created', null, storedRequest);
      db.exec('COMMIT');
    } catch (err) {
      safeRollback(db);
      const raced = existingIntent(provider.name, key);
      if (raced) return { intent: raced, idempotent: true, provider: provider.name, payment_url: null };
      throw toDataError(err, 'E_PAYMENT_CREATE', 'payment intent create failed');
    }
    recordAudit('payment.intent.created', intent, { amount_milli: amountMilli, currency });

    let result;
    const ctx = { credentials, transport, nowIso: now, callbackUrl, config: providerConfigRow(provider.name) };
    try {
      result = await provider.createPayment(
        {
          intent: getIntent(id),
          amount_milli: amountMilli,
          currency,
          direction,
          reference,
          customer: request.customer || null,
          description: request.description || null,
          returnUrl: request.return_url || null,
          cancelUrl: request.cancel_url || null,
        },
        ctx,
      );
    } catch (err) {
      applyStatusInternal(id, 'failed', { provider_error: redactText(err && err.message ? err.message : String(err)) }, null);
      throw err instanceof DataError ? err : new DataError('E_PAYMENT_TRANSPORT', redactText(String(err && err.message ? err.message : err)));
    }

    const nextStatus = assertKnownStatus(result && result.status ? result.status : 'pending');
    if (!canTransition('created', nextStatus)) {
      throw new DataError('E_PAYMENT_STATUS', 'provider returned invalid status transition: created -> ' + nextStatus);
    }
    const updated = applyStatusInternal(id, nextStatus, stripSecrets(result.raw), result.provider_ref || null);
    return {
      intent: updated,
      idempotent: false,
      provider: provider.name,
      payment_url: result.payment_url || null,
    };
  }

  function applyStatusInternal(intentId, status, payload, providerRef) {
    assertKnownStatus(status);
    const current = getIntent(intentId);
    let settlement = null;
    if (current.status === status) return current;
    if (!canTransition(current.status, status)) {
      throw new DataError(
        'E_PAYMENT_STATUS',
        'invalid payment status transition: ' + current.status + ' -> ' + status,
      );
    }
    const ts = now();
    const response_json = safeMeta(stripSecrets(payload || {}));
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(
        'UPDATE payment_intents SET status = ?, provider_ref = COALESCE(?, provider_ref), response_json = ?, updated_at = ? WHERE id = ?',
      ).run(status, providerRef || null, response_json, ts, intentId);
      appendEvent(current, 'status.changed', status, providerRef || current.provider_ref, payload);
      if (status === 'succeeded' && current.status !== 'succeeded' && current.wallet_id) {
        if (current.direction === 'payin') {
          settlement = appendWithinTx(db, {
            wallet_id: current.wallet_id,
            idempotency_key: 'payment:settlement:' + current.id,
            tx_type: 'deposit',
            direction: 'credit',
            amount_milli: current.amount_milli,
            status: 'committed',
            meta: {
              kind: 'payment_settlement',
              payment_intent_id: current.id,
              provider: current.provider,
              provider_ref: providerRef || current.provider_ref,
            },
          }).entry;
        } else if (current.direction === 'payout') {
          settlement = appendWithinTx(db, {
            wallet_id: current.wallet_id,
            idempotency_key: 'payment:settlement:' + current.id,
            tx_type: 'withdraw',
            direction: 'debit',
            amount_milli: current.amount_milli,
            status: 'committed',
            meta: {
              kind: 'payment_settlement',
              payment_intent_id: current.id,
              provider: current.provider,
              provider_ref: providerRef || current.provider_ref,
            },
          }).entry;
        }
      }
      db.exec('COMMIT');
    } catch (err) {
      safeRollback(db);
      throw toDataError(err, 'E_PAYMENT_STATUS', 'payment status update failed');
    }
    const updated = getIntent(intentId);
    recordAudit('payment.intent.' + status, updated, { amount_milli: updated.amount_milli, currency: updated.currency });
    if (settlement) {
      recordAudit('payment.wallet.settled', updated, {
        wallet_id: settlement.wallet_id,
        ledger_entry_id: settlement.id,
        amount_milli: settlement.amount_milli,
        direction: settlement.direction,
      });
    }
    return updated;
  }

  function applyProviderStatus(intentId, status, payload = {}, providerRef = null) {
    return applyStatusInternal(intentId, status, payload, providerRef);
  }

  function parseCallback(providerName, payload, headers = {}) {
    const provider = getProvider(providerName);
    const credentials = credentialsFor(provider);
    const normalized = provider.parseCallback(payload, headers, { credentials, nowIso: now });
    assertKnownStatus(normalized.status);
    return {
      provider: provider.name,
      provider_ref: normalized.provider_ref || null,
      status: normalized.status,
      amount_milli: Number.isSafeInteger(normalized.amount_milli) ? normalized.amount_milli : null,
      currency: normalized.currency || provider.currency,
      raw: stripSecrets(normalized.raw),
    };
  }

  function callbackDeliveryKey(providerName, parsed) {
    const raw = parsed.raw && typeof parsed.raw === 'object' ? parsed.raw : {};
    const explicit =
      raw.event_id || raw.eventId || raw.notification_id || raw.notificationId || raw.callback_id || raw.callbackId;
    if (typeof explicit === 'string' && explicit.trim().length > 0) return 'evt:' + explicit.trim();
    return (
      'sig:' +
      sha256hex(
        [
          providerName,
          parsed.provider_ref || '',
          parsed.status,
          parsed.amount_milli === null ? '' : String(parsed.amount_milli),
          parsed.currency || '',
          safeMeta(raw),
        ].join('\x1f'),
      )
    );
  }

  function findCallback(providerName, deliveryKey) {
    const row = db
      .prepare('SELECT * FROM payment_callbacks WHERE provider = ? AND delivery_key = ?')
      .get(providerName, deliveryKey);
    return row ? parseRow(row) : null;
  }

  function appendCallback(intent, parsed, deliveryKey, outcome, errorCode) {
    const payload_json = safeMeta(stripSecrets(parsed.raw || {}));
    if (containsSecretLike(JSON.parse(payload_json))) {
      throw new DataError('E_PAYMENT_SECRET_LEAK', 'refusing to persist secret-like callback payload');
    }
    const prevRow = db.prepare('SELECT hash FROM payment_callbacks ORDER BY seq DESC LIMIT 1').get();
    const prev_hash = (prevRow && prevRow.hash) || GENESIS_HASH;
    const id = genId();
    const created_at = now();
    const hash = hashPaymentCallback({
      intent_id: intent.id,
      provider: parsed.provider,
      delivery_key: deliveryKey,
      status: parsed.status,
      outcome,
      error_code: errorCode || '',
      payload_json,
      prev_hash,
      created_at,
    });
    db.prepare(INSERT_CALLBACK).run(
      id,
      intent.id,
      parsed.provider,
      parsed.provider_ref || null,
      parsed.status,
      deliveryKey,
      outcome,
      errorCode || null,
      payload_json,
      prev_hash,
      hash,
      created_at,
    );
    return parseRow(db.prepare('SELECT * FROM payment_callbacks WHERE hash = ?').get(hash));
  }

  function resolveIntentForCallback(providerName, parsed) {
    const raw = parsed.raw && typeof parsed.raw === 'object' ? parsed.raw : {};
    const candidates = [];
    if (parsed.provider_ref) candidates.push(parsed.provider_ref);
    for (const key of [
      'reference',
      'order_id',
      'orderId',
      'requestingOrganisationTransactionReference',
      'merchantTradeNo',
      'out_trade_no',
    ]) {
      const value = raw[key];
      if (typeof value === 'string' && value.length > 0) candidates.push(value);
    }
    for (const value of candidates) {
      const row = db
        .prepare('SELECT * FROM payment_intents WHERE provider = ? AND (provider_ref = ? OR idempotency_key = ?)')
        .get(providerName, value, value);
      if (row) return parseRow(row);
    }
    return null;
  }

  function rejectCallback(provider, intent, parsed, deliveryKey, errorCode, detail) {
    const callback = appendCallback(intent, parsed, deliveryKey, 'rejected', errorCode);
    recordAudit('payment.callback.rejected', intent, { error_code: errorCode, ...detail });
    return {
      provider: provider.name,
      intent_id: intent.id,
      intent,
      callback,
      duplicate: false,
      applied: false,
      outcome: 'rejected',
      error_code: errorCode,
      accepted: false,
    };
  }

  function handleCallback(providerName, payload, headers = {}) {
    const provider = getProvider(providerName);
    const parsed = parseCallback(providerName, payload, headers);
    const deliveryKey = callbackDeliveryKey(provider.name, parsed);
    const seen = findCallback(provider.name, deliveryKey);
    if (seen) {
      const intent = seen.intent_id ? getIntent(seen.intent_id) : null;
      return {
        provider: provider.name,
        intent_id: seen.intent_id,
        intent,
        callback: seen,
        duplicate: true,
        applied: false,
        outcome: 'duplicate',
        error_code: seen.error_code || null,
        accepted: seen.outcome !== 'rejected',
      };
    }
    const intent = resolveIntentForCallback(provider.name, parsed);
    if (!intent) {
      throw new DataError('E_PAYMENT_CALLBACK_UNMATCHED', 'callback does not match any payment intent');
    }
    if (parsed.amount_milli !== null && parsed.amount_milli !== intent.amount_milli) {
      return rejectCallback(provider, intent, parsed, deliveryKey, 'E_PAYMENT_AMOUNT_MISMATCH', {
        expected_amount_milli: intent.amount_milli,
      });
    }
    const parsedCurrency = String(parsed.currency || provider.currency).toUpperCase();
    if (parsedCurrency !== intent.currency) {
      return rejectCallback(provider, intent, parsed, deliveryKey, 'E_PAYMENT_CURRENCY', {
        expected_currency: intent.currency,
      });
    }
    if (intent.status !== parsed.status) {
      if (!canTransition(intent.status, parsed.status)) {
        return rejectCallback(provider, intent, parsed, deliveryKey, 'E_PAYMENT_STATUS_CONFLICT', {
          from: intent.status,
          to: parsed.status,
        });
      }
      const updated = applyStatusInternal(intent.id, parsed.status, parsed.raw, parsed.provider_ref);
      const callback = appendCallback(updated, parsed, deliveryKey, 'applied', null);
      recordAudit('payment.callback.applied', updated, { provider_ref: parsed.provider_ref, status: parsed.status });
      return {
        provider: provider.name,
        intent_id: updated.id,
        intent: updated,
        callback,
        duplicate: false,
        applied: true,
        outcome: 'applied',
        error_code: null,
        accepted: true,
      };
    }
    const callback = appendCallback(intent, parsed, deliveryKey, 'no_change', null);
    recordAudit('payment.callback.no_change', intent, { provider_ref: parsed.provider_ref, status: parsed.status });
    return {
      provider: provider.name,
      intent_id: intent.id,
      intent,
      callback,
      duplicate: false,
      applied: false,
      outcome: 'no_change',
      error_code: null,
      accepted: true,
    };
  }

  function listCallbacks(intentId) {
    return db
      .prepare('SELECT * FROM payment_callbacks WHERE intent_id = ? ORDER BY seq ASC')
      .all(String(intentId || ''))
      .map(parseRow);
  }

  function listReconciliations(intentId) {
    return db
      .prepare('SELECT * FROM payment_reconciliations WHERE intent_id = ? ORDER BY attempt ASC')
      .all(String(intentId || ''))
      .map(parseRow);
  }

  function nextAttempt(intentId) {
    const row = db
      .prepare('SELECT MAX(attempt) AS max_attempt FROM payment_reconciliations WHERE intent_id = ?')
      .get(intentId);
    return (row && Number.isInteger(row.max_attempt) ? row.max_attempt : 0) + 1;
  }

  function recordReconciliation(intent, statusBefore, statusAfter, outcome, providerRef, errorCode) {
    const attempt = nextAttempt(intent.id);
    const id = genId();
    const created_at = now();
    db.prepare(INSERT_RECONCILIATION).run(
      id,
      intent.id,
      intent.provider,
      attempt,
      statusBefore,
      statusAfter,
      outcome,
      providerRef || null,
      errorCode ? redactText(String(errorCode)) : null,
      created_at,
    );
    return parseRow(db.prepare('SELECT * FROM payment_reconciliations WHERE id = ?').get(id));
  }

  async function reconcileIntent(intentId, options = {}) {
    const intent = getIntent(intentId);
    if (TERMINAL_STATUSES.includes(intent.status)) {
      return { intent, outcome: 'terminal', changed: false, attempt: null };
    }
    const provider = getProvider(intent.provider);
    ok(
      provider.capabilities.polling !== false,
      'E_PAYMENT_RECONCILE',
      'provider does not support polling: ' + provider.name,
    );
    const project = intentProject(intent);
    const credentials = credentialsFor(provider, project);
    const missing = missingProviderCredentials(provider, credentials);
    if (missing.length > 0) {
      throw new DataError(
        'E_PROVIDER_UNCONFIGURED',
        'payment provider ' + provider.name + ' is missing credentials: ' + missing.join(', '),
      );
    }
    const reference = options.reference || intent.provider_ref || intent.idempotency_key;
    const ctx = { credentials, transport, nowIso: now, callbackUrl, config: providerConfigRow(provider.name) };
    let result;
    try {
      result = await provider.getPayment(reference, ctx);
    } catch (err) {
      recordReconciliation(intent, intent.status, intent.status, 'error', reference, err && err.code ? err.code : 'E_PAYMENT_TRANSPORT');
      throw err instanceof DataError
        ? err
        : new DataError('E_PAYMENT_RECONCILE', redactText(String(err && err.message ? err.message : err)));
    }
    const status = assertKnownStatus(result && result.status ? result.status : 'pending');
    const reportedRef = (result && result.provider_ref) || reference;
    const reportedAmount = result && Number.isSafeInteger(result.amount_milli) ? result.amount_milli : null;
    const reportedCurrency = result && result.currency ? String(result.currency).toUpperCase() : null;
    if (reportedAmount !== null && reportedAmount !== intent.amount_milli) {
      const attempt = recordReconciliation(intent, intent.status, status, 'conflict', reportedRef, 'E_PAYMENT_AMOUNT_MISMATCH');
      return { intent, outcome: 'conflict', changed: false, attempt, error_code: 'E_PAYMENT_AMOUNT_MISMATCH' };
    }
    if (reportedCurrency && reportedCurrency !== intent.currency) {
      const attempt = recordReconciliation(intent, intent.status, status, 'conflict', reportedRef, 'E_PAYMENT_CURRENCY');
      return { intent, outcome: 'conflict', changed: false, attempt, error_code: 'E_PAYMENT_CURRENCY' };
    }
    if (status === intent.status) {
      const attempt = recordReconciliation(intent, intent.status, status, 'no_change', reportedRef, null);
      return { intent, outcome: 'no_change', changed: false, attempt };
    }
    if (!canTransition(intent.status, status)) {
      const attempt = recordReconciliation(intent, intent.status, status, 'conflict', reportedRef, 'E_PAYMENT_STATUS_CONFLICT');
      return { intent, outcome: 'conflict', changed: false, attempt, error_code: 'E_PAYMENT_STATUS_CONFLICT' };
    }
    const updated = applyStatusInternal(intent.id, status, stripSecrets(result.raw), reportedRef);
    const attempt = recordReconciliation(updated, intent.status, status, 'updated', reportedRef, null);
    return { intent: updated, outcome: 'updated', changed: true, attempt };
  }

  async function reconcilePending(options = {}) {
    const limit = Number.isSafeInteger(options.limit) ? Math.min(Math.max(options.limit, 1), 500) : 100;
    const params = [];
    let sql = "SELECT * FROM payment_intents WHERE status = 'pending'";
    if (options.provider) {
      sql += ' AND provider = ?';
      params.push(String(options.provider));
    }
    sql += ' ORDER BY updated_at ASC, id ASC LIMIT ?';
    params.push(limit);
    const intents = db.prepare(sql).all(...params).map(parseRow);
    const expireAfterMs =
      Number.isSafeInteger(options.expire_after_ms) && options.expire_after_ms > 0 ? options.expire_after_ms : null;
    const results = [];
    let updated = 0;
    let unchanged = 0;
    let rejected = 0;
    let errors = 0;
    for (const intent of intents) {
      if (expireAfterMs !== null) {
        const ageMs = Date.parse(now()) - Date.parse(intent.updated_at);
        if (Number.isFinite(ageMs) && ageMs >= expireAfterMs) {
          recordReconciliation(intent, intent.status, 'expired', 'expired', intent.provider_ref, null);
          applyStatusInternal(intent.id, 'expired', { reason: 'reconciliation_timeout', age_ms: ageMs }, intent.provider_ref);
          results.push({ intent_id: intent.id, provider: intent.provider, outcome: 'expired', changed: true, error_code: null });
          updated += 1;
          continue;
        }
      }
      try {
        const result = await reconcileIntent(intent.id);
        results.push({
          intent_id: intent.id,
          provider: intent.provider,
          outcome: result.outcome,
          changed: result.changed,
          error_code: result.error_code || null,
        });
        if (result.changed) updated += 1;
        else if (result.outcome === 'conflict') rejected += 1;
        else unchanged += 1;
      } catch (err) {
        errors += 1;
        results.push({
          intent_id: intent.id,
          provider: intent.provider,
          outcome: 'error',
          changed: false,
          error_code: err && err.code ? err.code : 'E_PAYMENT_RECONCILE',
        });
      }
    }
    return { scanned: intents.length, updated, unchanged, rejected, errors, results };
  }

  return {
    db,
    providers,
    listProviders,
    getProvider,
    initiatePayment,
    applyProviderStatus,
    parseCallback,
    handleCallback,
    listCallbacks,
    listReconciliations,
    reconcileIntent,
    reconcilePending,
    getIntent,
    listIntents,
    listEvents,
    verifyIntents,
    credentialsFor,
    isConfigured: (name) => describeProvider(getProvider(name)).configured,
  };
}

module.exports = {
  buildPaymentGateway,
  CANONICAL_STATUSES,
  TERMINAL_STATUSES,
};
