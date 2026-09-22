'use strict';
const { DataError } = require('../db');
const { redactText } = require('./redact');

const DEFAULT_TIMEOUT_MS = 15000;

function encodeBody(body, encoding, headers) {
  if (body === undefined || body === null) return undefined;
  if (encoding === 'form') {
    const params = new URLSearchParams();
    for (const key of Object.keys(body)) {
      if (body[key] === undefined || body[key] === null) continue;
      params.append(key, String(body[key]));
    }
    headers['content-type'] = 'application/x-www-form-urlencoded';
    return params.toString();
  }
  if (typeof body === 'string') return body;
  headers['content-type'] = headers['content-type'] || 'application/json';
  return JSON.stringify(body);
}

function createHttpTransport(options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch;
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS;

  return async function request(spec) {
    if (typeof fetchImpl !== 'function') {
      throw new DataError('E_PAYMENT_TRANSPORT', 'no fetch implementation available for payment transport');
    }
    const headers = { accept: 'application/json', ...(spec.headers || {}) };
    const body = encodeBody(spec.body, spec.encoding, headers);
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), spec.timeoutMs || timeoutMs) : null;
    let response;
    try {
      response = await fetchImpl(spec.url, {
        method: spec.method || 'GET',
        headers,
        body,
        signal: controller ? controller.signal : undefined,
      });
    } catch (err) {
      throw new DataError('E_PAYMENT_TRANSPORT', redactText('payment transport failure: ' + (err && err.message ? err.message : err)));
    } finally {
      if (timer) clearTimeout(timer);
    }
    const text = await response.text().catch(() => '');
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch (_) {
        data = text;
      }
    }
    return {
      status: response.status,
      ok: response.ok,
      headers: response.headers && typeof response.headers.get === 'function'
        ? {
            'content-type': response.headers.get('content-type'),
            'x-request-id': response.headers.get('x-request-id'),
          }
        : {},
      data,
    };
  };
}

module.exports = { createHttpTransport, DEFAULT_TIMEOUT_MS };
