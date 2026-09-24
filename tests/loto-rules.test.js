'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const rules = require('../core/loto');

const VALID = [
  [1, 14, null, 36, null, null, 63, null, 88],
  [5, null, 21, null, 47, 58, null, 71, null],
  [null, 18, 27, 32, 41, 52, null, null, null],
];

test('column ranges match the standard 90-ball layout', () => {
  assert.deepEqual(rules.columnRange(0), { min: 1, max: 9 });
  assert.deepEqual(rules.columnRange(1), { min: 10, max: 19 });
  assert.deepEqual(rules.columnRange(7), { min: 70, max: 79 });
  assert.deepEqual(rules.columnRange(8), { min: 80, max: 90 });
  assert.equal(rules.colOfNumber(1), 0);
  assert.equal(rules.colOfNumber(9), 0);
  assert.equal(rules.colOfNumber(10), 1);
  assert.equal(rules.colOfNumber(59), 5);
  assert.equal(rules.colOfNumber(90), 8);
  assert.equal(rules.colOfNumber(0), -1);
  assert.equal(rules.colOfNumber(91), -1);
});

test('a hand-crafted ticket is valid with 3 rows x 9 columns', () => {
  assert.deepEqual(rules.validateTicket(VALID), { ok: true, errors: [] });
  assert.equal(rules.ticketHash(VALID), rules.ticketHash(VALID));
});

test('validateTicket rejects malformed grids', () => {
  assert.equal(rules.validateTicket([]).ok, false);
  assert.equal(rules.validateTicket([[1], [2], [3]]).ok, false);

  const rowCount = VALID.map((r) => r.slice());
  rowCount[0][8] = null;
  assert.equal(
    rules.validateTicket(rowCount).errors.some((e) => e.code === 'E_ROW_COUNT'),
    true,
  );

  const overflow = VALID.map((r) => r.slice());
  overflow[0][8] = 60;
  assert.equal(
    rules.validateTicket(overflow).errors.some((e) => e.code === 'E_CELL_OVERFLOW'),
    true,
  );

  const duplicate = VALID.map((r) => r.slice());
  duplicate[1][0] = 1;
  assert.equal(
    rules.validateTicket(duplicate).errors.some((e) => e.code === 'E_DUPLICATE'),
    true,
  );

  const emptyCol = VALID.map((r) => r.slice());
  emptyCol[0][8] = null;
  assert.equal(
    rules.validateTicket(emptyCol).errors.some((e) => e.code === 'E_COL_EMPTY'),
    true,
  );

  const outOfRange = VALID.map((r) => r.slice());
  outOfRange[2][2] = 0;
  assert.equal(
    rules.validateTicket(outOfRange).errors.some((e) => e.code === 'E_CELL_RANGE'),
    true,
  );

  const shapeRow = VALID.map((r) => r.slice());
  shapeRow[0] = shapeRow[0].slice(0, 4);
  assert.equal(
    rules.validateTicket(shapeRow).errors.some((e) => e.code === 'E_ROW_SHAPE'),
    true,
  );

  assert.throws(() => rules.assertValidTicket(overflow), (e) => e.code === 'E_CELL_OVERFLOW');
});

test('generateTicket is deterministic per seed and always yields a valid 3x9 ticket', () => {
  const a = rules.generateTicket('seed-1');
  const b = rules.generateTicket('seed-1');
  const c = rules.generateTicket('seed-2');
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
  assert.deepEqual(rules.validateTicket(a), { ok: true, errors: [] });
  assert.equal(rules.ticketHash(a), rules.ticketHash(b));
});

test('generated tickets keep 5 numbers per row and every column covered at scale', () => {
  for (let i = 0; i < 200; i += 1) {
    const grid = rules.generateTicket('bulk-' + i);
    const res = rules.validateTicket(grid);
    assert.equal(res.ok, true, 'generated ticket ' + i + ' invalid: ' + JSON.stringify(res.errors));
  }
  const many = rules.generateTickets(50, 'batch-seed');
  assert.equal(many.length, 50);
  for (const g of many) assert.deepEqual(rules.validateTicket(g), { ok: true, errors: [] });
});

test('buildDrawOrder is deterministic, covers 1..90 exactly and differs across seeds', () => {
  const a = rules.buildDrawOrder('order-seed');
  const b = rules.buildDrawOrder('order-seed');
  const c = rules.buildDrawOrder('order-other');
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
  assert.equal(a.length, 90);
  assert.equal(new Set(a).size, 90);
  for (let n = 1; n <= 90; n += 1) assert.ok(a.includes(n));
});

test('explicit draw order is prefixed then padded with remaining balls', () => {
  const order = rules.buildDrawOrder('ignored', [7, 42]);
  assert.equal(order[0], 7);
  assert.equal(order[1], 42);
  assert.equal(order.length, 90);
  assert.equal(new Set(order).size, 90);
});

test('marks and quine detection use the exact completing ball', () => {
  const partial = rules.marksForTicket(VALID, new Set([1, 14, 36]));
  assert.equal(partial.total, 3);
  assert.deepEqual(partial.perRow, [3, 0, 0]);
  assert.deepEqual(rules.winsForTicket(VALID, [1, 14, 36]), []);

  const wins = rules.winsForTicket(VALID, [1, 14, 36, 63, 88]);
  assert.equal(wins.length, 1);
  assert.equal(wins[0].category, 'quine');
  assert.equal(wins[0].ball, 88);
  assert.equal(wins[0].ball_index, 4);
  assert.equal(wins[0].complete_rows, 1);
});

test('carton plein is detected at the fifteenth marked number and quine precedes it', () => {
  const full = [1, 5, 14, 18, 21, 27, 32, 36, 41, 47, 52, 58, 63, 71, 88];
  const wins = rules.winsForTicket(VALID, full);
  assert.equal(wins.length, 2);
  assert.equal(wins[0].category, 'quine');
  assert.equal(wins[0].ball, 52);
  assert.equal(wins[0].ball_index, 10);
  assert.equal(wins[1].category, 'carton_plein');
  assert.equal(wins[1].ball, 88);
  assert.equal(wins[1].ball_index, 14);
  assert.deepEqual(rules.categoriesForTicket(VALID, full), ['quine', 'carton_plein']);
});

test('computePayouts splits the pool across categories with default fractions', () => {
  const result = rules.computePayouts(100000, { quine: [1, 2], carton_plein: [1] }, null);
  assert.deepEqual(result.prize, [
    { ticketIndex: 1, category: 'quine', amount_milli: 17500 },
    { ticketIndex: 2, category: 'quine', amount_milli: 17500 },
    { ticketIndex: 1, category: 'carton_plein', amount_milli: 55000 },
  ]);
  assert.equal(result.prize_milli, 90000);
  assert.equal(result.commission_milli, 10000);
  assert.equal(result.remainder_milli, 0);
});

test('computePayouts distributes the remainder deterministically across winners', () => {
  const result = rules.computePayouts(100001, { quine: [0, 1, 2], carton_plein: [] }, null);
  const amounts = result.prize.map((p) => p.amount_milli);
  assert.deepEqual(amounts, [11667, 11667, 11666]);
  assert.equal(result.prize_milli, 35000);
  assert.equal(result.commission_milli, 10000);
  assert.equal(result.remainder_milli, 55001);
});

test('computePayouts returns an empty plan for an empty or zero pool', () => {
  const empty = rules.computePayouts(0, { quine: [1], carton_plein: [] }, null);
  assert.deepEqual(empty.prize, []);
  assert.equal(empty.prize_milli, 0);
  assert.equal(empty.commission_milli, 0);
  assert.equal(empty.remainder_milli, 0);
});

test('prize fractions are configurable while commission remains fixed at 10%', () => {
  const result = rules.computePayouts(100000, { quine: [1], carton_plein: [1] }, {
    quine: 0.5,
    carton_plein: 0.3,
    commission: 0.2,
  });
  assert.equal(result.prize_milli, 80000);
  assert.equal(result.commission_milli, 10000);
});