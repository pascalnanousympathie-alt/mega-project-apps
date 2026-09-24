#!/usr/bin/env node
'use strict';
const { buildProviderRegistry, evaluatePaymentsReadiness } = require('../core/payments');

const registry = buildProviderRegistry();
const required = (process.env.ACEP_REQUIRED_PAYMENT_PROVIDERS || 'nowpayments')
  .split(',').map((value) => value.trim()).filter(Boolean);
const enforce = process.env.ACEP_ENFORCE_PAYMENT_READINESS === '1';
const production = process.env.ACEP_PRODUCTION_MODE !== 'false';
const report = evaluatePaymentsReadiness(registry, { providers: required, env: process.env, production });

console.log(`PAYMENT_READINESS=${report.ready ? 'PASS' : 'NOT_READY'}`);
console.log(`PRODUCTION_MODE=${production ? 'true' : 'false'}`);
console.log(`ENFORCE=${enforce ? 'true' : 'false'}`);
for (const row of report.providers) {
  console.log(`PROVIDER=${row.name} READY=${row.ready ? 'true' : 'false'} CALLBACK_SECRET=${row.callback_secret || 'ABSENT'} CALLBACK=${row.callback || 'UNKNOWN'} POLLING=${row.polling || 'UNKNOWN'} BASE_URL=${row.base_url || 'ABSENT'}`);
  if (Array.isArray(row.missing_credentials) && row.missing_credentials.length) {
    console.log(`MISSING=${row.missing_credentials.join(',')}`);
  }
  if (Array.isArray(row.reasons) && row.reasons.length) {
    console.log(`REASONS=${row.reasons.join(',')}`);
  }
}
if (enforce && !report.ready) process.exit(1);
