'use strict';
const { DataError } = require('../../db');
const { createProvider, normalizeStatus } = require('../base');
const { hmacSha256Hex, constantTimeEqual } = require('../sign');
const { sendJson } = require('./helpers');

const BINANCE_STATUS_MAP = {
  paid: 'succeeded',
  success: 'succeeded',
  succeeded: 'succeeded',
  completed: 'succeeded',
  fail: 'failed',
  failed: 'failed',
  error: 'failed',
  cancelled: 'cancelled',
  canceled: 'cancelled',
  expired: 'expired',
  created: 'pending',
  pending: 'pending',
  processing: 'pending',
};

function signedQuery(params, apiSecret) {
  const parts = Object.keys(params)
    .filter((key) => params[key] !== undefined && params[key] !== null)
    .sort()
    .map((key) => encodeURIComponent(key) + '=' + encodeURIComponent(String(params[key])));
  const query = parts.join('&');
  const signature = hmacSha256Hex(apiSecret, query);
  return query + '&signature=' + signature;
}

async function signedRequest(ctx, credentials, method, path, params) {
  const query = signedQuery({ ...params, timestamp: Date.now() }, credentials.apiSecret);
  const data = await sendJson(
    ctx.transport,
    {
      method,
      url: credentials.baseUrl + path + '?' + query,
      headers: { 'x-mbx-apikey': credentials.apiKey },
    },
    'binance',
  );
  if (data && data.code && data.code !== '000000') {
    throw new DataError('E_PAYMENT_TRANSPORT', '[binance] provider rejected request with code ' + data.code);
  }
  return data;
}

function createBinanceProvider() {
  return createProvider({
    name: 'binance',
    displayName: 'Binance Pay',
    currency: 'USDT',
    directions: ['payin'],
    defaultBaseUrl: 'https://api.binance.com',
    capabilities: { callback: true, polling: true, refund: false },
    limits: { min_milli: 1, max_milli: 100000000000 },
    statusMap: BINANCE_STATUS_MAP,
    credentialSpec: [
      { key: 'apiKey', env: 'BINANCE_API_KEY', secret: true },
      { key: 'apiSecret', env: 'BINANCE_API_SECRET', secret: true },
      { key: 'baseUrl', env: 'BINANCE_BASE_URL', required: false, secret: false },
      { key: 'callbackSecret', env: 'BINANCE_CALLBACK_SECRET', required: false, secret: true },
    ],
    async createPayment(request, ctx) {
      const credentials = ctx.credentials;
      const reference = request.reference || request.intent.id;
      const data = await signedRequest(ctx, credentials, 'POST', '/sapi/v1/pay/transactions', {
        merchantTradeNo: reference,
        orderAmount: request.amount_milli,
        currency: 'USDT',
        description: request.description || 'ACEP payment',
      });
      const payload = (data && data.data) || data || {};
      return {
        provider_ref: payload.prepayId || payload.merchantTradeNo || reference,
        status: normalizeStatus(payload.status || payload.bizStatus, BINANCE_STATUS_MAP),
        raw: data,
        payment_url: payload.checkoutUrl || null,
      };
    },
    async getPayment(providerRef, ctx) {
      const credentials = ctx.credentials;
      const data = await signedRequest(ctx, credentials, 'GET', '/sapi/v1/pay/transactions', {
        merchantTradeNo: providerRef,
      });
      const payload = (data && data.data) || data || {};
      return { status: normalizeStatus(payload.status || payload.bizStatus, BINANCE_STATUS_MAP), raw: data };
    },
    parseCallback(payload, headers, ctx) {
      if (!payload || typeof payload !== 'object') throw new DataError('E_ARG', '[binance] callback payload required');
      const secret = (ctx.credentials && ctx.credentials.callbackSecret) || null;
      if (secret) {
        const provided = headers && (headers['binancepay-signature'] || headers['BinancePay-Signature']);
        if (!constantTimeEqual(secret, provided)) {
          throw new DataError('E_PAYMENT_SIGNATURE', '[binance] callback signature rejected');
        }
      }
      const data = payload.data || {};
      const rawStatus = payload.bizStatus || data.bizStatus || data.status;
      const normalized = String(rawStatus || '').toUpperCase();
      return {
        provider_ref: data.prepayId || data.merchantTradeNo || null,
        status: normalizeStatus(
          normalized === 'PAY_SUCCESS' ? 'paid' : normalized === 'PAY_FAIL' ? 'failed' : rawStatus,
          BINANCE_STATUS_MAP,
        ),
        amount_milli: Number.isSafeInteger(Number(data.orderAmount)) ? Number(data.orderAmount) : null,
        currency: 'USDT',
        raw: payload,
      };
    },
  });
}

module.exports = { createBinanceProvider, BINANCE_STATUS_MAP, signedQuery };
