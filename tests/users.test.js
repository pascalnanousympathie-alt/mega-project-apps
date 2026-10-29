'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { makeDataLayer, makeUser, expectDataError } = require('./helpers');

test('creates and reads back a user', (t) => {
  const { layer } = makeDataLayer(t);
  const user = layer.createUser({
    username: 'alice',
    phone: '+261340000255',
    email: 'alice@example.mg',
    displayName: 'Alice',
    role: 'player',
  });
  assert.ok(user.id);
  assert.equal(user.username, 'alice');
  assert.equal(layer.getById(user.id).username, 'alice');
  assert.equal(layer.findByUsername('ALICE').id, user.id);
});

test('finds a user by phone and email identity', (t) => {
  const { layer } = makeDataLayer(t);
  const user = layer.createUser({ username: 'bob.42', phone: '+261340000777', email: 'bob@example.mg' });
  assert.equal(layer.findByIdentity('+261340000777').id, user.id);
  assert.equal(layer.findByIdentity('bob@example.mg').id, user.id);
  assert.equal(layer.findByIdentity('bob.42').id, user.id);
  assert.equal(layer.findByIdentity('nobody'), null);
});

test('rejects duplicate usernames case-insensitively', (t) => {
  const { layer } = makeDataLayer(t);
  layer.createUser({ username: 'dupe' });
  expectDataError(() => layer.createUser({ username: 'DUPE' }), 'E_DUPLICATE');
});

test('rejects invalid usernames and roles', (t) => {
  const { layer } = makeDataLayer(t);
  expectDataError(() => layer.createUser({ username: 'ab' }), 'E_ARG');
  expectDataError(() => layer.createUser({ username: 'bad name!' }), 'E_ARG');
  expectDataError(() => layer.createUser({ username: 'valid_user', role: 'god' }), 'E_ARG');
  expectDataError(() => layer.createUser({ username: 'valid_phone', phone: 'nope' }), 'E_ARG');
});

test('changes user status and advances updated_at when the wall clock stays in one millisecond', (t) => {
  const { layer } = makeDataLayer(t);
  const NativeDate = global.Date;
  const fixedMs = NativeDate.parse('2026-10-18T12:00:00.000Z');
  class FixedDate extends NativeDate {
    constructor(...args) { super(...(args.length ? args : [fixedMs])); }
    static now() { return fixedMs; }
  }

  // Force the exact same millisecond for createUser and setUserStatus. This
  // reproduces fast-runner timing deterministically instead of relying on luck.
  global.Date = FixedDate;
  try {
    const user = makeUser(layer, 'status_user');
    const blocked = layer.setUserStatus(user.id, 'blocked');
    assert.equal(layer.getById(user.id).status, 'blocked');
    assert.equal(Date.parse(blocked.updated_at), Date.parse(user.updated_at) + 1);
    expectDataError(() => layer.setUserStatus(user.id, 'ghost'), 'E_ARG');
  } finally {
    global.Date = NativeDate;
  }
});