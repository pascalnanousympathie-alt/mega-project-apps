'use strict';
const { DataError } = require('./db');
const { seededRng, shuffle } = require('./domino');

const SUITS = ['C', 'D', 'H', 'S'];
const RANK_MIN = 1;
const RANK_MAX = 13;
const JOKER_COUNT = 2;
const JOKER_PREFIX = 'JK';
const MIN_MELD_LEN = 3;
const GROUP_SIZES = [3, 4];
const MAX_JOKERS_PER_MELD = 1;
const FACE_POINTS = 10;
const JOKER_POINTS = 25;

function ruleError(code, message) {
  return new DataError(code, message);
}

function makeJoker(id) {
  return { joker: true, id: id === 2 ? 2 : 1 };
}

function makeCard(rank, suit) {
  if (!Number.isInteger(rank) || rank < RANK_MIN || rank > RANK_MAX) {
    throw ruleError('E_ARG', 'rank must be an integer 1..' + RANK_MAX);
  }
  if (!SUITS.includes(suit)) {
    throw ruleError('E_ARG', 'suit must be one of ' + SUITS.join('/'));
  }
  return { rank, suit };
}

function isJoker(card) {
  return !!card && card.joker === true;
}

function cardKey(card) {
  if (!card) throw ruleError('E_ARG', 'card required');
  if (isJoker(card)) return JOKER_PREFIX + ':' + (card.id === 2 ? 2 : 1);
  return card.suit + ':' + card.rank;
}

function parseCardKey(key) {
  if (typeof key !== 'string') throw ruleError('E_ARG', 'card key must be a string');
  const parts = key.split(':');
  if (parts.length !== 2) throw ruleError('E_ARG', 'malformed card key: ' + key);
  if (parts[0] === JOKER_PREFIX) {
    const id = Number(parts[1]);
    if (id !== 1 && id !== 2) throw ruleError('E_ARG', 'invalid joker id: ' + key);
    return { joker: true, id };
  }
  if (!SUITS.includes(parts[0])) throw ruleError('E_ARG', 'invalid suit in card key: ' + key);
  const rank = Number(parts[1]);
  if (!Number.isInteger(rank) || rank < RANK_MIN || rank > RANK_MAX) {
    throw ruleError('E_ARG', 'invalid rank in card key: ' + key);
  }
  return { rank, suit: parts[0] };
}

function fullDeck() {
  const out = [];
  for (const suit of SUITS) {
    for (let rank = RANK_MIN; rank <= RANK_MAX; rank += 1) out.push({ rank, suit });
  }
  for (let id = 1; id <= JOKER_COUNT; id += 1) out.push(makeJoker(id));
  return out;
}

function deckKeys() {
  return fullDeck().map(cardKey);
}

function shuffleDeck(seed) {
  return shuffle(fullDeck(), seed);
}

function sortHand(cards) {
  return cards.slice().sort((x, y) => {
    const a = cardKey(x);
    const b = cardKey(y);
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

function rankOf(card) {
  return isJoker(card) ? null : card.rank;
}

function suitOf(card) {
  return isJoker(card) ? null : card.suit;
}

function points(card) {
  if (isJoker(card)) return JOKER_POINTS;
  return card.rank <= 10 ? card.rank : FACE_POINTS;
}

function cardPoints(cardKeyStr) {
  return points(parseCardKey(cardKeyStr));
}

function handPoints(cardKeysOrCards) {
  let total = 0;
  for (const card of cardKeysOrCards || []) {
    total += typeof card === 'string' ? cardPoints(card) : points(card);
  }
  return total;
}

function validateGroup(cards) {
  const errors = [];
  if (!Array.isArray(cards) || cards.length === 0) {
    return { ok: false, kind: 'group', errors: [{ code: 'E_GROUP_EMPTY', message: 'group must not be empty' }] };
  }
  let jokers = 0;
  const real = [];
  for (const card of cards) {
    if (isJoker(card)) jokers += 1;
    else real.push(card);
  }
  if (cards.length !== 3 && cards.length !== 4) {
    errors.push({ code: 'E_GROUP_SIZE', message: 'a group must contain 3 or 4 cards (Brelan/Carré)' });
  }
  if (jokers > MAX_JOKERS_PER_MELD) {
    errors.push({ code: 'E_GROUP_TOO_MANY_JOKERS', message: 'a group may hold at most ' + MAX_JOKERS_PER_MELD + ' joker' });
  }
  if (real.length > 0) {
    const first = real[0].rank;
    if (real.some((c) => c.rank !== first)) {
      errors.push({ code: 'E_GROUP_RANK', message: 'a group requires a single shared rank' });
    }
  }
  const suits = real.map((c) => c.suit);
  if (new Set(suits).size !== suits.length) {
    errors.push({ code: 'E_GROUP_DUPLICATE_SUIT', message: 'a group requires distinct suits' });
  }
  if (real.length + jokers < MIN_MELD_LEN) {
    errors.push({ code: 'E_GROUP_MIXED_SIZE', message: 'a group must be exactly 3 or 4 cards' });
  }
  return { ok: errors.length === 0, kind: 'group', errors, cards: sortHand(cards) };
}

function validateRun(cards) {
  const errors = [];
  if (!Array.isArray(cards) || cards.length === 0) {
    return { ok: false, kind: 'run', errors: [{ code: 'E_RUN_EMPTY', message: 'run must not be empty' }] };
  }
  let jokers = 0;
  const realRanks = [];
  let suit = null;
  for (const card of cards) {
    if (isJoker(card)) {
      jokers += 1;
      continue;
    }
    if (suit === null) suit = card.suit;
    if (card.suit !== suit) {
      errors.push({ code: 'E_RUN_MIXED_SUIT', message: 'a run requires a single suit' });
    }
    realRanks.push(card.rank);
  }
  if (cards.length < MIN_MELD_LEN) {
    errors.push({ code: 'E_RUN_TOO_SHORT', message: 'a run must contain at least ' + MIN_MELD_LEN + ' cards' });
  }
  if (jokers > MAX_JOKERS_PER_MELD) {
    errors.push({ code: 'E_RUN_TOO_MANY_JOKERS', message: 'a run may hold at most ' + MAX_JOKERS_PER_MELD + ' joker' });
  }
  const uniq = new Set(realRanks);
  if (uniq.size !== realRanks.length) {
    errors.push({ code: 'E_RUN_DUP_RANK', message: 'a run cannot repeat a rank' });
  }
  if (realRanks.length > 0) {
    const min = Math.min(...realRanks);
    const max = Math.max(...realRanks);
    const span = max - min + 1;
    const consecutive = span === realRanks.length;
    const oneGap = span === realRanks.length + 1;
    const fitsJoker = jokers === 1 && (consecutive || oneGap);
    if (jokers === 0 && !consecutive) {
      errors.push({ code: 'E_RUN_NON_CONSECUTIVE', message: 'a run must be consecutive ranks' });
    }
    if (jokers === 1 && !fitsJoker) {
      errors.push({ code: 'E_RUN_JOKER_GAP', message: 'a single joker must fill exactly one rank slot' });
    }
  }
  return { ok: errors.length === 0, kind: 'run', errors, cards: sortHand(cards) };
}

function validateMeld(cards) {
  if (!cards || !Array.isArray(cards) || cards.length === 0) {
    return { ok: false, kind: 'none', errors: [{ code: 'E_MELD_EMPTY', message: 'meld must not be empty' }] };
  }
  const group = validateGroup(cards);
  if (group.ok) return group;
  const run = validateRun(cards);
  if (run.ok) return run;
  return { ok: false, kind: 'group', errors: [...group.errors, ...run.errors].slice(0, 3), cards: sortHand(cards) };
}

function assertValidMeld(cards) {
  const result = validateMeld(cards);
  if (!result.ok) throw ruleError(result.errors[0].code, result.errors[0].message);
  return result;
}

function findMelds(hand, opts = {}) {
  const desiredMin = Number.isInteger(opts.minLength) ? opts.minLength : MIN_MELD_LEN;
  const cards = (hand || []).map((card) => (typeof card === 'string' ? parseCardKey(card) : card));
  const byKey = {};
  for (const card of cards) byKey[cardKey(card)] = card;
  const jokerKeys = cards.filter(isJoker).map(cardKey).sort();
  const melds = [];
  const placed = new Set();
  let jokerCursor = 0;
  const jokerAvail = () => jokerCursor < jokerKeys.length;
  const popJoker = () => {
    jokerCursor += 1;
    return jokerKeys[jokerCursor - 1];
  };

  const byRank = new Map();
  for (const key of Object.keys(byKey).sort()) {
    const card = byKey[key];
    if (isJoker(card)) continue;
    if (!byRank.has(card.rank)) byRank.set(card.rank, []);
    byRank.get(card.rank).push(key);
  }
  for (const rank of [...byRank.keys()].sort((a, b) => a - b)) {
    const keys = byRank.get(rank);
    if (keys.length === 3 && jokerAvail()) {
      const meld = [...keys, popJoker()];
      for (const k of meld) placed.add(k);
      melds.push(meld.map((k) => byKey[k]));
    } else if (keys.length >= 4) {
      const alreadyPlaced = keys.slice(0, 4);
      for (const k of alreadyPlaced) placed.add(k);
      melds.push(alreadyPlaced.map((k) => byKey[k]));
    } else if (keys.length === 2 && jokerAvail()) {
      const meld = [...keys, popJoker()];
      for (const k of meld) placed.add(k);
      melds.push(meld.map((k) => byKey[k]));
    } else if (keys.length >= 3) {
      for (const k of keys) placed.add(k);
      melds.push(keys.map((k) => byKey[k]));
    }
  }

  for (const suit of SUITS) {
    const pool = Object.keys(byKey)
      .filter((k) => {
        const c = byKey[k];
        return !isJoker(c) && c.suit === suit && !placed.has(k);
      })
      .sort((a, b) => byKey[a].rank - byKey[b].rank);
    let i = 0;
    while (i < pool.length) {
      const key = pool[i];
      const runKeys = [key];
      placed.add(key);
      let j = i + 1;
      while (j < pool.length && byKey[pool[j]].rank === byKey[pool[j - 1]].rank + 1) {
        runKeys.push(pool[j]);
        placed.add(pool[j]);
        j += 1;
      }
      if (runKeys.length >= desiredMin && jokerAvail()) {
        runKeys.push(popJoker());
      }
      if (runKeys.length >= desiredMin) {
        melds.push(runKeys.map((k) => byKey[k]));
      }
      i = j;
    }
  }
  return melds;
}

function canFormAnyMeld(hand) {
  return findMelds(hand).length > 0;
}

function meldsCoverCard(melds, key) {
  return melds.some((meld) => meld.some((c) => cardKey(c) === key));
}

function keysInMelds(melds) {
  const out = [];
  for (const meld of melds) for (const c of meld) out.push(cardKey(c));
  return out;
}

function canUseCardInMeld(candidateKey, handKeysOrCards) {
  const candidate = typeof candidateKey === 'string' ? parseCardKey(candidateKey) : candidateKey;
  const all = [...(handKeysOrCards || []).map((k) => (typeof k === 'string' ? parseCardKey(k) : k)), candidate];
  const key = cardKey(candidate);
  return findMelds(all).some((meld) => meld.some((c) => cardKey(c) === key));
}

function validateMeldSet(melds) {
  const errors = [];
  const seen = new Set();
  if (!Array.isArray(melds) || melds.length === 0) {
    return { ok: true, errors, melds };
  }
  for (const meld of melds) {
    const cards = typeof meld[0] === 'string' ? meld.map(parseCardKey) : meld;
    const result = validateMeld(cards);
    if (!result.ok) {
      errors.push({ code: result.errors[0].code, message: result.errors[0].message });
      continue;
    }
    for (const c of cards) {
      const key = cardKey(c);
      if (seen.has(key)) errors.push({ code: 'E_MELD_OVERLAP', message: 'cards are shared across melds' });
      seen.add(key);
    }
  }
  return { ok: errors.length === 0, errors, melds };
}

function assertMeldSetPlayable(handKeys, melds) {
  if (!Array.isArray(melds) || melds.length === 0) {
    throw ruleError('E_MELDS_REQUIRED', 'at least one meld is required');
  }
  const hand = new Set(handKeys);
  const used = new Set();
  const result = validateMeldSet(melds);
  if (!result.ok) throw ruleError(result.errors[0].code, result.errors[0].message);
  for (let i = 0; i < melds.length; i += 1) {
    const meld = melds[i];
    if (!Array.isArray(meld) || meld.length === 0) {
      throw ruleError('E_MELD_EMPTY', 'meld ' + i + ' is empty');
    }
    for (const c of meld) {
      const key = typeof c === 'string' ? c : cardKey(c);
      if (!hand.has(key)) throw ruleError('E_CARD_NOT_IN_HAND', 'meld card is not in the hand: ' + key);
      if (used.has(key)) throw ruleError('E_MELD_OVERLAP', 'card used in two melds: ' + key);
      used.add(key);
    }
    const cards = typeof meld[0] === 'string' ? meld.map(parseCardKey) : meld;
    const v = validateMeld(cards);
    if (!v.ok) throw ruleError(v.errors[0].code, v.errors[0].message);
  }
  return true;
}

function findCard(hand, key) {
  const index = hand.findIndex((c) => cardKey(c) === key);
  return index === -1 ? null : { index, card: hand[index] };
}

function assertCardInHand(handKeys, key) {
  if (!Array.isArray(handKeys) || !handKeys.includes(key)) {
    throw ruleError('E_CARD_NOT_IN_HAND', 'card is not in the player hand: ' + key);
  }
}

function deckAudit(cardKeysList) {
  const expected = new Set(deckKeys());
  const seen = new Set();
  for (const key of cardKeysList) {
    if (!expected.has(key)) throw ruleError('E_UNKNOWN_CARD', 'unknown card in play: ' + key);
    if (seen.has(key)) throw ruleError('E_DUPLICATE_CARD', 'card appears more than once: ' + key);
    seen.add(key);
  }
  return { ok: true, cards: seen.size, expected: expected.size };
}

module.exports = {
  SUITS,
  RANK_MIN,
  RANK_MAX,
  JOKER_COUNT,
  JOKER_PREFIX,
  MIN_MELD_LEN,
  GROUP_SIZES,
  MAX_JOKERS_PER_MELD,
  makeJoker,
  makeCard,
  isJoker,
  cardKey,
  parseCardKey,
  fullDeck,
  deckKeys,
  shuffleDeck,
  sortHand,
  rankOf,
  suitOf,
  points,
  cardPoints,
  handPoints,
  validateGroup,
  validateRun,
  validateMeld,
  assertValidMeld,
  findMelds,
  canFormAnyMeld,
  meldsCoverCard,
  keysInMelds,
  canUseCardInMeld,
  validateMeldSet,
  assertMeldSetPlayable,
  findCard,
  assertCardInHand,
  deckAudit,
  seededRng,
  shuffle,
};