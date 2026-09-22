'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { makeDataLayer, makeUser, expectDataError } = require('./helpers');
const { computeRanking, hashLocalRecord } = require('../core/local-records');
const { openDataLayer } = require('../core/db');

function manualInput(user, overrides = {}) {
  return {
    userId: user.id,
    gameKind: 'domino',
    rule: 'low',
    players: [
      { userId: user.id, seat: 1, name: 'You' },
      { userId: 'bot:ana', seat: 2, name: 'Ana' },
      { userId: 'bot:hery', seat: 3, name: 'Hery' },
    ],
    scores: [
      { userId: user.id, value: 42 },
      { userId: 'bot:ana', value: 18 },
      { userId: 'bot:hery', value: 18 },
    ],
    ...overrides,
  };
}

test('manual records store a deterministic ranking and hash chain', (t) => {
  const { layer } = makeDataLayer(t);
  const u = makeUser(layer, 'manual_a');
  const first = layer.localRecords.recordManual(manualInput(u, { clientRef: 'session-1' }));
  assert.equal(first.idempotent, false);
  const rec = first.record;
  assert.equal(rec.session_type, 'manual');
  assert.equal(rec.winner_user_id, 'bot:ana', 'lowest tie is won by the lower seat');
  assert.deepEqual(
    rec.ranking.map((r) => [r.userId, r.rank]),
    [
      ['bot:ana', 1],
      ['bot:hery', 1],
      [u.id, 2],
    ],
  );
  const second = layer.localRecords.recordManual(manualInput(u, { clientRef: 'session-2' }));
  assert.equal(second.record.prev_hash, rec.hash, 'records are hash-linked');
  assert.equal(layer.localRecords.verifyChain().records, 2);
});

test('client_ref makes manual replay idempotent', (t) => {
  const { layer } = makeDataLayer(t);
  const u = makeUser(layer, 'manual_idem');
  const a = layer.localRecords.recordManual(manualInput(u, { clientRef: 'dup-1' }));
  const b = layer.localRecords.recordManual(manualInput(u, { clientRef: 'dup-1' }));
  assert.equal(b.idempotent, true);
  assert.equal(b.record.id, a.record.id);
  assert.equal(layer.localRecords.listSessions({ userId: u.id }).length, 1);
});

test('high rule ranks the biggest score first and derives the winner', (t) => {
  const { layer } = makeDataLayer(t);
  const u = makeUser(layer, 'manual_high');
  const input = manualInput(u, { gameKind: 'loto', rule: 'high', winner: undefined });
  input.players[1].name = 'Bola';
  const { record } = layer.localRecords.recordManual(input);
  assert.equal(record.ranking[0].userId, u.id);
  assert.equal(record.winner_user_id, u.id, 'manual winner defaults to rank one');
});

test('manual validation rejects bad rosters, scores and winners', (t) => {
  const { layer } = makeDataLayer(t);
  const u = makeUser(layer, 'manual_bad');
  expectDataError(
    () => layer.localRecords.recordManual(manualInput(u, { players: [{ userId: u.id, seat: 1 }] })),
    'E_ARG',
  );
  expectDataError(
    () =>
      layer.localRecords.recordManual(
        manualInput(u, { players: [{ userId: u.id, seat: 1 }, { userId: u.id, seat: 2 }] }),
      ),
    'E_ARG',
  );
  expectDataError(
    () =>
      layer.localRecords.recordManual(
        manualInput(u, { scores: [{ userId: 'ghost', value: 1 }] }),
      ),
    'E_ARG',
  );
  expectDataError(
    () => layer.localRecords.recordManual(manualInput(u, { winner: 'ghost' })),
    'E_ARG',
  );
  expectDataError(
    () => layer.localRecords.recordManual(manualInput(u, { gameKind: 'poker' })),
    'E_ARG',
  );
  expectDataError(
    () => layer.localRecords.recordManual(manualInput(u, { scores: [{ userId: u.id, value: 1 }] })),
    'E_ARG',
  );
});

test('local records are append-only at the database layer', (t) => {
  const { layer } = makeDataLayer(t);
  const u = makeUser(layer, 'manual_immutable');
  const { record } = layer.localRecords.recordManual(manualInput(u));
  assert.throws(
    () => layer.db.prepare('UPDATE local_records SET scores_json = ? WHERE id = ?').run('[]', record.id),
    /append-only/,
  );
  assert.throws(
    () => layer.db.prepare('DELETE FROM local_records WHERE id = ?').run(record.id),
    /append-only/,
  );
  assert.throws(
    () =>
      layer.db
        .prepare(
          `INSERT INTO local_records
             (id, user_id, game_kind, session_type, rule, players_json, scores_json,
              ranking_json, prev_hash, hash, created_at)
           VALUES ('x1', ?, 'domino', 'manual', 'low', '[]', '[]', '[]',
                   'genesis', 'bad', datetime('now'))`,
        )
        .run(u.id),
    /chain link invalid/,
  );
});

test('tampered local records are detected on reopen', (t) => {
  const { layer, dir } = makeDataLayer(t);
  const u = makeUser(layer, 'manual_tamper');
  const { record } = layer.localRecords.recordManual(manualInput(u));
  layer.close();
  const reopened = openDataLayer(dir, { verifyOnOpen: false });
  try {
    reopened.exec('DROP TRIGGER local_records_append_only_update');
    reopened
      .prepare('UPDATE local_records SET scores_json = ? WHERE id = ?')
      .run('[{"userId":"' + u.id + '","seat":1,"value":0}]', record.id);
    const { verifyLocalChain } = require('../core/local-records');
    expectDataError(() => verifyLocalChain(reopened), 'E_TAMPER');
  } finally {
    reopened.close();
  }
  assert.throws(() => openDataLayer(dir), (e) => e.code === 'E_TAMPER');
});

test('offline rami matches can be imported once into the local chain', (t) => {
  const { layer } = makeDataLayer(t);
  const u = makeUser(layer, 'import_owner');
  const m = layer.rami.createGame({ mode: 'offline', userId: u.id, settings: { seed: 'import-seed' } });
  expectDataError(() => layer.localRecords.importOffline({ userId: u.id, gameKind: 'rami', matchId: m.id }), 'E_GAME_OPEN');
  let game = layer.rami.startGame(m.id, { byUserId: u.id });
  const rules = require('../core/rami');
  let guard = 0;
  while (game.state.status === 'active' && guard < 800) {
    guard += 1;
    const st = game.state;
    const hand = st.hands[u.id] || [];
    if (st.turnPhase === 'draw') {
      game = layer.rami.applyAction(m.id, u.id, { type: 'draw', source: 'stock' });
      continue;
    }
    const melds = rules.findMelds(hand);
    if (melds.length > 0) {
      game = layer.rami.applyAction(m.id, u.id, { type: 'meld', melds: melds.map((md) => md.map(rules.cardKey)) });
      if (game.state.status !== 'active') break;
    }
    const remaining = game.state.hands[u.id] || hand;
    game = layer.rami.applyAction(m.id, u.id, { type: 'discard', card: remaining[remaining.length - 1] });
  }
  assert.equal(game.state.status, 'finished', 'offline game should terminate');
  const imported = layer.localRecords.importOffline({ userId: u.id, gameKind: 'rami', matchId: m.id });
  assert.equal(imported.idempotent, false);
  assert.equal(imported.record.session_type, 'offline');
  assert.equal(imported.record.match_ref, m.id);
  assert.equal(imported.record.seed, 'import-seed');
  const replay = layer.localRecords.importOffline({ userId: u.id, gameKind: 'rami', matchId: m.id });
  assert.equal(replay.idempotent, true);
  assert.equal(replay.record.id, imported.record.id);
  assert.equal(layer.localRecords.verifyChain().ok, true);
  expectDataError(
    () => layer.localRecords.importOffline({ userId: u.id, gameKind: 'rami', matchId: 'nope' }),
    'E_NO_MATCH',
  );
  const other = makeUser(layer, 'import_thief');
  expectDataError(
    () => layer.localRecords.importOffline({ userId: other.id, gameKind: 'rami', matchId: m.id }),
    'E_FORBIDDEN',
  );
});

test('computeRanking is a pure deterministic function', () => {
  const players = [
    { userId: 'a', seat: 1 },
    { userId: 'b', seat: 2 },
    { userId: 'c', seat: 3 },
  ];
  const scores = [
    { userId: 'a', seat: 1, value: 30 },
    { userId: 'b', seat: 2, value: 10 },
    { userId: 'c', seat: 3, value: 30 },
  ];
  assert.deepEqual(computeRanking('low', players, scores), [
    { userId: 'b', value: 10, rank: 1 },
    { userId: 'a', value: 30, rank: 2 },
    { userId: 'c', value: 30, rank: 2 },
  ]);
  assert.deepEqual(computeRanking('high', players, scores), [
    { userId: 'a', value: 30, rank: 1 },
    { userId: 'c', value: 30, rank: 1 },
    { userId: 'b', value: 10, rank: 2 },
  ]);
});

test('hashLocalRecord covers every signed field', () => {
  const base = {
    id: 'r1',
    user_id: 'u1',
    game_kind: 'domino',
    session_type: 'manual',
    match_ref: null,
    client_ref: null,
    seed: null,
    rule: 'low',
    players_json: '[]',
    scores_json: '[]',
    ranking_json: '[]',
    winner_user_id: null,
    prev_hash: 'genesis',
    created_at: '2026-01-01T00:00:00.000Z',
  };
  const h = hashLocalRecord(base);
  assert.equal(hashLocalRecord({ ...base }), h);
  assert.notEqual(hashLocalRecord({ ...base, rule: 'high' }), h);
  assert.notEqual(hashLocalRecord({ ...base, winner_user_id: 'u1' }), h);
  assert.notEqual(hashLocalRecord({ ...base, scores_json: '[1]' }), h);
});
