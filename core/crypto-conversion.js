'use strict';
const crypto = require('node:crypto');
const { DataError, ok, nowIso, genId, safeMeta, safeRollback, toDataError } = require('./db');
const { appendWithinTx } = require('./ledger');
const { buildCryptoEconomy } = require('./crypto-economy');

function sha256hex(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }
const GENESIS = '0'.repeat(64);

function buildCryptoConversion(deps = {}) {
  const db = deps.db; const repos = deps.repos; const cryptoLedger = deps.cryptoLedger;
  const cryptoEconomy = deps.cryptoEconomy || buildCryptoEconomy({ env: deps.env || process.env });
  const gameWallet = deps.gameWallet;
  ok(db && repos && cryptoLedger && gameWallet, 'E_ARG', 'crypto conversion requires db, repos, crypto ledger and game wallet');

  function userMgaWallet(userId) {
    const wallet = repos.getWalletByUser(userId);
    ok(wallet && wallet.currency === 'MGA', 'E_NO_WALLET', 'MGA wallet is required for conversion');
    ok(wallet.status === 'active', 'E_WALLET_INACTIVE', 'MGA wallet is not active');
    return wallet;
  }

  function houseMgaWallet() {
    const wallet = gameWallet.houseWallet();
    ok(wallet, 'E_NO_HOUSE_WALLET', 'house MGA wallet is unavailable');
    return wallet;
  }

  function conversionHash(row) {
    return sha256hex([
      'crypto-conversion', row.id, row.user_id, row.direction, row.asset, row.network,
      row.amount_crypto, row.amount_mga_milli, row.amount_usd, row.usd_rate, row.mga_per_usd,
      row.status, row.idempotency_key, row.prev_hash, row.meta_json, row.created_at,
    ].join('\x1f'));
  }

  function existing(key) {
    return db.prepare('SELECT * FROM crypto_conversions WHERE idempotency_key = ?').get(key) || null;
  }

  function convert(input = {}) {
    const direction = String(input.direction || '').trim().toLowerCase();
    ok(direction === 'crypto_to_mga' || direction === 'mga_to_crypto', 'E_CONVERSION_DIRECTION', 'invalid conversion direction');
    const userId = String(input.user_id || ''); ok(userId, 'E_ARG', 'user_id is required');
    const asset = String(input.asset || '').trim().toUpperCase();
    const network = String(input.network || '').trim().toLowerCase();
    const idempotencyKey = String(input.idempotency_key || '');
    ok(/^[A-Za-z0-9_.:-]{8,128}$/.test(idempotencyKey), 'E_IDEMPOTENCY_KEY_REQUIRED', 'valid Idempotency-Key is required');

    const old = existing(idempotencyKey);
    if (old) return { idempotent: true, conversion: old };

    const userWallet = userMgaWallet(userId);
    const houseWallet = houseMgaWallet();
    const quote = direction === 'crypto_to_mga'

      ? cryptoEconomy.quoteCryptoToMga({ asset, network, amount: input.amount_crypto })

      : cryptoEconomy.quoteMgaToCrypto({ asset, network, amount_mga_milli: input.amount_mga_milli });

    db.exec('BEGIN IMMEDIATE');
    try {
      const replay = existing(idempotencyKey);
      if (replay) { db.exec('COMMIT'); return { idempotent: true, conversion: replay }; }
      let cryptoUser, cryptoHouse, mgaUser, mgaHouse;
      if (direction === 'crypto_to_mga') {
        const userBalance = cryptoLedger.getBalance(userId, quote.asset, quote.network);
        const houseBalance = cryptoLedger.getBalance(houseWallet.user_id, quote.asset, quote.network);
        ok(userBalance, 'E_CRYPTO_BALANCE_NOT_FOUND', 'crypto balance is not available');
        ok(cryptoLedger.compareDecimal(userBalance.available_amount, quote.amount_crypto) >= 0, 'E_CRYPTO_INSUFFICIENT_FUNDS', 'insufficient crypto balance for conversion');
        ok(houseWallet.balance_milli >= quote.amount_mga_milli, 'E_HOUSE_INSUFFICIENT_MGA', 'house MGA liquidity is insufficient for conversion');
        cryptoUser = cryptoLedger.debitWithinTx({ user_id: userId, asset: quote.asset, network: quote.network, amount: quote.amount_crypto, idempotency_key: 'conversion:crypto-debit:' + idempotencyKey, meta: { kind: 'crypto_to_mga', conversion_key: idempotencyKey } });
        cryptoHouse = cryptoLedger.creditWithinTx({ user_id: houseWallet.user_id, asset: quote.asset, network: quote.network, amount: quote.amount_crypto, tx_type: 'credit', idempotency_key: 'conversion:crypto-house-credit:' + idempotencyKey, meta: { kind: 'crypto_to_mga', conversion_key: idempotencyKey } });
        mgaHouse = appendWithinTx(db, { wallet_id: houseWallet.id, idempotency_key: 'conversion:mga-house-debit:' + idempotencyKey, tx_type: 'adjustment', direction: 'debit', amount_milli: quote.amount_mga_milli, status: 'committed', meta: { kind: 'crypto_to_mga', conversion_key: idempotencyKey } });
        mgaUser = appendWithinTx(db, { wallet_id: userWallet.id, idempotency_key: 'conversion:mga-user-credit:' + idempotencyKey, tx_type: 'adjustment', direction: 'credit', amount_milli: quote.amount_mga_milli, status: 'committed', meta: { kind: 'crypto_to_mga', conversion_key: idempotencyKey } });
      } else {
        ok(userWallet.balance_milli >= quote.amount_mga_milli, 'E_INSUFFICIENT_FUNDS', 'insufficient MGA balance for conversion');
        const houseBalance = cryptoLedger.getBalance(houseWallet.user_id, quote.asset, quote.network);
        ok(houseBalance && cryptoLedger.compareDecimal(houseBalance.available_amount, quote.amount_crypto) >= 0, 'E_HOUSE_INSUFFICIENT_CRYPTO', 'house crypto liquidity is insufficient for conversion');
        mgaUser = appendWithinTx(db, { wallet_id: userWallet.id, idempotency_key: 'conversion:mga-user-debit:' + idempotencyKey, tx_type: 'adjustment', direction: 'debit', amount_milli: quote.amount_mga_milli, status: 'committed', meta: { kind: 'mga_to_crypto', conversion_key: idempotencyKey } });
        mgaHouse = appendWithinTx(db, { wallet_id: houseWallet.id, idempotency_key: 'conversion:mga-house-credit:' + idempotencyKey, tx_type: 'adjustment', direction: 'credit', amount_milli: quote.amount_mga_milli, status: 'committed', meta: { kind: 'mga_to_crypto', conversion_key: idempotencyKey } });
        cryptoHouse = cryptoLedger.debitWithinTx({ user_id: houseWallet.user_id, asset: quote.asset, network: quote.network, amount: quote.amount_crypto, idempotency_key: 'conversion:crypto-house-debit:' + idempotencyKey, meta: { kind: 'mga_to_crypto', conversion_key: idempotencyKey } });
        cryptoUser = cryptoLedger.creditWithinTx({ user_id: userId, asset: quote.asset, network: quote.network, amount: quote.amount_crypto, tx_type: 'credit', idempotency_key: 'conversion:crypto-user-credit:' + idempotencyKey, meta: { kind: 'mga_to_crypto', conversion_key: idempotencyKey } });
      }
      const ts = nowIso(); const id = genId();
      const prev = db.prepare('SELECT hash FROM crypto_conversions ORDER BY seq DESC LIMIT 1').get();
      const row = { id, user_id: userId, direction, asset: quote.asset, network: quote.network, amount_crypto: quote.amount_crypto, amount_mga_milli: quote.amount_mga_milli, amount_usd: quote.amount_usd, usd_rate: quote.usd_rate, mga_per_usd: quote.mga_per_usd, status: 'completed', idempotency_key: idempotencyKey, prev_hash: (prev && prev.hash) || GENESIS, meta_json: safeMeta({ kind: 'crypto_conversion', crypto_user_seq: cryptoUser.entry ? cryptoUser.entry.seq : null, crypto_house_seq: cryptoHouse.entry ? cryptoHouse.entry.seq : null, mga_user_seq: mgaUser ? mgaUser.entry.seq : null, mga_house_seq: mgaHouse ? mgaHouse.entry.seq : null }), created_at: ts };
      row.hash = conversionHash(row);
      db.prepare('INSERT INTO crypto_conversions (id,user_id,direction,asset,network,amount_crypto,amount_mga_milli,amount_usd,usd_rate,mga_per_usd,status,idempotency_key,prev_hash,hash,meta_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(row.id,row.user_id,row.direction,row.asset,row.network,row.amount_crypto,row.amount_mga_milli,row.amount_usd,row.usd_rate,row.mga_per_usd,row.status,row.idempotency_key,row.prev_hash,row.hash,row.meta_json,row.created_at);
      db.exec('COMMIT');
      try { repos.recordAudit({ actorType: 'user', actorId: userId, action: 'crypto.conversion.completed', targetType: 'crypto_conversion', targetId: row.id, detail: { direction, asset: row.asset, network: row.network, amount_crypto: row.amount_crypto, amount_mga_milli: row.amount_mga_milli, amount_usd: row.amount_usd } }); } catch (_) {}
      return { idempotent: false, conversion: row };
    } catch (err) { safeRollback(db); throw toDataError(err, 'E_CRYPTO_CONVERSION', 'crypto conversion failed'); }
  }

  function list(userId, limit = 100) {
    const n = Number.isSafeInteger(limit) ? Math.min(Math.max(limit, 1), 500) : 100;
    return db.prepare('SELECT * FROM crypto_conversions WHERE user_id = ? ORDER BY created_at DESC, seq DESC LIMIT ?').all(String(userId), n);
  }

  function verify() {
    const rows = db.prepare('SELECT * FROM crypto_conversions ORDER BY seq ASC').all();
    let prev = GENESIS;
    for (const row of rows) {
      ok(row.prev_hash === prev, 'E_CRYPTO_CONVERSION_CHAIN', 'conversion hash chain broken at seq ' + row.seq);
      ok(conversionHash(row) === row.hash, 'E_CRYPTO_CONVERSION_HASH', 'conversion hash mismatch at seq ' + row.seq);
      prev = row.hash;
    }
    return { ok: true, conversions: rows.length, crypto_ledger: cryptoLedger.verify() };
  }

  return { convert, list, verify, conversionHash };
}

module.exports = { buildCryptoConversion, sha256hex, GENESIS };