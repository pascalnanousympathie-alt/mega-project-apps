'use strict';
const {
  DataError,
  ok,
  nowIso,
  genId,
  sha256hex,
  safeRollback,
  parseRow,
  toDataError,
  GENESIS_HASH,
} = require('./db');
const { canonicalJson } = require('./domino-game');

const SESSION_TYPES = ['offline', 'manual'];
const RULES = ['high', 'low'];
const GAME_KINDS = ['domino', 'loto', 'rami'];
const MAX_PLAYERS = { domino: 4, rami: 4, loto: 8 };
const SCORE_LIMIT = 1000000;
const BOT_PREFIX = 'bot:';

function isBot(userId) {
  return typeof userId === 'string' && userId.startsWith(BOT_PREFIX);
}

function hashLocalRecord(f) {
  const parts = [
    'local_record',
    f.id,
    f.user_id,
    f.game_kind,
    f.session_type,
    f.match_ref === null || f.match_ref === undefined ? '' : f.match_ref,
    f.client_ref === null || f.client_ref === undefined ? '' : f.client_ref,
    f.seed === null || f.seed === undefined ? '' : f.seed,
    f.rule,
    f.players_json,
    f.scores_json,
    f.ranking_json,
    f.winner_user_id === null || f.winner_user_id === undefined ? '' : f.winner_user_id,
    f.prev_hash,
    f.created_at,
  ];
  return sha256hex(parts.join('\x1f'));
}

function normalizePlayers(value) {
  ok(Array.isArray(value), 'E_ARG', 'players must be an array');
  ok(value.length >= 2, 'E_ARG', 'a local session needs at least two players');
  const seenId = new Set();
  const seenSeat = new Set();
  return value.map((p, i) => {
    ok(p && typeof p === 'object' && !Array.isArray(p), 'E_ARG', 'player ' + i + ' must be an object');
    const userId = p.userId;
    const seat = p.seat;
    ok(
      typeof userId === 'string' && userId.length >= 1 && userId.length <= 80,
      'E_ARG',
      'invalid player user_id at index ' + i,
    );
    ok(Number.isInteger(seat) && seat >= 1 && seat <= 30, 'E_ARG', 'invalid seat for player ' + userId);
    ok(!seenId.has(userId), 'E_ARG', 'duplicate player: ' + userId);
    ok(!seenSeat.has(seat), 'E_ARG', 'duplicate seat: ' + seat);
    seenId.add(userId);
    seenSeat.add(seat);
    let name = null;
    if (p.name !== undefined && p.name !== null) {
      ok(typeof p.name === 'string' && p.name.length >= 1 && p.name.length <= 40, 'E_ARG', 'invalid name for player ' + userId);
      name = p.name;
    }
    return { userId, seat, name };
  });
}

function normalizeScores(value, players) {
  ok(Array.isArray(value), 'E_ARG', 'scores must be an array');
  const seatOf = {};
  for (const p of players) seatOf[p.userId] = p.seat;
  ok(value.length === players.length, 'E_ARG', 'scores must contain exactly one entry per player');
  const seen = new Set();
  return value.map((s, i) => {
    ok(s && typeof s === 'object' && !Array.isArray(s), 'E_ARG', 'score ' + i + ' must be an object');
    ok(Object.prototype.hasOwnProperty.call(seatOf, s.userId), 'E_ARG', 'score references unknown player: ' + s.userId);
    ok(!seen.has(s.userId), 'E_ARG', 'duplicate score entry for player: ' + s.userId);
    seen.add(s.userId);
    ok(
      Number.isSafeInteger(s.value) && Math.abs(s.value) <= SCORE_LIMIT,
      'E_ARG',
      'invalid score value for player ' + s.userId,
    );
    return { userId: s.userId, seat: seatOf[s.userId], value: s.value };
  });
}

function computeRanking(rule, players, scores) {
  const seatOf = {};
  for (const p of players) seatOf[p.userId] = p.seat;
  const better = (a, b) => (rule === 'low' ? a < b : a > b);
  return scores
    .map((s) => ({ userId: s.userId, seat: s.seat, value: s.value }))
    .sort((x, y) => {
      if (x.value !== y.value && better(x.value, y.value)) return -1;
      if (x.value !== y.value && better(y.value, x.value)) return 1;
      return x.seat - y.seat;
    })
    .map((s) => ({
      userId: s.userId,
      value: s.value,
      rank:
        1 +
        scores
          .filter((o) => o.userId !== s.userId && better(o.value, s.value))
          .filter((o, idx, arr) => arr.findIndex((t) => t.value === o.value) === idx).length,
    }));
}

function parseRecord(row) {
  if (!row) return null;
  const r = parseRow(row);
  const loadJson = (text, fallback) => {
    try {
      const value = JSON.parse(text);
      return value === null || value === undefined ? fallback : value;
    } catch (_) {
      return fallback;
    }
  };
  return {
    seq: r.seq,
    id: r.id,
    user_id: r.user_id,
    game_kind: r.game_kind,
    session_type: r.session_type,
    match_ref: r.match_ref,
    client_ref: r.client_ref,
    seed: r.seed,
    rule: r.rule,
    players: loadJson(r.players_json, []),
    scores: loadJson(r.scores_json, []),
    ranking: loadJson(r.ranking_json, []),
    winner_user_id: r.winner_user_id,
    prev_hash: r.prev_hash,
    hash: r.hash,
    created_at: r.created_at,
  };
}

function projectDomino(m) {
  const st = m.state;
  ok(st.status === 'finished', 'E_MATCH_OPEN', 'domino match is not finished');
  const players = st.players.map((p) => ({ userId: p.userId, seat: p.seat, name: p.name || null }));
  const scores = (st.scores || []).map((s) => ({ userId: s.userId, value: s.pips }));
  return {
    players,
    scores,
    rule: 'low',
    winner: st.winnerUserId || null,
    seed: m.seed,
    matchId: m.id,
    sessionType: 'offline',
    refUserId: m.user_id,
  };
}

function projectRami(m) {
  const st = m.state;
  ok(st.status === 'finished', 'E_GAME_OPEN', 'rami game is not finished');
  const players = st.players.map((p) => ({ userId: p.userId, seat: p.seat, name: p.name || null }));
  const scores = (st.scores || []).map((s) => ({ userId: s.userId, value: s.points }));
  return {
    players,
    scores,
    rule: 'low',
    winner: st.winnerUserId || null,
    seed: m.seed,
    matchId: m.id,
    sessionType: 'offline',
    refUserId: m.user_id,
  };
}

function projectLoto(m) {
  const st = m.state;
  ok(st.status === 'finished', 'E_DRAW_OPEN', 'loto draw is not finished');
  const players = [];
  const seen = new Set();
  for (const t of st.tickets) {
    if (seen.has(t.userId)) continue;
    seen.add(t.userId);
    players.push({ userId: t.userId, seat: players.length + 1, name: t.userId });
  }
  const scores = players.map((p) => {
    let categories = 0;
    for (const w of st.winners) {
      if (w.userId === p.userId) categories += (w.categories || []).length;
    }
    return { userId: p.userId, value: categories };
  });
  return {
    players,
    scores,
    rule: 'high',
    winner: st.winners.length > 0 ? st.winners[0].userId : null,
    seed: m.seed,
    matchId: m.id,
    sessionType: 'offline',
    refUserId: m.user_id,
  };
}

const OFFLINE_IMPORTERS = {
  domino: {
    verify: (engine, id) => engine.verifyMatch(id),
    project: (engine, id) => projectDomino(engine.getMatch(id)),
  },
  rami: {
    verify: (engine, id) => engine.verifyGame(id),
    project: (engine, id) => projectRami(engine.getGame(id)),
  },
  loto: {
    verify: (engine, id) => engine.verifyDraw(id),
    project: (engine, id) => projectLoto(engine.getDraw(id)),
  },
};

function buildLocalRecords(deps) {
  const db = deps && deps.db;
  const repos = deps && deps.repos;
  const engines = (deps && deps.engines) || {};
  ok(db, 'E_ARG', 'local records require db');
  ok(repos, 'E_ARG', 'local records require repos');

  function createRecord(fields) {
    ok(GAME_KINDS.includes(fields.game_kind), 'E_ARG', 'invalid game_kind: ' + fields.game_kind);
    ok(SESSION_TYPES.includes(fields.sessionType), 'E_ARG', 'invalid session_type: ' + fields.sessionType);
    ok(RULES.includes(fields.rule), 'E_ARG', 'invalid rule: ' + fields.rule);
    ok(fields.players.length <= MAX_PLAYERS[fields.game_kind], 'E_ARG', 'too many players for ' + fields.game_kind);

    if (typeof fields.clientRef === 'string' && fields.clientRef.length > 0) {
      const existing = db
        .prepare('SELECT * FROM local_records WHERE user_id = ? AND client_ref = ?')
        .get(fields.userId, fields.clientRef);
      if (existing) return { idempotent: true, record: parseRecord(existing) };
    }

    const players = normalizePlayers(fields.players);
    const scores = normalizeScores(fields.scores, players);
    const ranking = computeRanking(fields.rule, players, scores);
    let winner = fields.winner;
    if (fields.sessionType === 'manual') {
      winner = winner === undefined || winner === null ? (ranking.length > 0 ? ranking[0].userId : null) : winner;
      ok(
        winner === null || players.some((p) => p.userId === winner),
        'E_ARG',
        'winner must be one of the players',
      );
    } else {
      ok(
        winner === null || winner === undefined || players.some((p) => p.userId === winner),
        'E_ARG',
        'winner must be one of the players',
      );
      winner = winner || null;
    }

    const seed = fields.seed === undefined || fields.seed === null ? null : String(fields.seed);
    ok(seed === null || (seed.length >= 1 && seed.length <= 128), 'E_ARG', 'invalid seed');
    const matchRef = fields.matchRef === undefined || fields.matchRef === null ? null : String(fields.matchRef);
    ok(matchRef === null || matchRef.length <= 80, 'E_ARG', 'invalid match_ref');
    const clientRef = fields.clientRef === undefined || fields.clientRef === null ? null : String(fields.clientRef);
    ok(clientRef === null || (clientRef.length >= 1 && clientRef.length <= 80), 'E_ARG', 'invalid client_ref');
    const createdAt = fields.createdAt || nowIso();
    ok(/^\d{4}-\d{2}-\d{2}T/.test(createdAt), 'E_ARG', 'invalid createdAt');

    const record = {
      id: genId(),
      user_id: fields.userId,
      game_kind: fields.game_kind,
      session_type: fields.sessionType,
      match_ref: matchRef,
      client_ref: clientRef,
      seed,
      rule: fields.rule,
      players_json: canonicalJson(players),
      scores_json: canonicalJson(scores),
      ranking_json: canonicalJson(ranking),
      winner_user_id: winner,
      created_at: createdAt,
    };

    db.exec('BEGIN');
    try {
      const prevRow = db.prepare('SELECT hash FROM local_records ORDER BY seq DESC LIMIT 1').get();
      record.prev_hash = (prevRow && prevRow.hash) || GENESIS_HASH;
      record.hash = hashLocalRecord(record);
      db.prepare(
        `INSERT INTO local_records
           (id, user_id, game_kind, session_type, match_ref, client_ref, seed, rule,
            players_json, scores_json, ranking_json, winner_user_id, prev_hash, hash, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        record.id,
        record.user_id,
        record.game_kind,
        record.session_type,
        record.match_ref,
        record.client_ref,
        record.seed,
        record.rule,
        record.players_json,
        record.scores_json,
        record.ranking_json,
        record.winner_user_id,
        record.prev_hash,
        record.hash,
        record.created_at,
      );
      db.exec('COMMIT');
    } catch (err) {
      safeRollback(db);
      throw toDataError(err, 'E_LOCAL_RECORD', 'local record append failed');
    }
    return { idempotent: false, record: parseRecord(db.prepare('SELECT * FROM local_records WHERE id = ?').get(record.id)) };
  }

  function assertRealUsers(players) {
    for (const p of players) {
      if (isBot(p.userId)) continue;
      repos.getById(p.userId);
    }
  }

  function recordManual(input) {
    ok(input && typeof input === 'object', 'E_ARG', 'record input required');
    const userId = input.userId;
    ok(typeof userId === 'string' && userId.length > 0, 'E_ARG', 'userId required');
    repos.getById(userId);
    ok(input.gameKind && GAME_KINDS.includes(input.gameKind), 'E_ARG', 'invalid gameKind: ' + input.gameKind);
    const players = (input.players || []).map((p) => ({
      userId: p.userId || p.user_id,
      seat: p.seat,
      name: p.name === undefined ? null : p.name,
    }));
    assertRealUsers(players);
    const scores = (input.scores || []).map((s) => ({
      userId: s.userId || s.user_id,
      value: s.value,
    }));
    ok(players.some((p) => p.userId === userId), 'E_ARG', 'the recorder must be one of the players');
    const result = createRecord({
      userId,
      game_kind: input.gameKind,
      sessionType: 'manual',
      rule: input.rule || (input.gameKind === 'loto' ? 'high' : 'low'),
      players,
      scores,
      winner: input.winner === undefined ? null : input.winner,
      seed: input.seed || null,
      clientRef: input.clientRef || input.client_ref || null,
      createdAt: input.createdAt || null,
    });
    recordAudit(userId, 'local.record.manual', {
      record_id: result.record.id,
      game_kind: input.gameKind,
    });
    return result;
  }

  function importOffline(input) {
    ok(input && typeof input === 'object', 'E_ARG', 'import input required');
    const userId = input.userId;
    const gameKind = input.gameKind || input.game_kind;
    const matchId = input.matchId || input.match_id;
    ok(typeof userId === 'string' && userId.length > 0, 'E_ARG', 'userId required');
    ok(GAME_KINDS.includes(gameKind), 'E_ARG', 'invalid gameKind: ' + gameKind);
    ok(typeof matchId === 'string' && matchId.length > 0, 'E_ARG', 'matchId required');
    const engine = engines[gameKind];
    ok(engine, 'E_ARG', 'no engine wired for kind: ' + gameKind);
    const importer = OFFLINE_IMPORTERS[gameKind];
    const raw = db.prepare('SELECT * FROM ' + tableNameFor(gameKind) + ' WHERE id = ?').get(matchId);
    ok(raw, 'E_NO_MATCH', gameKind + ' match not found: ' + matchId);
    ok(raw.mode === 'offline', 'E_MATCH_ONLINE', 'only offline matches can be imported into local records');
    ok(raw.user_id === userId, 'E_FORBIDDEN', 'only the match owner can import it');
    const verify = importer.verify(engine, matchId);
    const projected = importer.project(engine, matchId);
    const result = createRecord({
      userId,
      game_kind: gameKind,
      sessionType: projected.sessionType,
      rule: projected.rule,
      players: projected.players,
      scores: projected.scores,
      winner: projected.winner,
      seed: projected.seed,
      matchRef: projected.matchId,
      clientRef: 'import:' + gameKind + ':' + projected.matchId,
      createdAt: input.createdAt || null,
    });
    recordAudit(userId, 'local.record.imported', {
      record_id: result.record.id,
      game_kind: gameKind,
      match_id: matchId,
      verified: verify && verify.ok === true,
    });
    return result;
  }

  function listSessions(options = {}) {
    const limit = Number.isSafeInteger(options.limit) ? Math.min(options.limit, 200) : 50;
    const offset = Number.isSafeInteger(options.offset) ? options.offset : 0;
    const where = [];
    const params = [];
    if (options.userId) {
      where.push('user_id = ?');
      params.push(String(options.userId));
    }
    if (options.gameKind) {
      ok(GAME_KINDS.includes(options.gameKind), 'E_ARG', 'invalid game_kind filter');
      where.push('game_kind = ?');
      params.push(options.gameKind);
    }
    if (options.sessionType) {
      ok(SESSION_TYPES.includes(options.sessionType), 'E_ARG', 'invalid session_type filter');
      where.push('session_type = ?');
      params.push(options.sessionType);
    }
    const sql =
      'SELECT * FROM local_records' +
      (where.length ? ' WHERE ' + where.join(' AND ') : '') +
      ' ORDER BY seq DESC LIMIT ? OFFSET ?';
    return db.prepare(sql).all(...params, limit, offset).map(parseRecord);
  }

  function getRecord(id) {
    const row = db.prepare('SELECT * FROM local_records WHERE id = ?').get(id);
    ok(row, 'E_NO_RECORD', 'local record not found: ' + id);
    return parseRecord(row);
  }

  function recordAudit(userId, action, detail) {
    try {
      repos.recordAudit({
        actorType: 'user',
        actorId: userId,
        action,
        targetType: 'local_record',
        targetId: detail.record_id || null,
        detail,
      });
    } catch (_) {
      // audit must never break local scoring
    }
  }

  return {
    createRecord,
    recordManual,
    importOffline,
    listSessions,
    getRecord,
    verifyChain: () => verifyLocalChain(db),
  };
}

function tableNameFor(gameKind) {
  if (gameKind === 'domino') return 'domino_matches';
  if (gameKind === 'loto') return 'loto_draws';
  if (gameKind === 'rami') return 'rami_games';
  throw new DataError('E_ARG', 'invalid game kind: ' + gameKind);
}

function verifyLocalChain(db) {
  const rows = db.prepare('SELECT * FROM local_records ORDER BY seq ASC').all();
  let prev = GENESIS_HASH;
  for (const row of rows) {
    if (row.prev_hash !== prev) {
      throw new DataError('E_TAMPER', 'local record chain broken at seq ' + row.seq + ': prev_hash mismatch');
    }
    const computed = hashLocalRecord(row);
    if (row.hash !== computed) {
      throw new DataError('E_TAMPER', 'local record hash mismatch at seq ' + row.seq);
    }
    let players;
    let scores;
    let ranking;
    try {
      players = JSON.parse(row.players_json);
      scores = JSON.parse(row.scores_json);
      ranking = JSON.parse(row.ranking_json);
    } catch (_) {
      throw new DataError('E_TAMPER', 'local record payloads are unreadable at seq ' + row.seq);
    }
    const derived = computeRanking(row.rule, players, scores);
    if (canonicalJson(derived) !== canonicalJson(ranking)) {
      throw new DataError('E_TAMPER', 'local record ranking does not match its scores at seq ' + row.seq);
    }
    prev = row.hash;
  }
  return { ok: true, records: rows.length, tail: prev };
}

module.exports = {
  buildLocalRecords,
  verifyLocalChain,
  hashLocalRecord,
  computeRanking,
  normalizePlayers,
  normalizeScores,
  SESSION_TYPES,
  RULES,
  GAME_KINDS,
  MAX_PLAYERS,
  SCORE_LIMIT,
};
