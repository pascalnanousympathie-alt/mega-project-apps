'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const GENESIS_HASH = '0'.repeat(64);

class DataError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DataError';
    this.code = code;
  }
}

function ok(cond, code, message) {
  if (!cond) throw new DataError(code, message);
}

function nowIso() {
  return new Date().toISOString();
}

function genId() {
  return crypto.randomUUID();
}

function sha256hex(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function toDataError(err, code, message) {
  if (err instanceof DataError) return err;
  const msg = String(err && err.message ? err.message : err);
  if (msg.includes('UNIQUE constraint failed')) {
    return new DataError('E_DUPLICATE', message + ': ' + msg);
  }
  if (msg.includes('FOREIGN KEY constraint failed')) {
    return new DataError('E_REFERENCE', message + ': ' + msg);
  }
  if (msg.includes('CHECK constraint failed')) {
    return new DataError('E_CONSTRAINT', message + ': ' + msg);
  }
  return new DataError(code, message + ': ' + msg);
}

function safeRollback(db) {
  try {
    db.exec('ROLLBACK');
  } catch (_) {
    // no transaction is active
  }
}

function safeMeta(meta) {
  if (meta === undefined || meta === null) return '{}';
  if (typeof meta !== 'object' || Array.isArray(meta)) return '{}';
  try {
    const text = JSON.stringify(meta);
    return text === undefined ? '{}' : text;
  } catch (_) {
    return '{}';
  }
}

function parseRow(row) {
  if (!row) return null;
  const out = { ...row };
  if (typeof out.meta_json === 'string') {
    try { out.meta = JSON.parse(out.meta_json); } catch (_) { out.meta = {}; }
  }
  if (typeof out.detail_json === 'string') {
    try { out.detail = JSON.parse(out.detail_json); } catch (_) { out.detail = {}; }
  }
  if (typeof out.config_json === 'string') {
    try { out.config = JSON.parse(out.config_json); } catch (_) { out.config = {}; }
  }
  return out;
}

const SCHEMA_V1 = `
CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL COLLATE NOCASE UNIQUE,
  phone         TEXT,
  email         TEXT,
  display_name  TEXT,
  role          TEXT NOT NULL DEFAULT 'player' CHECK (role IN ('player','admin','support')),
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','blocked','disabled')),
  password_hash TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE wallets (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  currency      TEXT NOT NULL DEFAULT 'MGA' CHECK (currency = 'MGA'),
  balance_milli INTEGER NOT NULL DEFAULT 0 CHECK (balance_milli >= 0),
  version       INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','locked','closed')),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (user_id, currency)
);

CREATE TABLE ledger_entries (
  seq                  INTEGER PRIMARY KEY AUTOINCREMENT,
  id                   TEXT NOT NULL UNIQUE,
  wallet_id            TEXT NOT NULL REFERENCES wallets(id) ON DELETE RESTRICT,
  idempotency_key      TEXT NOT NULL,
  tx_type              TEXT NOT NULL CHECK (tx_type IN ('deposit','withdraw','transfer_in','transfer_out','entry_fee','prize','commission','refund','adjustment')),
  direction            TEXT NOT NULL CHECK (direction IN ('credit','debit')),
  amount_milli         INTEGER NOT NULL CHECK (amount_milli > 0),
  balance_before_milli INTEGER NOT NULL,
  balance_after_milli  INTEGER NOT NULL,
  status               TEXT NOT NULL DEFAULT 'committed' CHECK (status IN ('pending','committed','voided')),
  prev_hash            TEXT NOT NULL,
  hash                 TEXT NOT NULL UNIQUE,
  meta_json            TEXT NOT NULL DEFAULT '{}',
  created_at           TEXT NOT NULL
);
CREATE INDEX idx_ledger_wallet ON ledger_entries (wallet_id, seq);
CREATE UNIQUE INDEX idx_ledger_idem ON ledger_entries (wallet_id, idempotency_key);

CREATE TABLE games (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('domino','loto','rami')),
  status      TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','active','finished','cancelled')),
  config_json TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE rooms (
  id            TEXT PRIMARY KEY,
  game_id       TEXT NOT NULL REFERENCES games(id) ON DELETE RESTRICT,
  name          TEXT NOT NULL,
  host_user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  capacity      INTEGER NOT NULL DEFAULT 4 CHECK (capacity BETWEEN 1 AND 30),
  status        TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','active','closed')),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE room_players (
  room_id   TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  seat      INTEGER NOT NULL CHECK (seat BETWEEN 1 AND 30),
  joined_at TEXT NOT NULL,
  left_at   TEXT,
  PRIMARY KEY (room_id, user_id),
  UNIQUE (room_id, seat)
);

CREATE TABLE audit_entries (
  id          TEXT PRIMARY KEY,
  actor_type  TEXT NOT NULL CHECK (actor_type IN ('user','system')),
  actor_id    TEXT,
  action      TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id   TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}',
  ledger_hash TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_audit_target  ON audit_entries (target_type, target_id);
CREATE INDEX idx_audit_actor   ON audit_entries (actor_id);
CREATE INDEX idx_audit_created ON audit_entries (created_at);
`;

const SCHEMA_V2 = `
CREATE TABLE auth_sessions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,
  ip           TEXT,
  user_agent   TEXT,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  revoked_at   TEXT
);
CREATE INDEX idx_auth_sessions_user  ON auth_sessions (user_id);
CREATE INDEX idx_auth_sessions_token ON auth_sessions (token_hash);

CREATE TABLE service_credentials (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  key_hash     TEXT NOT NULL UNIQUE,
  scopes_json  TEXT NOT NULL DEFAULT '[]',
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  created_at   TEXT NOT NULL,
  revoked_at   TEXT,
  last_used_at TEXT
);
`;

const SCHEMA_V3 = `
CREATE TABLE domino_matches (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  room_id       TEXT REFERENCES rooms(id) ON DELETE SET NULL,
  mode          TEXT NOT NULL CHECK (mode IN ('online','offline')),
  status        TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','active','finished','cancelled')),
  settings_json TEXT NOT NULL DEFAULT '{}',
  seed          TEXT NOT NULL,
  state_json    TEXT NOT NULL DEFAULT '{}',
  state_hash    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  finished_at   TEXT
);

CREATE TABLE domino_moves (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id     TEXT NOT NULL REFERENCES domino_matches(id) ON DELETE CASCADE,
  move_index   INTEGER NOT NULL,
  user_id      TEXT NOT NULL,
  move_type    TEXT NOT NULL CHECK (move_type IN ('deal','join','start','draw','play','pass','win','block','leave','cancel')),
  tile_a       INTEGER,
  tile_b       INTEGER,
  side         TEXT CHECK (side IN ('left','right')),
  hash         TEXT NOT NULL,
  detail_json  TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL,
  UNIQUE (match_id, move_index)
);
CREATE INDEX idx_domino_moves_match ON domino_moves (match_id, move_index);
`;

const SCHEMA_V4 = `
CREATE TABLE loto_draws (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  room_id       TEXT REFERENCES rooms(id) ON DELETE SET NULL,
  mode          TEXT NOT NULL CHECK (mode IN ('online','offline','sim')),
  status        TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','active','finished','cancelled')),
  settings_json TEXT NOT NULL DEFAULT '{}',
  seed          TEXT NOT NULL,
  state_json    TEXT NOT NULL DEFAULT '{}',
  state_hash    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  finished_at   TEXT
);

CREATE TABLE loto_events (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  draw_id      TEXT NOT NULL REFERENCES loto_draws(id) ON DELETE CASCADE,
  event_index  INTEGER NOT NULL,
  user_id      TEXT NOT NULL,
  event_type   TEXT NOT NULL CHECK (event_type IN ('open','ticket','start','ball','settle','cancel')),
  ball         INTEGER,
  ticket_index INTEGER,
  ticket_hash  TEXT,
  hash         TEXT NOT NULL,
  detail_json  TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL,
  UNIQUE (draw_id, event_index)
);
CREATE INDEX idx_loto_events_draw ON loto_events (draw_id, event_index);
`;

const SCHEMA_V5 = `
CREATE TABLE rami_games (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  room_id       TEXT REFERENCES rooms(id) ON DELETE SET NULL,
  mode          TEXT NOT NULL CHECK (mode IN ('online','offline')),
  status        TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','active','finished','cancelled')),
  settings_json TEXT NOT NULL DEFAULT '{}',
  seed          TEXT NOT NULL,
  state_json    TEXT NOT NULL DEFAULT '{}',
  state_hash    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  finished_at   TEXT
);

CREATE TABLE rami_moves (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id     TEXT NOT NULL REFERENCES rami_games(id) ON DELETE CASCADE,
  move_index  INTEGER NOT NULL,
  user_id     TEXT NOT NULL,
  move_type   TEXT NOT NULL CHECK (move_type IN ('deal','join','start','draw','meld','discard','win','leave','cancel')),
  source      TEXT CHECK (source IN ('stock','discard')),
  card        TEXT,
  cards_json  TEXT NOT NULL DEFAULT '[]',
  hash        TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL,
  UNIQUE (game_id, move_index)
);
CREATE INDEX idx_rami_moves_game ON rami_moves (game_id, move_index);
`;

const SCHEMA_V6 = `
CREATE TABLE payment_intents (
  id              TEXT PRIMARY KEY,
  provider        TEXT NOT NULL,
  direction       TEXT NOT NULL DEFAULT 'payin' CHECK (direction IN ('payin','payout')),
  user_id         TEXT REFERENCES users(id) ON DELETE RESTRICT,
  wallet_id       TEXT REFERENCES wallets(id) ON DELETE RESTRICT,
  amount_milli    INTEGER NOT NULL CHECK (amount_milli > 0),
  currency        TEXT NOT NULL DEFAULT 'MGA' CHECK (currency IN ('MGA','USD','EUR','USDT')),
  status          TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created','pending','succeeded','failed','cancelled','expired')),
  provider_ref    TEXT,
  idempotency_key TEXT NOT NULL,
  customer_ref    TEXT,
  request_json    TEXT NOT NULL DEFAULT '{}',
  response_json   TEXT NOT NULL DEFAULT '{}',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (provider, idempotency_key)
);
CREATE INDEX idx_payment_intents_wallet ON payment_intents (wallet_id, created_at);
CREATE INDEX idx_payment_intents_status ON payment_intents (provider, status);

CREATE TABLE payment_events (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  intent_id    TEXT NOT NULL REFERENCES payment_intents(id) ON DELETE CASCADE,
  event_index  INTEGER NOT NULL,
  event_type   TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('created','pending','succeeded','failed','cancelled','expired')),
  provider_ref TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  prev_hash    TEXT NOT NULL,
  hash         TEXT NOT NULL UNIQUE,
  created_at   TEXT NOT NULL,
  UNIQUE (intent_id, event_index)
);
CREATE INDEX idx_payment_events_intent ON payment_events (intent_id, event_index);

CREATE TABLE payment_provider_config (
  provider    TEXT PRIMARY KEY,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  config_json TEXT NOT NULL DEFAULT '{}',
  updated_at  TEXT NOT NULL
);
`;

const SCHEMA_V7 = `
CREATE TABLE payment_callbacks (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  id           TEXT NOT NULL UNIQUE,
  intent_id    TEXT NOT NULL REFERENCES payment_intents(id) ON DELETE CASCADE,
  provider     TEXT NOT NULL,
  provider_ref TEXT,
  status       TEXT NOT NULL CHECK (status IN ('created','pending','succeeded','failed','cancelled','expired')),
  delivery_key TEXT NOT NULL,
  outcome      TEXT NOT NULL CHECK (outcome IN ('applied','no_change','rejected')),
  error_code   TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  prev_hash    TEXT NOT NULL,
  hash         TEXT NOT NULL UNIQUE,
  created_at   TEXT NOT NULL,
  UNIQUE (provider, delivery_key)
);
CREATE INDEX idx_payment_callbacks_intent ON payment_callbacks (intent_id, seq);

CREATE TABLE payment_reconciliations (
  seq           INTEGER PRIMARY KEY AUTOINCREMENT,
  id            TEXT NOT NULL UNIQUE,
  intent_id     TEXT NOT NULL REFERENCES payment_intents(id) ON DELETE CASCADE,
  provider      TEXT NOT NULL,
  attempt       INTEGER NOT NULL,
  status_before TEXT NOT NULL,
  status_after  TEXT NOT NULL,
  outcome       TEXT NOT NULL CHECK (outcome IN ('no_change','updated','conflict','error','expired')),
  provider_ref  TEXT,
  error         TEXT,
  created_at    TEXT NOT NULL,
  UNIQUE (intent_id, attempt)
);
CREATE INDEX idx_payment_recon_intent ON payment_reconciliations (intent_id, attempt);
`;

const SCHEMA_V8 = `
CREATE TABLE local_records (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT,
  id             TEXT NOT NULL UNIQUE,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  game_kind      TEXT NOT NULL CHECK (game_kind IN ('domino','loto','rami')),
  session_type   TEXT NOT NULL CHECK (session_type IN ('offline','manual')),
  match_ref      TEXT,
  client_ref     TEXT,
  seed           TEXT,
  rule           TEXT NOT NULL CHECK (rule IN ('high','low')),
  players_json   TEXT NOT NULL,
  scores_json    TEXT NOT NULL,
  ranking_json   TEXT NOT NULL,
  winner_user_id TEXT,
  prev_hash      TEXT NOT NULL,
  hash           TEXT NOT NULL UNIQUE,
  created_at     TEXT NOT NULL
);
CREATE INDEX idx_local_records_user ON local_records (user_id, seq);
CREATE UNIQUE INDEX idx_local_records_client_ref ON local_records (user_id, client_ref) WHERE client_ref IS NOT NULL;

CREATE TRIGGER local_records_append_only_update
BEFORE UPDATE ON local_records
BEGIN
  SELECT RAISE(ABORT, 'local_records is append-only');
END;

CREATE TRIGGER local_records_append_only_delete
BEFORE DELETE ON local_records
BEGIN
  SELECT RAISE(ABORT, 'local_records is append-only');
END;

CREATE TRIGGER local_records_chain_insert
BEFORE INSERT ON local_records
WHEN NEW.prev_hash <> COALESCE((SELECT hash FROM local_records ORDER BY seq DESC LIMIT 1), '${GENESIS_HASH}')
BEGIN
  SELECT RAISE(ABORT, 'local_records chain link invalid');
END;
`;

const MIGRATIONS = [SCHEMA_V1, SCHEMA_V2, SCHEMA_V3, SCHEMA_V4, SCHEMA_V5, SCHEMA_V6, SCHEMA_V7, SCHEMA_V8];

function migrate(db) {
  const has = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_meta'"
  ).get();
  let version = 0;
  if (has) {
    version = db.prepare('SELECT version FROM schema_meta').get().version;
  }
  for (let v = version; v < MIGRATIONS.length; v += 1) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(MIGRATIONS[v]);
      if (v === 0) {
        db.exec('CREATE TABLE schema_meta (version INTEGER NOT NULL)');
        db.exec('INSERT INTO schema_meta (version) VALUES (1)');
      } else {
        db.prepare('UPDATE schema_meta SET version = ?').run(v + 1);
      }
      db.exec('COMMIT');
    } catch (err) {
      safeRollback(db);
      throw err;
    }
  }
}

function openDataLayer(dataDir, options = {}) {
  const verifyOnOpen = options.verifyOnOpen !== false;
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, 'app.db');
  const db = new DatabaseSync(dbPath);
  // Set the busy timeout before WAL negotiation so concurrent real processes
  // opening the same store wait instead of failing during journal-mode setup.
  db.exec('PRAGMA busy_timeout = 15000');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA synchronous = FULL');
  migrate(db);
  if (verifyOnOpen) {
    const { verifyLedger } = require('./ledger');
    try {
      verifyLedger(db);
    } catch (err) {
      db.close();
      throw err;
    }
    const { verifyLocalChain } = require('./local-records');
    try {
      verifyLocalChain(db);
    } catch (err) {
      db.close();
      throw err;
    }
  }
  return db;
}

module.exports = {
  DataError,
  ok,
  nowIso,
  genId,
  sha256hex,
  safeRollback,
  safeMeta,
  parseRow,
  toDataError,
  GENESIS_HASH,
  openDataLayer,
};