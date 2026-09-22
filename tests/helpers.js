'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const { createDataLayer } = require('../core');

function makeDataLayer(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acep-p04-'));
  const layer = createDataLayer({ dataDir: dir });
  t.after(() => {
    try {
      layer.close();
    } catch (_) {
      // already closed
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { layer, dir };
}

function makeUser(layer, name) {
  return layer.createUser({
    username: name,
    phone: '+261340000001',
    email: name.toLowerCase() + '@example.mg',
    displayName: name.toUpperCase(),
  });
}

function expectDataError(fn, code) {
  assert.throws(fn, (err) => err && err.code === code && err.name === 'DataError');
}

module.exports = { makeDataLayer, makeUser, expectDataError };