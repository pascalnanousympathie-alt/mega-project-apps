'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const rules = require('../core/rami');

const H = (r) => rules.makeCard(r, 'H');
const S = (r) => rules.makeCard(r, 'S');
const D = (r) => rules.makeCard(r, 'D');
const C = (r) => rules.makeCard(r, 'C');

test('the deck is 52 cards plus 2 jokers with unique keys', () => {
  const deck = rules.fullDeck();
  assert.equal(deck.length, 54);
  const jokers = deck.filter(rules.isJoker);
  assert.equal(jokers.length, 2);
  const keys = deck.map(rules.cardKey);
  assert.equal(new Set(keys).size, 54);
  for (const suit of rules.SUITS) {
    for (let rank = 1; rank <= 13; rank += 1) {
      const key = suit + ':' + rank;
      assert.ok(keys.includes(key), 'missing ' + key);
    }
  }
  assert.ok(keys.includes('JK:1'));
  assert.ok(keys.includes('JK:2'));
});

test('cardKey/parseCardKey round-trips and rejects malformed keys', () => {
  assert.deepEqual(rules.parseCardKey('H:7'), { rank: 7, suit: 'H' });
  assert.deepEqual(rules.parseCardKey('JK:2'), { joker: true, id: 2 });
  assert.equal(rules.cardKey(rules.parseCardKey('S:13')), 'S:13');
  assert.throws(() => rules.parseCardKey('X:1'), (e) => e.code === 'E_ARG');
  assert.throws(() => rules.parseCardKey('H:14'), (e) => e.code === 'E_ARG');
  assert.throws(() => rules.parseCardKey('JK:3'), (e) => e.code === 'E_ARG');
  assert.throws(() => rules.parseCardKey('H:0'), (e) => e.code === 'E_ARG');
});

test('shuffleDeck is deterministic per seed and differs across seeds', () => {
  const a = rules.shuffleDeck('seed-a');
  const b = rules.shuffleDeck('seed-a');
  const c = rules.shuffleDeck('seed-b');
  assert.deepEqual(a.map(rules.cardKey), b.map(rules.cardKey));
  assert.notDeepEqual(a.map(rules.cardKey), c.map(rules.cardKey));
  assert.deepEqual(new Set(a.map(rules.cardKey)).size, 54);
});

test('brelan requires 3 same-rank cards with distinct suits', () => {
  assert.equal(rules.validateMeld([H(7), S(7), D(7)]).ok, true);
  assert.equal(rules.validateMeld([H(7), S(7), D(7), C(7)]).ok, true, 'carre is a valid group too');
  assert.equal(rules.validateMeld([H(7), H(8), D(7)]).ok, false, 'mixed ranks rejected');
  assert.equal(rules.validateMeld([H(7), H(7), D(7)]).ok, false, 'duplicate suit rejected');
  assert.equal(rules.validateMeld([H(7), S(7)]).ok, false, 'pair is not a brelan');
  assert.equal(rules.validateMeld([H(7), S(7), D(7), H(8)]).ok, false, '5-card group rejected');
});

test('a brelan or carre may use a single joker', () => {
  assert.equal(rules.validateMeld([H(7), S(7), rules.makeJoker(1)]).ok, true);
  assert.equal(rules.validateMeld([H(7), S(7), D(7), rules.makeJoker(1)]).ok, true);
  assert.equal(rules.validateMeld([H(7), S(7), rules.makeJoker(1), rules.makeJoker(2)]).ok, false, 'two jokers rejected');
  assert.equal(rules.validateMeld([H(7)]).ok, false, 'group of jokers alone is not a group');
});

test('a run requires 3+ consecutive ranks in a single suit', () => {
  assert.equal(rules.validateMeld([H(4), H(5), H(6)]).ok, true);
  assert.equal(rules.validateMeld([H(4), S(5), H(6)]).ok, false, 'mixed suits rejected');
  assert.equal(rules.validateMeld([H(4), H(6), H(8)]).ok, false, 'gap rejected');
  assert.equal(rules.validateMeld([H(4), H(5)]).ok, false, 'too short');
  assert.equal(rules.validateMeld([H(4), H(5), H(5)]).ok, false, 'duplicate rank rejected');
  assert.equal(rules.validateMeld([H(4), H(5), H(6), H(7), H(8)]).ok, true, 'long runs are valid');
});

test('a run may use a single joker to extend or bridge', () => {
  assert.equal(rules.validateMeld([H(4), H(5), H(6), rules.makeJoker(1)]).ok, true, 'joker extends the top');
  assert.equal(rules.validateMeld([H(4), H(5), rules.makeJoker(1), H(7)]).ok, true, 'joker bridges an internal gap');
  assert.equal(rules.validateMeld([H(4), H(6), H(8), rules.makeJoker(1)]).ok, false, 'joker cannot fix two gaps');
  assert.equal(rules.validateMeld([H(4), H(5), rules.makeJoker(1), rules.makeJoker(2)]).ok, false, 'two jokers rejected');
});

test('points follow rank/face/joker rules', () => {
  assert.equal(rules.points(H(1)), 1);
  assert.equal(rules.points(H(10)), 10);
  assert.equal(rules.points(H(11)), 10, 'faces are worth 10');
  assert.equal(rules.points(H(13)), 10);
  assert.equal(rules.points(rules.makeJoker(1)), 25);
  assert.equal(rules.handPoints(['H:1', 'H:13', 'JK:1']), 1 + 10 + 25);
});

test('findMelds is deterministic and returns valid melds covering hand cards', () => {
  const hand = rules.sortHand([H(7), S(7), D(7), C(1), C(2), C(3), H(9), D(2)]);
  const melds = rules.findMelds(hand);
  assert.ok(melds.length >= 2, 'should find group + run, got ' + new Set(melds.map((m) => m.map(rules.cardKey).join(','))).size);
  const flat = new Set(melds.reduce((acc, m) => acc.concat(m.map(rules.cardKey)), []));
  assert.ok(flat.has('C:1') && flat.has('H:7'), 'melds cover expected cards');
  for (const meld of melds) assert.equal(rules.validateMeld(meld).ok, true);
  const repeated = rules.findMelds(rules.sortHand([H(7), S(7), D(7), C(1), C(2), C(3), H(9), D(2)]));
  assert.deepEqual(repeated.map((m) => m.map(rules.cardKey)), melds.map((m) => m.map(rules.cardKey)));
});

test('findMelds builds a brelan from a pair plus joker', () => {
  const melds = rules.findMelds(rules.sortHand([H(7), S(7), rules.makeJoker(1), C(1), C(2), C(3)]));
  const any = melds.some((m) => m.length === 3 && m.every((c) => rules.isJoker(c) || rules.parseCardKey(rules.cardKey(c)).rank === 7));
  assert.equal(any, true);
});

test('assertMeldSetPlayable validates ownership, validity and overlaps', () => {
  const hand = ['H:7', 'S:7', 'D:7', 'H:4', 'H:5', 'H:6', 'C:9'];
  const good = [['H:7', 'S:7', 'D:7'], ['H:4', 'H:5', 'H:6']];
  assert.equal(rules.assertMeldSetPlayable(hand, good), true);
  assert.throws(() => rules.assertMeldSetPlayable(hand, [['H:7', 'S:7', 'C:9']]), (e) => e.code === 'E_GROUP_RANK');
  assert.throws(() => rules.assertMeldSetPlayable(hand, [['H:7', 'S:7', 'D:9']]), (e) => e.name === 'DataError');
  assert.throws(() => rules.assertMeldSetPlayable(hand, [['H:7', 'S:7', 'D:7'], ['H:7', 'S:7', 'C:7']]), (e) => e.code === 'E_MELD_OVERLAP');
  assert.throws(() => rules.assertMeldSetPlayable(hand, [['H:7', 'S:7', 'JK:1']]), (e) => e.code === 'E_CARD_NOT_IN_HAND');
  assert.throws(() => rules.assertMeldSetPlayable(hand, []), (e) => e.code === 'E_MELDS_REQUIRED');
});

test('deckAudit accepts exactly one full deck and rejects duplicates/unknown cards', () => {
  assert.deepEqual(rules.deckAudit(rules.deckKeys()), { ok: true, cards: 54, expected: 54 });
  assert.throws(() => rules.deckAudit([...rules.deckKeys().slice(0, 53), 'H:13']), (e) => e.code === 'E_DUPLICATE_CARD');
  assert.throws(() => rules.deckAudit([...rules.deckKeys(), 'XX:1']), (e) => e.code === 'E_UNKNOWN_CARD');
});

test('canUseCardInMeld reports when a drawn card completes a meld', () => {
  const hand = ['H:4', 'H:5'];
  assert.equal(rules.canUseCardInMeld('H:6', hand), true);
  assert.equal(rules.canUseCardInMeld('S:6', hand), false);
  assert.equal(rules.canUseCardInMeld('D:6', ['H:6', 'S:6']), true, 'pair plus discard makes a brelan');
});