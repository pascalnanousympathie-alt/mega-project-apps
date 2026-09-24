'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { makeDataLayer, makeUser } = require('./helpers');

function fundMGA(layer, user, amount) {
  const wallet = layer.createWallet(user.id);
  layer.ledger.append({ wallet_id: wallet.id, idempotency_key: 'fund:' + wallet.id, tx_type: 'deposit', direction: 'credit', amount_milli: amount });
  return wallet;
}

function fundCrypto(layer, user, amount, asset='USDT', network='tron') {
  return layer.cryptoLedger.credit({ user_id: user.id, asset, network, amount, idempotency_key: 'crypto-fund:' + user.id + ':' + asset + ':' + network });
}

test('crypto economy exposes exactly the five allowed USD stakes', (t) => {
  const { layer } = makeDataLayer(t);
  for (const cents of [10, 50, 100, 200, 500]) {
    const q = layer.gameWallet.normalizeEconomy({ mode:'crypto', stakeUsdCents:cents, asset:'USDT', network:'tron' }, 'online');
    assert.equal(q.mode, 'crypto');
    assert.equal(q.stake_usd_cents, cents);
    assert.equal(q.amount_crypto, String(cents / 100));
  }
  assert.throws(() => layer.gameWallet.normalizeEconomy({ mode:'crypto', stakeUsdCents:25, asset:'USDT', network:'tron' }, 'online'), (e) => e.code === 'E_STAKE_AMOUNT');
  assert.throws(() => layer.gameWallet.normalizeEconomy({ mode:'crypto', stakeUsdCents:10, asset:'BTC', network:'bitcoin' }, 'online'), (e) => e.code === 'E_FX_RATE_UNAVAILABLE');
});

test('crypto to MGA and MGA to crypto are atomic, balanced and idempotent', (t) => {
  const { layer } = makeDataLayer(t, { payments: { env: { MGA_PER_USD:'4500' } } });
  const user = makeUser(layer, 'crypto_fx_user');
  const userWallet = fundMGA(layer, user, 50000000);
  const house = layer.gameWallet.houseWallet();
  layer.ledger.append({ wallet_id: house.id, idempotency_key:'fx-house-seed', tx_type:'deposit', direction:'credit', amount_milli:100000000, status:'committed' });
  fundCrypto(layer, user, '10');
  const a = layer.cryptoConversion.convert({ user_id:user.id, direction:'crypto_to_mga', asset:'USDT', network:'tron', amount_crypto:'1.5', idempotency_key:'fx-ctm-0001' });
  assert.equal(a.conversion.amount_usd, '1.5');
  assert.equal(a.conversion.amount_mga_milli, 6750000);
  assert.equal(layer.cryptoLedger.getBalance(user.id,'USDT','tron').available_amount,'8.5');
  assert.equal(layer.getWallet(userWallet.id).balance_milli,56750000);
  const replay = layer.cryptoConversion.convert({ user_id:user.id, direction:'crypto_to_mga', asset:'USDT', network:'tron', amount_crypto:'1.5', idempotency_key:'fx-ctm-0001' });
  assert.equal(replay.idempotent,true);
  const b = layer.cryptoConversion.convert({ user_id:user.id, direction:'mga_to_crypto', asset:'USDT', network:'tron', amount_mga_milli:4500000, idempotency_key:'fx-mtc-0001' });
  assert.equal(b.conversion.amount_crypto,'1');
  assert.equal(layer.cryptoLedger.getBalance(user.id,'USDT','tron').available_amount,'9.5');
  assert.equal(layer.getWallet(userWallet.id).balance_milli,52250000);
  assert.equal(layer.cryptoConversion.verify().ok,true);
  assert.equal(layer.cryptoLedger.verify().ok,true);
  layer.ledger.verify();
});

test('domino accepts crypto stakes and settles the crypto pot with audit verification', (t) => {
  const { layer } = makeDataLayer(t);
  const host = makeUser(layer, 'crypto_dom_host');
  const guest = makeUser(layer, 'crypto_dom_guest');
  fundCrypto(layer, host, '1');
  fundCrypto(layer, guest, '1');
  const game = layer.createGame({ kind:'domino' });
  const room = layer.createRoom({ gameId:game.id, hostUserId:host.id, name:'crypto-dom', capacity:2 });
  layer.joinRoom(room.id, host.id);
  layer.joinRoom(room.id, guest.id);
  layer.setRoomStatus(room.id, 'active');
  const m0 = layer.domino.createMatch({ mode:'online', userId:host.id, roomId:room.id, settings:{ handSize:1, seed:'crypto-dom-seed', mode:'crypto', stakeUsdCents:10, asset:'USDT', network:'tron' } });
  layer.domino.joinMatch(m0.id, host.id);
  layer.domino.joinMatch(m0.id, guest.id);
  let m = layer.domino.startMatch(m0.id, { byUserId:host.id });
  assert.equal(layer.cryptoLedger.getBalance(host.id,'USDT','tron').available_amount,'0.9');
  assert.equal(layer.cryptoLedger.getBalance(guest.id,'USDT','tron').available_amount,'0.9');
  assert.equal(layer.cryptoLedger.getBalance(layer.gameWallet.houseWallet().user_id,'USDT','tron').available_amount,'0.2');
  const current = m.state.currentUserId;
  const tile = m.state.hands[current][0];
  m = layer.domino.applyAction(m.id, current, { type:'play', tile, side:'right' });
  assert.equal(m.state.status,'finished');
  const winner = m.state.winnerUserId;
  assert.ok([host.id,guest.id].includes(winner));
  assert.equal(layer.domino.verifyMatch(m.id).ok,true);
  assert.equal(layer.cryptoLedger.verify().ok,true);
});