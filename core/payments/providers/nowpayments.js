'use strict';

const { DataError } = require('../../db');
const { createProvider, normalizeStatus } = require('../base');
const { hmacSha512Hex, constantTimeEqual } = require('../sign');
const { sendJson } = require('./helpers');

const NOWPAYMENTS_STATUS_MAP = {
  waiting: 'pending',
  confirming: 'pending',
  confirmed: 'pending',
  sending: 'pending',
  partially_paid: 'pending',
  finished: 'succeeded',
  failed: 'failed',
  refunded: 'cancelled',
  expired: 'expired',
};

function decimalToMilli(value) {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value).trim();
  if (!/^\d+(?:\.\d{1,6})?$/.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  const milli = Number(whole) * 1000 + Number((fraction + '000').slice(0, 3));
  return Number.isSafeInteger(milli) ? milli : null;
}

function sortedObject(value) {
  if (Array.isArray(value)) return value.map(sortedObject);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((out, key) => {
      out[key] = sortedObject(value[key]);
      return out;
    }, {});
  }
  return value;
}

function verifyIpnSignature(payload, provided, secret) {
  if (!secret || !provided) return false;
  const canonical = JSON.stringify(sortedObject(payload));
  return constantTimeEqual(hmacSha512Hex(secret, canonical), provided);
}

function createNowPaymentsProvider(options = {}) {
  const sandbox = options.sandbox === true;
  const name = sandbox ? 'nowpayments-sandbox' : 'nowpayments';
  const prefix = sandbox ? 'NOWPAYMENTS_SANDBOX' : 'NOWPAYMENTS';
  return createProvider({
    name,
    displayName: sandbox ? 'NOWPayments Sandbox' : 'NOWPayments',
    currency: 'USD',
    directions: ['payin'],
    defaultBaseUrl: sandbox ? 'https://api-sandbox.nowpayments.io' : 'https://api.nowpayments.io',
    capabilities: { callback: true, polling: true, refund: false },
    limits: { min_milli: 1, max_milli: 100000000000 },
    statusMap: NOWPAYMENTS_STATUS_MAP,
    credentialSpec: [
      { key: 'apiKey', env: `${prefix}_API_KEY`, secret: true },
      { key: 'callbackSecret', env: `${prefix}_IPN_SECRET`, secret: true },
      { key: 'callbackUrl', env: `${prefix}_IPN_CALLBACK_URL`, required: false, secret: false },
      { key: 'payCurrency', env: `${prefix}_PAY_CURRENCY`, required: false, secret: false },
      { key: 'baseUrl', env: `${prefix}_BASE_URL`, required: false, secret: false },
      ...(sandbox ? [{ key: 'testCase', env: `${prefix}_CASE`, required: false, secret: false }] : []),
    ],
    async createPayment(request, ctx) {
      const credentials = ctx.credentials;
      const reference = request.reference || request.intent.id;
      const payCurrency = credentials.payCurrency || 'usdttrc20';
      const data = await sendJson(
        ctx.transport,
        {
          method: 'POST',
          url: credentials.baseUrl + '/v1/payment',
          headers: { 'x-api-key': credentials.apiKey },
          body: {
            price_amount: request.amount_milli / 1000,
            price_currency: 'usd',
            pay_currency: payCurrency,
            ipn_callback_url: credentials.callbackUrl || ctx.callbackUrl || null,
            order_id: reference,
            order_description: request.description || 'ACEP crypto payment',
            ...(sandbox ? { case: credentials.testCase || 'success' } : {}),
          },
        },
        name,
      );
      const paymentId = data && data.payment_id;
      if (paymentId === undefined || paymentId === null) {
        throw new DataError('E_PAYMENT_TRANSPORT', '[nowpayments] create payment response missing payment_id');
      }
      return {
        provider_ref: String(paymentId),
        status: normalizeStatus(data.payment_status, NOWPAYMENTS_STATUS_MAP),
        raw: data,
        payment_url: data.invoice_url || null,
      };
    },
    async getPayment(providerRef, ctx) {
      const credentials = ctx.credentials;
      const data = await sendJson(
        ctx.transport,
        {
          method: 'GET',
          url: credentials.baseUrl + '/v1/payment/' + encodeURIComponent(providerRef),
          headers: { 'x-api-key': credentials.apiKey },
        },
        name,
      );
      return {
        provider_ref: String(data && data.payment_id !== undefined ? data.payment_id : providerRef),
        status: normalizeStatus(data && data.payment_status, NOWPAYMENTS_STATUS_MAP),
        amount_milli: decimalToMilli(data && data.price_amount),
        currency: 'USD',
        raw: data,
      };
    },
    parseCallback(payload, headers, ctx) {
      if (!payload || typeof payload !== 'object') {
        throw new DataError('E_ARG', '[nowpayments] callback payload required');
      }
      const secret = ctx.credentials && ctx.credentials.callbackSecret;
      const provided = headers && (headers['x-nowpayments-sig'] || headers['X-Nowpayments-Sig']);
      if (!verifyIpnSignature(payload, provided, secret)) {
        throw new DataError('E_PAYMENT_SIGNATURE', '[nowpayments] callback signature rejected');
      }
      return {
        provider_ref: payload.payment_id === undefined ? (payload.order_id || null) : String(payload.payment_id),
        status: normalizeStatus(payload.payment_status, NOWPAYMENTS_STATUS_MAP),
        amount_milli: decimalToMilli(payload.price_amount),
        currency: String(payload.price_currency || 'USD').toUpperCase(),
        raw: payload,
      };
    },
  });
}

module.exports = {
  createNowPaymentsProvider,
  NOWPAYMENTS_STATUS_MAP,
  decimalToMilli,
  sortedObject,
  verifyIpnSignature,
};
