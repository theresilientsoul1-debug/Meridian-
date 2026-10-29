// Meridian core: pure time logic shared by the app (browser) and the notification function (Node).
// No DOM, no clock: "now" is always passed in as { key: 'YYYY-MM-DD', min: minutes since local midnight }.

export const MIN = 1440;
export const NY = 'America/New_York';

/* ---------- dates (calendar keys, timezone-free) ---------- */
export const pad = n => String(n).padStart(2, '0');
export function keyFromParts(y, m, d) { return y + '-' + pad(m) + '-' + pad(d); }
export function addDays(key, n) {
  const [y, m, d] = key.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return keyFromParts(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}
export function weekday(key) { const [y, m, d] = key.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); }
export function mondayOf(key) { return addDays(key, -((weekday(key) + 6) % 7)); }
export function isWeekday(key) { const w = weekday(key); return w >= 1 && w <= 5; }

/* ---------- time zones ---------- */
const dtfCache = {};
function dtf(tz) {
  return dtfCache[tz] || (dtfCache[tz] = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }));
}
export function zonedNow(ms, tz) {
  const p = {}; for (const x of dtf(tz).formatToParts(new Date(ms))) p[x.type] = x.value;
  return { key: p.year + '-' + p.month + '-' + p.day, min: (Number(p.hour) % 24) * 60 + Number(p.minute) + Number(p.second) / 60 };
}
export function tzOffsetMin(ms, tz) {
  const z = zonedNow(ms, tz); const [y, m, d] = z.key.split('-').map(Number);
  return Math.round((Date.UTC(y, m - 1, d) + z.min * 60000 - ms) / 60000);
}
export function zonedToUtc(key, minutes, tz) {
  const [y, m, d] = key.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d) + minutes * 60000;
  const off = tzOffsetMin(guess, tz); let ms = guess - off * 60000;
  const off2 = tzOffsetMin(ms, tz); if (off2 !== off) ms = guess - off2 * 60000;
  return ms;
}
// minutes on local day `key` (tz) at which New York wall-clock `nyMin` on the same calendar date happens
export function nyToLocal(key, nyMin, tz) {
  return Math.round((zonedToUtc(key, nyMin, NY) - zonedToUtc(key, 0, tz)) / 60000);
}
export function localToNy(key, localMin, tz) {
  return Math.round((zonedToUtc(key, localMin, tz) - zonedToUtc(key, 0, NY)) / 60000);
}

/* ---------- NYSE calendar (source: nyse.com hours & calendars) ---------- */
const CLOSED = new Set(['2026-01-01','2026-01-19','2026-02-16','2026-04-03','2026-05-25','2026-06-19','2026-07-03','2026-09-07','2026-11-26','2026-12-25',
  '2027-01-01','2027-01-18','2027-02-15','2027-03-26','2027-05-31','2027-06-18','2027-07-05','2027-09-06','2027-11-25','2027-12-24',
  '2028-01-17','2028-02-21','2028-04-14','2028-05-29','2028-06-19','2028-07-04','2028-09-04','2028-11-23','2028-12-25']);
const HOLIDAY_NAME = { '01-01': "New Year's Day", '11-26': 'Thanksgiving', '11-25': 'Thanksgiving', '11-23': 'Thanksgiving', '12-25': 'Christmas', '12-24': 'Christmas', '07-03': 'Independence Day', '07-04': 'Independence Day', '07-05': 'Independence Day', '06-18': 'Juneteenth', '06-19': 'Juneteenth' };
const EARLY = new Set(['2026-11-27', '2026-12-24', '2027-11-26', '2028-07-03', '2028-11-24']);
export function marketDay(key) {
  const w = weekday(key);
  if (w === 0 || w === 6) return { status: 'weekend', label: 'Market closed (weekend)' };
  if (CLOSED.has(key)) return { status: 'closed', label: 'Market closed' + (HOLIDAY_NAME[key.slice(5)] ? ' · ' + HOLIDAY_NAME[key.slice(5)] : '') };
  if (EARLY.has(key)) return { status: 'early', label: 'Early close 1 pm ET', closeNy: 780 };
  return { status: 'open', label: '' };
}

/* ---------- formatting (12-hour) ---------- */
export function hm(min) { min = Math.round(min); const h = Math.floor(((min % MIN) + MIN) % MIN / 60), m = ((min % 60) + 60) % 60; return { h12: ((h + 11) % 12) + 1, m, ap: h < 12 ? 'am' : 'pm' }; }
export function fmtT(min, withAp = true) { const t = hm(min); const s = t.h12 + (t.m ? ':' + pad(t.m) : ''); return withAp ? s + ' ' + t.ap : s; }
export function fmtR(a, b) { const A = hm(a), B = hm(b); return (A.ap === B.ap && b - a < 720 ? fmtT(a, false) : fmtT(a)) + ' – ' + fmtT(b); }
export function fmtD(m) { m = Math.round(m); if (m <= 0) return '0m'; const h = Math.floor(m / 60), r = m % 60; return h ? (r ? h + 'h ' + r + 'm' : h + 'h') : r + 'm'; }

/* ---------- blocks ---------- */
// A day doc: { date, plan: [], actual: [], skip: [] }. A block: { id, s, e, c, t, ... }.
// s is minutes from the day's local midnight; e may run past 1440 (crosses midnight), up to s + 1440.
// ny:true means s/e are New York wall-clock minutes on the same calendar date; they follow US clock changes.
// actual blocks with e === null are running (a timer, or sleep in progress).
export function emptyDay(key) { return { date: key, plan: [], actual: [], skip: [] }; }
export function dayOf(days, key) { return days[key] || emptyDay(key); }

export function resolvePlanBlock(key, b, tz) {
  if (!b.ny) return { ...b, srcKey: key };
  const s = nyToLocal(key, b.s, tz), e = nyToLocal(key, b.e, tz);
  const mk = marketDay(key);
  return { ...b, s, e, srcKey: key, closed: mk.status === 'closed' || mk.status === 'weekend', market: mk };
}
function runningEnd(srcKey, s, now) {
  if (!now) return s + 1;
  let e;
  if (now.key === srcKey) e = now.min;
  else if (now.key === addDays(srcKey, 1)) e = MIN + now.min;
  else if (now.key > srcKey) e = 2 * MIN;
  else e = s + 1;
  return Math.max(s + 1, Math.min(e, s + MIN));
}
// Blocks visible on day `key`, in key's minutes: its own (clipped to the day) plus the part of yesterday's that spills past midnight.
export function visible(days, key, ring, tz, now) {
  const out = [];
  const add = (srcKey, shift) => {
    const d = days[srcKey]; if (!d) return;
    for (const raw of (d[ring] || [])) {
      let b = ring === 'plan' ? resolvePlanBlock(srcKey, raw, tz) : { ...raw, srcKey };
      const running = ring === 'actual' && raw.e == null;
      const e = running ? runningEnd(srcKey, b.s, now) : b.e;
      const s2 = b.s + shift, e2 = e + shift;
      if (e2 <= 0 || s2 >= MIN) continue;
      out.push({ ...b, s: Math.max(0, s2), e: Math.min(MIN, e2), fullS: b.s, fullE: e, running, spill: shift !== 0, cutEnd: e2 > MIN, skipped: (d.skip || []).includes(raw.id) });
    }
  };
  add(addDays(key, -1), -MIN);
  add(key, 0);
  return out.sort((a, b) => a.s - b.s);
}
export function subtract(segs, cuts) {
  let out = segs.slice();
  for (const c of cuts) {
    const next = [];
    for (const s of out) {
      if (c.e <= s.s || c.s >= s.e) { next.push(s); continue; }
      if (c.s > s.s) next.push({ ...s, e: c.s });
      if (c.e < s.e) next.push({ ...s, s: c.e });
    }
    out = next;
  }
  return out;
}
// What happened on day `key`: logged blocks, plus the plan carried forward for elapsed time you didn't log or skip.
export function effActual(days, key, tz, now) {
  const limit = !now ? 0 : key < now.key ? MIN : key === now.key ? now.min : 0;
  const explicit = visible(days, key, 'actual', tz, now).map(b => ({ ...b, carried: false }));
  const carry = visible(days, key, 'plan', tz, now)
    .filter(p => !p.skipped && !p.closed && p.s < limit && !explicit.some(a => a.from === p.id))
    .map(p => ({ ...p, e: Math.min(p.e, limit), carried: true, from: p.id }));
  return explicit.concat(subtract(carry, explicit)).filter(b => b.e - b.s > 0.5).sort((a, b) => a.s - b.s);
}
// Busy intervals around day `key` in key's minutes (yesterday shifted −1440, tomorrow +1440), for overlap checks.
export function occupied(days, key, ring, tz, now, excludeId) {
  const out = [];
  for (const [k, shift] of [[addDays(key, -1), -MIN], [key, 0], [addDays(key, 1), MIN]]) {
    const d = days[k]; if (!d) continue;
    for (const raw of (d[ring] || [])) {
      if (raw.id === excludeId) continue;
      const b = ring === 'plan' ? resolvePlanBlock(k, raw, tz) : raw;
      const e = ring === 'actual' && raw.e == null ? runningEnd(k, b.s, now) : b.e;
      out.push({ s: b.s + shift, e: e + shift, id: raw.id, t: raw.t, c: raw.c, srcKey: k });
    }
  }
  return out.sort((a, b) => a.s - b.s);
}
export function clash(list, s, e) { return list.find(b => s < b.e && e > b.s) || null; }
export function freeGap(list, m) {
  let lo = -MIN, hi = 2 * MIN;
  for (const b of list) { if (b.s <= m && m < b.e) return null; if (b.e <= m) lo = Math.max(lo, b.e); if (b.s > m) hi = Math.min(hi, b.s); }
  return [lo, hi];
}

/* ---------- check-ins ---------- */
// Planned blocks that have ended and have no answer yet (yesterday and today).
export function pendingCheckins(days, tz, now) {
  const out = [];
  for (const k of [addDays(now.key, -1), now.key]) {
    const d = days[k]; if (!d) continue;
    for (const raw of d.plan || []) {
      if ((d.skip || []).includes(raw.id) || raw.c === 'sleep') continue;
      const b = resolvePlanBlock(k, raw, tz); if (b.closed) continue;
      const endAbs = (k === now.key ? 0 : -MIN) + b.e;
      if (endAbs > now.min || now.min - endAbs > 30 * 60) continue;
      if ((d.actual || []).some(a => a.from === raw.id)) continue;
      out.push({ ...b, srcKey: k });
    }
  }
  return out.sort((a, b) => (a.srcKey + pad(a.e)).localeCompare(b.srcKey + pad(b.e)));
}

/* ---------- notification events ---------- */
// Events on day `key`, in key's minutes: block starts, block ends (check-ins) and the evening shutdown.
export function dayEvents(days, key, settings, tz) {
  const out = []; const d = days[key];
  const n = settings && settings.notify || {};
  if (d) for (const raw of d.plan || []) {
    if (raw.c === 'sleep') continue;
    const b = resolvePlanBlock(key, raw, tz); if (b.closed) continue;
    if (n.start !== false) out.push({ at: b.s, kind: 'start', key: key + ':' + raw.id + ':start', b });
    if (n.checkin !== false && !(d.skip || []).includes(raw.id)) out.push({ at: b.e, kind: 'end', key: key + ':' + raw.id + ':end', b });
  }
  if (n.shutdown !== false && settings && settings.shutdownAt != null) out.push({ at: settings.shutdownAt, kind: 'shutdown', key: key + ':shutdown' });
  return out;
}
export function dueEvents(days, settings, tz, now, windowMin = 3) {
  const out = [];
  for (const [k, shift] of [[addDays(now.key, -1), -MIN], [now.key, 0]]) {
    for (const ev of dayEvents(days, k, settings, tz)) {
      const at = ev.at + shift;
      if (at <= now.min && now.min - at < windowMin) out.push(ev);
    }
  }
  return out;
}
export function eventMessage(ev, days, catName) {
  if (ev.kind === 'shutdown') return { title: 'Close the day', body: 'Two minutes: confirm today and plan tomorrow.', tag: 'shutdown' };
  const b = ev.b, name = b.t || catName(b.c);
  if (ev.kind === 'start') return { title: name + ' · ' + fmtR(b.s, b.e), body: b.f ? 'First step: ' + b.f : 'Starting now.', tag: 'start-' + b.id };
  return { title: 'Did ' + name + ' happen?', body: 'Tap to check in: yes, partly or no.', tag: 'end-' + b.id };
}

/* ---------- totals ---------- */
// Per category on day `key`: planned, confirmed (logged) and assumed (carried) minutes.
export function dayTotals(days, key, tz, now) {
  const out = {};
  const get = c => out[c] || (out[c] = { plan: 0, done: 0, assumed: 0 });
  for (const b of visible(days, key, 'plan', tz, now)) if (!b.closed) get(b.c).plan += b.e - b.s;
  for (const b of effActual(days, key, tz, now)) { if (b.carried) get(b.c).assumed += b.e - b.s; else get(b.c).done += b.e - b.s; }
  return out;
}

/* ---------- quick add ---------- */
const KEYWORDS = { gym: 'gym', workout: 'gym', run: 'gym', train: 'gym', trade: 'trading', trading: 'trading', chart: 'trading', charts: 'trading', backtest: 'trading', study: 'study', read: 'study', learn: 'study', course: 'study', work: 'work', job: 'work', home: 'home', routine: 'home', cook: 'home', clean: 'home', family: 'home', business: 'business', launch: 'business', sleep: 'sleep', nap: 'sleep', bed: 'sleep' };
export function guessCat(text, cats) {
  const words = String(text).toLowerCase().split(/[^a-z]+/).filter(Boolean);
  for (const w of words) { const c = cats.find(c => c.name.toLowerCase() === w || (w.length >= 3 && c.name.toLowerCase().startsWith(w))); if (c) return c.id; }
  for (const w of words) if (KEYWORDS[w] && cats.find(c => c.id === KEYWORDS[w])) return KEYWORDS[w];
  return null;
}
function toMin(h, m, ap) { h = +h; m = +(m || 0); if (ap) { ap = ap[0]; if (ap === 'p' && h < 12) h += 12; if (ap === 'a' && h === 12) h = 0; } return h * 60 + m; }
export const snap = m => Math.round(m / 15) * 15;
// "gym 6-7:30pm", "study 2h at 4pm", "sleep 11:30pm-7am" → { s, e, c, t } (e may pass midnight)
export function parseQuick(str, cats, fallbackStart, lastCat) {
  let s = ' ' + str.toLowerCase().replace(/–|—/g, '-') + ' ', a = null, b = null;
  const R = /\s(\d{1,2})(?::(\d{2}))?\s*(am|pm|a|p)?\s*(?:-|to|until)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm|a|p)?\b/;
  const mt = s.match(R);
  if (mt) {
    let ap1 = mt[3], ap2 = mt[6]; const h1 = +mt[1], h2 = +mt[4];
    if (!ap1 && ap2) { ap1 = (h1 % 12) <= (h2 % 12) ? ap2 : (ap2[0] === 'p' ? 'am' : 'pm'); }
    if (!ap1 && !ap2) ap1 = h1 >= 7 && h1 <= 11 ? 'am' : 'pm';
    if (ap1 && !ap2) ap2 = (h2 % 12) > (h1 % 12) ? ap1 : (ap1[0] === 'a' ? 'pm' : 'am');
    a = toMin(mt[1], mt[2], ap1); b = toMin(mt[4], mt[5], ap2);
    if (b <= a) b += MIN;
    s = s.replace(mt[0], ' ');
  } else {
    const at = s.match(/\s(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm|a|p)\b/) || s.match(/\sat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm|a|p)?\b/);
    const du = s.match(/\s(?:for\s+)?(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours|m|min|mins|minutes)\b/);
    if (at) { const h1 = +at[1]; a = toMin(at[1], at[2], at[3] || (h1 >= 7 && h1 <= 11 ? 'am' : 'pm')); s = s.replace(at[0], ' '); }
    if (du) { const n = parseFloat(du[1]); const mins = du[2][0] === 'h' ? n * 60 : n; s = s.replace(du[0], ' '); if (a == null) a = Math.ceil(fallbackStart / 15) * 15; b = a + mins; }
    else if (a != null) b = a + 60;
  }
  if (a == null || b == null) return { error: 'Add a time, like "gym 6–7:30pm" or "study 2h at 4pm".' };
  a = snap(a); b = snap(b);
  if (b <= a) return { error: 'The end has to be after the start.' };
  if (b - a > MIN) return { error: 'A block can be at most 24 hours.' };
  const title = s.replace(/\b(at|for|from)\b/g, ' ').replace(/\s+/g, ' ').trim();
  const c = guessCat(title, cats) || lastCat || (cats[0] && cats[0].id);
  const cat = cats.find(x => x.id === c);
  return { s: a, e: b, c, t: title ? title[0].toUpperCase() + title.slice(1) : (cat ? cat.name : 'Block') };
}

/* ---------- defaults ---------- */
export const DEFAULT_CATS = [
  { id: 'trading', name: 'Trading', color: '#c9a66b' },
  { id: 'home', name: 'Home', color: '#a7a57c' },
  { id: 'work', name: 'Work', color: '#8299b8' },
  { id: 'business', name: 'Business', color: '#b98d85' },
  { id: 'gym', name: 'Gym', color: '#6fa8a6' },
  { id: 'study', name: 'Study', color: '#8fb093' },
  { id: 'sleep', name: 'Sleep', color: '#55524d' }
];
// Trading follows the New York open: 9:30 am – 12:30 pm ET (5:30–8:30 pm Tbilisi in US summer time, 6:30–9:30 pm in winter).
export const ROUTINE = [
  { s: 600, e: 690, c: 'home', t: 'Morning routine' },
  { s: 720, e: 900, c: 'study', t: 'Study' },
  { s: 570, e: 750, c: 'trading', t: 'Trading session', ny: true }
];
export function defaultSettings(tz) {
  return {
    v: 2, tz, cats: DEFAULT_CATS.map(c => ({ ...c })),
    templates: [{ id: 'tpl-trading', name: 'Trading day', blocks: ROUTINE.map(b => ({ ...b })) }],
    shutdownAt: 1305, notify: { start: true, checkin: true, shutdown: true }
  };
}
