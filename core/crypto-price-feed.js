'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_ASSETS = Object.freeze(['BTC', 'ETH', 'SOL', 'TRX', 'USDT', 'USDC']);
const DEFAULT_SOURCE = 'Coinbase public spot prices';
const DEFAULT_BASE_URL = 'https://api.coinbase.com/v2/prices';
const DEFAULT_REFRESH_MS = 60 * 1000;
const DEFAULT_MAX_AGE_MS = 5 * 60 * 1000;

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function buildCryptoPriceFeed(options = {}) {
  const env = options.env || process.env;
  const dataDir = options.dataDir || process.cwd();
  const snapshotPath = options.snapshotPath || path.join(dataDir, 'crypto-prices.json');
  const assets = Array.isArray(options.assets) && options.assets.length
    ? [...new Set(options.assets.map((a) => String(a).trim().toUpperCase()).filter(Boolean))]
    : [...DEFAULT_ASSETS];
  const refreshMs = positiveInt(env.CRYPTO_PRICE_REFRESH_MS, DEFAULT_REFRESH_MS);
  const maxAgeMs = positiveInt(env.CRYPTO_PRICE_MAX_AGE_MS, DEFAULT_MAX_AGE_MS);
  const baseUrl = String(env.CRYPTO_PRICE_API_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, '');
  const fetchImpl = options.fetch || globalThis.fetch;
  let snapshot = loadSnapshot();
  let timer = null;
  let refreshing = null;

  function loadSnapshot() {
    try {
      const raw = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
      if (raw && typeof raw === 'object' && raw.rates && typeof raw.rates === 'object') return raw;
    } catch (_) {}
    return { source: DEFAULT_SOURCE, updated_at: null, rates: {} };
  }

  function saveSnapshot(next) {
    fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
    const tmp = snapshotPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, snapshotPath);
  }

  async function fetchPrice(asset) {
    if (typeof fetchImpl !== 'function') throw new Error('fetch implementation unavailable');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetchImpl(baseUrl + '/' + encodeURIComponent(asset + '-USD') + '/spot', {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error('price provider HTTP ' + response.status);
      const payload = await response.json();
      const amount = payload && payload.data ? String(payload.data.amount || '') : '';
      if (!/^\d+(?:\.\d{1,18})?$/.test(amount) || Number(amount) <= 0) {
        throw new Error('invalid USD price for ' + asset);
      }
      return amount;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function refresh() {
    if (refreshing) return refreshing;
    refreshing = Promise.all(assets.map(async (asset) => {
      try {
        return [asset, await fetchPrice(asset)];
      } catch (_) {
        return [asset, null];
      }
    })).then((pairs) => {
      const rates = { ...snapshot.rates };
      for (const [asset, price] of pairs) if (price) rates[asset] = price;
      const next = { source: DEFAULT_SOURCE, updated_at: new Date().toISOString(), rates };
      snapshot = next;
      try { saveSnapshot(next); } catch (_) {}
      return getSnapshot();
    }).finally(() => { refreshing = null; });
    return refreshing;
  }

  function getUsdRateSync(asset) {
    const key = String(asset || '').trim().toUpperCase();
    const raw = snapshot.rates[key];
    if (!raw || !snapshot.updated_at) return null;
    const age = Date.now() - new Date(snapshot.updated_at).getTime();
    if (!Number.isFinite(age) || age < 0 || age > maxAgeMs) return null;
    return String(raw);
  }

  function getSnapshot() {
    const updatedAt = snapshot.updated_at || null;
    const ageMs = updatedAt ? Math.max(0, Date.now() - new Date(updatedAt).getTime()) : null;
    return {
      source: snapshot.source || DEFAULT_SOURCE,
      updated_at: updatedAt,
      age_ms: ageMs,
      stale: ageMs === null || ageMs > maxAgeMs,
      max_age_ms: maxAgeMs,
      rates: { ...snapshot.rates },
    };
  }

  function start() {
    stop();
    void refresh();
    timer = setInterval(() => { void refresh(); }, refreshMs);
    if (timer.unref) timer.unref();
    return getSnapshot();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { refresh, start, stop, getUsdRateSync, getSnapshot, snapshotPath, assets: [...assets] };
}

module.exports = {
  buildCryptoPriceFeed,
  DEFAULT_ASSETS,
  DEFAULT_SOURCE,
  DEFAULT_BASE_URL,
  DEFAULT_REFRESH_MS,
  DEFAULT_MAX_AGE_MS,
};
