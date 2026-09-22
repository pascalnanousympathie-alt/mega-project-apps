'use strict';
const path = require('node:path');
const { DataError } = require('./db');
const { openDataLayer } = require('./db');
const { appendLedger, verifyLedger, entriesByWallet, listEntries, getEntry, byIdempotency } = require('./ledger');
const { buildRepositories } = require('./repos');
const { buildAuth } = require('./auth');
const { buildCentralWallet } = require('./wallet');
const { buildGameWallet } = require('./game-wallet');
const { buildDominoGame } = require('./domino-game');
const { buildLotoGame } = require('./loto-game');
const { buildRamiGame } = require('./rami-game');
const { buildLocalRecords } = require('./local-records');
const { buildGateway } = require('./gateway');
const { buildSocketIo, socketAuthMiddleware, createServer } = require('./socketio');
const { buildPaymentGateway } = require('./payments');
const contracts = require('./contracts');

function createDataLayer(options = {}) {
  const dataDir = options.dataDir || process.env.ACEP_DATA_DIR || path.join(__dirname, '..', 'data');
  const db = openDataLayer(dataDir, options);
  const repos = buildRepositories(db);
  const auth = buildAuth(db, repos);
  const wallet = buildCentralWallet(db);
  const gameWallet = buildGameWallet({ db, repos, options: options.house || {} });
  const gatewayOptions = {
    ...(options.gateway || {}),
  };
  const domino = buildDominoGame({ db, repos, gameWallet, options: options.domino });
  const loto = buildLotoGame({ db, repos, wallet, gameWallet, options: options.loto });
  const rami = buildRamiGame({ db, repos, gameWallet, options: options.rami });
  const localRecords = buildLocalRecords({
    db,
    repos,
    engines: { domino, loto, rami },
  });
  gatewayOptions.onGameEvent = (roomId, userId, payload) => {
    const room = repos.getRoom(roomId);
    const game = repos.getGame(room.game_id);
    if (game.kind === 'domino') return domino.onGameEvent(roomId, userId, payload);
    if (game.kind === 'loto') return loto.onGameEvent(roomId, userId, payload);
    if (game.kind === 'rami') return rami.onGameEvent(roomId, userId, payload);
    throw new DataError('E_ARG', 'no game engine for room kind: ' + game.kind);
  };
  const gateway = buildGateway({ db, repos, auth, options: gatewayOptions });
  const payments = buildPaymentGateway({
    db,
    repos,
    credentials: (options.payments || {}).credentials,
    env: (options.payments || {}).env || process.env,
    transport: (options.payments || {}).transport,
    callbackUrl: (options.payments || {}).callbackUrl,
  });
  const idempotency = contracts.createIdempotencyStore();
  const ledger = {
    append: (input) => appendLedger(db, input),
    verify: () => verifyLedger(db),
    entriesByWallet: (walletId, opts) => entriesByWallet(db, walletId, opts),
    list: (opts) => listEntries(db, opts),
    get: (id) => getEntry(db, id),
    byIdempotency: (walletId, key) => byIdempotency(db, walletId, key),
  };
  return {
    dataDir,
    db,
    ...repos,
    repos,
    auth,
    wallet,
    gameWallet,
    ledger,
    domino,
    loto,
    rami,
    localRecords,
    gateway,
    payments,
    contracts,
    idempotency,
    close() {
      gateway.stopSweep();
      if (db.isOpen) db.close();
    },
  };
}

module.exports = {
  createDataLayer,
  buildGateway,
  buildSocketIo,
  socketAuthMiddleware,
  createServer,
  buildLocalRecords,
  contracts,
};