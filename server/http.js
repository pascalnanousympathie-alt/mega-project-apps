'use strict';
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { DataError } = require('../core/db');
const contracts = require('../core/contracts');
const { buildApiHandlers } = require('./api');

const MAX_BODY_BYTES = 64 * 1024;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

const SECURITY_HEADERS = {
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
    "connect-src 'self' ws: wss:; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
};

function securityHeaders() {
  return { ...SECURITY_HEADERS };
}

function numericStrings(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (/^-?\d+$/.test(trimmed) && Number.isSafeInteger(Number(trimmed))) return Number(trimmed);
  return value;
}

function queryObject(searchParams) {
  const out = {};
  for (const key of searchParams.keys()) {
    const values = searchParams.getAll(key).map(numericStrings);
    out[key] = values.length > 1 ? values : values[0];
  }
  return out;
}

function headerObject(req) {
  const out = {};
  for (const [key, value] of Object.entries(req.headers || {})) {
    out[key] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}

function sendJson(res, requestId, contractResponse) {
  const headers = { ...securityHeaders(), ...(contractResponse.headers || {}) };
  res.writeHead(contractResponse.status, headers);
  res.end(JSON.stringify(contractResponse.body));
  void requestId;
}

function sendErrorResponse(res, err, requestId) {
  const payload = contracts.errorResponse(err, { requestId });
  sendJson(res, requestId, payload);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        settled = true;
        req.destroy();
        reject(new DataError('E_VALIDATION', 'request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return reject(new DataError('E_VALIDATION', 'request body must be a JSON object'));
        }
        return resolve(parsed);
      } catch (_) {
        return reject(new DataError('E_VALIDATION', 'request body is not valid JSON'));
      }
    });
    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err instanceof DataError ? err : new DataError('E_VALIDATION', 'request body read failed'));
    });
  });
}

function resolveStatic(clientDir, pathname) {
  const decoded = decodeURIComponent(pathname || '/');
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const target = path.resolve(clientDir, relative);
  const root = path.resolve(clientDir);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new DataError('E_FORBIDDEN', 'path escapes client root');
  }
  let real = target;
  try {
    real = fs.realpathSync(target);
  } catch (_) {
    throw new DataError('E_NO_ROUTE', 'not found: ' + decoded);
  }
  const stat = fs.statSync(real);
  if (stat.isDirectory()) {
    const index = path.join(real, 'index.html');
    if (!fs.existsSync(index)) throw new DataError('E_NO_ROUTE', 'not found: ' + decoded);
    return { file: index, stat: fs.statSync(index) };
  }
  if (!stat.isFile()) throw new DataError('E_NO_ROUTE', 'not found: ' + decoded);
  const within = path.resolve(real).startsWith(root + path.sep) || path.resolve(real) === path.resolve(root, 'index.html');
  if (!within) throw new DataError('E_FORBIDDEN', 'path escapes client root');
  return { file: real, stat };
}

function serveStatic(req, res, clientDir, pathname) {
  let resolved;
  try {
    resolved = resolveStatic(clientDir, pathname);
  } catch (err) {
    const payload = contracts.errorResponse(err, {});
    if (payload.status === 404) {
      res.writeHead(404, { ...securityHeaders(), 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    res.writeHead(payload.status, { ...securityHeaders(), 'content-type': 'text/plain; charset=utf-8' });
    res.end(String(payload.body.error.code || 'error'));
    return;
  }
  const ext = path.extname(resolved.file).toLowerCase();
  const headers = { ...securityHeaders(), 'content-type': MIME[ext] || 'application/octet-stream' };
  if (ext !== '.html') {
    headers['cache-control'] = 'public, max-age=60';
  }
  headers['last-modified'] = resolved.stat.mtime.toUTCString();
  res.writeHead(200, headers);
  fs.createReadStream(resolved.file).pipe(res);
}

function createRequestHandler(app) {
  const layer = app.layer;
  const api = app.api;
  const clientDir = app.clientDir;
  const realtimePrefix = app.realtimePrefix || null;
  const observability = app.observability || null;

  function record(route, method, status, startedAt, errorCode) {
    if (!observability) return;
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    observability.recordRequest({ route, method, status, durationMs });
    if (status >= 400) observability.recordError({ route, method, status, code: errorCode });
  }

  return function handle(req, res) {
    const startedAt = process.hrtime.bigint();
    if (realtimePrefix && String(req.url || '').split(/[\?#]/)[0].startsWith(realtimePrefix)) {
      // owned by the socket.io listener attached to this server
      return;
    }
    const requestId = contracts.createRequestId();
    let url;
    try {
      url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
    } catch (_) {
      sendErrorResponse(res, new DataError('E_ARG', 'malformed request url'), requestId);
      return;
    }
    const pathname = url.pathname;

    if (!pathname.startsWith(contracts.API_PREFIX + '/') && pathname !== contracts.API_PREFIX) {
      if (req.method === 'GET' || req.method === 'HEAD') {
        serveStatic(req, res, clientDir, pathname);
        return;
      }
      sendErrorResponse(res, new DataError('E_NO_ROUTE', 'no route for ' + req.method + ' ' + pathname), requestId);
      return;
    }

    const version = contracts.pathVersion(pathname) || contracts.API_VERSION;
    const match = contracts.matchRoute(version, req.method, pathname);
    if (!match) {
      sendErrorResponse(res, new DataError('E_NO_ROUTE', 'no route for ' + req.method + ' ' + pathname), requestId);
      return;
    }
    if (!api.handlers[match.id]) {
      sendErrorResponse(res, new DataError('E_NO_HANDLER', 'no handler for route: ' + match.id), requestId);
      return;
    }

    const bodyPromise =
      req.method === 'GET' || req.method === 'HEAD' || req.method === 'DELETE' ? Promise.resolve({}) : readJsonBody(req);

    bodyPromise
      .then((body) => {
        const response = contracts.handleRestRequest({
          version,
          method: req.method,
          path: pathname,
          params: match.matched_params,
          query: queryObject(url.searchParams),
          body,
          headers: headerObject(req),
          requestId,
          idempotency: layer.idempotency,
          handler: api.handlers[match.id],
        });
        return Promise.resolve(response).then((resolved) => {
          record(match.id, req.method, resolved.status, startedAt, resolved.body && resolved.body.error ? resolved.body.error.code : undefined);
          sendJson(res, requestId, resolved);
        });
      })
      .catch((err) => {
        const payload = contracts.errorResponse(err, { requestId });
        record(match.id, req.method, payload.status, startedAt, payload.body && payload.body.error ? payload.body.error.code : undefined);
        sendErrorResponse(res, err, requestId);
      });
  };
}

function createHttpServer(app) {
  const withDefaults = {
    api: app.api || buildApiHandlers(app.layer),
    clientDir: app.clientDir || path.join(__dirname, '..', 'client'),
    observability: app.observability || (app.layer && app.layer.observability) || null,
  };
  return http.createServer(createRequestHandler({ ...app, ...withDefaults }));
}

module.exports = {
  MAX_BODY_BYTES,
  SECURITY_HEADERS,
  MIME,
  securityHeaders,
  numericStrings,
  queryObject,
  headerObject,
  resolveStatic,
  serveStatic,
  readJsonBody,
  createRequestHandler,
  createHttpServer,
};
