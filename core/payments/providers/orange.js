'use strict';
const { DataError } = require('../../db');
const { createProvider, normalizeStatus } = require('../base');
const { basicAuthHeader, constantTimeEqual } = require('../sign');
const { sendJson } = require('./helpers');

const ORANGE_STATUS_MAP = {
  success: 'succeeded',
  succeeded: 'succeeded',
  failed: 'failed',
  failure: 'failed',
  expired: 'expired',
  initiated: 'pending',
  pending: 'pending',
  cancelled: 'cancelled',
  canceled: 'cancelled',
};

async function accessToken(ctx, credentials) {
  if (credentials.accessToken) return credentials.accessToken;
  const data = await sendJson(
    ctx.transport,
    {
      method: 'POST',
      url: credentials.baseUrl + '/oauth/v3/token',
      encoding: 'form',
      headers: { authorization: basicAuthHeader(credentials.clientId, credentials.clientSecret) },
      body: { grant_type: 'client_credentials' },
    },
    'orange',
  );
  if (!data || !data.access_token) throw new DataError('E_PAYMENT_TRANSPORT', '[orange] token response missing access_token');
  return data.access_token;
}

function createOrangeProvider() {
  return createProvider({
    name: 'orange',
    displayName: 'Orange Money',
    currency: 'MGA',
    directions: ['payin'],
    defaultBaseUrl: 'https://api.orange.com',
    capabilities: { callback: true, polling: true, refund: false },
    limits: { min_milli: 1000, max_milli: 2000000000 },
    statusMap: ORANGE_STATUS_MAP,
    credentialSpec: [
      { key: 'clientId', env: 'ORANGE_CLIENT_ID', secret: true },
      { key: 'clientSecret', env: 'ORANGE_CLIENT_SECRET', secret: true },
      { key: 'merchantKey', env: 'ORANGE_MERCHANT_KEY', secret: true },
      { key: 'baseUrl', env: 'ORANGE_BASE_URL', required: false, secret: false },
      { key: 'callbackSecret', env: 'ORANGE_CALLBACK_SECRET', required: false, secret: true },
    ],
    async createPayment(request, ctx) {
      const credentials = ctx.credentials;
      const token = await accessToken(ctx, credentials);
      const data = await sendJson(
        ctx.transport,
        {
          method: 'POST',
          url: credentials.baseUrl + '/orange-money-webpay/dev/v1/webpayment',
          headers: { authorization: 'Bearer ' + token },
          body: {
            merchant_key: credentials.merchantKey,
            currency: 'MGA',
            order_id: request.reference || request.intent.id,
            amount: request.amount_milli,
            return_url: request.returnUrl || 'https://acep.local/payments/return',
            cancel_url: request.cancelUrl || 'https://acep.local/payments/cancel',
            notif_url: ctx.callbackUrl || 'https://acep.local/payments/callback',
            lang: 'fr',
            reference: request.reference || request.intent.id,
          },
        },
        'orange',
      );
      return {
        provider_ref: (data && (data.pay_token || data.order_id)) || request.reference || request.intent.id,
        status: normalizeStatus(data && data.status, ORANGE_STATUS_MAP),
        raw: data,
        payment_url: data && data.payment_url ? data.payment_url : null,
      };
    },
    async getPayment(providerRef, ctx) {
      const credentials = ctx.credentials;
      const token = await accessToken(ctx, credentials);
      const data = await sendJson(
        ctx.transport,
        {
          method: 'GET',
          url: credentials.baseUrl + '/orange-money-webpay/dev/v1/transactionstatus?order_id=' + encodeURIComponent(providerRef),
          headers: { authorization: 'Bearer ' + token },
        },
        'orange',
      );
      return { status: normalizeStatus(data && data.status, ORANGE_STATUS_MAP), raw: data };
    },
    parseCallback(payload, headers, ctx) {
      if (!payload || typeof payload !== 'object') throw new DataError('E_ARG', '[orange] callback payload required');
      const secret = (ctx.credentials && ctx.credentials.callbackSecret) || null;
      const provided = headers && (headers['x-orange-signature'] || headers['X-Orange-Signature']);
      if (!secret || !constantTimeEqual(secret, provided)) {
        throw new DataError('E_PAYMENT_SIGNATURE', '[orange] callback signature rejected');
      }
      return {
        provider_ref: payload.txnid || payload.order_id || payload.notif_token || null,
        status: normalizeStatus(payload.status, ORANGE_STATUS_MAP),
        amount_milli: Number.isSafeInteger(Number(payload.amount)) ? Number(payload.amount) : null,
        currency: 'MGA',
        raw: payload,
      };
    },
  });
}

module.exports = { createOrangeProvider, ORANGE_STATUS_MAP };
