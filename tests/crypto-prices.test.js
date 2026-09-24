const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildCryptoPriceFeed } = require('../core/crypto-price-feed');
const { buildCryptoEconomy } = require('../core/crypto-economy');

function fakeFetch(prices) {
  return async (url) => {
    const match = /\/prices\/([^/]+)\/spot/.exec(url);
    const asset = match ? decodeURIComponent(match[1]).replace('-USD', '') : '';
    const amount = prices[asset];
    if (!amount) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ data: { amount } }) };
  };
}

test('live crypto price feed refreshes, persists and drives dynamic conversion rates', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acep-price-'));
  try {
    const prices = { BTC: '84000', ETH: '2600', SOL: '115', TRX: '0.33', USDT: '1', USDC: '1' };
    const feed = buildCryptoPriceFeed({
      env: { CRYPTO_PRICE_MAX_AGE_MS: '300000' },
      dataDir: dir,
      fetch: fakeFetch(prices),
    });
    await feed.refresh();
    const snapshot = feed.getSnapshot();
    assert.equal(snapshot.rates.BTC, '84000');
    assert.equal(snapshot.rates.TRX, '0.33');
    assert.equal(snapshot.stale, false);
    assert.ok(fs.existsSync(path.join(dir, 'crypto-prices.json')));
    const economy = buildCryptoEconomy({ env: { MGA_PER_USD: '4324.50' }, priceFeed: feed });
    assert.equal(economy.resolveUsdRate('BTC', 'bitcoin'), '84000');
    const quote = economy.quoteCryptoToMga({ asset: 'BTC', network: 'bitcoin', amount: '0.001' });
    assert.equal(quote.amount_usd, '84');
    assert.equal(quote.usd_rate, '84000');
    prices.BTC = '90000';
    await feed.refresh();
    assert.equal(economy.resolveUsdRate('BTC', 'bitcoin'), '90000');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
