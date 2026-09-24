const { test } = require('node:test');
const assert = require('node:assert');
const { makeDataLayer, expectDataError } = require('./helpers');

function user(layer, name, role = 'player') {
  return layer.createUser({
    username: name,
    phone: '+261340' + String(name.length).padStart(6, '0'),
    email: name + '@example.mg',
    role,
  });
}

test('four app community groups support realtime-safe chat with idempotency and hash verification', (t) => {
  const { layer } = makeDataLayer(t);
  const alice = user(layer, 'alicechat');
  const bob = user(layer, 'bobchat');
  const groups = layer.community.listGroups();

  assert.deepEqual(groups.map((g) => g.group_key).sort(), ['dominomada', 'lotomada', 'ludomada', 'ramimada']);
  const first = layer.community.sendChatMessage({
    user_id: alice.id,
    group_key: 'ludomada',
    body: 'Bonjour la communauté',
    idempotency_key: 'chat-1',
  });
  const replay = layer.community.sendChatMessage({
    user_id: alice.id,
    group_key: 'ludomada',
    body: 'Bonjour la communauté',
    idempotency_key: 'chat-1',
  });
  assert.equal(first.idempotent, false);
  assert.equal(replay.idempotent, true);
  assert.equal(replay.message.id, first.message.id);
  const listed = layer.community.listChatMessages(bob.id, 'ludomada', 20);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].body, 'Bonjour la communauté');
  assert.deepEqual(layer.community.verify(), { ok: true });
});

test('support tickets belong to the client, while admin/support can read, reply and update status', (t) => {
  const { layer } = makeDataLayer(t);
  const client = user(layer, 'clientsupport');
  const other = user(layer, 'othersupport');
  const admin = user(layer, 'adminsupport', 'admin');

  const created = layer.community.createTicket({
    user_id: client.id,
    subject: 'Problème de paiement',
    body: 'Mon dépôt ne se termine pas.',
    idempotency_key: 'ticket-1',
  });
  assert.equal(created.ticket.status, 'open');
  assert.equal(created.messages.length, 1);

  const replay = layer.community.createTicket({
    user_id: client.id,
    subject: 'Problème de paiement',
    body: 'Mon dépôt ne se termine pas.',
    idempotency_key: 'ticket-1',
  });
  assert.equal(replay.idempotent, true);
  assert.equal(replay.ticket.id, created.ticket.id);

  expectDataError(() => layer.community.getTicket(other.id, created.ticket.id), 'E_FORBIDDEN');

  const all = layer.community.listTickets(admin.id);
  assert.ok(all.some((ticket) => ticket.id === created.ticket.id));

  const reply = layer.community.addTicketMessage({
    user_id: admin.id,
    ticket_id: created.ticket.id,
    body: 'Nous vérifions votre dossier.',
    idempotency_key: 'ticket-msg-1',
  });
  assert.equal(reply.message.sender_role, 'admin');

  const resolved = layer.community.setTicketStatus(admin.id, created.ticket.id, 'resolved');
  assert.equal(resolved.status, 'resolved');
  const thread = layer.community.listTicketMessages(client.id, created.ticket.id);
  assert.equal(thread.length, 2);
  assert.deepEqual(layer.community.verify(), { ok: true });
});
