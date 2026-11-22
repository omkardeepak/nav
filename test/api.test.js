// Needs a database: DATABASE_URL=postgres://... npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const run = process.env.DATABASE_URL ? test : test.skip;
let app, init, pool, srv, base, A, B, M;
const call = async (p, o = {}, tok) => {
  const r = await fetch(base + p, { method: o.method || 'GET', headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: o.body ? JSON.stringify(o.body) : undefined });
  const raw = await r.text(); let json = {}; try { json = JSON.parse(raw); } catch {}
  return { status: r.status, raw, json };
};
const login = async id => (await call('/login', { method: 'POST', body: { agentId: id, password: 'frontdesk' } })).json.token;
const newTicket = async (priority = 'medium') => {
  const r = await call('/customer/tickets', { method: 'POST', body: { name: 'Cust', email: 'c@x.io', subject: 'S', body: 'Help', priority } });
  const id = (await pool.query('SELECT id FROM tickets WHERE token=$1', [r.json.token])).rows[0].id;
  return { token: r.json.token, id };
};
if (process.env.DATABASE_URL) {
  ({ app, init, pool } = require('../src/server'));
  before(async () => { await init(); srv = app.listen(0); base = `http://127.0.0.1:${srv.address().port}/api`; A = await login(1); B = await login(2); M = await login((await pool.query("SELECT id FROM agents WHERE role='manager'")).rows[0].id); });
  after(async () => { srv.close(); await pool.end(); });
}

run('INC-0291: two simultaneous claims -> exactly one wins, other gets 409', async () => {
  const { id } = await newTicket();
  const rs = await Promise.all([call(`/tickets/${id}/claim`, { method: 'POST' }, A), call(`/tickets/${id}/claim`, { method: 'POST' }, B)]);
  assert.deepEqual(rs.map(r => r.status).sort(), [200, 409]);
});
run('only the assigned agent can reply to the customer', async () => {
  const { id } = await newTicket();
  await call(`/tickets/${id}/claim`, { method: 'POST' }, A);
  assert.equal((await call(`/tickets/${id}/reply`, { method: 'POST', body: { body: 'hi' } }, B)).status, 403);
  assert.equal((await call(`/tickets/${id}/reply`, { method: 'POST', body: { body: 'hi' } }, A)).status, 200);
});
run('INC-0304: internal notes never appear on customer endpoints', async () => {
  const { id, token } = await newTicket();
  await call(`/tickets/${id}/claim`, { method: 'POST' }, A);
  await call(`/tickets/${id}/note`, { method: 'POST', body: { body: 'SECRET-NOTE-XYZ' } }, A);
  await call(`/tickets/${id}/reply`, { method: 'POST', body: { body: 'public reply' } }, A);
  const c = await call(`/customer/tickets/${token}`);
  assert.ok(c.raw.includes('public reply'));
  assert.ok(!c.raw.includes('SECRET-NOTE-XYZ'));
  assert.ok(!(await call('/customer/tickets', { method: 'POST', body: {} })).raw.includes('SECRET-NOTE-XYZ'));
  const agentView = await call(`/tickets/${id}`, {}, A);
  assert.ok(agentView.raw.includes('SECRET-NOTE-XYZ')); // agents do see it
});
run('internal note does not count as first response', async () => {
  const { id } = await newTicket();
  await call(`/tickets/${id}/claim`, { method: 'POST' }, A);
  await call(`/tickets/${id}/note`, { method: 'POST', body: { body: 'note' } }, A);
  assert.equal((await call(`/tickets/${id}`, {}, A)).json.ticket.first_response_at, null);
});
run('INC-0318: events cannot be updated or deleted', async () => {
  await assert.rejects(pool.query("UPDATE ticket_events SET type='x'"), /append-only/);
  await assert.rejects(pool.query('DELETE FROM ticket_events'), /append-only/);
  await assert.rejects(pool.query('TRUNCATE ticket_events'), /append-only/);
  await assert.rejects(pool.query("UPDATE messages SET body='x'"), /append-only/);
});
run('ask question -> paused/not late; customer reply -> resumes', async () => {
  const { id, token } = await newTicket('critical');
  await call(`/tickets/${id}/claim`, { method: 'POST' }, A);
  await call(`/tickets/${id}/reply`, { method: 'POST', body: { body: 'Which browser?', waitForCustomer: true } }, A);
  let t = (await call(`/tickets/${id}`, {}, A)).json.ticket;
  assert.equal(t.status, 'waiting'); assert.equal(t.late, false);
  await call(`/customer/tickets/${token}/reply`, { method: 'POST', body: { body: 'Chrome' } });
  t = (await call(`/tickets/${id}`, {}, A)).json.ticket;
  assert.equal(t.status, 'open');
});
run('priority change recomputes deadline from original start and is logged', async () => {
  const { id } = await newTicket('low');
  const before = (await call(`/tickets/${id}`, {}, A)).json.ticket;
  assert.equal((await call(`/tickets/${id}/priority`, { method: 'POST', body: { priority: 'critical' } }, A)).status, 200);
  const d = await call(`/tickets/${id}`, {}, A);
  assert.ok(new Date(d.json.ticket.reply_due) < new Date(before.reply_due));
  assert.ok(d.json.events.some(e => e.type === 'priority_change'));
});
run('reopen works inside the window, is refused after it', async () => {
  const { id, token } = await newTicket();
  await call(`/tickets/${id}/claim`, { method: 'POST' }, A);
  await call(`/tickets/${id}/resolve`, { method: 'POST' }, A);
  assert.equal((await call(`/customer/tickets/${token}/reopen`, { method: 'POST', body: { body: 'still broken' } })).status, 200);
  await call(`/tickets/${id}/resolve`, { method: 'POST' }, A);
  await pool.query("UPDATE tickets SET done_at = now() - interval '8 days' WHERE id=$1", [id]);
  assert.equal((await call(`/customer/tickets/${token}/reopen`, { method: 'POST', body: { body: 'again' } })).status, 410);
});
run('GET /healthz returns 200 and ok:true', async () => {
  const r = await fetch(`http://127.0.0.1:${srv.address().port}/healthz`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.deepEqual(body, { ok: true });
});

run('late report and holidays are for the support lead only', async () => {
  assert.equal((await call('/report/late', {}, A)).status, 403);
  assert.equal((await call('/report/late', {}, M)).status, 200);
  assert.equal((await call('/holidays', {}, A)).status, 403);
  assert.equal((await call('/holidays', {}, M)).status, 200);
  assert.equal((await call('/tickets', {}, M)).status, 200);
});
run('holiday change recalculates open tickets and is logged on the ticket', async () => {
  const { id } = await newTicket('low');
  const before = (await call(`/tickets/${id}`, {}, M)).json.ticket;
  const day = new Date(+new Date(before.resolve_due) + 330 * 60000).toISOString().slice(0, 10);
  assert.equal((await call('/holidays', { method: 'POST', body: { day, name: 'Test day' } }, A)).status, 403);
  assert.equal((await call('/holidays', { method: 'POST', body: { day: 'nope', name: 'x' } }, M)).status, 400);
  assert.equal((await call('/holidays', { method: 'POST', body: { day, name: 'Test day' } }, M)).status, 200);
  const after = (await call(`/tickets/${id}`, {}, M)).json;
  assert.ok(new Date(after.ticket.resolve_due) > new Date(before.resolve_due));
  assert.ok(after.events.some(e => e.type === 'deadline_recalculated' && e.actor_type === 'agent'));
  assert.equal((await call('/holidays/' + day, { method: 'DELETE' }, M)).status, 200);
  assert.equal(+new Date((await call(`/tickets/${id}`, {}, M)).json.ticket.resolve_due), +new Date(before.resolve_due));
});
run('each agent has their own password; wrong password refused; change works', async () => {
  assert.equal((await call('/login', { method: 'POST', body: { agentId: 5, password: 'wrong' } })).status, 401);
  const t5 = await login(5);
  assert.equal((await call('/me/password', { method: 'POST', body: { current: 'bad', password: 'newpass-123' } }, t5)).status, 401);
  assert.equal((await call('/me/password', { method: 'POST', body: { current: 'frontdesk', password: 'short' } }, t5)).status, 400);
  try {
    assert.equal((await call('/me/password', { method: 'POST', body: { current: 'frontdesk', password: 'newpass-123' } }, t5)).status, 200);
    assert.equal((await call('/login', { method: 'POST', body: { agentId: 5, password: 'frontdesk' } })).status, 401);
    assert.equal((await call('/login', { method: 'POST', body: { agentId: 5, password: 'newpass-123' } })).status, 200);
    assert.equal((await call('/login', { method: 'POST', body: { agentId: 6, password: 'newpass-123' } })).status, 401); // other agents unaffected
  } finally {
    await call('/me/password', { method: 'POST', body: { current: 'newpass-123', password: 'frontdesk' } }, t5);
  }
});
run('no session / expired session is refused', async () => {
  assert.equal((await call('/tickets')).status, 401);
  const tok = await login(7);
  await pool.query("UPDATE sessions SET created_at = now() - interval '13 hours' WHERE token=$1", [tok]);
  assert.equal((await call('/tickets', {}, tok)).status, 401);
});
run('too many wrong passwords -> 429', async () => {
  for (let i = 0; i < 10; i++) assert.equal((await call('/login', { method: 'POST', body: { agentId: 9, password: 'nope' } })).status, 401);
  assert.equal((await call('/login', { method: 'POST', body: { agentId: 9, password: 'nope' } })).status, 429);
});
run('new ticket after the reopen window is linked to the old one', async () => {
  const old = await newTicket();
  await call(`/tickets/${old.id}/claim`, { method: 'POST' }, A);
  await call(`/tickets/${old.id}/resolve`, { method: 'POST' }, A);
  const body = { name: 'Cust', email: 'c@x.io', subject: 'Again', body: 'back', priority: 'low' };
  assert.equal((await call('/customer/tickets', { method: 'POST', body: { ...body, previousToken: 'bogus' } })).status, 400);
  const open = await newTicket(); // still open -> cannot be used as "previous"
  assert.equal((await call('/customer/tickets', { method: 'POST', body: { ...body, previousToken: open.token } })).status, 400);
  const r = await call('/customer/tickets', { method: 'POST', body: { ...body, previousToken: old.token } });
  assert.equal(r.status, 200);
  const nid = (await pool.query('SELECT id FROM tickets WHERE token=$1', [r.json.token])).rows[0].id;
  assert.equal((await call(`/tickets/${nid}`, {}, A)).json.ticket.previous_ticket_id, old.id);
  assert.deepEqual((await call(`/tickets/${old.id}`, {}, A)).json.followUps, [nid]);
});
run('agent gets 403 on reset-password', async () => {
  assert.equal((await call('/agents/2/reset-password', { method: 'POST' }, A)).status, 403);
});
run('manager cannot reset another manager', async () => {
  const mgrId = (await pool.query("SELECT id FROM agents WHERE role='manager'")).rows[0].id;
  assert.equal((await call(`/agents/${mgrId}/reset-password`, { method: 'POST' }, M)).status, 403);
});
run('manager reset works; old password stops working while new signs in; password not in account_events', async () => {
  const tokBefore = await login(3);
  assert.ok(tokBefore);
  const res = await call('/agents/3/reset-password', { method: 'POST' }, M);
  assert.equal(res.status, 200);
  const newPass = res.json.password;
  assert.ok(newPass && newPass.length >= 12);

  // Old password fails
  assert.equal((await call('/login', { method: 'POST', body: { agentId: 3, password: 'frontdesk' } })).status, 401);

  // Old session invalidated
  assert.equal((await call('/tickets', {}, tokBefore)).status, 401);

  // New password logs in
  assert.equal((await call('/login', { method: 'POST', body: { agentId: 3, password: newPass } })).status, 200);

  // The new password does NOT appear in account_events
  const evs = (await pool.query('SELECT * FROM account_events WHERE agent_id=3')).rows;
  assert.ok(evs.length > 0);
  assert.equal(evs[0].type, 'password_reset');
  for (const row of evs) {
    for (const val of Object.values(row)) {
      assert.ok(!String(val).includes(newPass), 'Password must not appear in account_events');
    }
  }

  // Restore password
  await call('/agents/3/reset-password', { method: 'POST', body: { password: 'frontdesk' } }, M);
});
run('agent gets 403 on SLA endpoints', async () => {
  assert.equal((await call('/sla', {}, A)).status, 403);
  assert.equal((await call('/sla/medium', { method: 'PUT', body: { reply_min: 180, resolve_min: 1080 } }, A)).status, 403);
});
run('invalid SLA values get 400', async () => {
  assert.equal((await call('/sla/invalid-prio', { method: 'PUT', body: { reply_min: 180, resolve_min: 1080 } }, M)).status, 400);
  assert.equal((await call('/sla/medium', { method: 'PUT', body: { reply_min: 10, resolve_min: 1080 } }, M)).status, 400);
  assert.equal((await call('/sla/medium', { method: 'PUT', body: { reply_min: 5000, resolve_min: 6000 } }, M)).status, 400);
  assert.equal((await call('/sla/medium', { method: 'PUT', body: { reply_min: 'bad', resolve_min: 1080 } }, M)).status, 400);
  assert.equal((await call('/sla/medium', { method: 'PUT', body: { reply_min: 300, resolve_min: 200 } }, M)).status, 400);
  assert.equal((await call('/sla/medium', { method: 'PUT', body: { reply_min: 300, resolve_min: 20000 } }, M)).status, 400);
});
run('valid SLA change moves deadline of NEW ticket but not existing open ticket; change is in account_events', async () => {
  const oldT = await newTicket('medium');
  const oldDetails = (await call('/tickets/' + oldT.id, {}, A)).json.ticket;

  const putRes = await call('/sla/medium', { method: 'PUT', body: { reply_min: 180, resolve_min: 1080 } }, M);
  assert.equal(putRes.status, 200);

  const oldAfter = (await call('/tickets/' + oldT.id, {}, A)).json.ticket;
  assert.equal(+new Date(oldAfter.reply_due), +new Date(oldDetails.reply_due));
  assert.equal(+new Date(oldAfter.resolve_due), +new Date(oldDetails.resolve_due));

  const newT = await newTicket('medium');
  const newDetails = (await call('/tickets/' + newT.id, {}, A)).json.ticket;
  assert.ok(new Date(newDetails.reply_due) < new Date(oldDetails.reply_due));

  const evs = (await pool.query("SELECT * FROM account_events WHERE type='sla_change' ORDER BY id DESC")).rows;
  assert.ok(evs.length > 0);
  assert.equal(evs[0].detail.priority, 'medium');
  assert.equal(evs[0].detail.from.reply_min, 270);
  assert.equal(evs[0].detail.to.reply_min, 180);
  assert.equal(evs[0].actor_id, 10);

  // Restore policy
  await call('/sla/medium', { method: 'PUT', body: { reply_min: 270, resolve_min: 1620 } }, M);
});
run('database migrations: fresh database and upgraded old database', async () => {
  async function cleanDb() {
    await pool.query(`
      DROP TABLE IF EXISTS account_events CASCADE;
      DROP TABLE IF EXISTS internal_notes CASCADE;
      DROP TABLE IF EXISTS messages CASCADE;
      DROP TABLE IF EXISTS ticket_events CASCADE;
      DROP TABLE IF EXISTS tickets CASCADE;
      DROP TABLE IF EXISTS sessions CASCADE;
      DROP TABLE IF EXISTS agents CASCADE;
      DROP TABLE IF EXISTS holidays CASCADE;
      DROP TABLE IF EXISTS sla_policies CASCADE;
      DROP FUNCTION IF EXISTS forbid_change CASCADE;
    `);
  }

  // 1. Fresh database test
  await cleanDb();
  await init();

  const agentCols = (await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='agents'")).rows.map(r => r.column_name);
  assert.ok(agentCols.includes('role'), 'agents table has role column');
  assert.ok(agentCols.includes('password_hash'), 'agents table has password_hash column');

  const ticketCols = (await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='tickets'")).rows.map(r => r.column_name);
  assert.ok(ticketCols.includes('previous_ticket_id'), 'tickets table has previous_ticket_id column');

  const acctExists = (await pool.query("SELECT 1 FROM information_schema.tables WHERE table_name='account_events'")).rowCount;
  assert.equal(acctExists, 1, 'account_events table exists');

  await pool.query("INSERT INTO account_events(agent_id, type, actor_id, actor_name, created_at) VALUES(1, 'password_reset', 10, 'Meera', now())");
  await assert.rejects(
    pool.query("UPDATE account_events SET type='hacked'"),
    /account_events is append-only/,
    'account_events must reject UPDATE with append-only error'
  );

  // 2. Old database migration test
  await cleanDb();

  await pool.query(`
    CREATE TABLE agents (id SERIAL PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL);
    CREATE TABLE sessions (token TEXT PRIMARY KEY, agent_id INT NOT NULL REFERENCES agents(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE TABLE sla_policies (priority TEXT PRIMARY KEY, reply_min INT NOT NULL, resolve_min INT, label TEXT NOT NULL);
    CREATE TABLE holidays (day DATE PRIMARY KEY, name TEXT);
    CREATE TABLE tickets (
      id SERIAL PRIMARY KEY, token TEXT UNIQUE NOT NULL,
      customer_name TEXT NOT NULL, customer_email TEXT NOT NULL, subject TEXT NOT NULL,
      priority TEXT NOT NULL REFERENCES sla_policies(priority),
      status TEXT NOT NULL DEFAULT 'new', assignee_id INT REFERENCES agents(id),
      created_at TIMESTAMPTZ NOT NULL, sla_start TIMESTAMPTZ NOT NULL,
      first_response_at TIMESTAMPTZ, reply_due TIMESTAMPTZ NOT NULL, resolve_due TIMESTAMPTZ NOT NULL,
      paused_at TIMESTAMPTZ, paused_total_min INT NOT NULL DEFAULT 0, done_at TIMESTAMPTZ,
      reply_breached BOOLEAN NOT NULL DEFAULT false, resolve_breached BOOLEAN NOT NULL DEFAULT false
    );
    CREATE TABLE messages (id SERIAL PRIMARY KEY, ticket_id INT NOT NULL REFERENCES tickets(id), author_type TEXT NOT NULL, author_id INT REFERENCES agents(id), body TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL);
    CREATE TABLE internal_notes (id SERIAL PRIMARY KEY, ticket_id INT NOT NULL REFERENCES tickets(id), agent_id INT NOT NULL REFERENCES agents(id), body TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL);
    CREATE TABLE ticket_events (id BIGSERIAL PRIMARY KEY, ticket_id INT NOT NULL REFERENCES tickets(id), type TEXT NOT NULL, actor_type TEXT NOT NULL, actor_id INT, actor_name TEXT NOT NULL, detail JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL);
  `);

  await pool.query("INSERT INTO agents(name, email) VALUES('Asha', 'asha@arvo.example')");

  await init();

  const asha = (await pool.query("SELECT * FROM agents WHERE name='Asha'")).rows[0];
  assert.equal(asha.email, 'asha@arvo.example', 'old row preserved email');
  assert.equal(asha.role, 'agent', 'old row got default role=agent');
  assert.ok(asha.password_hash, 'old row got password_hash set by init');

  const colsAfter = (await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='tickets'")).rows.map(r => r.column_name);
  assert.ok(colsAfter.includes('previous_ticket_id'), 'previous_ticket_id was added by migration');

  const meera = (await pool.query("SELECT * FROM agents WHERE role='manager'")).rows[0];
  assert.ok(meera, 'Meera manager was seeded');
  assert.equal(meera.name, 'Meera');

  // Re-init clean state
  await cleanDb();
  await init();
});
