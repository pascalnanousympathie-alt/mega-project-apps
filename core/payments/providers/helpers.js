'use strict';
const { DataError } = require('../../db');
const { redactText } = require('../redact');

async function sendJson(transport, spec, providerName) {
  const response = await transport(spec);
  if (!response || !response.ok) {
    const status = response ? response.status : 0;
    const raw = response && response.data;
    const text = typeof raw === 'string' ? raw : raw === undefined || raw === null ? '' : JSON.stringify(raw);
    const snippet = redactText(String(text).slice(0, 240));
    throw new DataError(
      'E_PAYMENT_TRANSPORT',
      '[' + providerName + '] provider http ' + status + (snippet ? ': ' + snippet : ''),
    );
  }
  return response.data === undefined ? null : response.data;
}

function requireCustomer(customer) {
  const value = customer && (customer.msisdn || customer.phone || customer.account);
  if (!value) {
    throw new DataError('E_ARG', 'customer msisdn/phone is required for mobile money payments');
  }
  return String(value).replace(/\s+/g, '');
}

module.exports = { sendJson, requireCustomer };
