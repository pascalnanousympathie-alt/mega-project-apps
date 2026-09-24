'use strict';
const { buildPaymentGateway } = require('./gateway');
const { safeBaseUrl, describeReadiness, evaluatePaymentsReadiness } = require('./readiness');
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
const { maskSecret, hmacSha256Hex, hmacSha512Hex, basicAuthHeader } = require('./sign');
const { MVOLA_PROJECTS, normalizeMvolaProject, mvolaProjectEnv, resolveMvolaProjectCredentials } = require('./project-map');
const {
  buildProviderRegistry,
  PROVIDER_FACTORIES,
  createMvolaProvider,
  createAirtelProvider,
  createOrangeProvider,
  createBinanceProvider,
  createNowPaymentsProvider,
} = require('./providers');

module.exports = {
  buildPaymentGateway,
  buildProviderRegistry,
  PROVIDER_FACTORIES,
  createMvolaProvider,
  createAirtelProvider,
  createOrangeProvider,
  createBinanceProvider,
  createNowPaymentsProvider,
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
  hmacSha512Hex,
  basicAuthHeader,
  MVOLA_PROJECTS,
  normalizeMvolaProject,
  mvolaProjectEnv,
  resolveMvolaProjectCredentials,
  safeBaseUrl,
  describeReadiness,
  evaluatePaymentsReadiness,
};
