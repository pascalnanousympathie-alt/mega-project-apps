'use strict';
const { missingCredentials, resolveCredentials } = require('./base');
const { normalizeMvolaProject, resolveMvolaProjectCredentials } = require('./project-map');

const UNSAFE_PRODUCTION_HOST_MARKERS = [
  'localhost', '127.0.0.1', '0.0.0.0', 'sandbox', 'test', 'devapi.', 'pre-api.',
];
const UNSAFE_PRODUCTION_PATH_MARKERS = ['/dev/', '/sandbox/', '/test/'];

function isPresent(value) {
  return value !== undefined && value !== null && String(value).trim().length > 0;
}

function safeBaseUrl(value) {
  if (!isPresent(value)) return { ok: false, reason: 'base_url_absent' };
  let url;
  try { url = new URL(String(value)); } catch (_) { return { ok: false, reason: 'base_url_invalid' }; }
  if (url.protocol !== 'https:') return { ok: false, reason: 'base_url_not_https' };
  const host = url.hostname.toLowerCase();
  const path = url.pathname.toLowerCase();
  if (UNSAFE_PRODUCTION_HOST_MARKERS.some((m) => host.includes(m))) return { ok: false, reason: 'sandbox_or_dev_host' };
  if (UNSAFE_PRODUCTION_PATH_MARKERS.some((m) => path.includes(m))) return { ok: false, reason: 'sandbox_or_dev_path' };
  return { ok: true, normalized: url.toString() };
}

function missingForReadiness(provider, credentials) {
  if (provider.name !== 'mvola') return missingCredentials(provider, credentials);
  const source = credentials || {};
  const missing = [];
  const hasApiKey = String(source.apiKey || '').trim().length > 0;
  const hasOAuthPair = String(source.consumerKey || '').trim().length > 0 && String(source.consumerSecret || '').trim().length > 0;
  if (!hasApiKey && !hasOAuthPair) missing.push('MVOLA_API_KEY or MVOLA_CONSUMER_KEY+MVOLA_CONSUMER_SECRET');
  if (!String(source.merchantNumber || '').trim()) missing.push('MVOLA_MERCHANT_NUMBER or MVOLA_PARTNER_MSISDN');
  if (!String(source.partnerName || '').trim()) missing.push('MVOLA_PARTNER_NAME');
  return missing;
}

function describeReadiness(provider, input = {}) {
  let credentials = resolveCredentials(provider, { credentials: input.credentials || {}, env: input.env || {} });
  if (provider.name === 'mvola' && input.project) {
    const project = normalizeMvolaProject(input.project);
    if (project) credentials = { ...credentials, ...(resolveMvolaProjectCredentials(project, input.env || {}) || {}) };
  }
  const missing = missingForReadiness(provider, credentials);
  const callbackReady = isPresent(credentials.callbackSecret);
  const url = safeBaseUrl(credentials.baseUrl || provider.defaultBaseUrl);
  const pollingReady = Boolean(provider.capabilities && provider.capabilities.polling);
  const callbackCapability = Boolean(provider.capabilities && provider.capabilities.callback);
  const reasons = [];
  if (missing.length) reasons.push('required_credentials_absent');
  if (!callbackReady) reasons.push('callback_secret_absent');
  if (!callbackCapability) reasons.push('callback_unsupported');
  if (!pollingReady) reasons.push('polling_unsupported');
  if (!url.ok) reasons.push(url.reason);
  return {
    name: provider.name,
    ready: reasons.length === 0,
    required_credentials: provider.credentialSpec.filter((s) => s.required !== false).map((s) => s.env),
    missing_credentials: missing,
    callback_secret: callbackReady ? 'SET' : 'ABSENT',
    callback: callbackCapability ? 'SUPPORTED' : 'UNSUPPORTED',
    polling: pollingReady ? 'SUPPORTED' : 'UNSUPPORTED',
    base_url: url.ok ? 'HTTPS_PRODUCTION_SAFE' : url.reason,
    reasons,
  };
}

function evaluatePaymentsReadiness(registry, input = {}) {
  const wanted = Array.isArray(input.providers) && input.providers.length
    ? input.providers.map(String)
    : [...registry.keys()];
  const rows = [];
  for (const name of wanted) {
    const provider = registry.get(name);
    if (!provider) rows.push({ name, ready: false, reasons: ['provider_unknown'] });
    else rows.push(describeReadiness(provider, { credentials: input.credentials && input.credentials[name], env: input.env }));
  }
  return {
    ready: rows.every((row) => row.ready),
    production_mode: input.production !== false,
    providers: rows,
  };
}

module.exports = { UNSAFE_PRODUCTION_HOST_MARKERS, UNSAFE_PRODUCTION_PATH_MARKERS, safeBaseUrl, describeReadiness, evaluatePaymentsReadiness };
