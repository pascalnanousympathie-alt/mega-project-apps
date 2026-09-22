'use strict';
const path = require('node:path');
const { createDataLayer } = require('../core');
const { buildApiHandlers } = require('./api');
const { createHttpServer } = require('./http');
const { buildSocketIo } = require('../core/socketio');

function createApp(options = {}) {
  const layer = options.layer || createDataLayer(options);
  const api = buildApiHandlers(layer);
  const server = createHttpServer({
    layer,
    api,
    clientDir: options.clientDir || path.join(__dirname, '..', 'client'),
    realtimePrefix: '/socket.io',
  });
  let realtime = null;

  function attachRealtime() {
    if (realtime) return realtime;
    realtime = buildSocketIo({
      dataLayer: layer,
      httpServer: server,
      options: { gateway: { sweepIntervalMs: options.sweepIntervalMs, ...(options.gateway || {}) } },
    });
    return realtime;
  }

  function listen(port, host) {
    attachRealtime();
    return new Promise((resolve) => {
      server.listen(port === undefined ? 0 : port, host || '127.0.0.1', () => {
        resolve(server.address());
      });
    });
  }

  function close() {
    return new Promise((resolve, reject) => {
      if (realtime && realtime.gateway && realtime.gateway.stopSweep) realtime.gateway.stopSweep();
      if (realtime && realtime.io) {
        realtime.io.close();
      }
      server.close((err) => {
        try {
          layer.close();
        } catch (closeErr) {
          // layer already closed
        }
        if (err && err.code !== 'ERR_SERVER_NOT_RUNNING') return reject(err);
        return resolve();
      });
    });
  }

  return { layer, api, server, get io() { return realtime && realtime.io; }, get gateway() { return realtime && realtime.gateway; }, listen, close };
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const app = createApp({ dataDir: process.env.ACEP_DATA_DIR });
  app.listen(port).then((address) => {
    // eslint-disable-next-line no-console
    console.log(`LudoMada server listening on http://${address.address}:${address.port}`);
  });
}

module.exports = { createApp };
