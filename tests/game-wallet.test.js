'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDataLayer } = require('../core');
const gameWalletModule = require('../core/game-wallet');

const VALID = [
  [1, 14, null, 36, null, null, 63, null, 88],
  [5, null, 21, null, 47, 58, null, 71, null],
  [null, 18, 27, 32, 41, 52, null, null, null],
];
const FULL_BALLS = [1, 14, 36, 63, 88, 5, 21, 47, 58, 71, 18, 27, 32, 41, 52];

function makeLayer(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acep-p14-'));
  const layer = createDataLayer({ dataDir: dir });
  t.after(() => {
    try { layer.close(); } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { layer, dir };
}

function makeUser(layer, name) {
  return layer.createUser({
    username: name,
    phone: '+26134' + String(Math.floor(Math.random() * 90000000) + 10000000),
    email: name.toLowerCase() + Math.random().toString(16).slice(2) + '@example.mg',
    displayName: name.toUpperCase(),
  });
}

function funded(layer, name, milli) {
  const user = makeUser(layer, name);
  const wallet = layer.createWallet(user.id);
  layer.ledger.append({
    wallet_id: wallet.id,
    idempotency_key: 'fund:' + wallet.id,
    tx_type: 'deposit',
    direction: 'credit',
    amount_milli: milli,
  });
  return { user, wallet };
}

function onlineRoom(layer, kind, host, capacity = 2) {
  const game = layer.createGame({ kind });
  const room = layer.createRoom({ gameId: game.id, hostUserId: host.id, name: kind + '-room', capacity });
  layer.joinRoom(room.id, host.id);
  layer.setRoomStatus(room.id, 'active');
  return { game, room };
}

test('economy normalization and pot math are deterministic', () => {
  assert.deepEqual(gameWalletModule.normalizeEconomy({ entryFee: 1000 }, 'online'), {
    mode: 'mga',
    currency: 'MGA',
    entry_fee_milli: 1000,
    commission_fraction: 0.1,
  });
  assert.equal(gameWalletModule.normalizeEconomy({ entryFee: 1000 }, 'offline').entry_fee_milli, 0);
  assert.equal(gameWalletModule.normalizeEconomy({ entryFee: -5 }, 'online').entry_fee_milli, 0);
  assert.equal(gameWalletModule.normalizeEconomy({ entryFee: 100, commission: 0.25 }, 'online').commission_fraction, 0.1);
  assert.equal(gameWalletModule.normalizeEconomy({ entryFee: 100, commission: 2 }, 'online').commission_fraction, 0.1);

  const breakdown = gameWalletModule.potBreakdown(1000, 3, 0.1);
  assert.deepEqual(breakdown, {
    entry_fee_milli: 1000,
    payers: 3,
    pot_milli: 3000,
    prize_milli: 2700,
    commission_milli: 300,
  });
  assert.equal(gameWalletModule.potBreakdown(0, 4, 0.1).pot_milli, 0);
});

test('loto settles prizes and credits the house commission exactly once', (t) => {
  const { layer } = makeLayer(t);
  const { user, wallet } = funded(layer, 'loto_winner', 10000);
  const { room } = onlineRoom(layer, 'loto', user);
  const m = layer.loto.createDraw({
    mode: 'online',
    userId: user.id,
    roomId: room.id,
    settings: { entryFee: 1000, balls: FULL_BALLS },
  });
  layer.loto.purchaseTicket(m.id, user.id, { grid: VALID });
  layer.loto.startDraw(m.id, user.id);
  let d = layer.loto.getDraw(m.id);
  for (let i = 0; i < FULL_BALLS.length; i += 1) d = layer.loto.nextBall(d.id, user.id);
  const settled = layer.loto.settleDraw(d.id, user.id);

  assert.equal(settled.state.status, 'finished');
  assert.equal(settled.state.commission_milli, 100);
  assert.equal(layer.getWallet(wallet.id).balance_milli, 9000 + 900);
  const house = layer.gameWallet.houseWallet();
  assert.ok(house, 'house wallet should be provisioned');
  assert.equal(layer.getWallet(house.id).balance_milli, 100);

  const trail = layer.gameWallet.listGameEntries('loto', m.id);
  const byType = {};
  for (const entry of trail) byType[entry.tx_type] = (byType[entry.tx_type] || 0) + entry.amount_milli;
  assert.equal(byType.entry_fee, 1000);
  assert.equal(byType.prize, 900);
  assert.equal(byType.commission, 100);

  layer.loto.verifyDraw(m.id);
  layer.ledger.verify();
});

test('loto refundDraw returns entry fees and replays idempotently', (t) => {
  const { layer } = makeLayer(t);
  const { user, wallet } = funded(layer, 'loto_refund', 5000);
  const { room } = onlineRoom(layer, 'loto', user);
  const m = layer.loto.createDraw({ mode: 'online', userId: user.id, roomId: room.id, settings: { entryFee: 1000 } });
  layer.loto.purchaseTicket(m.id, user.id, { grid: VALID });
  assert.equal(layer.getWallet(wallet.id).balance_milli, 4000);

  const refunded = layer.loto.refundDraw(m.id, user.id);
  assert.equal(refunded.state.status, 'cancelled');
  assert.equal(layer.getWallet(wallet.id).balance_milli, 5000);
  layer.loto.verifyDraw(m.id);

  const trail = layer.gameWallet.listGameEntries('loto', m.id);
  assert.deepEqual(trail.map((e) => e.tx_type).sort(), ['entry_fee', 'refund']);
  assert.equal(trail.find((e) => e.tx_type === 'refund').amount_milli, 1000);
});

test('domino charges entry fees, pays a human winner and the commission atomically', (t) => {
  const { layer } = makeLayer(t);
  const host = funded(layer, 'dom_host', 5000);
  const guest = funded(layer, 'dom_guest', 5000);
  const { room } = onlineRoom(layer, 'domino', host.user);
  const m0 = layer.domino.createMatch({
    mode: 'online',
    userId: host.user.id,
    roomId: room.id,
    settings: { handSize: 1, seed: 'dom-econ', entryFee: 1000 },
  });
  layer.domino.joinMatch(m0.id, host.user.id);
  layer.domino.joinMatch(m0.id, guest.user.id);
  let m = layer.domino.startMatch(m0.id, { byUserId: host.user.id });

  assert.equal(layer.getWallet(host.wallet.id).balance_milli, 4000);
  assert.equal(layer.getWallet(guest.wallet.id).balance_milli, 4000);

  const current = m.state.currentUserId;
  const winner = current === host.user.id ? host : guest;
  const loser = current === host.user.id ? guest : host;
  m = layer.domino.applyAction(m.id, current, { type: 'play', tile: m.state.hands[current][0], side: 'right' });

  assert.equal(m.state.status, 'finished');
  assert.equal(m.state.winnerUserId, winner.user.id);
  assert.equal(layer.getWallet(winner.wallet.id).balance_milli, 5800);
  assert.equal(layer.getWallet(loser.wallet.id).balance_milli, 4000);
  const house = layer.gameWallet.houseWallet();
  assert.equal(layer.getWallet(house.id).balance_milli, 200);

  assert.deepEqual(layer.domino.verifyMatch(m.id), {
    ok: true,
    moves: layer.domino.movesOf(m.id).length,
    state_hash: m.state_hash,
  });
  layer.ledger.verify();
});

test('domino cancel refunds entry fees and keeps the wallet handshake consistent', (t) => {
  const { layer } = makeLayer(t);
  const host = funded(layer, 'dom_cancel_host', 5000);
  const guest = funded(layer, 'dom_cancel_guest', 5000);
  const { room } = onlineRoom(layer, 'domino', host.user);
  const m0 = layer.domino.createMatch({
    mode: 'online',
    userId: host.user.id,
    roomId: room.id,
    settings: { entryFee: 500 },
  });
  layer.domino.joinMatch(m0.id, host.user.id);
  layer.domino.joinMatch(m0.id, guest.user.id);
  layer.domino.startMatch(m0.id, { byUserId: host.user.id });
  assert.equal(layer.getWallet(host.wallet.id).balance_milli, 4500);

  const cancelled = layer.domino.cancelMatch(m0.id, host.user.id);
  assert.equal(cancelled.state.status, 'cancelled');
  assert.equal(layer.getWallet(host.wallet.id).balance_milli, 5000);
  assert.equal(layer.getWallet(guest.wallet.id).balance_milli, 5000);
  layer.domino.verifyMatch(m0.id);
  layer.ledger.verify();
});

test('domino start rolls back atomically when a player cannot pay', (t) => {
  const { layer } = makeLayer(t);
  const host = funded(layer, 'dom_rollback_host', 5000);
  const broke = makeUser(layer, 'dom_rollback_broke');
  const { room } = onlineRoom(layer, 'domino', host.user);
  const m0 = layer.domino.createMatch({
    mode: 'online',
    userId: host.user.id,
    roomId: room.id,
    settings: { entryFee: 1000 },
  });
  layer.domino.joinMatch(m0.id, host.user.id);
  layer.domino.joinMatch(m0.id, broke.id);

  assert.throws(
    () => layer.domino.startMatch(m0.id, { byUserId: host.user.id }),
    (err) => err.code === 'E_NO_WALLET',
  );
  const unchanged = layer.domino.getMatch(m0.id);
  assert.equal(unchanged.state.status, 'scheduled');
  assert.equal(layer.getWallet(host.wallet.id).balance_milli, 5000);
  assert.equal(layer.gameWallet.listGameEntries('domino', m0.id).length, 0);
  layer.ledger.verify();
});

test('rami charges entry fees, pays a human winner and the commission atomically', (t) => {
  const { layer } = makeLayer(t);
  const host = funded(layer, 'rami_host', 5000);
  const guest = funded(layer, 'rami_guest', 5000);
  const { room } = onlineRoom(layer, 'rami', host.user);
  const m0 = layer.rami.createGame({
    mode: 'online',
    userId: host.user.id,
    roomId: room.id,
    settings: { handSize: 3, seed: 'rami-econ-49', entryFee: 1000 },
  });
  layer.rami.joinGame(m0.id, host.user.id);
  layer.rami.joinGame(m0.id, guest.user.id);
  let m = layer.rami.startGame(m0.id, { byUserId: host.user.id });

  assert.equal(layer.getWallet(host.wallet.id).balance_milli, 4000);
  assert.equal(layer.getWallet(guest.wallet.id).balance_milli, 4000);

  m = layer.rami.applyAction(m.id, host.user.id, { type: 'draw', source: 'stock' });
  m = layer.rami.applyAction(m.id, host.user.id, { type: 'meld', melds: [['H:11', 'H:12', 'H:13']] });
  const remaining = m.state.hands[host.user.id][0];
  m = layer.rami.applyAction(m.id, host.user.id, { type: 'discard', card: remaining });

  assert.equal(m.state.status, 'finished');
  assert.equal(m.state.winnerUserId, host.user.id);
  assert.equal(layer.getWallet(host.wallet.id).balance_milli, 5800);
  assert.equal(layer.getWallet(guest.wallet.id).balance_milli, 4000);
  const house = layer.gameWallet.houseWallet();
  assert.equal(layer.getWallet(house.id).balance_milli, 200);
  layer.rami.verifyGame(m.id);
  layer.ledger.verify();
});

test('rami cancel refunds entry fees exactly once', (t) => {
  const { layer } = makeLayer(t);
  const host = funded(layer, 'rami_cancel_host', 5000);
  const guest = funded(layer, 'rami_cancel_guest', 5000);
  const { room } = onlineRoom(layer, 'rami', host.user);
  const m0 = layer.rami.createGame({
    mode: 'online',
    userId: host.user.id,
    roomId: room.id,
    settings: { entryFee: 700 },
  });
  layer.rami.joinGame(m0.id, host.user.id);
  layer.rami.joinGame(m0.id, guest.user.id);
  layer.rami.startGame(m0.id, { byUserId: host.user.id });
  assert.equal(layer.getWallet(host.wallet.id).balance_milli, 4300);

  const cancelled = layer.rami.cancelGame(m0.id, host.user.id);
  assert.equal(cancelled.state.status, 'cancelled');
  assert.equal(layer.getWallet(host.wallet.id).balance_milli, 5000);
  assert.equal(layer.getWallet(guest.wallet.id).balance_milli, 5000);
  layer.rami.verifyGame(m0.id);
  layer.ledger.verify();
});

test('tampering with a game prize ledger entry is detected by verification', (t) => {
  const { layer } = makeLayer(t);
  const host = funded(layer, 'dom_tamper_host', 5000);
  const guest = funded(layer, 'dom_tamper_guest', 5000);
  const { room } = onlineRoom(layer, 'domino', host.user);
  const m0 = layer.domino.createMatch({
    mode: 'online',
    userId: host.user.id,
    roomId: room.id,
    settings: { handSize: 1, seed: 'dom-econ', entryFee: 1000 },
  });
  layer.domino.joinMatch(m0.id, host.user.id);
  layer.domino.joinMatch(m0.id, guest.user.id);
  let m = layer.domino.startMatch(m0.id, { byUserId: host.user.id });
  const current = m.state.currentUserId;
  layer.domino.applyAction(m.id, current, {
    type: 'play',
    tile: m.state.hands[current][0],
    side: 'right',
  });
  layer.domino.verifyMatch(m.id);

  layer.db
    .prepare("UPDATE ledger_entries SET amount_milli = amount_milli + 1 WHERE tx_type = 'prize' AND json_extract(meta_json, '$.game_id') = ?")
    .run(m.id);
  assert.throws(() => layer.domino.verifyMatch(m.id), (err) => err.code === 'E_TAMPER');
});

test('the house wallet is provisioned once and shared across games', (t) => {
  const { layer } = makeLayer(t);
  const user = funded(layer, 'house_probe', 5000);
  const house = layer.gameWallet.houseWallet();
  assert.ok(house && house.id);
  assert.equal(layer.gameWallet.houseWalletId(), house.id);
  assert.equal(layer.gameWallet.houseWallet().user_id, house.user_id);
  assert.equal(
    layer.db
      .prepare('SELECT COUNT(*) AS c FROM users WHERE username = ?')
      .get(gameWalletModule.HOUSE_USERNAME).c,
    1,
  );
  assert.ok(user.id !== house.user_id);
});
