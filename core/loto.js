'use strict';
const { DataError } = require('./db');
const { sha256hex } = require('./db');
const { seededRng, shuffle } = require('./domino');

const ROWS = 3;
const COLS = 9;
const NUMBERS_PER_ROW = 5;
const BLANKS_PER_ROW = 4;
const BALLS = 90;
const CELLS = ROWS * NUMBERS_PER_ROW;
const CATEGORIES = ['quine', 'carton_plein'];
const CATEGORY_RANK = { quine: 0, carton_plein: 1 };
const DEFAULT_PAYOUT = { quine: 0.35, carton_plein: 0.55, commission: 0.1 };

function colOfNumber(n) {
  if (!Number.isInteger(n) || n < 1 || n > BALLS) return -1;
  if (n === BALLS) return 8;
  return Math.floor(n / 10);
}

function columnRange(col) {
  const clampCol = Math.max(0, Math.min(8, col));
  if (clampCol === 8) return { min: 80, max: BALLS };
  return { min: clampCol === 0 ? 1 : clampCol * 10, max: clampCol * 10 + 9 };
}

function isBlank(cell) {
  return cell === null || cell === undefined || cell === '';
}

function blankGrid() {
  const grid = [];
  for (let r = 0; r < ROWS; r += 1) grid.push(Array(COLS).fill(null));
  return grid;
}

function validateTicket(grid) {
  const errors = [];
  if (!Array.isArray(grid) || grid.length !== ROWS) {
    return {
      ok: false,
      errors: [{ code: 'E_GRID_SHAPE', message: 'ticket must be a 3-row grid' }],
    };
  }
  const seen = new Set();
  for (let r = 0; r < ROWS; r += 1) {
    const row = grid[r];
    if (!Array.isArray(row) || row.length !== COLS) {
      errors.push({ code: 'E_ROW_SHAPE', row, message: 'row must have ' + COLS + ' columns' });
      continue;
    }
    let nums = 0;
    // Raw integer cell values in column order. The ascending-order rule is
    // evaluated on every integer cell, including numbers that fail the
    // per-column range check below: dropping them made E_ROW_ORDER unreachable,
    // because a number sitting in the wrong column always broke the order.
    const ordered = [];
    for (let c = 0; c < COLS; c += 1) {
      const cell = row[c];
      if (isBlank(cell)) continue;
      if (Number.isInteger(cell)) ordered.push(cell);
      if (!Number.isInteger(cell) || cell < 1 || cell > BALLS) {
        errors.push({ code: 'E_CELL_RANGE', row: r, col: c, message: 'cell must be an integer 1..' + BALLS });
        continue;
      }
      const range = columnRange(c);
      if (cell < range.min || cell > range.max) {
        errors.push({
          code: 'E_CELL_OVERFLOW',
          row: r,
          col: c,
          message: 'number ' + cell + ' is outside column range ' + range.min + '-' + range.max,
        });
        continue;
      }
      if (seen.has(cell)) {
        errors.push({ code: 'E_DUPLICATE', row: r, col: c, message: 'duplicate number ' + cell });
      }
      seen.add(cell);
      nums += 1;
    }
    if (nums !== NUMBERS_PER_ROW) {
      errors.push({ code: 'E_ROW_COUNT', row: r, message: 'each row needs exactly ' + NUMBERS_PER_ROW + ' numbers' });
    }
    for (let i = 1; i < ordered.length; i += 1) {
      if (ordered[i] <= ordered[i - 1]) {
        errors.push({ code: 'E_ROW_ORDER', row: r, message: 'row numbers must be strictly increasing' });
        break;
      }
    }
  }
  for (let c = 0; c < COLS; c += 1) {
    let count = 0;
    for (let r = 0; r < ROWS; r += 1) {
      const row = grid[r];
      if (Array.isArray(row) && Number.isInteger(row[c])) count += 1;
    }
    if (count === 0) {
      errors.push({ code: 'E_COL_EMPTY', col: c, message: 'every column needs at least one number' });
    }
  }
  return { ok: errors.length === 0, errors };
}

function assertValidTicket(grid) {
  const result = validateTicket(grid);
  if (!result.ok) {
    throw new DataError(result.errors[0].code, result.errors[0].message);
  }
  return grid;
}

function ticketHash(grid) {
  return sha256hex(JSON.stringify(grid));
}

function rngOf(rngOrSeed) {
  return typeof rngOrSeed === 'function' ? rngOrSeed : seededRng(rngOrSeed);
}

function shuffleWith(rng, arr) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

function sampleRange(rng, min, max, count) {
  const pool = [];
  for (let v = min; v <= max; v += 1) pool.push(v);
  const picked = shuffleWith(rng, pool).slice(0, count);
  return picked;
}

function generateTicket(rngOrSeed) {
  const rng = rngOf(rngOrSeed);
  const rowSets = [[], [], []];
  const counts = [0, 0, 0];
  const cols = [0, 1, 2, 3, 4, 5, 6, 7, 8];
  const order = shuffleWith(rng, cols);
  for (const c of order) {
    const candidates = [0, 1, 2].filter((r) => counts[r] < NUMBERS_PER_ROW);
    const r = candidates[Math.floor(rng() * candidates.length)];
    rowSets[r].push(c);
    counts[r] += 1;
  }
  for (let r = 0; r < ROWS; r += 1) {
    while (counts[r] < NUMBERS_PER_ROW) {
      const avail = cols.filter((c) => !rowSets[r].includes(c));
      const c = avail[Math.floor(rng() * avail.length)];
      rowSets[r].push(c);
      counts[r] += 1;
    }
  }
  const grid = blankGrid();
  for (let c = 0; c < COLS; c += 1) {
    const rowsWith = [];
    for (let r = 0; r < ROWS; r += 1) {
      if (rowSets[r].includes(c)) rowsWith.push(r);
    }
    const range = columnRange(c);
    const chosen = sampleRange(rng, range.min, range.max, rowsWith.length);
    const perm = shuffleWith(rng, chosen);
    rowsWith.forEach((r, idx) => {
      grid[r][c] = perm[idx];
    });
  }
  return grid;
}

function generateTickets(count, seed) {
  const rng = rngOf(seed);
  const out = [];
  for (let i = 0; i < count; i += 1) out.push(generateTicket(rng));
  return out;
}

function numbers1to90() {
  const out = [];
  for (let n = 1; n <= BALLS; n += 1) out.push(n);
  return out;
}

function buildDrawOrder(seed, explicit) {
  if (Array.isArray(explicit) && explicit.length > 0) {
    const order = explicit.slice();
    const used = new Set(order);
    for (let n = 1; n <= BALLS; n += 1) {
      if (!used.has(n)) order.push(n);
    }
    return order;
  }
  return shuffle(numbers1to90(), seed);
}

function marksForTicket(grid, drawn) {
  let total = 0;
  const perRow = [0, 0, 0];
  for (let r = 0; r < ROWS; r += 1) {
    const row = grid[r];
    if (!Array.isArray(row)) continue;
    for (let c = 0; c < COLS; c += 1) {
      const v = row[c];
      if (Number.isInteger(v) && drawn.has(v)) {
        total += 1;
        perRow[r] += 1;
      }
    }
  }
  return { total, perRow };
}

function winsForTicket(grid, drawn) {
  const set = new Set();
  const perRow = [0, 0, 0];
  const out = [];
  let total = 0;
  let quineDone = false;
  let cartonDone = false;
  for (let i = 0; i < drawn.length; i += 1) {
    const ball = drawn[i];
    set.add(ball);
    for (let r = 0; r < ROWS; r += 1) {
      const row = grid[r];
      if (!Array.isArray(row)) continue;
      for (let c = 0; c < COLS; c += 1) {
        if (row[c] === ball) {
          perRow[r] += 1;
          total += 1;
        }
      }
    }
    if (!quineDone && perRow.some((n) => n >= NUMBERS_PER_ROW)) {
      quineDone = true;
      out.push({
        category: 'quine',
        ball,
        ball_index: i,
        complete_rows: perRow.filter((n) => n >= NUMBERS_PER_ROW).length,
      });
    }
    if (!cartonDone && total === CELLS) {
      cartonDone = true;
      out.push({ category: 'carton_plein', ball, ball_index: i });
    }
  }
  return out;
}

function categoriesForTicket(grid, drawn) {
  return winsForTicket(grid, drawn).map((w) => w.category);
}

function normalizePayout(configured) {
  const out = {};
  for (const key of ['quine', 'carton_plein', 'commission']) {
    const value = configured && Number.isFinite(configured[key]) ? configured[key] : DEFAULT_PAYOUT[key];
    out[key] = Math.min(Math.max(value, 0), 1);
  }
  return out;
}

function fractionOf(amount, fraction) {
  return Math.floor(amount * fraction);
}

function computePayouts(poolMilli, winnersByCategory, configured) {
  const payout = normalizePayout(configured);
  const prize = [];
  let prize_milli = 0;
  let commission_milli = 0;
  if (Number.isSafeInteger(poolMilli) && poolMilli > 0) {
    commission_milli = fractionOf(poolMilli, payout.commission);
    for (const category of CATEGORIES) {
      const indexes = winnersByCategory[category] || [];
      if (indexes.length === 0) continue;
      const base = fractionOf(poolMilli, payout[category]);
      const share = Math.floor(base / indexes.length);
      const remainder = base - share * indexes.length;
      indexes.forEach((ticketIndex, i) => {
        const amount = share + (i < remainder ? 1 : 0);
        if (amount > 0) {
          prize.push({ ticketIndex, category, amount_milli: amount });
          prize_milli += amount;
        }
      });
    }
  }
  const remainder_milli = poolMilli - prize_milli - commission_milli;
  return { prize, prize_milli, commission_milli, remainder_milli };
}

module.exports = {
  ROWS,
  COLS,
  NUMBERS_PER_ROW,
  BLANKS_PER_ROW,
  BALLS,
  CELLS,
  CATEGORIES,
  CATEGORY_RANK,
  DEFAULT_PAYOUT,
  colOfNumber,
  columnRange,
  isBlank,
  blankGrid,
  validateTicket,
  assertValidTicket,
  ticketHash,
  generateTicket,
  generateTickets,
  numbers1to90,
  buildDrawOrder,
  marksForTicket,
  winsForTicket,
  categoriesForTicket,
  normalizePayout,
  computePayouts,
};