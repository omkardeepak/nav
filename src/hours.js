// Working-time engine. Hours: Mon-Fri 09:30-18:30 Asia/Kolkata (UTC+5:30, no DST), minus holidays.
// All functions take/return epoch milliseconds. `hol` is a Set of 'YYYY-MM-DD' strings (IST dates).
const OFFSET = 330 * 60000, DAY = 86400000, S = 570, E = 1110;
const DAY_MIN = E - S; // 540

const midnight = t => t - (((t % DAY) + DAY) % DAY);
const isWorkday = (ds, hol) => {
  const d = new Date(ds), w = d.getUTCDay();
  return w !== 0 && w !== 6 && !hol.has(d.toISOString().slice(0, 10));
};
// first working instant at or after t (t is IST-shifted)
function normalize(t, hol) {
  for (;;) {
    const ds = midnight(t);
    if (isWorkday(ds, hol)) {
      const m = (t - ds) / 60000;
      if (m < S) return ds + S * 60000;
      if (m < E) return t;
    }
    t = ds + DAY;
  }
}
function addBusinessMinutes(startMs, minutes, hol = new Set()) {
  let t = normalize(startMs + OFFSET, hol), left = minutes;
  for (;;) {
    const end = midnight(t) + E * 60000, avail = (end - t) / 60000;
    if (left <= avail) return t + left * 60000 - OFFSET;
    left -= avail;
    t = normalize(end, hol);
  }
}
function businessMinutesBetween(aMs, bMs, hol = new Set()) {
  if (bMs <= aMs) return 0;
  const a = aMs + OFFSET, b = bMs + OFFSET;
  let total = 0;
  for (let ds = midnight(a); ds <= b; ds += DAY) {
    if (!isWorkday(ds, hol)) continue;
    const s = Math.max(a, ds + S * 60000), e = Math.min(b, ds + E * 60000);
    if (e > s) total += (e - s) / 60000;
  }
  return total;
}
// 18:30 of the working day the clock starts on
function endOfWorkDay(startMs, hol = new Set()) {
  return midnight(normalize(startMs + OFFSET, hol)) + E * 60000 - OFFSET;
}
module.exports = { addBusinessMinutes, businessMinutesBetween, endOfWorkDay, DAY_MIN };
