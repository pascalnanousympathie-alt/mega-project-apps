'use strict';

const MAX_ERROR_EVENTS = 50;

function safeFinite(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function createObservability(options = {}) {
  const startedAt = Date.now();
  const routeCounts = new Map();
  const statusCounts = new Map();
  const errors = [];
  let totalRequests = 0;
  let totalDurationMs = 0;
  let totalErrors = 0;
  let lastRequestAt = null;
  let lastErrorAt = null;

  function recordRequest(input = {}) {
    const route = typeof input.route === 'string' && input.route ? input.route : 'unmatched';
    const method = typeof input.method === 'string' ? input.method.toUpperCase() : 'UNKNOWN';
    const status = Number.isInteger(input.status) ? input.status : 0;
    const durationMs = Math.max(0, safeFinite(Number(input.durationMs)));
    totalRequests += 1;
    totalDurationMs += durationMs;
    lastRequestAt = new Date().toISOString();
    routeCounts.set(route, (routeCounts.get(route) || 0) + 1);
    const statusClass = status > 0 ? `${Math.floor(status / 100)}xx` : 'unknown';
    statusCounts.set(statusClass, (statusCounts.get(statusClass) || 0) + 1);
    return { route, method, status, duration_ms: durationMs };
  }

  function recordError(input = {}) {
    totalErrors += 1;
    lastErrorAt = new Date().toISOString();
    const event = {
      at: lastErrorAt,
      route: typeof input.route === 'string' ? input.route : 'unmatched',
      method: typeof input.method === 'string' ? input.method.toUpperCase() : 'UNKNOWN',
      status: Number.isInteger(input.status) ? input.status : 500,
      code: typeof input.code === 'string' ? input.code : 'E_INTERNAL',
    };
    errors.push(event);
    while (errors.length > MAX_ERROR_EVENTS) errors.shift();
    return event;
  }

  function snapshot() {
    return {
      uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
      total_requests: totalRequests,
      total_errors: totalErrors,
      average_duration_ms: totalRequests ? Number((totalDurationMs / totalRequests).toFixed(3)) : 0,
      last_request_at: lastRequestAt,
      last_error_at: lastErrorAt,
      routes: Object.fromEntries([...routeCounts.entries()].sort(([a], [b]) => a.localeCompare(b))),
      status_classes: Object.fromEntries([...statusCounts.entries()].sort(([a], [b]) => a.localeCompare(b))),
      recent_errors: errors.map((entry) => ({ ...entry })),
    };
  }

  function log(level, event, fields = {}) {
    const safeLevels = new Set(['info', 'warn', 'error']);
    const record = {
      ts: new Date().toISOString(),
      level: safeLevels.has(level) ? level : 'info',
      event: typeof event === 'string' ? event : 'unknown',
    };
    for (const key of ['request_id', 'route', 'method', 'status', 'code', 'duration_ms']) {
      if (fields[key] !== undefined && fields[key] !== null) record[key] = fields[key];
    }
    process.stderr.write(`${JSON.stringify(record)}\n`);
  }

  return {
    recordRequest,
    recordError,
    snapshot,
    log,
    maxErrorEvents: MAX_ERROR_EVENTS,
    startedAt,
    options,
  };
}

function readiness(layer) {
  const dbOpen = Boolean(layer && layer.db && layer.db.isOpen);
  let ledgerOk = false;
  let ledgerDetail = 'unavailable';
  if (dbOpen && layer.ledger && typeof layer.ledger.verify === 'function') {
    try {
      const result = layer.ledger.verify();
      ledgerOk = Boolean(result && result.ok);
      ledgerDetail = ledgerOk ? 'ok' : 'invalid';
    } catch (_) {
      ledgerDetail = 'error';
    }
  }
  return {
    status: dbOpen && ledgerOk ? 'ready' : 'not_ready',
    checks: { database: dbOpen ? 'ok' : 'down', ledger: ledgerDetail },
  };
}

module.exports = { createObservability, readiness, MAX_ERROR_EVENTS };
