const { test } = require('node:test');
const assert = require('node:assert');
const { view, pool } = require('../src/server');
const ist = s => new Date(s.replace(' ', 'T') + ':00+05:30');
const base = { status: 'open', first_response_at: null, paused_total_min: 0 };
test.after(() => pool.end());

test('deadline passed over a weekend still counts as late (0 working minutes since)', () => {
  const t = { ...base, first_response_at: ist('2026-11-20 10:00'), reply_due: ist('2026-11-20 11:30'), resolve_due: ist('2026-11-20 18:30') };
  const v = view(t, ist('2026-11-22 13:00'), new Set());
  assert.equal(v.late, true);
  assert.ok(v.resLeft < 0);
});
test('not late before the deadline, and a waiting ticket is never late', () => {
  const t = { ...base, reply_due: ist('2026-11-23 11:00'), resolve_due: ist('2026-11-23 18:30') };
  assert.equal(view(t, ist('2026-11-22 13:00'), new Set()).late, false);
  const w = { ...base, status: 'waiting', reply_due: ist('2026-11-20 11:00'), resolve_due: ist('2026-11-20 18:30') };
  assert.equal(view(w, ist('2026-11-25 13:00'), new Set()).late, false);
});
