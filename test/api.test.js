// Needs a database: DATABASE_URL=postgres://... npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const run = process.env.DATABASE_URL ? test : test.skip;
let app, init, pool, srv, base, A, B;
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
  before(async () => { await init(); srv = app.listen(0); base = `http://127.0.0.1:${srv.address().port}/api`; A = await login(1); B = await login(2); });
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
