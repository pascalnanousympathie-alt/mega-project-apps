'use strict';
const { DataError } = require('../../db');
const { createProvider, normalizeStatus } = require('../base');
const { constantTimeEqual } = require('../sign');
const { sendJson, requireCustomer } = require('./helpers');

const AIRTEL_STATUS_MAP = {
  ts: 'succeeded',
  success: 'succeeded',
  tf: 'failed',
  failed: 'failed',
  ta: 'pending',
  tip: 'pending',
  pending: 'pending',
  cancelled: 'cancelled',
  expired: 'expired',
};

function unwrap(data) {
  return data && data.data ? data.data : data;
}

async function accessToken(ctx, credentials) {
  if (credentials.accessToken) return credentials.accessToken;
  const data = await sendJson(
    ctx.transport,
    {
      method: 'POST',
      url: credentials.baseUrl + '/auth/oauth2/token',
      headers: { accept: '*/*' },
      body: {
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        grant_type: 'client_credentials',
      },
    },
    'airtel',
  );
  if (!data || !data.access_token) throw new DataError('E_PAYMENT_TRANSPORT', '[airtel] token response missing access_token');
  return data.access_token;
}

function createAirtelProvider() {
  return createProvider({
    name: 'airtel',
    displayName: 'Airtel Money',
    currency: 'MGA',
    directions: ['payin'],
    defaultBaseUrl: 'https://openapi.airtel.africa',
    capabilities: { callback: true, polling: true, refund: false },
    limits: { min_milli: 1000, max_milli: 1000000000 },
    statusMap: AIRTEL_STATUS_MAP,
    credentialSpec: [
      { key: 'clientId', env: 'AIRTEL_CLIENT_ID', secret: true },
      { key: 'clientSecret', env: 'AIRTEL_CLIENT_SECRET', secret: true },
      { key: 'country', env: 'AIRTEL_COUNTRY', secret: false },
      { key: 'currency', env: 'AIRTEL_CURRENCY', secret: false },
      { key: 'baseUrl', env: 'AIRTEL_API_BASE_URL', required: false, secret: false },
      { key: 'callbackSecret', env: 'AIRTEL_CALLBACK_SECRET', required: false, secret: true },
    ],
    async createPayment(request, ctx) {
      const credentials = ctx.credentials;
      const token = await accessToken(ctx, credentials);
      const data = await sendJson(
        ctx.transport,
        {
          method: 'POST',
          url: credentials.baseUrl + '/merchant/v1/payments/',
          headers: {
            authorization: 'Bearer ' + token,
            'x-country': credentials.country,
            'x-currency': credentials.currency,
          },
          body: {
            reference: request.reference || request.intent.id,
            subscriber: {
              country: credentials.country,
              currency: credentials.currency,
              msisdn: requireCustomer(request.customer),
            },
            transaction: {
              amount: request.amount_milli,
              country: credentials.country,
              currency: credentials.currency,
              id: request.reference || request.intent.id,
            },
          },
        },
        'airtel',
      );
      const body = unwrap(data);
      const transaction = (body && body.transaction) || {};
      const status = normalizeStatus((body && body.status && body.status.result_code) || transaction.status, AIRTEL_STATUS_MAP);
      return { provider_ref: transaction.id || request.reference || request.intent.id, status, raw: data };
    },
    async getPayment(providerRef, ctx) {
      const credentials = ctx.credentials;
      const token = await accessToken(ctx, credentials);
      const data = await sendJson(
        ctx.transport,
        {
          method: 'GET',
          url: credentials.baseUrl + '/standard/v1/payments/' + encodeURIComponent(providerRef),
          headers: { authorization: 'Bearer ' + token, 'x-country': credentials.country, 'x-currency': credentials.currency },
        },
        'airtel',
      );
      const body = unwrap(data);
      const transaction = (body && body.transaction) || {};
      return { status: normalizeStatus((body && body.status && body.status.result_code) || transaction.status, AIRTEL_STATUS_MAP), raw: data };
    },
    parseCallback(payload, headers, ctx) {
      if (!payload || typeof payload !== 'object') throw new DataError('E_ARG', '[airtel] callback payload required');
      const secret = (ctx.credentials && ctx.credentials.callbackSecret) || null;
      const provided = headers && (headers['x-signature'] || headers['X-Signature']);
      if (!secret || !constantTimeEqual(secret, provided)) {
        throw new DataError('E_PAYMENT_SIGNATURE', '[airtel] callback signature rejected');
      }
      const transaction = payload.transaction || (payload.data && payload.data.transaction) || {};
      return {
        provider_ref: transaction.id || payload.id || null,
        status: normalizeStatus(transaction.status || payload.status, AIRTEL_STATUS_MAP),
        amount_milli: Number.isSafeInteger(Number(transaction.amount)) ? Number(transaction.amount) : null,
        currency: 'MGA',
        raw: payload,
      };
    },
  });
}

module.exports = { createAirtelProvider, AIRTEL_STATUS_MAP };
