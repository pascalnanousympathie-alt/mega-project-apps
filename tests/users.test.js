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

test('changes user status', (t) => {
  const { layer } = makeDataLayer(t);
  const user = makeUser(layer, 'status_user');
  const blocked = layer.setUserStatus(user.id, 'blocked');
  assert.equal(layer.getById(user.id).status, 'blocked');
  assert.notEqual(blocked.updated_at, user.updated_at);
  expectDataError(() => layer.setUserStatus(user.id, 'ghost'), 'E_ARG');
});