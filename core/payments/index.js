'use strict';
const { buildPaymentGateway } = require('./gateway');
const {
  CANONICAL_STATUSES,
  TERMINAL_STATUSES,
  DIRECTIONS,
  STATUS_TRANSITIONS,
  canTransition,
  normalizeStatus,
} = require('./base');
const { redact, stripSecrets, redactText, containsSecretLike } = require('./redact');
const { createHttpTransport } = require('./transport');
const { maskSecret, hmacSha256Hex, basicAuthHeader } = require('./sign');
const {
  buildProviderRegistry,
  PROVIDER_FACTORIES,
  createMvolaProvider,
  createAirtelProvider,
  createOrangeProvider,
  createBinanceProvider,
} = require('./providers');

module.exports = {
  buildPaymentGateway,
  buildProviderRegistry,
  PROVIDER_FACTORIES,
  createMvolaProvider,
  createAirtelProvider,
  createOrangeProvider,
  createBinanceProvider,
  CANONICAL_STATUSES,
  TERMINAL_STATUSES,
  DIRECTIONS,
  STATUS_TRANSITIONS,
  canTransition,
  normalizeStatus,
  redact,
  stripSecrets,
  redactText,
  containsSecretLike,
  createHttpTransport,
  maskSecret,
  hmacSha256Hex,
  basicAuthHeader,
};
