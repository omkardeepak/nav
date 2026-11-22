const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const H = require('./hours');

const envPath = path.join(__dirname, '../.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const idx = trimmed.indexOf('=');
      if (idx !== -1) {
        const k = trimmed.slice(0, idx).trim();
        const v = trimmed.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
        if (process.env[k] === undefined) process.env[k] = v;
      }
    }
  }
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === '1' ? { rejectUnauthorized: false } : undefined,
});
const SYSTEM = { type: 'system', id: null, name: 'system' };
const REOPEN_DAYS = 7;      // calendar days after resolved / auto-closed
const AUTOCLOSE_DAYS = 5;   // working days of customer silence
const DONE = ['resolved', 'closed'];

// ---------- helpers ----------
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const wrap = fn => (req, res, next) => fn(req, res, next).catch(e =>
  e.status ? res.status(e.status).json({ error: e.message }) : (console.error(e), res.status(500).json({ error: 'Server error' })));
const text = (v, max = 5000) => { const s = String(v ?? '').trim(); if (!s) fail(400, 'Text is required'); return s.slice(0, max); };
const hashPassword = pw => { const salt = crypto.randomBytes(16); return salt.toString('hex') + ':' + crypto.scryptSync(pw, salt, 32).toString('hex'); };
const checkPassword = (pw, stored) => {
  if (!stored) return false;
  const [s, h] = stored.split(':'), x = crypto.scryptSync(pw, Buffer.from(s, 'hex'), 32), y = Buffer.from(h, 'hex');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const fails = new Map(); // login failures per agent+ip: 10 in 15 minutes -> 429
const tooMany = k => { const f = fails.get(k); return !!f && f.n >= 10 && Date.now() - f.t < 15 * 60000; };
const noteFail = k => { const f = fails.get(k); fails.set(k, f && Date.now() - f.t < 15 * 60000 ? { n: f.n + 1, t: f.t } : { n: 1, t: Date.now() }); };
async function tx(fn) {
  const c = await pool.connect();
  try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; }
  catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}
async function lock(c, where, val) {
  const r = await c.query(`SELECT * FROM tickets WHERE ${where}=$1 FOR UPDATE`, [val]);
  return r.rows[0] || fail(404, 'Ticket not found');
}
function canonicalJSON(val) {
  if (val === null || val === undefined) return 'null';
  if (typeof val.toJSON === 'function') return canonicalJSON(val.toJSON());
  if (typeof val !== 'object') return JSON.stringify(val);
  if (Array.isArray(val)) return '[' + val.map(canonicalJSON).join(',') + ']';
  const keys = Object.keys(val).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJSON(val[k])).join(',') + '}';
}

function computeEventHash(e) {
  const iso = e.created_at instanceof Date ? e.created_at.toISOString() : new Date(e.created_at).toISOString();
  const aid = (e.actor_id === null || e.actor_id === undefined) ? '' : String(e.actor_id);
  const str = [
    e.prev_hash,
    e.ticket_id,
    e.type,
    e.actor_type,
    aid,
    e.actor_name,
    canonicalJSON(e.detail),
    iso
  ].join('|');
  return crypto.createHash('sha256').update(str).digest('hex');
}

// Every event: server-side time, who did it, what happened. Table is append-only with cryptographic hash chain (INC-0318).
const ev = async (c, ticketId, type, actor, detail = {}, at = new Date()) => {
  const last = (await c.query('SELECT hash FROM ticket_events WHERE ticket_id=$1 ORDER BY id DESC LIMIT 1', [ticketId])).rows[0];
  const prev_hash = last ? last.hash : 'genesis';
  const hash = computeEventHash({
    prev_hash,
    ticket_id: ticketId,
    type,
    actor_type: actor.type,
    actor_id: actor.id,
    actor_name: actor.name,
    detail,
    created_at: at
  });
  return c.query(
    'INSERT INTO ticket_events(ticket_id,type,actor_type,actor_id,actor_name,detail,created_at,prev_hash,hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [ticketId, type, actor.type, actor.id, actor.name, detail, at, prev_hash, hash]
  );
};
const getHolidays = async c => new Set((await c.query("SELECT to_char(day,'YYYY-MM-DD') d FROM holidays")).rows.map(r => r.d));
const getPolicy = async (c, p) => (await c.query('SELECT * FROM sla_policies WHERE priority=$1', [p])).rows[0] || fail(400, 'Invalid priority');

// Deadlines are always derived from sla_start + policy + total paused working minutes.
function dues(p, start, pausedMin, hol) {
  const s = start.getTime();
  let reply = H.addBusinessMinutes(s, p.reply_min, hol);
  let res = p.resolve_min == null ? H.endOfWorkDay(s, hol) : H.addBusinessMinutes(s, p.resolve_min, hol);
  if (pausedMin) { reply = H.addBusinessMinutes(reply, pausedMin, hol); res = H.addBusinessMinutes(res, pausedMin, hol); }
  return { reply: new Date(reply), res: new Date(res) };
}

async function createTicket(c, { name, email, subject, body, priority, previousToken = null, now = new Date() }) {
  const hol = await getHolidays(c), d = dues(await getPolicy(c, priority), now, 0, hol);
  let prev = null;
  if (previousToken) {
    prev = (await c.query('SELECT id,status FROM tickets WHERE token=$1', [previousToken])).rows[0];
    if (!prev || !DONE.includes(prev.status)) fail(400, 'The earlier ticket must be resolved or closed');
  }
  const token = crypto.randomBytes(16).toString('hex');
  const t = (await c.query(
    'INSERT INTO tickets(token,customer_name,customer_email,subject,priority,created_at,sla_start,reply_due,resolve_due,previous_ticket_id) VALUES($1,$2,$3,$4,$5,$6,$6,$7,$8,$9) RETURNING *',
    [token, name, email, subject, priority, now, d.reply, d.res, prev ? prev.id : null])).rows[0];
  await c.query("INSERT INTO messages(ticket_id,author_type,body,created_at) VALUES($1,'customer',$2,$3)", [t.id, body, now]);
  await ev(c, t.id, 'created', { type: 'customer', id: null, name }, { priority, replyDue: d.reply, resolveDue: d.res, previousTicketId: prev ? prev.id : null }, now);
  return t;
}

// Record a breach once per SLA cycle, with how late it was when detected.
async function markBreaches(c, t, now, hol) {
  if (t.status === 'waiting' || DONE.includes(t.status)) return;
  for (const [kind, due, flag, applies] of [
    ['reply', t.reply_due, 'reply_breached', !t.first_response_at],
    ['resolve', t.resolve_due, 'resolve_breached', true]]) {
    if (t[flag] || !applies || now <= due) continue;
    await c.query(`UPDATE tickets SET ${flag}=true WHERE id=$1`, [t.id]);
    await ev(c, t.id, 'sla_breach', SYSTEM, {
      kind, priority: t.priority, due, detectedAt: now, assigneeId: t.assignee_id,
      lateWorkingMin: H.businessMinutesBetween(due.getTime(), now.getTime(), hol), pausedWorkingMin: t.paused_total_min,
    }, now);
  }
}

async function resume(c, t, now, hol, actor) {
  const mins = H.businessMinutesBetween(t.paused_at.getTime(), now.getTime(), hol);
  const total = t.paused_total_min + mins, d = dues(await getPolicy(c, t.priority), t.sla_start, total, hol);
  await c.query("UPDATE tickets SET status='open', paused_at=NULL, paused_total_min=$2, reply_due=$3, resolve_due=$4 WHERE id=$1", [t.id, total, d.reply, d.res]);
  await ev(c, t.id, 'resumed', actor, { pausedWorkingMin: mins, totalPausedWorkingMin: total, replyDue: d.reply, resolveDue: d.res }, now);
}

function view(t, now, hol) {
  const done = DONE.includes(t.status), paused = t.status === 'waiting';
  // Past the deadline must always be negative, even when no working minutes have passed since (e.g. due Friday 18:30, now Sunday).
  const left = due => now <= due ? H.businessMinutesBetween(now.getTime(), due.getTime(), hol) : -(H.businessMinutesBetween(due.getTime(), now.getTime(), hol) || 0.01);
  const replyLeft = !t.first_response_at && !done ? left(t.reply_due) : null;
  const resLeft = !done ? left(t.resolve_due) : null;
  const late = !paused && ((replyLeft !== null && replyLeft < 0) || (resLeft !== null && resLeft < 0));
  const nums = [replyLeft, resLeft].filter(x => x !== null);
  const dueSoon = !late && !paused && nums.length > 0 && Math.min(...nums) <= 120;
  const { token, customer_email, ...rest } = t;
  return { ...rest, paused, late, dueSoon, replyLeft, resLeft };
}

// ---------- background work: breach detection + auto-close ----------
async function sweep() {
  const hol = await getHolidays(pool), now = new Date();
  await pool.query("DELETE FROM sessions WHERE created_at < now() - interval '12 hours'");
  const ids = (await pool.query("SELECT id FROM tickets WHERE status IN ('new','open','waiting')")).rows;
  for (const { id } of ids) {
    try {
      await tx(async c => {
        const t = await lock(c, 'id', id);
        if (t.status === 'waiting') {
          if (H.businessMinutesBetween(t.paused_at.getTime(), now.getTime(), hol) >= AUTOCLOSE_DAYS * H.DAY_MIN) {
            await c.query("UPDATE tickets SET status='closed', done_at=$2 WHERE id=$1", [id, now]);
            await ev(c, id, 'auto_close', SYSTEM, { reason: `No customer reply for ${AUTOCLOSE_DAYS} working days` }, now);
          }
        } else if (!DONE.includes(t.status)) await markBreaches(c, t, now, hol);
      });
    } catch (e) { console.error('sweep', id, e.message); }
  }
}
let lastSweep = 0;
const maybeSweep = async () => { if (Date.now() - lastSweep > 20000) { lastSweep = Date.now(); await sweep(); } };

// ---------- app ----------
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, '../public')));

const healthzHandler = async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(503).json({ ok: false, error: 'Database unavailable' });
  }
};
app.get('/favicon.ico', (req, res) => res.status(204).end());
app.get('/healthz', healthzHandler);
app.get('/api/healthz', healthzHandler);

const auth = wrap(async (req, res, next) => {
  const tok = (req.headers.authorization || '').replace('Bearer ', '');
  const a = (await pool.query("SELECT a.id,a.name,a.role FROM sessions s JOIN agents a ON a.id=s.agent_id WHERE s.token=$1 AND s.created_at > now() - interval '12 hours'", [tok])).rows[0];
  if (!a) return res.status(401).json({ error: 'Please log in' });
  req.agent = a; req.token = tok; req.actor = { type: 'agent', id: a.id, name: a.name }; next();
});

const manager = (req, res, next) => req.agent.role === 'manager' ? next() : res.status(403).json({ error: 'Managers only' });
app.get('/api/agents', wrap(async (req, res) => res.json((await pool.query('SELECT id,name,role FROM agents ORDER BY id')).rows)));
app.post('/api/login', wrap(async (req, res) => {
  const id = +req.body.agentId, key = id + '|' + req.ip;
  if (tooMany(key)) fail(429, 'Too many failed attempts. Try again in 15 minutes.');
  const a = (await pool.query('SELECT id,name,role,password_hash FROM agents WHERE id=$1', [id])).rows[0];
  if (!a || !checkPassword(String(req.body.password ?? '').slice(0, 200), a.password_hash)) { noteFail(key); fail(401, 'Wrong agent or password'); }
  fails.delete(key);
  const token = crypto.randomBytes(24).toString('hex');
  await pool.query('INSERT INTO sessions(token,agent_id) VALUES($1,$2)', [token, a.id]);
  res.json({ token, agent: { id: a.id, name: a.name, role: a.role } });
}));
app.post('/api/me/password', auth, wrap(async (req, res) => {
  const cur = String(req.body.current ?? '').slice(0, 200), next = String(req.body.password ?? '');
  if (next.length < 8 || next.length > 200) fail(400, 'New password must be 8 to 200 characters');
  const a = (await pool.query('SELECT password_hash FROM agents WHERE id=$1', [req.agent.id])).rows[0];
  if (!checkPassword(cur, a.password_hash)) fail(401, 'Current password is wrong');
  await pool.query('UPDATE agents SET password_hash=$2 WHERE id=$1', [req.agent.id, hashPassword(next)]);
  await pool.query('DELETE FROM sessions WHERE agent_id=$1 AND token<>$2', [req.agent.id, req.token]);
  res.json({ ok: true });
}));
app.post('/api/agents/:id/reset-password', auth, manager, wrap(async (req, res) => {
  const id = +req.params.id;
  const target = (await pool.query('SELECT id, name, role FROM agents WHERE id=$1', [id])).rows[0];
  if (!target) fail(404, 'Agent not found');
  if (target.role === 'manager') fail(403, 'A manager cannot reset another manager');
  const pwd = (req.body && req.body.password) ? String(req.body.password) : crypto.randomBytes(9).toString('base64url');
  const now = new Date();
  await tx(async c => {
    await c.query('UPDATE agents SET password_hash=$2 WHERE id=$1', [id, hashPassword(pwd)]);
    await c.query('DELETE FROM sessions WHERE agent_id=$1', [id]);
    await c.query("INSERT INTO account_events(agent_id,type,actor_id,actor_name,created_at) VALUES($1,'password_reset',$2,$3,$4)", [id, req.agent.id, req.agent.name, now]);
  });
  res.json({ password: pwd });
}));

// ----- agent: list, detail -----
app.get('/api/tickets', auth, wrap(async (req, res) => {
  await maybeSweep();
  const now = new Date(), hol = await getHolidays(pool);
  const rows = (await pool.query('SELECT t.*, a.name assignee_name FROM tickets t LEFT JOIN agents a ON a.id=t.assignee_id ORDER BY t.id DESC LIMIT 500')).rows;
  res.json(rows.map(t => view(t, now, hol)));
}));

app.get('/api/tickets/:id', auth, wrap(async (req, res) => {
  const id = +req.params.id, now = new Date(), hol = await getHolidays(pool);
  const t = (await pool.query('SELECT t.*, a.name assignee_name FROM tickets t LEFT JOIN agents a ON a.id=t.assignee_id WHERE t.id=$1', [id])).rows[0] || fail(404, 'Ticket not found');
  const pub = (await pool.query("SELECT 'public' kind, m.author_type, COALESCE(a.name,$2) author, m.body, m.created_at FROM messages m LEFT JOIN agents a ON a.id=m.author_id WHERE m.ticket_id=$1", [id, t.customer_name])).rows;
  const notes = (await pool.query("SELECT 'internal' kind, 'agent' author_type, a.name author, n.body, n.created_at FROM internal_notes n JOIN agents a ON a.id=n.agent_id WHERE n.ticket_id=$1", [id])).rows;
  const events = (await pool.query('SELECT type,actor_type,actor_name,detail,created_at FROM ticket_events WHERE ticket_id=$1 ORDER BY id', [id])).rows;
  const followUps = (await pool.query('SELECT id FROM tickets WHERE previous_ticket_id=$1 ORDER BY id', [id])).rows.map(r => r.id);
  res.json({ ticket: view(t, now, hol), thread: [...pub, ...notes].sort((x, y) => x.created_at - y.created_at), events, followUps });
}));

app.get('/api/tickets/:id/verify', auth, wrap(async (req, res) => {
  const id = +req.params.id;
  const t = (await pool.query('SELECT id FROM tickets WHERE id=$1', [id])).rows[0] || fail(404, 'Ticket not found');
  const events = (await pool.query('SELECT * FROM ticket_events WHERE ticket_id=$1 ORDER BY id ASC', [id])).rows;
  let expectedPrev = 'genesis';
  for (const e of events) {
    if (e.prev_hash !== expectedPrev) {
      return res.json({ ok: false, brokenAtEventId: e.id });
    }
    const expectedHash = computeEventHash({
      prev_hash: e.prev_hash,
      ticket_id: e.ticket_id,
      type: e.type,
      actor_type: e.actor_type,
      actor_id: e.actor_id,
      actor_name: e.actor_name,
      detail: e.detail,
      created_at: e.created_at
    });
    if (e.hash !== expectedHash) {
      return res.json({ ok: false, brokenAtEventId: e.id });
    }
    expectedPrev = e.hash;
  }
  res.json({ ok: true, events: events.length });
}));

// ----- agent: actions -----
// INC-0291: one atomic UPDATE decides the winner; the loser gets 409.
app.post('/api/tickets/:id/claim', auth, wrap(async (req, res) => {
  const id = +req.params.id;
  await tx(async c => {
    const r = await c.query("UPDATE tickets SET assignee_id=$2, status='open' WHERE id=$1 AND assignee_id IS NULL AND status IN ('new','open') RETURNING id", [id, req.agent.id]);
    if (!r.rowCount) {
      const o = (await c.query('SELECT a.name FROM tickets t LEFT JOIN agents a ON a.id=t.assignee_id WHERE t.id=$1', [id])).rows[0];
      fail(409, o && o.name ? `Already taken by ${o.name}` : 'This ticket cannot be taken');
    }
    await ev(c, id, 'claimed', req.actor);
  });
  res.json({ ok: true });
}));

// Reply to customer. Only the assigned agent. Optionally ask a question and wait (pauses the SLA clock).
app.post('/api/tickets/:id/reply', auth, wrap(async (req, res) => {
  const body = text(req.body.body), wait = !!req.body.waitForCustomer;
  await tx(async c => {
    const t = await lock(c, 'id', +req.params.id), now = new Date(), hol = await getHolidays(c);
    if (t.assignee_id !== req.agent.id) fail(403, 'Only the agent who took this ticket can reply to the customer');
    if (!['open', 'waiting'].includes(t.status)) fail(409, `Ticket is ${t.status}`);
    await markBreaches(c, t, now, hol);
    await c.query("INSERT INTO messages(ticket_id,author_type,author_id,body,created_at) VALUES($1,'agent',$2,$3,$4)", [t.id, req.agent.id, body, now]);
    await ev(c, t.id, 'agent_reply', req.actor, {}, now);
    if (!t.first_response_at) {
      await c.query('UPDATE tickets SET first_response_at=$2 WHERE id=$1', [t.id, now]);
      await ev(c, t.id, 'first_response', req.actor, { dueWas: t.reply_due }, now);
    }
    if (wait && t.status === 'open') {
      await c.query("UPDATE tickets SET status='waiting', paused_at=$2 WHERE id=$1", [t.id, now]);
      await ev(c, t.id, 'paused', req.actor, { reason: 'waiting on customer' }, now);
    }
  });
  res.json({ ok: true });
}));

// Internal note: never touches messages, first_response_at or the SLA.
app.post('/api/tickets/:id/note', auth, wrap(async (req, res) => {
  const body = text(req.body.body), id = +req.params.id, now = new Date();
  await tx(async c => {
    await lock(c, 'id', id);
    const n = (await c.query('INSERT INTO internal_notes(ticket_id,agent_id,body,created_at) VALUES($1,$2,$3,$4) RETURNING id', [id, req.agent.id, body, now])).rows[0];
    await ev(c, id, 'internal_note', req.actor, { noteId: n.id }, now);
  });
  res.json({ ok: true });
}));

app.post('/api/tickets/:id/resolve', auth, wrap(async (req, res) => {
  await tx(async c => {
    const t = await lock(c, 'id', +req.params.id), now = new Date(), hol = await getHolidays(c);
    if (t.assignee_id !== req.agent.id) fail(403, 'Only the assigned agent can resolve this ticket');
    if (!['open', 'waiting'].includes(t.status)) fail(409, `Ticket is ${t.status}`);
    await markBreaches(c, t, now, hol);
    await c.query("UPDATE tickets SET status='resolved', done_at=$2, paused_at=NULL WHERE id=$1", [t.id, now]);
    await ev(c, t.id, 'resolved', req.actor, {}, now);
  });
  res.json({ ok: true });
}));

// Decision: priority change recomputes deadlines from the ORIGINAL sla_start (no clock reset), keeping paused time.
app.post('/api/tickets/:id/priority', auth, wrap(async (req, res) => {
  await tx(async c => {
    const t = await lock(c, 'id', +req.params.id), now = new Date(), hol = await getHolidays(c);
    if (DONE.includes(t.status)) fail(409, `Ticket is ${t.status}`);
    if (req.body.priority === t.priority) fail(400, 'Priority is unchanged');
    await markBreaches(c, t, now, hol);
    const d = dues(await getPolicy(c, req.body.priority), t.sla_start, t.paused_total_min, hol);
    await c.query('UPDATE tickets SET priority=$2, reply_due=$3, resolve_due=$4 WHERE id=$1', [t.id, req.body.priority, d.reply, d.res]);
    await ev(c, t.id, 'priority_change', req.actor, { from: t.priority, to: req.body.priority, oldReplyDue: t.reply_due, oldResolveDue: t.resolve_due, replyDue: d.reply, resolveDue: d.res }, now);
  });
  res.json({ ok: true });
}));

// ----- manager: late-ticket report (built from the immutable event log) -----
app.get('/api/report/late', auth, manager, wrap(async (req, res) => {
  await maybeSweep();
  const rows = (await pool.query(`SELECT e.created_at, e.detail, t.id ticket_id, t.subject, t.priority, a.name assignee,
      EXISTS(SELECT 1 FROM ticket_events x WHERE x.ticket_id=t.id AND x.type='priority_change') priority_changed
    FROM ticket_events e JOIN tickets t ON t.id=e.ticket_id LEFT JOIN agents a ON a.id=t.assignee_id
    WHERE e.type='sla_breach' ORDER BY e.created_at DESC`)).rows;
  res.json(rows.map(r => {
    const d = r.detail, why = [];
    if (!d.assigneeId) why.push('nobody had taken the ticket');
    else if (d.kind === 'reply') why.push('assigned agent had not replied');
    if (d.pausedWorkingMin) why.push(`${d.pausedWorkingMin} min waiting on customer were already excluded`);
    if (r.priority_changed) why.push('priority was changed during the ticket');
    return { ticketId: r.ticket_id, subject: r.subject, priority: d.priority, kind: d.kind === 'reply' ? 'First reply' : 'Resolution',
      due: d.due, detectedAt: r.created_at, lateWorkingMin: d.lateWorkingMin, assignee: r.assignee, why: why.join('; ') || 'deadline passed' };
  }));
}));

// ----- manager: holidays. Changing them recalculates open tickets' deadlines; each change is logged on the ticket. -----
async function recalcOpenTickets(c, actor, reason) {
  const hol = await getHolidays(c), now = new Date(), pol = {};
  const rows = (await c.query("SELECT * FROM tickets WHERE status IN ('new','open','waiting') ORDER BY id FOR UPDATE")).rows;
  for (const t of rows) {
    pol[t.priority] = pol[t.priority] || await getPolicy(c, t.priority);
    const d = dues(pol[t.priority], t.sla_start, t.paused_total_min, hol);
    if (+d.reply === +t.reply_due && +d.res === +t.resolve_due) continue;
    await c.query('UPDATE tickets SET reply_due=$2, resolve_due=$3 WHERE id=$1', [t.id, d.reply, d.res]);
    await ev(c, t.id, 'deadline_recalculated', actor, { reason, oldReplyDue: t.reply_due, oldResolveDue: t.resolve_due, replyDue: d.reply, resolveDue: d.res }, now);
  }
}
app.get('/api/holidays', auth, manager, wrap(async (req, res) =>
  res.json((await pool.query("SELECT to_char(day,'YYYY-MM-DD') AS day, name FROM holidays ORDER BY day")).rows)));
app.post('/api/holidays', auth, manager, wrap(async (req, res) => {
  const day = String(req.body.day || ''), name = text(req.body.name, 100);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || new Date(day + 'T00:00:00Z').toISOString().slice(0, 10) !== day) fail(400, 'Date must be YYYY-MM-DD');
  await tx(async c => {
    await c.query('INSERT INTO holidays(day,name) VALUES($1,$2) ON CONFLICT (day) DO UPDATE SET name=$2', [day, name]);
    await recalcOpenTickets(c, req.actor, `holiday added: ${day} ${name}`);
  });
  res.json({ ok: true });
}));
app.delete('/api/holidays/:day', auth, manager, wrap(async (req, res) => {
  await tx(async c => {
    const r = await c.query('DELETE FROM holidays WHERE day=$1', [req.params.day]);
    if (!r.rowCount) fail(404, 'Holiday not found');
    await recalcOpenTickets(c, req.actor, `holiday removed: ${req.params.day}`);
  });
  res.json({ ok: true });
}));

// ----- manager: SLA targets. Changes apply only to new/reopened tickets. -----
app.get('/api/sla', auth, manager, wrap(async (req, res) =>
  res.json((await pool.query("SELECT priority, reply_min, resolve_min, label FROM sla_policies ORDER BY CASE priority WHEN 'critical' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END")).rows)));

app.put('/api/sla/:priority', auth, manager, wrap(async (req, res) => {
  const prio = req.params.priority;
  if (!['critical', 'medium', 'low'].includes(prio)) fail(400, 'Invalid priority');
  const { reply_min, resolve_min } = req.body || {};
  if (typeof reply_min !== 'number' || !Number.isInteger(reply_min) || reply_min < 15 || reply_min > 4320)
    fail(400, 'reply_min must be an integer between 15 and 4320');
  if (resolve_min !== null && (typeof resolve_min !== 'number' || !Number.isInteger(resolve_min) || resolve_min < reply_min || resolve_min > 14400))
    fail(400, 'resolve_min must be null or an integer between reply_min and 14400');

  const now = new Date();
  await tx(async c => {
    const old = (await c.query('SELECT reply_min, resolve_min FROM sla_policies WHERE priority=$1', [prio])).rows[0];
    if (!old) fail(400, 'Priority not found');
    await c.query('UPDATE sla_policies SET reply_min=$2, resolve_min=$3 WHERE priority=$1', [prio, reply_min, resolve_min]);
    await c.query(
      "INSERT INTO account_events(type, actor_id, actor_name, detail, created_at) VALUES('sla_change', $1, $2, $3, $4)",
      [
        req.agent.id,
        req.agent.name,
        JSON.stringify({ priority: prio, from: { reply_min: old.reply_min, resolve_min: old.resolve_min }, to: { reply_min, resolve_min } }),
        now
      ]
    );
  });
  res.json({ ok: true });
}));

// ----- customer (no login; the ticket token is the credential). Only SELECTs the messages table. -----
app.post('/api/customer/tickets', wrap(async (req, res) => {
  const t = await tx(c => createTicket(c, { name: text(req.body.name, 100), email: text(req.body.email, 200), subject: text(req.body.subject, 200), body: text(req.body.body), priority: String(req.body.priority), previousToken: req.body.previousToken ? String(req.body.previousToken) : null }));
  res.json({ token: t.token });
}));

app.get('/api/customer/tickets/:token', wrap(async (req, res) => {
  const t = (await pool.query('SELECT id,subject,status,priority,created_at,done_at,customer_name,customer_email FROM tickets WHERE token=$1', [req.params.token])).rows[0] || fail(404, 'Not found');
  const messages = (await pool.query("SELECT author_type, CASE WHEN author_type='agent' THEN 'Arvo Support' ELSE $2 END author, body, created_at FROM messages WHERE ticket_id=$1 ORDER BY id", [t.id, t.customer_name])).rows;
  const until = DONE.includes(t.status) && t.done_at ? new Date(+t.done_at + REOPEN_DAYS * 864e5) : null;
  res.json({ ticket: { id: t.id, subject: t.subject, status: t.status, customerName: t.customer_name, customerEmail: t.customer_email, created_at: t.created_at, canReopen: !!until && new Date() <= until, reopenUntil: until }, messages });
}));

app.post('/api/customer/tickets/:token/reply', wrap(async (req, res) => {
  const body = text(req.body.body);
  await tx(async c => {
    const t = await lock(c, 'token', req.params.token), now = new Date(), hol = await getHolidays(c), actor = { type: 'customer', id: null, name: t.customer_name };
    if (DONE.includes(t.status)) fail(409, 'This ticket is closed. Reopen it or create a new ticket.');
    await c.query("INSERT INTO messages(ticket_id,author_type,body,created_at) VALUES($1,'customer',$2,$3)", [t.id, body, now]);
    await ev(c, t.id, 'customer_reply', actor, {}, now);
    if (t.status === 'waiting') await resume(c, t, now, hol, actor);
  });
  res.json({ ok: true });
}));

// Reopen: only within 7 calendar days of resolved/auto-closed. SLA restarts from now.
app.post('/api/customer/tickets/:token/reopen', wrap(async (req, res) => {
  const body = text(req.body.body);
  await tx(async c => {
    const t = await lock(c, 'token', req.params.token), now = new Date(), hol = await getHolidays(c), actor = { type: 'customer', id: null, name: t.customer_name };
    if (!DONE.includes(t.status)) fail(409, 'Ticket is not closed');
    if (now > new Date(+t.done_at + REOPEN_DAYS * 864e5)) fail(410, `The ${REOPEN_DAYS}-day reopen window has ended. Please create a new ticket.`);
    const d = dues(await getPolicy(c, t.priority), now, 0, hol);
    await c.query(`UPDATE tickets SET status='open', done_at=NULL, paused_at=NULL, paused_total_min=0, sla_start=$2, first_response_at=NULL,
      reply_due=$3, resolve_due=$4, reply_breached=false, resolve_breached=false WHERE id=$1`, [t.id, now, d.reply, d.res]);
    await c.query("INSERT INTO messages(ticket_id,author_type,body,created_at) VALUES($1,'customer',$2,$3)", [t.id, body, now]);
    await ev(c, t.id, 'reopened', actor, { previousStatus: t.status, replyDue: d.reply, resolveDue: d.res }, now);
  });
  res.json({ ok: true });
}));

async function backfillHashes() {
  const ticketsWithNullHashes = (await pool.query('SELECT DISTINCT ticket_id FROM ticket_events WHERE hash IS NULL')).rows;
  for (const { ticket_id } of ticketsWithNullHashes) {
    await tx(async c => {
      await lock(c, 'id', ticket_id);
      const events = (await c.query('SELECT * FROM ticket_events WHERE ticket_id=$1 ORDER BY id ASC', [ticket_id])).rows;
      let prev_hash = 'genesis';
      for (const e of events) {
        if (e.hash) {
          prev_hash = e.hash;
          continue;
        }
        const hash = computeEventHash({
          prev_hash,
          ticket_id: e.ticket_id,
          type: e.type,
          actor_type: e.actor_type,
          actor_id: e.actor_id,
          actor_name: e.actor_name,
          detail: e.detail,
          created_at: e.created_at
        });
        await c.query('UPDATE ticket_events SET prev_hash=$1, hash=$2 WHERE id=$3', [prev_hash, hash, e.id]);
        prev_hash = hash;
      }
    });
  }
}

// ---------- startup: schema, reference data, sample tickets ----------
async function init() {
  await pool.query(fs.readFileSync(path.join(__dirname, '../schema.sql'), 'utf8'));
  await backfillHashes();
  await pool.query(`INSERT INTO sla_policies(priority,reply_min,resolve_min,label) VALUES
    ('critical',120,NULL,'Cannot work at all'),('medium',270,1620,'Medium'),('low',540,2700,'Question / small request') ON CONFLICT DO NOTHING`);
  await pool.query(`INSERT INTO holidays(day,name) VALUES ('2026-12-25','Christmas'),('2027-01-26','Republic Day'),('2027-08-15','Independence Day') ON CONFLICT DO NOTHING`);
  if (!(await pool.query('SELECT 1 FROM agents LIMIT 1')).rowCount)
    for (const n of ['Asha', 'Bilal', 'Chitra', 'Dev', 'Esha', 'Farid', 'Gita', 'Hari', 'Isha'])
      await pool.query('INSERT INTO agents(name,email) VALUES($1,$2)', [n, n.toLowerCase() + '@arvo.example']);
  if (!(await pool.query("SELECT 1 FROM agents WHERE role='manager'")).rowCount)
    await pool.query("INSERT INTO agents(name,email,role) VALUES('Meera','meera@arvo.example','manager') ON CONFLICT DO NOTHING");
  // every account gets its own salted hash of the initial password (AGENT_PASSWORD, default 'frontdesk'); each person can change theirs
  for (const r of (await pool.query('SELECT id FROM agents WHERE password_hash IS NULL')).rows)
    await pool.query('UPDATE agents SET password_hash=$2 WHERE id=$1', [r.id, hashPassword(process.env.AGENT_PASSWORD || 'frontdesk')]);
  if (process.env.SEED_SAMPLE !== '0' && !(await pool.query('SELECT 1 FROM tickets LIMIT 1')).rowCount) await seedSamples();
}

async function seedSamples() {
  const DAY = 864e5, now = Date.now(), links = [];
  await tx(async c => {
    const ag = id => ({ type: 'agent', id, name: ['', 'Asha', 'Bilal'][id] });
    // 1. Late: critical, created 3 days ago, nobody took it
    const a = await createTicket(c, { name: 'Ravi Menon', email: 'ravi@example.com', subject: 'Whole team cannot log in', body: 'Nobody on my team can sign in since this morning.', priority: 'critical', now: new Date(now - 3 * DAY) });
    // 2. Waiting on customer: agent asked a question yesterday
    const b = await createTicket(c, { name: 'Sara Joseph', email: 'sara@example.com', subject: 'Invoice shows wrong tax', body: 'The tax on invoice 4471 looks wrong.', priority: 'medium', now: new Date(now - 2 * DAY) });
    const at = new Date(now - DAY);
    await c.query("UPDATE tickets SET assignee_id=1, status='waiting', first_response_at=$2, paused_at=$2 WHERE id=$1", [b.id, at]);
    await c.query("INSERT INTO messages(ticket_id,author_type,author_id,body,created_at) VALUES($1,'agent',1,'Could you send the invoice PDF?',$2)", [b.id, at]);
    await ev(c, b.id, 'claimed', ag(1), {}, new Date(+at - 36e5)); await ev(c, b.id, 'agent_reply', ag(1), {}, at);
    await ev(c, b.id, 'first_response', ag(1), {}, at); await ev(c, b.id, 'paused', ag(1), { reason: 'waiting on customer' }, at);
    // 3. Has an internal note (must never reach the customer)
    const d = await createTicket(c, { name: 'Tom Alvarez', email: 'tom@example.com', subject: 'Refund request', body: 'Please refund my last payment.', priority: 'low', now: new Date(now - 3600e3) });
    await c.query("UPDATE tickets SET assignee_id=2, status='open' WHERE id=$1", [d.id]);
    await ev(c, d.id, 'claimed', ag(2), {});
    const n = (await c.query("INSERT INTO internal_notes(ticket_id,agent_id,body,created_at) VALUES($1,2,'Tom is a difficult customer. Check with Meera before refunding.',now()) RETURNING id", [d.id])).rows[0];
    await ev(c, d.id, 'internal_note', ag(2), { noteId: n.id });
    links.push(a, b, d);
  });
  links.forEach(t => console.log(`Sample ticket #${t.id} customer link: /#/c/${t.token}`));
}

module.exports = { app, init, pool, sweep, canonicalJSON, computeEventHash, view };
if (require.main === module) {
  init().then(() => {
    const server = app.listen(process.env.PORT || 3000, () => console.log('Frontdesk running on port ' + (process.env.PORT || 3000)));
    const sweepTimer = setInterval(() => sweep().catch(console.error), 60000);

    process.on('SIGTERM', () => {
      clearInterval(sweepTimer);
      server.close(async () => {
        try {
          await pool.end();
        } catch (e) {
          console.error(e);
        }
        process.exit(0);
      });
      if (typeof server.closeIdleConnections === 'function') {
        server.closeIdleConnections();
      }
    });
  }).catch(e => { console.error(e); process.exit(1); });
}
