'use strict';
// P18 — rules engine edge cases (domino / loto / rami pure functions).
const { test } = require('node:test');
const assert = require('node:assert');
const domino = require('../core/domino');
const loto = require('../core/loto');
const rami = require('../core/rami');

function expectError(fn, code) {
  assert.throws(fn, (err) => err && err.code === code && err.name === 'DataError', 'expected ' + code);
}

// ---------------------------------------------------------------- domino ----

test('domino tile canonicalization rejects malformed pips', () => {
  expectError(() => domino.makeTile(1.5, 2), 'E_ARG');
  expectError(() => domino.makeTile('1', 2), 'E_ARG');
  expectError(() => domino.makeTile(-1, 2), 'E_ARG');
  expectError(() => domino.makeTile(0, 7), 'E_ARG');
  assert.deepEqual(domino.makeTile(6, 2), { a: 2, b: 6 });
  assert.equal(domino.tileKey(domino.makeTile(6, 2)), '2:6');
  assert.equal(domino.pips({ a: 6, b: 6 }), 12);
  assert.equal(domino.isDouble({ a: 6, b: 6 }), true);
  assert.equal(domino.isDouble({ a: 6, b: 2 }), false);
});

test('domino open ends, playability and side validation', () => {
  const empty = domino.newBoard();
  assert.equal(domino.openEnds(empty), null);
  assert.deepEqual(domino.openEnds(null), null);
  assert.equal(domino.firstMoveOn(empty), true);
  assert.equal(domino.canPlayOn({ a: 6, b: 1 }, 'left', empty), true);
  const board = domino.applyPlay(empty, { a: 6, b: 6 }, 'right');
  assert.deepEqual(board, { center: { a: 6, b: 6 }, left: [], right: [] });
  assert.equal(domino.firstMoveOn(board), false);
  assert.deepEqual(domino.openEnds(board), { left: 6, right: 6 });
  assert.equal(domino.canPlayOn({ a: 6, b: 3 }, 'right', board), true);
  assert.equal(domino.canPlayOn({ a: 1, b: 2 }, 'right', board), false);
  expectError(() => domino.applyPlay(board, { a: 6, b: 3 }, 'top'), 'E_ARG');
  expectError(() => domino.applyPlay(board, { a: 1, b: 2 }, 'left'), 'E_TILE_NO_MATCH');
  expectError(() => domino.applyPlay(board, { a: 1, b: 2 }, 'right'), 'E_TILE_NO_MATCH');
  const right = domino.applyPlay(board, { a: 6, b: 3 }, 'right');
  assert.deepEqual(right.right, [{ a: 6, b: 3 }]);
  assert.deepEqual(domino.openEnds(right), { left: 6, right: 3 });
  const left = domino.applyPlay(right, { a: 6, b: 1 }, 'left');
  assert.deepEqual(left.left, [{ a: 1, b: 6 }]);
  assert.deepEqual(domino.openEnds(left), { left: 1, right: 3 });
});

test('domino hand helpers, drawing and bot choice', () => {
  const hand = [domino.makeTile(6, 6), domino.makeTile(3, 4), domino.makeTile(5, 2)];
  assert.equal(domino.handPips(hand), 26);
  assert.deepEqual(domino.handPipsByTile(hand).map((h) => h.pips), [12, 7, 7]);
  assert.deepEqual(domino.highestDouble(hand), { a: 6, b: 6 });
  assert.deepEqual(domino.highestSingle(hand), { a: 3, b: 4 });
  assert.equal(domino.highestDouble([domino.makeTile(1, 2)]), null);
  assert.equal(domino.highestSingle([domino.makeTile(4, 4)]), null);
  assert.equal(domino.canDraw([]), false);
  assert.equal(domino.canDraw(null), false);
  const boneyard = [domino.makeTile(0, 1), domino.makeTile(2, 2)];
  expectError(() => domino.drawOne([], null), 'E_NO_TILE_TO_DRAW');
  assert.deepEqual(domino.drawOne(boneyard, () => 0), { a: 0, b: 1 });
  assert.equal(boneyard.length, 1);
  assert.deepEqual(domino.drawOne(boneyard, null), { a: 2, b: 2 });
  assert.equal(boneyard.length, 0);
  const fivesBoard = domino.applyPlay(domino.newBoard(), { a: 5, b: 5 }, 'right');
  assert.equal(domino.tileKey(domino.bestPlayFor(hand, fivesBoard).tile), '2:5');
  assert.equal(domino.bestPlayFor(hand, fivesBoard).side, 'right');
  const sixesBoard = domino.applyPlay(domino.newBoard(), { a: 6, b: 6 }, 'right');
  assert.equal(domino.bestPlayFor([domino.makeTile(0, 0)], sixesBoard), null);
  assert.equal(domino.findTile(hand, 6, 6).index, 0);
  assert.equal(domino.findTile(hand, domino.makeTile(2, 5)).index, 2);
  assert.equal(domino.findTile(hand, domino.makeTile(1, 1)), null);
  assert.deepEqual(domino.sortHand([domino.makeTile(6, 6), domino.makeTile(0, 1)]), [domino.makeTile(0, 1), domino.makeTile(6, 6)]);
  expectError(() => domino.assertTileInHand(hand, domino.makeTile(1, 1)), 'E_TILE_NOT_IN_HAND');
  assert.equal(domino.assertTileInHand(hand, domino.makeTile(6, 6)), undefined);
});

test('domino blocked board detection and bot fallbacks', () => {
  const board = domino.applyPlay(domino.newBoard(), { a: 4, b: 4 }, 'right');
  const blocked = [domino.makeTile(1, 2), domino.makeTile(3, 5)];
  const playable = [domino.makeTile(1, 2), domino.makeTile(4, 6)];
  assert.equal(domino.allBlocked(board, [blocked]), true);
  assert.equal(domino.allBlocked(board, [blocked, playable]), false);
  assert.equal(domino.canPlayAny([], board), false);
  assert.equal(domino.playsFor(playable, board).length, 2);
  assert.deepEqual(domino.chooseBotAction(blocked, board, [domino.makeTile(0, 0)]), { action: 'draw' });
  assert.deepEqual(domino.chooseBotAction(blocked, board, []), { action: 'pass' });
  assert.deepEqual(domino.chooseBotAction(playable, board, []), { action: 'play', tile: domino.makeTile(4, 6), side: 'right' });
  assert.deepEqual(domino.playsFor([domino.makeTile(3, 3)], domino.newBoard()), [{ tile: domino.makeTile(3, 3), side: 'right' }]);
});

// ------------------------------------------------------------------ loto ----

test('loto ticket validation reports every structural defect', () => {
  assert.equal(loto.validateTicket('nope').errors[0].code, 'E_GRID_SHAPE');
  assert.equal(loto.validateTicket([[1], [2], [3]]).errors[0].code, 'E_ROW_SHAPE');
  const good = loto.generateTicket('p18-loto-edge');
  assert.equal(loto.validateTicket(good).ok, true);

  const outOfRange = good.map((row) => row.slice());
  outOfRange[0][0] = 0;
  assert.ok(loto.validateTicket(outOfRange).errors.some((e) => e.code === 'E_CELL_RANGE'));

  const overflow = good.map((row) => row.slice());
  overflow[0][0] = 90;
  assert.ok(loto.validateTicket(overflow).errors.some((e) => e.code === 'E_CELL_OVERFLOW'));

  const duplicate = [
    [1, 11, 21, 31, 41, null, null, null, null],
    [1, 12, 22, 32, 42, null, null, null, null],
    [3, 13, 23, 33, 43, null, null, null, null],
  ];
  assert.ok(loto.validateTicket(duplicate).errors.some((e) => e.code === 'E_DUPLICATE'));

  const shortRow = good.map((row) => row.slice());
  shortRow[0][shortRow[0].findIndex((cell) => cell !== null)] = null;
  assert.ok(loto.validateTicket(shortRow).errors.some((e) => e.code === 'E_ROW_COUNT'));

  const unordered = good.map((row) => row.slice());
  const filled = [];
  unordered[0].forEach((cell, i) => {
    if (cell !== null) filled.push(i);
  });
  const first = filled[0];
  const last = filled[filled.length - 1];
  const swap = unordered[0][first];
  unordered[0][first] = unordered[0][last];
  unordered[0][last] = swap;
  assert.ok(loto.validateTicket(unordered).errors.some((e) => e.code === 'E_ROW_ORDER'));

  const emptyColumn = [
    [1, 11, null, null, null, null, null, null, null],
    [2, 12, null, null, null, null, null, null, null],
    [3, 13, null, null, null, null, null, null, null],
  ];
  assert.ok(loto.validateTicket(emptyColumn).errors.some((e) => e.code === 'E_COL_EMPTY'));

  expectError(() => loto.assertValidTicket([[1], [2], [3]]), 'E_ROW_SHAPE');
  assert.equal(loto.assertValidTicket(good), good);
});

test('loto ticket generation is deterministic, valid and 3x9 shaped', () => {
  const a = loto.generateTicket('seed-a');
  const b = loto.generateTicket('seed-a');
  const c = loto.generateTicket('seed-b');
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
  assert.equal(a.length, loto.ROWS);
  for (const row of a) {
    assert.equal(row.length, loto.COLS);
    assert.equal(row.filter((cell) => cell !== null).length, loto.NUMBERS_PER_ROW);
  }
  assert.equal(loto.validateTicket(a).ok, true);
  const many = loto.generateTickets(3, 'seed-many');
  assert.equal(many.length, 3);
  assert.ok(many.every((grid) => loto.validateTicket(grid).ok));
  assert.equal(loto.ticketHash(a), loto.ticketHash(a));
  assert.notEqual(loto.ticketHash(a), loto.ticketHash(c));
});

test('loto column helpers, blanks and draw order', () => {
  assert.equal(loto.colOfNumber(1), 0);
  assert.equal(loto.colOfNumber(10), 1);
  assert.equal(loto.colOfNumber(90), 8);
  assert.equal(loto.colOfNumber(0), -1);
  assert.equal(loto.colOfNumber(91), -1);
  assert.equal(loto.colOfNumber(7.5), -1);
  assert.deepEqual(loto.columnRange(-3), { min: 1, max: 9 });
  assert.deepEqual(loto.columnRange(99), { min: 80, max: 90 });
  assert.deepEqual(loto.columnRange(4), { min: 40, max: 49 });
  assert.equal(loto.isBlank(null), true);
  assert.equal(loto.isBlank(undefined), true);
  assert.equal(loto.isBlank(''), true);
  assert.equal(loto.isBlank(0), false);
  const blank = loto.blankGrid();
  assert.equal(blank.length, loto.ROWS);
  assert.ok(blank.every((row) => row.length === loto.COLS && row.every((cell) => cell === null)));
  const order = loto.buildDrawOrder('p18-draw', [5, 4]);
  assert.equal(order.length, loto.BALLS);
  assert.deepEqual(order.slice(0, 2), [5, 4]);
  assert.equal(new Set(order).size, loto.BALLS);
  assert.equal(loto.buildDrawOrder('p18-draw').length, loto.BALLS);
  assert.equal(loto.numbers1to90().length, loto.BALLS);
  assert.equal(loto.numbers1to90()[loto.BALLS - 1], 90);
  const grid = loto.generateTicket('p18-marks');
  const firstNumber = grid[0].find((cell) => cell !== null);
  const marks = loto.marksForTicket(grid, new Set([firstNumber]));
  assert.equal(marks.total, 1);
  assert.equal(marks.perRow.length, loto.ROWS);
  const blankRow = [null, null, null, null, null, null, null, null, null];
  assert.equal(loto.marksForTicket([blankRow, 3, null], new Set([1])).total, 0);
});

// ------------------------------------------------------------------ rami ----

test('rami deck construction and card key round-trip', () => {
  assert.equal(rami.fullDeck().length, 54);
  assert.equal(new Set(rami.deckKeys()).size, 54);
  expectError(() => rami.makeCard(0, 'H'), 'E_ARG');
  expectError(() => rami.makeCard(14, 'H'), 'E_ARG');
  expectError(() => rami.makeCard(5, 'X'), 'E_ARG');
  expectError(() => rami.parseCardKey('H'), 'E_ARG');
  expectError(() => rami.parseCardKey('X:5'), 'E_ARG');
  expectError(() => rami.parseCardKey('H:14'), 'E_ARG');
  expectError(() => rami.parseCardKey('JK:3'), 'E_ARG');
  expectError(() => rami.parseCardKey(7), 'E_ARG');
  expectError(() => rami.cardKey(null), 'E_ARG');
  assert.equal(rami.cardKey(rami.makeJoker(2)), 'JK:2');
  assert.equal(rami.cardKey(rami.makeJoker(7)), 'JK:1');
  assert.deepEqual(rami.parseCardKey('JK:1'), { joker: true, id: 1 });
  assert.equal(rami.rankOf(rami.makeJoker(1)), null);
  assert.equal(rami.suitOf(rami.makeJoker(1)), null);
  assert.equal(rami.points(rami.makeCard(11, 'H')), 10);
  assert.equal(rami.points(rami.makeCard(7, 'H')), 7);
  assert.equal(rami.points(rami.makeJoker(1)), 25);
  assert.equal(rami.cardPoints('H:13'), 10);
  assert.equal(rami.handPoints(['H:13', rami.makeJoker(1), rami.makeCard(9, 'S')]), 44);
  assert.deepEqual(rami.deckAudit(rami.deckKeys()), { ok: true, cards: 54, expected: 54 });
  expectError(() => rami.deckAudit([...rami.deckKeys(), 'H:5']), 'E_DUPLICATE_CARD');
  expectError(() => rami.deckAudit(['Z:1']), 'E_UNKNOWN_CARD');
  assert.deepEqual(rami.deckAudit(rami.deckKeys().slice(0, 53)), { ok: true, cards: 53, expected: 54 });
});

test('rami group and run validation covers every rejection path', () => {
  assert.equal(rami.validateGroup([]).errors[0].code, 'E_GROUP_EMPTY');
  assert.equal(rami.validateGroup('nope').errors[0].code, 'E_GROUP_EMPTY');
  assert.equal(rami.validateRun([]).errors[0].code, 'E_RUN_EMPTY');
  assert.equal(rami.validateMeld([]).errors[0].code, 'E_MELD_EMPTY');
  const brelan = [rami.makeCard(7, 'H'), rami.makeCard(7, 'S'), rami.makeCard(7, 'D')];
  assert.equal(rami.validateMeld(brelan).ok, true);
  assert.equal(rami.validateMeld(brelan).kind, 'group');
  assert.equal(rami.validateGroup([...brelan, rami.makeCard(7, 'C')]).ok, true);
  assert.equal(rami.validateGroup([...brelan, rami.makeCard(7, 'H')]).errors[0].code, 'E_GROUP_DUPLICATE_SUIT');
  assert.equal(
    rami.validateGroup([rami.makeCard(7, 'H'), rami.makeCard(7, 'S'), rami.makeJoker(1), rami.makeJoker(2)]).errors[0].code,
    'E_GROUP_TOO_MANY_JOKERS',
  );
  assert.equal(rami.validateGroup([rami.makeCard(7, 'H'), rami.makeCard(8, 'S')]).errors[0].code, 'E_GROUP_SIZE');
  assert.equal(rami.validateGroup([rami.makeCard(7, 'H'), rami.makeJoker(1)]).errors[0].code, 'E_GROUP_SIZE');
  const mixed = [rami.makeCard(7, 'H'), rami.makeCard(7, 'S'), rami.makeCard(8, 'H')];
  assert.equal(rami.validateMeld(mixed).ok, false);
  assert.equal(rami.validateMeld(mixed).kind, 'group');
  expectError(() => rami.assertValidMeld(mixed), 'E_GROUP_RANK');
  assert.equal(rami.validateRun([rami.makeCard(5, 'H'), rami.makeCard(9, 'H'), rami.makeCard(10, 'H')]).ok, false);
  assert.equal(rami.validateRun([rami.makeCard(5, 'H'), rami.makeCard(6, 'S'), rami.makeCard(7, 'H')]).ok, false);
  const okRun = [rami.makeCard(5, 'H'), rami.makeCard(6, 'H'), rami.makeCard(7, 'H')];
  assert.equal(rami.validateMeld(okRun).kind, 'run');
});

test('rami meld search, coverage helpers and playable-set guards', () => {
  const hand = [
    rami.makeCard(4, 'H'), rami.makeCard(4, 'S'), rami.makeCard(4, 'D'), rami.makeCard(4, 'C'),
    rami.makeCard(9, 'H'), rami.makeCard(10, 'H'), rami.makeCard(11, 'H'),
  ];
  const melds = rami.findMelds(hand);
  assert.ok(melds.some((meld) => meld.length === 4));
  assert.ok(melds.some((meld) => meld.length === 3 && meld.every((c) => c.suit === 'H')));
  assert.equal(rami.canFormAnyMeld(hand), true);
  assert.equal(rami.canFormAnyMeld([rami.makeCard(2, 'H'), rami.makeCard(9, 'S'), rami.makeJoker(1)]), false);
  assert.equal(rami.meldsCoverCard(melds, 'H:4'), true);
  assert.equal(rami.meldsCoverCard(melds, 'C:13'), false);
  assert.ok(rami.keysInMelds(melds).includes('S:4'));
  assert.equal(rami.canUseCardInMeld('C:4', hand.filter((c) => c.suit !== 'C')), true);
  assert.equal(rami.canUseCardInMeld('H:2', hand), false);
  assert.equal(rami.canUseCardInMeld(rami.makeCard(4, 'C'), hand.filter((c) => c.suit !== 'C')), true);
  const pair = [rami.makeCard(6, 'H'), rami.makeCard(6, 'S'), rami.makeJoker(1)];
  assert.deepEqual(rami.findMelds(pair).map((m) => m.length), [3]);
  assert.equal(rami.findCard(hand, 'H:9').index, 4);
  assert.equal(rami.findCard(hand, 'H:2'), null);
  expectError(() => rami.assertCardInHand(['H:2'], 'H:3'), 'E_CARD_NOT_IN_HAND');
  expectError(() => rami.assertCardInHand('H:2', 'H:2'), 'E_CARD_NOT_IN_HAND');
  assert.equal(rami.assertCardInHand(['H:2'], 'H:2'), undefined);

  assert.equal(rami.validateMeldSet([[], ['H:2', 'H:3']]).ok, false);
  assert.equal(rami.validateMeldSet([['H:2', 'S:2', 'D:2']]).ok, true);
  assert.equal(rami.validateMeldSet([]).ok, true);
  const handSet = new Set(hand.map(rami.cardKey));
  expectError(() => rami.assertMeldSetPlayable(handSet, [[]]), 'E_MELD_EMPTY');
  expectError(
    () => rami.assertMeldSetPlayable(handSet, [[rami.makeCard(2, 'H'), rami.makeCard(2, 'S'), rami.makeCard(2, 'D')]]),
    'E_CARD_NOT_IN_HAND',
  );
  expectError(() => rami.assertMeldSetPlayable(handSet, [melds[0], melds[0]]), 'E_MELD_OVERLAP');
  expectError(
    () => rami.assertMeldSetPlayable(handSet, [[rami.makeCard(4, 'H'), rami.makeCard(9, 'H'), rami.makeCard(11, 'H')]]),
    'E_GROUP_RANK',
  );
  assert.equal(rami.assertMeldSetPlayable(handSet, [melds[0]]), true);
  assert.deepEqual(rami.sortHand([hand[1], hand[0]]), [hand[0], hand[1]]);
  assert.equal(rami.shuffleDeck('seed-x').length, 54);
  assert.deepEqual(rami.shuffleDeck('seed-x'), rami.shuffleDeck('seed-x'));
});
