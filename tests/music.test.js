const test = require('node:test');
const assert = require('node:assert/strict');
const music = require('../client/js/music.js');

test('music catalog has one calm track for each of the four brands', () => {
  assert.deepEqual(music.KINDS, ['ludo', 'domino', 'loto', 'rami']);
  for (const kind of music.KINDS) {
    assert.ok(music.TRACKS[kind]);
    assert.ok(music.TRACKS[kind].tempo >= 400);
    assert.equal(music.TRACKS[kind].notes.length, 8);
  }
});

test('music settings are independent and persisted', () => {
  const data = {};
  const storage = {
    getItem: (key) => Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null,
    setItem: (key, value) => { data[key] = value; },
  };
  const fakeRoot = { localStorage: storage };
  const initial = music.createController(fakeRoot);
  assert.deepEqual(initial.settings(), { ludo: true, domino: true, loto: true, rami: true });

  const disabled = { ludo: false, domino: true, loto: false, rami: true };
  storage.setItem('acep.music.v1', JSON.stringify(disabled));
  const restored = music.createController(fakeRoot);
  assert.deepEqual(restored.settings(), disabled);
  assert.equal(restored.enabled('ludo'), false);
  assert.equal(restored.enabled('dominomada'), true);
});

test('brand aliases normalize to their dedicated track keys', () => {
  assert.equal(music.normalizeKind('LudoMada'), 'ludo');
  assert.equal(music.normalizeKind('DominoMada'), 'domino');
  assert.equal(music.normalizeKind('LotoMada'), 'loto');
  assert.equal(music.normalizeKind('RamiMada'), 'rami');
});
