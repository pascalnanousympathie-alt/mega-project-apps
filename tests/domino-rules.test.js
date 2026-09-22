'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const {
  fullSet,
  shuffle,
  newBoard,
  openEnds,
  playsFor,
  canPlayAny,
  applyPlay,
  handPips,
  highestDouble,
  highestSingle,
  canDraw,
  chooseBotAction,
  allBlocked,
  makeTile,
  tileKey,
  pips,
  isDouble,
  sortHand,
} = require('../core/domino');

test('full double-six set has 28 unique tiles normalized a<=b', () => {
  const set = fullSet();
  assert.equal(set.length, 28);
  const keys = new Set(set.map(tileKey));
  assert.equal(keys.size, 28);
  for (const t of set) {
    assert.ok(t.a <= t.b);
    assert.ok(t.a >= 0 && t.b <= 6);
  }
});

test('shuffle is deterministic for the same seed and differs across seeds', () => {
  const set = fullSet();
  const a = shuffle(set, 'seed-x');
  const b = shuffle(set, 'seed-x');
  assert.deepEqual(a, b);
  const c = shuffle(set, 'seed-y');
  assert.notDeepEqual(a, c);
  assert.equal(a.length, 28);
  const allTiles = new Set(a.map(tileKey));
  assert.equal(allTiles.size, 28);
});

test('first move opens both faces of the first tile', () => {
  const board = newBoard();
  assert.equal(openEnds(board), null);
  const b1 = applyPlay(board, makeTile(2, 5), 'right');
  assert.deepEqual(openEnds(b1), { left: 2, right: 5 });
  const b2 = applyPlay(b1, makeTile(2, 3), 'left');
  assert.deepEqual(openEnds(b2), { left: 3, right: 5 });
  const b3 = applyPlay(b2, makeTile(5, 6), 'right');
  assert.deepEqual(openEnds(b3), { left: 3, right: 6 });
});

test('a tile must match the open end it is played on', () => {
  const board = applyPlay(newBoard(), makeTile(2, 5), 'right');
  assert.throws(() => applyPlay(board, makeTile(1, 3), 'left'), (e) => e.code === 'E_TILE_NO_MATCH');
  assert.throws(() => applyPlay(board, makeTile(4, 6), 'right'), (e) => e.code === 'E_TILE_NO_MATCH');
  const okLeft = applyPlay(board, makeTile(2, 4), 'left');
  assert.deepEqual(openEnds(okLeft), { left: 4, right: 5 });
});

test('playsFor lists exactly the legal placements per side', () => {
  const board = applyPlay(applyPlay(newBoard(), makeTile(2, 5), 'right'), makeTile(2, 3), 'left');
  const hand = [makeTile(3, 4), makeTile(5, 6), makeTile(6, 6), makeTile(0, 3), makeTile(1, 5)];
  const plays = playsFor(hand, board);
  const keys = plays.map((p) => p.side + ':' + tileKey(p.tile)).sort();
  assert.deepEqual(keys, ['left:0:3', 'left:3:4', 'right:1:5', 'right:5:6']);
  assert.ok(canPlayAny([makeTile(3, 4)], board));
  assert.equal(canPlayAny([makeTile(1, 4)], board), false);
});

test('hand helpers compute pips, doubles and highest tile', () => {
  const hand = [makeTile(0, 0), makeTile(5, 6), makeTile(3, 3)];
  assert.equal(handPips(hand), 17);
  assert.deepEqual(highestDouble(hand), makeTile(3, 3));
  assert.deepEqual(highestSingle(hand), makeTile(5, 6));
  assert.ok(isDouble(makeTile(6, 6)));
  assert.deepEqual(sortHand([makeTile(5, 6), makeTile(0, 0)]), [makeTile(0, 0), makeTile(5, 6)]);
});

test('boneyard draw availability and deterministic removal', () => {
  const boneyard = [makeTile(1, 1), makeTile(4, 4)];
  assert.ok(canDraw(boneyard));
  boneyard.pop();
  assert.ok(canDraw(boneyard));
  boneyard.pop();
  assert.equal(canDraw(boneyard), false);
});

test('allBlocked detects a closed board', () => {
  const board = applyPlay(newBoard(), makeTile(3, 3), 'right');
  const hands = [[makeTile(1, 5)], [makeTile(0, 2)]];
  assert.ok(allBlocked(board, hands));
  assert.equal(allBlocked(board, [[makeTile(3, 6)], [makeTile(0, 2)]]), false);
});

test('chooseBotAction prefers a play, then draw, then pass', () => {
  const board = applyPlay(newBoard(), makeTile(3, 3), 'right');
  assert.deepEqual(chooseBotAction([makeTile(3, 6)], board, []), {
    action: 'play',
    tile: makeTile(3, 6),
    side: 'right',
  });
  assert.deepEqual(chooseBotAction([makeTile(1, 5)], board, [makeTile(1, 1)]), { action: 'draw' });
  assert.deepEqual(chooseBotAction([makeTile(1, 5)], board, []), { action: 'pass' });
});

test('bot picks the highest-value playable tile', () => {
  const board = applyPlay(newBoard(), makeTile(4, 4), 'right');
  const choice = chooseBotAction([makeTile(4, 1), makeTile(4, 6)], board, []);
  assert.equal(pips(choice.tile), 10);
});