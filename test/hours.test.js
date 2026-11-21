const { test } = require('node:test');
const assert = require('node:assert');
const H = require('../src/hours');
const ist = s => Date.parse(s.replace(' ', 'T') + ':00+05:30');
const none = new Set();

test('Friday 18:00 critical: 30 min Friday + 90 min Monday -> Monday 11:00', () => {
  assert.equal(H.addBusinessMinutes(ist('2026-11-20 18:00'), 120, none), ist('2026-11-23 11:00'));
});
test('Friday 18:00 ticket is NOT late on Sunday morning', () => {
  const used = H.businessMinutesBetween(ist('2026-11-20 18:00'), ist('2026-11-22 10:00'), none);
  assert.equal(used, 30);
  assert.ok(used < 120);
});
test('created on Saturday starts Monday 09:30', () => {
  assert.equal(H.addBusinessMinutes(ist('2026-11-21 10:00'), 120, none), ist('2026-11-23 11:30'));
});
test('created before 09:30 starts at 09:30', () => {
  assert.equal(H.addBusinessMinutes(ist('2026-11-23 08:00'), 60, none), ist('2026-11-23 10:30'));
});
test('holiday is skipped (Fri 25 Dec 2026)', () => {
  const hol = new Set(['2026-12-25']);
  assert.equal(H.addBusinessMinutes(ist('2026-12-24 17:30'), 120, hol), ist('2026-12-28 10:30'));
});
test('business minutes across a weekend', () => {
  assert.equal(H.businessMinutesBetween(ist('2026-11-20 17:30'), ist('2026-11-23 10:30'), none), 120);
});
test('full working days: 3 days from Mon 10:00 -> Thu 10:00', () => {
  assert.equal(H.addBusinessMinutes(ist('2026-11-23 10:00'), 3 * 540, none), ist('2026-11-26 10:00'));
});
test('end of working day', () => {
  assert.equal(H.endOfWorkDay(ist('2026-11-20 18:00'), none), ist('2026-11-20 18:30'));
  assert.equal(H.endOfWorkDay(ist('2026-11-21 11:00'), none), ist('2026-11-23 18:30'));
});
