'use strict';
const { DataError } = require('./db');

const MAX_PIPS = 6;
const SIDES = ['left', 'right'];

function ruleError(code, message) {
  return new DataError(code, message);
}

function canonicalTile(a, b) {
  if (!Number.isInteger(a) || !Number.isInteger(b)) {
    throw ruleError('E_ARG', 'tile pips must be integers');
  }
  if (a < 0 || a > MAX_PIPS || b < 0 || b > MAX_PIPS) {
    throw ruleError('E_ARG', 'tile pips out of range 0..' + MAX_PIPS);
  }
  return a <= b ? { a, b } : { a: b, b: a };
}

function makeTile(a, b) {
  return canonicalTile(a, b);
}

function tileKey(tile) {
  return tile.a + ':' + tile.b;
}

function fullSet() {
  const out = [];
  for (let a = 0; a <= MAX_PIPS; a += 1) {
    for (let b = a; b <= MAX_PIPS; b += 1) {
      out.push({ a, b });
    }
  }
  return out;
}

function pips(tile) {
  return tile.a + tile.b;
}

function isDouble(tile) {
  return tile.a === tile.b;
}

function hashSeed(seed) {
  let h = 2166136261 >>> 0;
  const text = String(seed);
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  if (h === 0) h = 0x9e3779b9;
  return h;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededRng(seed) {
  return mulberry32(hashSeed(seed));
}

function shuffle(tiles, seed) {
  const rng = seededRng(seed);
  const out = tiles.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

function newBoard() {
  return { center: null, left: [], right: [] };
}

function openEnds(board) {
  if (!board || !board.center) return null;
  const left = board.left.length ? board.left[board.left.length - 1].a : board.center.a;
  const right = board.right.length ? board.right[board.right.length - 1].b : board.center.b;
  return { left, right };
}

function firstMoveOn(board) {
  return !board || board.center === null;
}

function matchesOpen(tile, value) {
  return tile.a === value || tile.b === value;
}

function canPlayOn(tile, side, board) {
  if (firstMoveOn(board)) return true;
  const ends = openEnds(board);
  const value = side === 'left' ? ends.left : ends.right;
  return matchesOpen(tile, value);
}

function playsFor(hand, board) {
  const moves = [];
  if (firstMoveOn(board)) {
    for (const tile of hand) {
      moves.push({ tile, side: 'right' });
    }
    return moves;
  }
  const ends = openEnds(board);
  for (const tile of hand) {
    if (matchesOpen(tile, ends.left)) moves.push({ tile, side: 'left' });
    if (matchesOpen(tile, ends.right)) moves.push({ tile, side: 'right' });
  }
  return moves;
}

function canPlayAny(hand, board) {
  if (!hand || hand.length === 0) return false;
  return playsFor(hand, board).length > 0;
}

function applyPlay(board, tile, side) {
  if (!SIDES.includes(side)) {
    throw ruleError('E_ARG', 'invalid side: ' + side);
  }
  const placed = makeTile(tile.a, tile.b);
  if (firstMoveOn(board)) {
    return { center: placed, left: [], right: [] };
  }
  const ends = openEnds(board);
  const out = { center: board.center, left: board.left.slice(), right: board.right.slice() };
  if (side === 'left') {
    if (!matchesOpen(placed, ends.left)) {
      throw ruleError('E_TILE_NO_MATCH', 'tile does not match the left open end');
    }
    const outward = placed.a === ends.left ? placed.b : placed.a;
    const inner = placed.a === ends.left ? placed.a : placed.b;
    out.left.push({ a: outward, b: inner });
  } else {
    if (!matchesOpen(placed, ends.right)) {
      throw ruleError('E_TILE_NO_MATCH', 'tile does not match the right open end');
    }
    const outValue = placed.a === ends.right ? placed.b : placed.a;
    out.right.push({ a: ends.right, b: outValue });
  }
  return out;
}

function handPips(hand) {
  let total = 0;
  for (const tile of hand) total += pips(tile);
  return total;
}

function handPipsByTile(hand) {
  return hand.map((t) => ({ tile: t, pips: pips(t) }));
}

function highestDouble(hand) {
  let best = null;
  for (const tile of hand) {
    if (isDouble(tile) && (best === null || tile.a > best.a)) best = tile;
  }
  return best;
}

function highestSingle(hand) {
  let best = null;
  for (const tile of hand) {
    if (isDouble(tile)) continue;
    if (best === null || pips(tile) > pips(best)) best = tile;
  }
  return best;
}

function canDraw(boneyard) {
  return !!boneyard && boneyard.length > 0;
}

function drawOne(boneyard, rng) {
  if (!boneyard || boneyard.length === 0) {
    throw ruleError('E_NO_TILE_TO_DRAW', 'the boneyard is empty');
  }
  const index = rng ? Math.floor(rng() * boneyard.length) : boneyard.length - 1;
  return boneyard.splice(index, 1)[0];
}

function bestPlayFor(hand, board) {
  const moves = playsFor(hand, board);
  if (moves.length === 0) return null;
  let best = moves[0];
  for (const m of moves) {
    if (pips(m.tile) > pips(best.tile)) best = m;
    else if (pips(m.tile) === pips(best.tile) && m.side === 'right' && best.side !== 'right') {
      best = m;
    }
  }
  return best;
}

function chooseBotAction(hand, board, boneyard) {
  const move = bestPlayFor(hand, board);
  if (move) return { action: 'play', tile: move.tile, side: move.side };
  if (canDraw(boneyard)) return { action: 'draw' };
  return { action: 'pass' };
}

function findTile(hand, aOrTile, b) {
  const want = b === undefined ? aOrTile : { a: aOrTile, b };
  const index = hand.findIndex((t) => tileKey(t) === tileKey(want));
  return index === -1 ? null : { index, tile: hand[index] };
}

function assertTileInHand(hand, tile) {
  if (findTile(hand, tile) === null) {
    throw ruleError('E_TILE_NOT_IN_HAND', 'tile is not in the player hand');
  }
}

function allBlocked(board, hands) {
  return hands.every((hand) => !canPlayAny(hand, board));
}

function sortHand(hand) {
  return hand.slice().sort((x, y) => tileKey(x) < tileKey(y) ? -1 : 1);
}

module.exports = {
  MAX_PIPS,
  SIDES,
  makeTile,
  tileKey,
  fullSet,
  pips,
  isDouble,
  seededRng,
  shuffle,
  newBoard,
  openEnds,
  firstMoveOn,
  matchesOpen,
  canPlayOn,
  playsFor,
  canPlayAny,
  applyPlay,
  handPips,
  handPipsByTile,
  highestDouble,
  highestSingle,
  canDraw,
  drawOne,
  bestPlayFor,
  chooseBotAction,
  findTile,
  sortHand,
  assertTileInHand,
  allBlocked,
};