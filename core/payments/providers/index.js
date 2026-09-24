'use strict';
const { createMvolaProvider } = require('./mvola');
const { createAirtelProvider } = require('./airtel');
const { createOrangeProvider } = require('./orange');
const { createBinanceProvider, signedQuery } = require('./binance');
const { createNowPaymentsProvider } = require('./nowpayments');

const PROVIDER_FACTORIES = [
  createMvolaProvider,
  createAirtelProvider,
  createOrangeProvider,
  createBinanceProvider,
  createNowPaymentsProvider,
];

function buildProviderRegistry() {
  const registry = new Map();
  for (const factory of PROVIDER_FACTORIES) {
    const provider = factory();
    if (registry.has(provider.name)) throw new Error('duplicate payment provider: ' + provider.name);
    registry.set(provider.name, provider);
  }
  return registry;
}

module.exports = {
  buildProviderRegistry,
  PROVIDER_FACTORIES,
  createMvolaProvider,
  createAirtelProvider,
  createOrangeProvider,
  createBinanceProvider,
  createNowPaymentsProvider,
  signedQuery,
};
