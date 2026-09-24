'use strict';

const crypto = require('node:crypto');
const { DataError, ok, nowIso, genId, safeMeta, safeRollback, toDataError, GENESIS_HASH } = require('./db');

const GROUPS = Object.freeze([
  { key: 'ludomada', name: 'LudoMada', description: 'Communauté LudoMada' },
  { key: 'dominomada', name: 'DominoMada', description: 'Communauté DominoMada' },
  { key: 'lotomada', name: 'LotoMada', description: 'Communauté LotoMada' },
  { key: 'ramimada', name: 'RamiMada', description: 'Communauté RamiMada' },
]);
const GROUP_KEYS = new Set(GROUPS.map((g) => g.key));
const MESSAGE_MAX = 1000;
const SUBJECT_MAX = 120;

function normalizeText(value, max, label) {
  const text = String(value === undefined || value === null ? '' : value).replace(/\u0000/g, '').trim();
  ok(text.length >= 1, 'E_ARG', label + ' is required');
  ok(text.length <= max, 'E_ARG', label + ' is too long');
  return text;
}

function hashRow(prefix, values) {
  return crypto.createHash('sha256').update([prefix, ...values].join('\x1f')).digest('hex');
}

function buildCommunityService(deps = {}) {
  const db = deps.db;
  const repos = deps.repos;
  ok(db && repos, 'E_ARG', 'community service requires db and repos');

  function ensureGroups() {
    for (const group of GROUPS) {
      db.prepare(
        'INSERT OR IGNORE INTO chat_groups (id, group_key, name, description, created_at, updated_at) VALUES (?,?,?,?,?,?)',
      ).run(genId(), group.key, group.name, group.description, nowIso(), nowIso());
    }
  }
  ensureGroups();

  function groupRow(groupKey) {
    const key = String(groupKey || '').trim().toLowerCase();
    ok(GROUP_KEYS.has(key), 'E_CHAT_GROUP_INVALID', 'unknown community group: ' + key);
    const row = db.prepare('SELECT * FROM chat_groups WHERE group_key = ?').get(key);
    ok(row, 'E_CHAT_GROUP_NOT_FOUND', 'community group not found: ' + key);
    return row;
  }

  function userRow(userId) {
    const user = repos.getById(String(userId || ''));
    ok(user, 'E_NO_USER', 'user not found');
    ok(user.status === 'active', 'E_USER_INACTIVE', 'user is not active');
    return user;
  }

  function staff(user) {
    return user && (user.role === 'admin' || user.role === 'support');
  }

  function publicGroup(row) {
    return {
      id: row.id,
      group_key: row.group_key,
      name: row.name,
      description: row.description,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  function publicChatMessage(row) {
    return {
      id: row.id,
      group_key: row.group_key,
      user_id: row.user_id,
      username: row.username || null,
      display_name: row.display_name || row.username || null,
      body: row.body,
      created_at: row.created_at,
    };
  }

  function publicTicket(row) {
    return {
      id: row.id,
      user_id: row.user_id,
      username: row.username || null,
      subject: row.subject,
      status: row.status,
      created_at: row.created_at,
      updated_at: row.updated_at,
      message_count: Number(row.message_count || 0),
    };
  }

  function publicSupportMessage(row) {
    return {
      id: row.id,
      ticket_id: row.ticket_id,
      sender_user_id: row.sender_user_id,
      sender_role: row.sender_role,
      username: row.username || null,
      display_name: row.display_name || row.username || null,
      body: row.body,
      created_at: row.created_at,
    };
  }

  function listGroups() {
    return db.prepare('SELECT * FROM chat_groups ORDER BY id').all().map(publicGroup);
  }

  function listChatMessages(userId, groupKey, limit = 80) {
    userRow(userId);
    const group = groupRow(groupKey);
    const n = Number.isSafeInteger(limit) ? Math.min(Math.max(limit, 1), 200) : 80;
    const rows = db.prepare(
      'SELECT m.*, g.group_key, u.username, u.display_name FROM chat_messages m JOIN chat_groups g ON g.id = m.group_id JOIN users u ON u.id = m.user_id WHERE m.group_id = ? ORDER BY m.seq DESC LIMIT ?',
    ).all(group.id, n).reverse();
    return rows.map(publicChatMessage);
  }

  function sendChatMessage(input = {}) {
    const user = userRow(input.user_id);
    const group = groupRow(input.group_key);
    const body = normalizeText(input.body, MESSAGE_MAX, 'message');
    const key = normalizeText(input.idempotency_key, 128, 'Idempotency-Key');
    const old = db.prepare('SELECT * FROM chat_messages WHERE group_id = ? AND idempotency_key = ?').get(group.id, key);
    if (old) return { idempotent: true, message: publicChatMessage(db.prepare(
      'SELECT m.*, g.group_key, u.username, u.display_name FROM chat_messages m JOIN chat_groups g ON g.id=m.group_id JOIN users u ON u.id=m.user_id WHERE m.id=?',
    ).get(old.id)) };

    db.exec('BEGIN IMMEDIATE');
    try {
      const replay = db.prepare('SELECT * FROM chat_messages WHERE group_id = ? AND idempotency_key = ?').get(group.id, key);
      if (replay) {
        db.exec('COMMIT');
        return { idempotent: true, message: publicChatMessage(db.prepare(
          'SELECT m.*, g.group_key, u.username, u.display_name FROM chat_messages m JOIN chat_groups g ON g.id=m.group_id JOIN users u ON u.id=m.user_id WHERE m.id=?',
        ).get(replay.id)) };
      }
      const prev = db.prepare('SELECT hash FROM chat_messages WHERE group_id = ? ORDER BY seq DESC LIMIT 1').get(group.id);
      const ts = nowIso();
      const id = genId();
      const prevHash = (prev && prev.hash) || GENESIS_HASH;
      const hash = hashRow('chat-message', [id, group.id, user.id, key, body, prevHash, ts]);
      db.prepare(
        'INSERT INTO chat_messages (seq,id,group_id,user_id,idempotency_key,body,prev_hash,hash,created_at) VALUES (NULL,?,?,?,?,?,?,?,?)',
      ).run(id, group.id, user.id, key, body, prevHash, hash, ts);
      db.exec('COMMIT');
      try {
        repos.recordAudit({ actorType: 'user', actorId: user.id, action: 'chat.message.sent', targetType: 'chat_group', targetId: group.id, detail: { group_key: group.group_key } });
      } catch (_) {}
      const row = db.prepare(
        'SELECT m.*, g.group_key, u.username, u.display_name FROM chat_messages m JOIN chat_groups g ON g.id=m.group_id JOIN users u ON u.id=m.user_id WHERE m.id=?',
      ).get(id);
      return { idempotent: false, message: publicChatMessage(row) };
    } catch (err) {
      safeRollback(db);
      throw toDataError(err, 'E_CHAT_MESSAGE', 'chat message failed');
    }
  }

  function listTickets(userId) {
    const user = userRow(userId);
    const rows = staff(user)
      ? db.prepare(
        'SELECT t.*, u.username, (SELECT COUNT(*) FROM support_messages sm WHERE sm.ticket_id=t.id) AS message_count FROM support_tickets t JOIN users u ON u.id=t.user_id ORDER BY t.updated_at DESC LIMIT 200',
      ).all()
      : db.prepare(
        'SELECT t.*, u.username, (SELECT COUNT(*) FROM support_messages sm WHERE sm.ticket_id=t.id) AS message_count FROM support_tickets t JOIN users u ON u.id=t.user_id WHERE t.user_id=? ORDER BY t.updated_at DESC LIMIT 100',
      ).all(user.id);
    return rows.map(publicTicket);
  }

  function getTicket(userId, ticketId) {
    const user = userRow(userId);
    const row = db.prepare(
      'SELECT t.*, u.username, (SELECT COUNT(*) FROM support_messages sm WHERE sm.ticket_id=t.id) AS message_count FROM support_tickets t JOIN users u ON u.id=t.user_id WHERE t.id=?',
    ).get(String(ticketId || ''));
    ok(row, 'E_SUPPORT_TICKET_NOT_FOUND', 'support ticket not found');
    ok(staff(user) || row.user_id === user.id, 'E_FORBIDDEN', 'support ticket does not belong to this user');
    return publicTicket(row);
  }

  function listTicketMessages(userId, ticketId, limit = 200) {
    getTicket(userId, ticketId);
    const n = Number.isSafeInteger(limit) ? Math.min(Math.max(limit, 1), 300) : 200;
    return db.prepare(
      'SELECT sm.*, u.username, u.display_name FROM support_messages sm JOIN users u ON u.id=sm.sender_user_id WHERE sm.ticket_id=? ORDER BY sm.seq ASC LIMIT ?',
    ).all(String(ticketId), n).map((row) => publicSupportMessage({ ...row, sender_role: row.sender_role }));
  }

  function createTicket(input = {}) {
    const user = userRow(input.user_id);
    const subject = normalizeText(input.subject, SUBJECT_MAX, 'subject');
    const body = normalizeText(input.body, MESSAGE_MAX, 'message');
    const key = normalizeText(input.idempotency_key, 128, 'Idempotency-Key');
    const old = db.prepare('SELECT * FROM support_tickets WHERE user_id=? AND idempotency_key=?').get(user.id, key);
    if (old) return { idempotent: true, ticket: getTicket(user.id, old.id), messages: listTicketMessages(user.id, old.id) };

    db.exec('BEGIN IMMEDIATE');
    try {
      const replay = db.prepare('SELECT * FROM support_tickets WHERE user_id=? AND idempotency_key=?').get(user.id, key);
      if (replay) {
        db.exec('COMMIT');
        return { idempotent: true, ticket: getTicket(user.id, replay.id), messages: listTicketMessages(user.id, replay.id) };
      }
      const ts = nowIso();
      const ticketId = genId();
      db.prepare(
        'INSERT INTO support_tickets (id,user_id,idempotency_key,subject,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
      ).run(ticketId, user.id, key, subject, 'open', ts, ts);
      const messageId = genId();
      const hash = hashRow('support-message', [messageId, ticketId, user.id, user.role, key + ':initial', body, GENESIS_HASH, ts]);
      db.prepare(
        'INSERT INTO support_messages (seq,id,ticket_id,sender_user_id,sender_role,idempotency_key,body,prev_hash,hash,created_at) VALUES (NULL,?,?,?,?,?,?,?,?,?)',
      ).run(messageId, ticketId, user.id, user.role, key + ':initial', body, GENESIS_HASH, hash, ts);
      db.exec('COMMIT');
      try { repos.recordAudit({ actorType: 'user', actorId: user.id, action: 'support.ticket.created', targetType: 'support_ticket', targetId: ticketId, detail: { subject } }); } catch (_) {}
      return { idempotent: false, ticket: getTicket(user.id, ticketId), messages: listTicketMessages(user.id, ticketId) };
    } catch (err) {
      safeRollback(db);
      throw toDataError(err, 'E_SUPPORT_TICKET_CREATE', 'support ticket creation failed');
    }
  }

  function addTicketMessage(input = {}) {
    const user = userRow(input.user_id);
    const ticket = db.prepare('SELECT * FROM support_tickets WHERE id=?').get(String(input.ticket_id || ''));
    ok(ticket, 'E_SUPPORT_TICKET_NOT_FOUND', 'support ticket not found');
    ok(staff(user) || ticket.user_id === user.id, 'E_FORBIDDEN', 'support ticket does not belong to this user');
    ok(ticket.status !== 'closed', 'E_SUPPORT_TICKET_CLOSED', 'support ticket is closed');
    const body = normalizeText(input.body, MESSAGE_MAX, 'message');
    const key = normalizeText(input.idempotency_key, 128, 'Idempotency-Key');
    const old = db.prepare('SELECT * FROM support_messages WHERE ticket_id=? AND idempotency_key=?').get(ticket.id, key);
    if (old) return { idempotent: true, message: publicSupportMessage(db.prepare(
      'SELECT sm.*, u.username, u.display_name FROM support_messages sm JOIN users u ON u.id=sm.sender_user_id WHERE sm.id=?',
    ).get(old.id)) };

    db.exec('BEGIN IMMEDIATE');
    try {
      const replay = db.prepare('SELECT * FROM support_messages WHERE ticket_id=? AND idempotency_key=?').get(ticket.id, key);
      if (replay) {
        db.exec('COMMIT');
        return { idempotent: true, message: publicSupportMessage(db.prepare(
          'SELECT sm.*, u.username, u.display_name FROM support_messages sm JOIN users u ON u.id=sm.sender_user_id WHERE sm.id=?',
        ).get(replay.id)) };
      }
      const prev = db.prepare('SELECT hash FROM support_messages WHERE ticket_id=? ORDER BY seq DESC LIMIT 1').get(ticket.id);
      const ts = nowIso();
      const id = genId();
      const prevHash = (prev && prev.hash) || GENESIS_HASH;
      const hash = hashRow('support-message', [id, ticket.id, user.id, user.role, key, body, prevHash, ts]);
      db.prepare(
        'INSERT INTO support_messages (seq,id,ticket_id,sender_user_id,sender_role,idempotency_key,body,prev_hash,hash,created_at) VALUES (NULL,?,?,?,?,?,?,?,?,?)',
      ).run(id, ticket.id, user.id, user.role, key, body, prevHash, hash, ts);
      const nextStatus = staff(user) ? 'pending' : 'open';
      db.prepare('UPDATE support_tickets SET status=?, updated_at=? WHERE id=?').run(nextStatus, ts, ticket.id);
      db.exec('COMMIT');
      try { repos.recordAudit({ actorType: 'user', actorId: user.id, action: 'support.message.sent', targetType: 'support_ticket', targetId: ticket.id, detail: { role: user.role } }); } catch (_) {}
      const row = db.prepare('SELECT sm.*, u.username, u.display_name FROM support_messages sm JOIN users u ON u.id=sm.sender_user_id WHERE sm.id=?').get(id);
      return { idempotent: false, message: publicSupportMessage(row) };
    } catch (err) {
      safeRollback(db);
      throw toDataError(err, 'E_SUPPORT_MESSAGE', 'support message failed');
    }
  }

  function setTicketStatus(userId, ticketId, status) {
    const user = userRow(userId);
    ok(staff(user), 'E_FORBIDDEN', 'only support staff can change ticket status');
    const allowed = new Set(['open', 'pending', 'resolved', 'closed']);
    ok(allowed.has(status), 'E_ARG', 'invalid support ticket status');
    const row = db.prepare('SELECT * FROM support_tickets WHERE id=?').get(String(ticketId || ''));
    ok(row, 'E_SUPPORT_TICKET_NOT_FOUND', 'support ticket not found');
    const ts = nowIso();
    db.prepare('UPDATE support_tickets SET status=?, updated_at=? WHERE id=?').run(status, ts, row.id);
    try { repos.recordAudit({ actorType: 'user', actorId: user.id, action: 'support.ticket.status', targetType: 'support_ticket', targetId: row.id, detail: { status } }); } catch (_) {}
    return getTicket(user.id, row.id);
  }

  function verify() {
    for (const group of db.prepare('SELECT * FROM chat_groups ORDER BY id').all()) {
      let prev = GENESIS_HASH;
      const rows = db.prepare('SELECT * FROM chat_messages WHERE group_id=? ORDER BY seq ASC').all(group.id);
      for (const row of rows) {
        ok(row.prev_hash === prev, 'E_CHAT_CHAIN', 'chat chain broken at seq ' + row.seq);
        ok(hashRow('chat-message', [row.id, row.group_id, row.user_id, row.idempotency_key, row.body, row.prev_hash, row.created_at]) === row.hash, 'E_CHAT_HASH', 'chat hash mismatch at seq ' + row.seq);
        prev = row.hash;
      }
    }
    for (const ticket of db.prepare('SELECT * FROM support_tickets ORDER BY created_at ASC').all()) {
      let prev = GENESIS_HASH;
      const rows = db.prepare('SELECT * FROM support_messages WHERE ticket_id=? ORDER BY seq ASC').all(ticket.id);
      for (const row of rows) {
        ok(row.prev_hash === prev, 'E_SUPPORT_CHAIN', 'support chain broken at seq ' + row.seq);
        ok(hashRow('support-message', [row.id, row.ticket_id, row.sender_user_id, row.sender_role, row.idempotency_key, row.body, row.prev_hash, row.created_at]) === row.hash, 'E_SUPPORT_HASH', 'support hash mismatch at seq ' + row.seq);
        prev = row.hash;
      }
    }
    return { ok: true };
  }

  return {
    listGroups,
    listChatMessages,
    sendChatMessage,
    listTickets,
    getTicket,
    listTicketMessages,
    createTicket,
    addTicketMessage,
    setTicketStatus,
    verify,
    isStaff: (userId) => staff(userRow(userId)),
  };
}

module.exports = { buildCommunityService, GROUPS, GROUP_KEYS, MESSAGE_MAX, SUBJECT_MAX };
