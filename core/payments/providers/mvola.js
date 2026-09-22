'use strict';
const { DataError } = require('../../db');
const { createProvider, normalizeStatus, defineProviderError } = require('../base');
const { basicAuthHeader, constantTimeEqual } = require('../sign');
const { sendJson, requireCustomer } = require('./helpers');

const MVOLA_STATUS_MAP = {
  pending: 'pending',
  success: 'succeeded',
  completed: 'succeeded',
  succeeded: 'succeeded',
  failed: 'failed',
  failure: 'failed',
  cancelled: 'cancelled',
  canceled: 'cancelled',
  expired: 'expired',
};

async function accessToken(ctx, credentials) {
  if (credentials.accessToken) return credentials.accessToken;
  const data = await sendJson(
    ctx.transport,
    {
      method: 'POST',
      url: credentials.baseUrl + '/token',
      encoding: 'form',
      headers: { authorization: basicAuthHeader(credentials.consumerKey, credentials.consumerSecret) },
      body: { grant_type: 'client_credentials', scope: 'EXT_INT_MVOLA_SCOPE' },
    },
    'mvola',
  );
  if (!data || !data.access_token) throw new DataError('E_PAYMENT_TRANSPORT', '[mvola] token response missing access_token');
  return data.access_token;
}

function createMvolaProvider() {
  return createProvider({
    name: 'mvola',
    displayName: 'MVola (Telma)',
    currency: 'MGA',
    directions: ['payin'],
    defaultBaseUrl: 'https://devapi.mvola.mg',
    capabilities: { callback: true, polling: true, refund: false },
    limits: { min_milli: 1000, max_milli: 2000000000 },
    statusMap: MVOLA_STATUS_MAP,
    credentialSpec: [
      { key: 'consumerKey', env: 'MVOLA_CONSUMER_KEY', secret: true },
      { key: 'consumerSecret', env: 'MVOLA_CONSUMER_SECRET', secret: true },
      { key: 'apiKey', env: 'MVOLA_API_KEY', required: false, secret: true },
      { key: 'merchantNumber', env: 'MVOLA_MERCHANT_NUMBER', secret: false },
      { key: 'partnerName', env: 'MVOLA_PARTNER_NAME', secret: false },
      { key: 'baseUrl', env: 'MVOLA_BASE_URL', required: false, secret: false },
      { key: 'callbackSecret', env: 'MVOLA_CALLBACK_SECRET', required: false, secret: true },
    ],
    async createPayment(request, ctx) {
      const credentials = ctx.credentials;
      const token = await accessToken(ctx, credentials);
      const reference = request.reference || request.intent.id;
      const debit = requireCustomer(request.customer);
      const data = await sendJson(
        ctx.transport,
        {
          method: 'POST',
          url: credentials.baseUrl + '/mvola/mm/transactions/type/merchantpay/1.0.0/',
          headers: {
            authorization: 'Bearer ' + token,
            'x-correlation-id': reference,
            version: '1.0',
            userlanguage: 'FR',
            useraccountidentifier: 'msisdn;' + credentials.merchantNumber,
            partnername: credentials.partnerName,
            'cache-control': 'no-cache',
            ...(ctx.callbackUrl ? { 'x-callback-url': ctx.callbackUrl } : {}),
          },
          body: {
            amount: String(request.amount_milli),
            currency: 'Ar',
            descriptionText: request.description || 'ACEP payment',
            requestDate: ctx.nowIso(),
            requestingOrganisationTransactionReference: reference,
            debitParty: [{ key: 'msisdn', value: debit }],
            creditParty: [{ key: 'msisdn', value: credentials.merchantNumber }],
            metadata: [{ key: 'partnerName', value: credentials.partnerName }],
          },
        },
        'mvola',
      );
      const status = normalizeStatus(data && data.status, MVOLA_STATUS_MAP);
      if (status === 'pending' && !(data && (data.serverCorrelationId || data.transactionId))) {
        throw defineProviderError(this, 'E_PAYMENT_TRANSPORT', 'unexpected provider response without correlation id');
      }
      return { provider_ref: (data && (data.serverCorrelationId || data.transactionId)) || reference, status, raw: data };
    },
    async getPayment(providerRef, ctx) {
      const credentials = ctx.credentials;
      const token = await accessToken(ctx, credentials);
      const data = await sendJson(
        ctx.transport,
        {
          method: 'GET',
          url: credentials.baseUrl + '/mvola/mm/transactions/type/merchantpay/1.0.0/status/' + encodeURIComponent(providerRef),
          headers: {
            authorization: 'Bearer ' + token,
            'x-correlation-id': providerRef,
            version: '1.0',
            userlanguage: 'FR',
            useraccountidentifier: 'msisdn;' + credentials.merchantNumber,
            partnername: credentials.partnerName,
            'cache-control': 'no-cache',
          },
        },
        'mvola',
      );
      return {
        status: normalizeStatus(data && (data.transactionStatus || data.status), MVOLA_STATUS_MAP),
        provider_ref: (data && (data.serverCorrelationId || providerRef)),
        raw: data,
      };
    },
    parseCallback(payload, headers, ctx) {
      if (!payload || typeof payload !== 'object') throw new DataError('E_ARG', '[mvola] callback payload required');
      const secret = (ctx.credentials && ctx.credentials.callbackSecret) || null;
      const provided = headers && (headers['x-content-signature'] || headers['X-Content-Signature']);
      if (!secret || !constantTimeEqual(secret, provided)) {
        throw new DataError('E_PAYMENT_SIGNATURE', '[mvola] callback signature rejected');
      }
      return {
        provider_ref: payload.serverCorrelationId || payload.transactionId || (payload.transaction && payload.transaction.transactionId) || null,
        status: normalizeStatus(payload.transactionStatus || payload.status, MVOLA_STATUS_MAP),
        amount_milli: Number.isSafeInteger(Number(payload.amount)) ? Number(payload.amount) : null,
        currency: 'MGA',
        raw: payload,
      };
    },
  });
}

module.exports = { createMvolaProvider, MVOLA_STATUS_MAP };
