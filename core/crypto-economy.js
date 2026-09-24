'use strict';
const { DataError, ok } = require('./db');

const STAKE_USD_CENTS = Object.freeze([10, 50, 100, 200, 500]);
const MIN_CRYPTO_DEPOSIT_USD_CENTS = 50;
const MIN_CRYPTO_WITHDRAW_USD_CENTS = 50;
const SCALE = 18n;
const TEN = 10n;
const SCALE_FACTOR = TEN ** SCALE;

function decimalParts(value) {
  const text = String(value === undefined || value === null ? '' : value).trim();
  if (!/^\d+(?:\.\d{1,18})?$/.test(text)) throw new DataError('E_CRYPTO_AMOUNT', 'invalid decimal amount');
  let [whole, fraction = ''] = text.split('.');
  whole = whole.replace(/^0+(?=\d)/, '');
  return { whole, fraction, scale: fraction.length };
}

function scaled(value) {
  const p = decimalParts(value);
  return BigInt(p.whole + p.fraction.padEnd(18, '0'));
}
function decimalFromScaled(value) {
  const raw = BigInt(value).toString().padStart(19, '0');
  const whole = raw.slice(0, -18).replace(/^0+(?=\d)/, '') || '0';
  const fraction = raw.slice(-18).replace(/0+$/, '');
  return fraction ? whole + '.' + fraction : whole;
}
function multiplyDecimal(a, b) {
  return decimalFromScaled((scaled(a) * scaled(b)) / SCALE_FACTOR);
}
function divideDecimal(a, b) {
  ok(scaled(b) > 0n, 'E_FX_RATE_INVALID', 'rate must be positive');
  return decimalFromScaled((scaled(a) * SCALE_FACTOR) / scaled(b));
}
function normalizeAsset(asset) {
  const value = String(asset || '').trim().toUpperCase();
  ok(/^[A-Z0-9]{2,12}$/.test(value), 'E_CRYPTO_ASSET', 'invalid crypto asset');
  return value;
}
function normalizeNetwork(network) {
  const value = String(network || '').trim().toLowerCase();
  ok(/^[a-z0-9._-]{2,32}$/.test(value), 'E_CRYPTO_NETWORK', 'invalid crypto network');
  return value;
}
function rateKey(asset, network) { return normalizeAsset(asset) + '/' + normalizeNetwork(network); }

function parseConfiguredRates(env = {}) {
  const raw = env.CRYPTO_USD_RATES_JSON || '{}';
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    throw new DataError('E_FX_RATE_CONFIG', 'CRYPTO_USD_RATES_JSON is invalid');
  }
}

function isStable(asset) { return ['USDT', 'USDC'].includes(normalizeAsset(asset)); }

function resolveUsdRate(asset, network, env = {}) {
  const key = rateKey(asset, network);
  if (isStable(asset)) return '1';
  const rates = parseConfiguredRates(env);
  const raw = rates[key] !== undefined ? rates[key] : rates[key.replace('/', ':')];
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    throw new DataError('E_FX_RATE_UNAVAILABLE', 'USD rate unavailable for ' + key);
  }
  const value = decimalFromScaled(scaled(raw));
  ok(scaled(value) > 0n, 'E_FX_RATE_INVALID', 'USD rate must be positive for ' + key);
  return value;
}

function mgaPerUsd(env = {}) {
  const raw = env.MGA_PER_USD || env.USD_TO_MGA_RATE || '';
  if (!String(raw).trim()) throw new DataError('E_FX_RATE_UNAVAILABLE', 'MGA_PER_USD rate is not configured');
  const value = decimalFromScaled(scaled(raw));
  ok(scaled(value) > 0n, 'E_FX_RATE_INVALID', 'MGA_PER_USD must be positive');
  return value;
}

function centsToUsd(cents) {
  ok(Number.isInteger(cents) && cents > 0, 'E_STAKE_AMOUNT', 'stake cents must be positive');
  return decimalFromScaled(BigInt(cents) * (SCALE_FACTOR / 100n));
}
function usdToCrypto(usd, usdRate) {
  const out = divideDecimal(usd, usdRate);
  ok(scaled(out) > 0n, 'E_CRYPTO_AMOUNT', 'USD value converts to zero crypto');
  return out;
}
function cryptoToUsd(crypto, usdRate) { return multiplyDecimal(crypto, usdRate); }
function usdAtLeastCents(usd, cents) {
  ok(Number.isInteger(cents) && cents > 0, 'E_FX_RATE_INVALID', 'USD cents threshold must be positive');
  return scaled(usd) >= BigInt(cents) * (SCALE_FACTOR / 100n);
}
function usdToMgaMilli(usd, rate) {
  const mga = multiplyDecimal(usd, rate);
  return Number((scaled(mga) * 1000n) / SCALE_FACTOR);
}
function mgaMilliToUsd(milli, rate) {
  ok(Number.isSafeInteger(milli) && milli > 0, 'E_MGA_AMOUNT', 'MGA amount must be positive');
  return divideDecimal(decimalFromScaled(BigInt(milli) * (SCALE_FACTOR / 1000n)), rate);
}

function validateStakeUsdCents(cents) {
  ok(STAKE_USD_CENTS.includes(Number(cents)), 'E_STAKE_AMOUNT', 'allowed crypto stakes are $0.10, $0.50, $1, $2 or $5');
  return Number(cents);
}

function buildCryptoEconomy(options = {}) {
  const env = options.env || {};
  function stake(stakeUsdCents, asset, network) {
    const cents = validateStakeUsdCents(stakeUsdCents);
    const a = normalizeAsset(asset);
    const n = normalizeNetwork(network);
    const rate = resolveUsdRate(a, n, env);
    return { stake_usd_cents: cents, stake_usd: centsToUsd(cents), asset: a, network: n, usd_rate: rate, amount_crypto: usdToCrypto(centsToUsd(cents), rate) };
  }
  function quoteCryptoToMga(input = {}) {
    const a = normalizeAsset(input.asset); const n = normalizeNetwork(input.network);
    const amountCrypto = String(input.amount || '').trim();
    const rate = resolveUsdRate(a, n, env); const fx = mgaPerUsd(env);
    const usd = cryptoToUsd(amountCrypto, rate); const mgaMilli = usdToMgaMilli(usd, fx);
    return { direction: 'crypto_to_mga', asset: a, network: n, amount_crypto: amountCrypto, usd_rate: rate, mga_per_usd: fx, amount_usd: usd, amount_mga_milli: mgaMilli };
  }
  function quoteMgaToCrypto(input = {}) {
    const a = normalizeAsset(input.asset); const n = normalizeNetwork(input.network);
    const milli = Number(input.amount_mga_milli);
    const rate = resolveUsdRate(a, n, env); const fx = mgaPerUsd(env);
    const usd = mgaMilliToUsd(milli, fx); const amountCrypto = usdToCrypto(usd, rate);
    return { direction: 'mga_to_crypto', asset: a, network: n, amount_mga_milli: milli, usd_rate: rate, mga_per_usd: fx, amount_usd: usd, amount_crypto: amountCrypto };
  }
  return { stake, quoteCryptoToMga, quoteMgaToCrypto, resolveUsdRate: (a,n)=>resolveUsdRate(a,n,env), mgaPerUsd: ()=>mgaPerUsd(env), validateStakeUsdCents };
}

module.exports = { STAKE_USD_CENTS, MIN_CRYPTO_DEPOSIT_USD_CENTS, MIN_CRYPTO_WITHDRAW_USD_CENTS, buildCryptoEconomy, normalizeAsset, normalizeNetwork, rateKey, resolveUsdRate, mgaPerUsd, centsToUsd, usdToCrypto, cryptoToUsd, usdAtLeastCents, usdToMgaMilli, mgaMilliToUsd, validateStakeUsdCents };