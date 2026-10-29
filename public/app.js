import * as C from './core.js';
const { MIN, addDays, fmtT, fmtR, fmtD, pad } = C;

/* ===================================================================
   Meridian v2 — the app. Pure time logic lives in core.js (shared with the notification server).
   =================================================================== */
const TZ = (Intl.DateTimeFormat().resolvedOptions().timeZone) || 'UTC';
const CX = 300, R_PLAN = 222, W_PLAN = 40, R_ACT = 181, W_ACT = 18, R_TICK = 264, R_LABEL = 289;
const PALETTE = ['#c9a66b','#b98d85','#a7a57c','#8fb093','#6fa8a6','#8299b8','#c7b48f','#a98f7a','#9aa3a8','#55524d'];
const WD = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const WDL = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const MON = ['January','February','March','April','May','June','July','August','September','October','November','December'];

const S = { settings: null, days: {}, inbox: { items: [] }, view: 'day', sel: null, reviewRange: 'week', monthAnchor: null, drag: null, drop: null, selected: null, lastInk: null, email: null };
let sb = null, uid = null, mode = 'local', session = null;
const $ = id => document.getElementById(id);

/* ---------- time ---------- */
const now = () => C.zonedNow(Date.now(), TZ);
const todayKey = () => now().key;
S.sel = todayKey();
const dateParts = k => k.split('-').map(Number);
function longDate(k) { const [, m, d] = dateParts(k); return WDL[C.weekday(k)] + ', ' + MON[m - 1] + ' ' + d; }
function shortDate(k) { const [, m, d] = dateParts(k); return MON[m - 1].slice(0, 3) + ' ' + d; }
function relLabel(k) { const t = todayKey(); if (k === t) return 'Today'; if (k === addDays(t, 1)) return 'Tomorrow'; if (k === addDays(t, -1)) return 'Yesterday'; return ''; }
function fmtClock(sec) { sec = Math.max(0, Math.floor(sec)); const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60; return (h ? h + ':' + pad(m) : m) + ':' + pad(s); }
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const newId = () => Math.random().toString(36).slice(2, 10);
const clone = o => o == null ? o : JSON.parse(JSON.stringify(o));

/* ---------- model helpers ---------- */
const cats = () => (S.settings && S.settings.cats) || C.DEFAULT_CATS;
function cat(id) { return cats().find(c => c.id === id) || (S.settings?.retired || []).find(c => c.id === id) || { id, name: 'Other', color: '#8a847b' }; }
const nameOf = b => b.t || cat(b.c).name;
function ensureDay(k) { if (!S.days[k]) S.days[k] = C.emptyDay(k); const d = S.days[k]; d.plan ||= []; d.actual ||= []; d.skip ||= []; return d; }
const vis = (k, ring) => C.visible(S.days, k, ring, TZ, now());
const eff = k => C.effActual(S.days, k, TZ, now());
const occ = (k, ring, ex) => C.occupied(S.days, k, ring, TZ, now(), ex);
function findRunning() {
  const t = todayKey();
  for (const k of [t, addDays(t, -1)]) { const d = S.days[k]; const b = d && d.actual.find(x => x.e == null); if (b) return { k, b }; }
  return null;
}
function minutesSince(k) { const n = now(); return n.key === k ? n.min : n.key === addDays(k, 1) ? MIN + n.min : MIN * 2; }

/* ---------- storage, sync, undo ---------- */
const cacheKey = () => 'meridian-v2:' + (uid || 'local');
function cacheWrite() { try { localStorage.setItem(cacheKey(), JSON.stringify({ settings: S.settings, days: S.days, inbox: S.inbox, dirty: [...dirty] })); } catch (_) {} }
function cacheRead() { try { return JSON.parse(localStorage.getItem(cacheKey()) || 'null'); } catch (_) { return null; } }
function docBody(id) { return id === 'settings' ? S.settings : id === 'inbox' ? S.inbox : S.days[id.slice(2)]; }
function setDoc(id, body) {
  if (id === 'settings') S.settings = body;
  else if (id === 'inbox') S.inbox = body && body.items ? body : { items: [] };
  else if (id.startsWith('d-')) { const k = id.slice(2); if (body) S.days[k] = body; else delete S.days[k]; }
}
const dirty = new Set(); let flushT = null, flushing = false, syncState = '';
function save(id) { dirty.add(id); cacheWrite(); setSync(); clearTimeout(flushT); flushT = setTimeout(flush, 400); }
const saveDay = k => save('d-' + k);
async function flush() {
  if (mode !== 'cloud' || flushing) { setSync(); return; }
  if (!navigator.onLine) { setSync('offline'); return; }
  const ids = [...dirty]; if (!ids.length) { setSync(); return; }
  flushing = true;
  ids.forEach(i => dirty.delete(i));
  const rows = ids.map(id => ({ user_id: uid, id, body: docBody(id) || {}, updated_at: new Date().toISOString() }));
  let failed = false;
  try { const { error } = await sb.from('docs').upsert(rows); if (error) { failed = true; console.warn(error); } }
  catch (e) { failed = true; console.warn(e); }
  flushing = false;
  if (failed) { ids.forEach(i => dirty.add(i)); setSync('offline'); setTimeout(flush, 8000); }
  else { cacheWrite(); setSync(); if (dirty.size) setTimeout(flush, 300); }
}
function setSync(force) {
  const el = $('sync'); if (!el) return;
  syncState = force || (mode !== 'cloud' ? 'This device only' : dirty.size ? (navigator.onLine ? 'Saving…' : 'Offline · saved here') : 'Synced');
  if (force === 'offline') syncState = 'Offline · saved here';
  el.textContent = syncState;
}
const undoStack = [];
function checkpoint(ids) { const snap = {}; for (const id of ids) snap[id] = clone(docBody(id) ?? null); undoStack.push(snap); if (undoStack.length > 40) undoStack.shift(); }
function undo() { const snap = undoStack.pop(); if (!snap) return; for (const id in snap) { setDoc(id, snap[id]); save(id); } render(); toast('Undone'); }
// Every user-made change goes through here: snapshot for undo, apply, save, redraw.
function change(ids, fn, msg) { checkpoint(ids); fn(); ids.forEach(save); render(); if (msg) toast(msg, true); }

/* ---------- boot ---------- */
async function boot() {
  registerSW();
  let cfg = null;
  try { const r = await fetch('/api/config', { cache: 'no-store' }); if (r.ok) { cfg = await r.json(); try { localStorage.setItem('meridian-cfg', JSON.stringify(cfg)); } catch (_) {} } } catch (_) {}
  if (!cfg) { try { cfg = JSON.parse(localStorage.getItem('meridian-cfg') || 'null'); } catch (_) {} }
  if (cfg && cfg.configured && window.supabase) {
    sb = window.supabase.createClient(cfg.url, cfg.key, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
    sb.auth.onAuthStateChange((ev, sess) => { session = sess; if (ev === 'SIGNED_OUT') { location.hash = ''; location.reload(); } });
    const { data } = await sb.auth.getSession(); session = data.session;
    if (session) await startCloud(session.user); else showAuth();
  } else {
    mode = 'local';
    const c = cacheRead(); if (c) { S.settings = c.settings; S.days = c.days || {}; S.inbox = c.inbox || { items: [] }; }
    seedIfNew(); render();
    showBanner('<b>Not connected to your account yet.</b> Your plan is saved on this device only until the Supabase keys are set in Netlify.');
    afterStart();
  }
}
async function startCloud(user) {
  uid = user.id; mode = 'cloud'; S.email = user.email;
  $('auth').hidden = true;
  const c = cacheRead();
  if (c) { S.settings = c.settings; S.days = c.days || {}; S.inbox = c.inbox || { items: [] }; (c.dirty || []).forEach(id => dirty.add(id)); }
  render();
  const ok = await pull();
  if (ok) seedIfNew();
  if (S.settings && S.settings.tz !== TZ) { S.settings.tz = TZ; save('settings'); }
  render(); flush(); subscribeLive(); afterStart();
}
function afterStart() {
  setSync(); handleHash();
  setTimeout(maybeGlance, 400);
}
async function pull() {
  if (mode !== 'cloud') return false;
  try {
    const { data, error } = await sb.from('docs').select('id,body');
    if (error) { console.warn(error); setSync('offline'); return false; }
    for (const row of data) if (!dirty.has(row.id)) setDoc(row.id, row.body);
    cacheWrite(); return true;
  } catch (e) { setSync('offline'); return false; }
}
function subscribeLive() {
  try {
    sb.channel('docs-' + uid).on('postgres_changes', { event: '*', schema: 'public', table: 'docs', filter: 'user_id=eq.' + uid }, p => {
      const row = p.new && p.new.id ? p.new : null; if (!row || dirty.has(row.id) || S.drag) return;
      setDoc(row.id, row.body); cacheWrite(); softRender();
    }).subscribe();
  } catch (e) { console.warn('live sync off', e); }
}
let softT = null;
function softRender() { clearTimeout(softT); softT = setTimeout(() => { if (!sheetOpen() && !S.drag) render(); }, 150); }
function seedIfNew() {
  if (!S.inbox || !S.inbox.items) S.inbox = { items: [] };
  if (S.settings) return;
  S.settings = C.defaultSettings(TZ); save('settings');
  const t = todayKey();
  for (const k of [t, addDays(t, 1)]) if (C.isWeekday(k) && !(S.days[k] && S.days[k].plan.length)) applyTemplate(k, S.settings.templates[0], true);
}
function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/sw.js').catch(e => console.warn('sw', e));
  navigator.serviceWorker.addEventListener('message', e => { if (e.data && e.data.type === 'open') { const u = new URL(e.data.url, location.href); if (u.hash) { location.hash = u.hash; handleHash(); } } });
}
window.addEventListener('online', () => { setSync(); flush(); pull().then(ok => ok && softRender()); });
window.addEventListener('offline', () => setSync('offline'));
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { pull().then(ok => { if (ok) softRender(); }); setTimeout(maybeGlance, 300); } });

/* ---------- auth ---------- */
function showAuth(msg) {
  ['week', 'day-view', 'month-view'].forEach(id => $(id).hidden = true);
  const a = $('auth'); a.hidden = false;
  a.innerHTML = `<h1 id="auth-h">Sign in to Meridian</h1><p>Your days sync between your phone, iPad and computer.</p>
    <form id="auth-form" class="field" style="gap:12px" autocomplete="on">
      <div class="field"><label for="au-email">Email</label><input id="au-email" type="email" autocomplete="email" required></div>
      <div class="field"><label for="au-pass">Password</label><input id="au-pass" type="password" autocomplete="current-password" minlength="6" required></div>
      <div class="err" id="au-err" ${msg ? '' : 'hidden'}>${esc(msg || '')}</div>
      <div class="sheet-foot"><button class="btn-primary" type="submit">Sign in</button><button class="btn-ghost" type="button" id="au-new">Create account</button></div>
    </form>`;
  const err = m => { const e = $('au-err'); e.hidden = false; e.textContent = m; };
  $('auth-form').onsubmit = async ev => {
    ev.preventDefault();
    const { data, error } = await sb.auth.signInWithPassword({ email: $('au-email').value.trim(), password: $('au-pass').value });
    if (error) return err(error.message === 'Invalid login credentials' ? 'That email and password don’t match an account.' : error.message);
    session = data.session; ['week', 'day-view'].forEach(id => $(id).hidden = false); await startCloud(data.user);
  };
  $('au-new').onclick = async () => {
    const email = $('au-email').value.trim(), password = $('au-pass').value;
    if (!email || password.length < 6) return err('Enter your email and a password of at least 6 characters.');
    const { data, error } = await sb.auth.signUp({ email, password, options: { emailRedirectTo: location.origin } });
    if (error) return err(error.message);
    if (data.session) { session = data.session; ['week', 'day-view'].forEach(id => $(id).hidden = false); await startCloud(data.user); }
    else err('Account created. Open the confirmation email, then come back and sign in.');
  };
}
function showBanner(html) { const b = $('banner'); b.innerHTML = html; b.hidden = false; }

/* ---------- templates ---------- */
function applyTemplate(k, tpl, quiet) {
  const d = ensureDay(k); let added = 0, skipped = 0;
  for (const b of tpl.blocks) {
    const r = C.resolvePlanBlock(k, b, TZ);
    if (C.clash(occ(k, 'plan'), r.s, r.e)) { skipped++; continue; }
    d.plan.push({ ...clone(b), id: newId() }); added++;
  }
  saveDay(k);
  if (!quiet) toast(added ? tpl.name + ' added' + (skipped ? ' · ' + skipped + ' skipped (time taken)' : '') : 'Those times are already taken', added > 0);
  return added;
}

/* ---------- dial ---------- */
const dialEl = $('dial');
const ang = m => m / MIN * Math.PI * 2;
const P = (r, m) => [CX + r * Math.sin(ang(m)), CX - r * Math.cos(ang(m))];
const f2 = n => n.toFixed(2);
function arcD(r, a, b, rev) {
  b = Math.min(b, a + 1439.6); const [x0, y0] = P(r, a), [x1, y1] = P(r, b); const lg = (b - a) > 720 ? 1 : 0;
  return rev ? `M${f2(x1)} ${f2(y1)}A${r} ${r} 0 ${lg} 0 ${f2(x0)} ${f2(y0)}` : `M${f2(x0)} ${f2(y0)}A${r} ${r} 0 ${lg} 1 ${f2(x1)} ${f2(y1)}`;
}
const arcLen = (r, a, b) => r * ang(b - a);
const snap = m => Math.max(0, Math.min(MIN, Math.round(m / 15) * 15));
let LABEL_PX = 14;
function dialSVG(k) {
  LABEL_PX = dialEl.clientWidth && dialEl.clientWidth < 440 ? 21 : 14;
  const n = now(), t = n.key, nm = n.min, isToday = k === t, isPast = k < t;
  const plan = vis(k, 'plan'), acts = eff(k);
  let defs = `<pattern id="hatch" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="7" height="7" fill="#1d1c1a"/><line x1="0" y1="0" x2="0" y2="7" stroke="#3a3733" stroke-width="2"/></pattern>`, g = '';
  g += `<circle cx="${CX}" cy="${CX}" r="${R_TICK + 6}" fill="var(--face)"/>`;
  g += `<circle cx="${CX}" cy="${CX}" r="${R_PLAN}" fill="none" stroke="var(--track)" stroke-width="${W_PLAN}"/>`;
  g += `<circle cx="${CX}" cy="${CX}" r="${R_ACT}" fill="none" stroke="var(--track-2)" stroke-width="${W_ACT}"/>`;
  for (let i = 0; i < 96; i++) { const m = i * 15, h = i % 4 === 0; const [x0, y0] = P(R_TICK, m), [x1, y1] = P(R_TICK - (h ? 12 : 5), m); g += `<line class="${h ? 'tick-h' : 'tick'}" x1="${f2(x0)}" y1="${f2(y0)}" x2="${f2(x1)}" y2="${f2(y1)}"/>`; }
  for (let h = 0; h < 24; h++) { const [x, y] = P(R_LABEL, h * 60); g += `<text class="hl ${h % 3 === 0 ? 'major' : 'minor'}" x="${f2(x)}" y="${f2(y)}">${((h + 11) % 12) + 1}</text>`; }
  { const [ax, ay] = P(150, 360), [px, py] = P(150, 1080); g += `<text class="ampm" x="${f2(ax)}" y="${f2(ay)}">AM</text><text class="ampm" x="${f2(px)}" y="${f2(py)}">PM</text>`; }
  const gaps = []; let cur = 0;
  for (const b of plan) { if (b.s - cur >= 15) gaps.push([cur, b.s]); cur = Math.max(cur, b.e); }
  if (MIN - cur >= 15) gaps.push([cur, MIN]);
  const seam = 0.9, cw = LABEL_PX * 0.57;
  for (const b of plan) {
    const col = b.closed ? 'url(#hatch)' : cat(b.c).color, a = b.s + seam, e = b.e - seam;
    if (e <= a) continue;
    const parts = isToday && b.s < nm && b.e > nm ? [[a, nm, true], [nm, e, false]] : [[a, e, isPast || (isToday && b.e <= nm)]];
    for (const [pa, pe, past] of parts) {
      if (pe - pa <= 0) continue;
      const ink = S.lastInk === b.id ? ` class="ink" style="--len:${f2(arcLen(R_PLAN, pa, pe))}"` : '';
      const op = b.closed ? 1 : b.skipped ? 0.25 : past ? (isPast ? 0.5 : 0.42) : 1;
      g += `<path${ink} d="${arcD(R_PLAN, pa, pe)}" fill="none" stroke="${col}" stroke-width="${W_PLAN - 2}" opacity="${op}"/>`;
    }
    if (S.selected && S.selected.ring === 'plan' && S.selected.id === b.id) g += `<path d="${arcD(R_PLAN + W_PLAN / 2 + 4, a, e)}" fill="none" stroke="var(--ivory)" stroke-width="2"/>`;
    const mid = (b.s + b.e) / 2, rev = mid > 360 && mid < 1080, len = arcLen(R_PLAN, b.s, b.e) - 18;
    let title = b.closed ? 'Market closed' : (b.top ? '★ ' : '') + nameOf(b);
    if (len > 36) {
      if (title.length * cw > len) title = title.slice(0, Math.max(2, Math.floor(len / cw) - 1)) + '…';
      const pid = 'tp-' + b.id + (b.spill ? 's' : ''); defs += `<path id="${pid}" d="${arcD(R_PLAN, b.s, b.e, rev)}"/>`;
      g += `<text class="arc-label${b.closed ? ' closed' : ''}" style="font-size:${LABEL_PX}px" dy="0.36em" opacity="${b.skipped ? 0.5 : 1}"><textPath href="#${pid}" startOffset="50%" text-anchor="middle">${esc(title)}</textPath></text>`;
    }
  }
  for (const [a, b] of gaps) {
    if (b - a < 120) continue;
    const mid = (a + b) / 2, rev = mid > 360 && mid < 1080, pid = 'fp-' + a;
    defs += `<path id="${pid}" d="${arcD(R_PLAN, a, b, rev)}"/>`;
    g += `<text class="free-label" style="font-size:${LABEL_PX - 1}px" dy="0.36em"><textPath href="#${pid}" startOffset="50%" text-anchor="middle">Free</textPath></text>`;
  }
  for (const b of acts) {
    const col = cat(b.c).color, ink = S.lastInk === b.id ? ` class="ink" style="--len:${f2(arcLen(R_ACT, b.s, b.e))}"` : '';
    g += `<path${ink} d="${arcD(R_ACT, b.s + 0.6, Math.max(b.s + 1.2, b.e - 0.6))}" fill="none" stroke="${col}" stroke-width="${W_ACT - 2}" opacity="${b.carried ? 0.42 : 1}"/>`;
    if (S.selected && S.selected.ring === 'actual' && S.selected.id === b.id) g += `<path d="${arcD(R_ACT - W_ACT / 2 - 4, b.s, b.e)}" fill="none" stroke="var(--ivory)" stroke-width="2"/>`;
  }
  const gh = ghostRange();
  if (gh) {
    const r = gh.ring === 'plan' ? R_PLAN : R_ACT, w = gh.ring === 'plan' ? W_PLAN - 2 : W_ACT - 2;
    g += `<g class="ghost"><path d="${arcD(r, gh.a + 0.6, gh.b - 0.6)}" fill="none" stroke="${gh.color}" stroke-width="${w}" opacity="${gh.ok === false ? 0.35 : 0.9}"/>`;
    for (const m of [gh.a, gh.b]) { const [x0, y0] = P(r - w / 2 - 6, m), [x1, y1] = P(r + w / 2 + 6, m); g += `<line x1="${f2(x0)}" y1="${f2(y0)}" x2="${f2(x1)}" y2="${f2(y1)}" stroke="var(--ivory)" stroke-width="2"/>`; }
    g += '</g>';
  }
  if (isToday) {
    const [tx, ty] = P(R_TICK + 4, nm), [bx, by] = P(R_ACT - W_ACT / 2 - 8, nm);
    g += `<g aria-hidden="true"><line x1="${f2(bx)}" y1="${f2(by)}" x2="${f2(tx)}" y2="${f2(ty)}" stroke="var(--ivory)" stroke-width="2" stroke-linecap="round"/><circle cx="${f2(bx)}" cy="${f2(by)}" r="4" fill="var(--ivory)"/><circle cx="${f2(tx)}" cy="${f2(ty)}" r="2.6" fill="var(--ivory)"/></g>`;
  }
  return `<defs>${defs}</defs>${g}`;
}
function ghostRange() {
  const D = S.drag;
  if (D && (D.mode === 'draw' || D.mode === 'resize' || D.mode === 'move') && D.b > D.a) return { ring: D.ring, a: D.a, b: D.b, color: D.mode === 'draw' ? 'var(--ivory)' : cat(D.block.c).color };
  if (S.drop && S.drop.b > S.drop.a) return { ring: 'plan', a: S.drop.a, b: S.drop.b, color: S.drop.ok ? 'var(--ivory)' : '#6b6660', ok: S.drop.ok };
  return null;
}
function renderDial() {
  dialEl.innerHTML = dialSVG(S.sel);
  const plan = vis(S.sel, 'plan').filter(b => !b.closed), planned = plan.reduce((s, b) => s + b.e - b.s, 0);
  dialEl.setAttribute('aria-label', `24-hour dial for ${longDate(S.sel)}: ${plan.length} planned blocks, ${fmtD(planned)} planned, ${fmtD(MIN - planned)} free.`);
  renderCenter();
}
function renderCenter() {
  const el = $('dial-center'), k = S.sel, n = now(), t = n.key;
  const gh = ghostRange();
  if (gh) {
    const D = S.drag, lab = S.drop ? (S.drop.ok ? S.drop.name : 'That time is taken') : D.mode === 'draw' ? (D.ring === 'plan' ? 'New block' : 'Log what happened') : nameOf(D.block);
    el.innerHTML = `<div class="dc-date">${esc(lab)}</div><div class="dc-time" style="font-size:clamp(22px,5vw,32px)">${fmtR(gh.a, gh.b)}</div><div class="dc-sub num">${fmtD(gh.b - gh.a)}</div>`;
    return;
  }
  const plan = vis(k, 'plan');
  if (k === t) {
    const T = C.hm(n.min), cb = plan.find(b => !b.closed && b.s <= n.min && n.min < b.e), run = findRunning();
    let line;
    if (run) line = `<span class="pulse" style="display:inline-block;margin-right:6px"></span>${run.b.c === 'sleep' ? 'Asleep' : 'Logging ' + esc(nameOf(run.b))}`;
    else if (cb) line = `<span class="dot" style="background:${cat(cb.c).color};width:8px;height:8px;margin-right:6px;vertical-align:1px"></span>${esc(nameOf(cb))} · ${fmtD(cb.e - n.min)} left`;
    else { const nx = plan.find(b => !b.closed && b.s > n.min); line = 'Free' + (nx ? ' until ' + fmtT(nx.s) : ' for the rest of the day'); }
    el.innerHTML = `<div class="dc-time">${T.h12}:${pad(T.m)}<small>${T.ap}</small></div><div class="dc-date">${longDate(k).replace(',', '')}</div><div class="dc-now">${line}</div>`;
  } else {
    const planned = plan.filter(b => !b.closed).reduce((s, b) => s + b.e - b.s, 0);
    const sub = k < t ? fmtD(eff(k).reduce((s, b) => s + b.e - b.s, 0)) + ' logged' : planned ? fmtD(planned) + ' planned · ' + fmtD(MIN - planned) + ' free' : 'Nothing planned yet';
    el.innerHTML = `<div class="dc-date">${relLabel(k) || WDL[C.weekday(k)]}</div><div class="dc-time" style="font-size:clamp(26px,6vw,38px)">${shortDate(k)}</div><div class="dc-sub num">${sub}</div>${!planned && k > t ? '<div class="dc-sub">Drag around the ring to plan</div>' : ''}`;
  }
}
function miniSVG(k) {
  const t = todayKey(), r = 38, w = 13; let s = `<svg viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="${r}" fill="none" stroke="var(--track)" stroke-width="${w}"/>`;
  const list = k < t ? eff(k) : vis(k, 'plan').filter(b => !b.closed);
  for (const b of list) {
    if (b.e - b.s < 8) continue;
    const a0 = ang(b.s + 4), a1 = ang(Math.min(b.e - 4, b.s + 1439));
    const x0 = 50 + r * Math.sin(a0), y0 = 50 - r * Math.cos(a0), x1 = 50 + r * Math.sin(a1), y1 = 50 - r * Math.cos(a1);
    s += `<path d="M${f2(x0)} ${f2(y0)}A${r} ${r} 0 ${b.e - b.s > 720 ? 1 : 0} 1 ${f2(x1)} ${f2(y1)}" fill="none" stroke="${cat(b.c).color}" stroke-width="${w}" opacity="${b.carried ? 0.55 : 1}"/>`;
  }
  if (k === t) { const a = ang(now().min); s += `<line x1="50" y1="50" x2="${f2(50 + 46 * Math.sin(a))}" y2="${f2(50 - 46 * Math.cos(a))}" stroke="var(--ivory)" stroke-width="1.6"/><circle cx="50" cy="50" r="2.6" fill="var(--ivory)"/>`; }
  return s + '</svg>';
}

/* ---------- side cards ---------- */
const chev = d => `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><path d="${d === 'l' ? 'M12.5 4.5 7 10l5.5 5.5' : 'M7.5 4.5 13 10l-5.5 5.5'}"/></svg>`;
function renderWeek() {
  const el = $('week'), mon = C.mondayOf(S.sel), t = todayKey();
  let h = `<button type="button" class="icon-btn" data-act="week-prev" aria-label="Previous week">${chev('l')}</button><div class="week-days">`;
  for (let i = 0; i < 7; i++) {
    const k = addDays(mon, i);
    h += `<button type="button" class="wd${k === t ? ' is-today' : ''}" data-day="${k}" ${k === S.sel ? 'aria-current="date"' : ''} aria-label="${longDate(k)}">${miniSVG(k)}<span class="wd-l"><span>${WD[C.weekday(k)]}</span><b class="num">${dateParts(k)[2]}</b></span></button>`;
  }
  el.innerHTML = h + `</div><button type="button" class="icon-btn" data-act="week-next" aria-label="Next week">${chev('r')}</button>`;
}
function catChips(attr, selectedId, big) {
  return `<div class="chips${big ? ' big' : ''}">` + cats().map(c => `<button type="button" class="chip" ${attr}="${c.id}" aria-pressed="${c.id === selectedId}"><span class="dot" style="background:${c.color}"></span>${esc(c.name)}</button>`).join('') + '</div>';
}
function checkinBox(p, more) {
  const c = cat(p.c), when = p.srcKey === todayKey() ? fmtR(p.s, p.e) : 'Yesterday · ' + fmtR(p.s, p.e);
  return `<div class="checkin"><div class="q"><span class="dot" style="background:${c.color}"></span>Did ${esc(nameOf(p))} happen?</div><div class="meta num">${when}</div>
    <div class="seg-ans" role="group" aria-label="Answer"><button type="button" class="yes" data-ci="yes" data-k="${p.srcKey}" data-id="${p.id}">Yes</button><button type="button" data-ci="partly" data-k="${p.srcKey}" data-id="${p.id}">Partly</button><button type="button" data-ci="no" data-k="${p.srcKey}" data-id="${p.id}">No</button></div>
    ${more ? `<button type="button" class="btn-text" data-act="checkins" style="justify-self:start">${more} more to check in</button>` : ''}</div>`;
}
function renderNow() {
  const el = $('now-card'), k = S.sel, n = now(), t = n.key;
  if (!S.settings) { el.innerHTML = '<div class="card-h"><h2 id="now-h">Now</h2></div><p class="label">Loading your day…</p>'; return; }
  const plan = vis(k, 'plan');
  if (k !== t) {
    const tpls = S.settings.templates || [];
    if (k > t) {
      const planned = plan.filter(b => !b.closed).reduce((s, b) => s + b.e - b.s, 0);
      el.innerHTML = `<div class="card-h"><h2 id="now-h">${k === addDays(t, 1) ? 'Tomorrow' : 'Plan ahead'}</h2><span class="aside num">${fmtD(planned)} planned</span></div>
        <p class="finding" style="margin-bottom:12px">${planned ? 'Mark up to three blocks as the ones that matter most, and give each a first step.' : 'Decide the few blocks that matter before the day starts.'}</p>
        ${tpls.length ? `<div class="label" style="margin-bottom:8px">Start from a template</div><div class="chips">${tpls.map(p => `<button type="button" class="chip" data-tpl="${p.id}">${esc(p.name)}</button>`).join('')}</div>` : ''}
        <div class="next"><button type="button" class="btn-text" data-act="go-today">Back to today</button></div>`;
    } else {
      const acts = eff(k), done = acts.filter(b => !b.carried).reduce((s, b) => s + b.e - b.s, 0), assumed = acts.filter(b => b.carried).reduce((s, b) => s + b.e - b.s, 0);
      el.innerHTML = `<div class="card-h"><h2 id="now-h">Looking back</h2><span class="aside">${relLabel(k)}</span></div>
        <p class="finding">${fmtD(done)} confirmed · <span>${fmtD(assumed)} assumed from the plan</span></p>
        <p class="label">Tap a block on the inner ring to correct it, or draw on the inner ring to add what happened.</p>
        <div class="next"><button type="button" class="btn-text" data-act="go-today">Back to today</button></div>`;
    }
    return;
  }
  const pending = C.pendingCheckins(S.days, TZ, n);
  const cb = plan.find(b => !b.closed && b.s <= n.min && n.min < b.e), nx = plan.find(b => !b.closed && b.s > n.min), run = findRunning();
  let h = `<div class="card-h"><h2 id="now-h">Now</h2><span class="aside num">${fmtT(n.min)}</span></div>`;
  if (pending.length) h += checkinBox(pending[pending.length - 1], pending.length - 1);
  if (cb) {
    const c = cat(cb.c), done = (n.min - cb.s) / (cb.e - cb.s);
    h += `<div class="now-row"><span class="dot" style="background:${c.color}"></span><div style="min-width:0"><div class="now-title">${esc(nameOf(cb))}</div><div class="now-meta num">${fmtR(cb.s, cb.e)} · ${fmtD(cb.e - n.min)} left</div></div></div>`;
    if (cb.f) h += `<p class="label" style="margin:10px 0 0">First step: <span style="color:var(--text)">${esc(cb.f)}</span></p>`;
    h += `<div class="bar"><i style="width:${(done * 100).toFixed(1)}%;background:${c.color}"></i></div><div class="bar-ends num"><span>${fmtT(cb.s)}</span><span>${fmtT(cb.e)}</span></div>`;
  } else {
    h += `<div class="now-title" style="color:var(--muted)">Free time</div><div class="now-meta">${nx ? 'Until ' + fmtT(nx.s) + ' · ' + fmtD(nx.s - n.min) : 'Nothing else planned today'}</div>`;
  }
  h += '<div class="sect">';
  if (run) {
    const since = run.b.s + (run.k === t ? 0 : -MIN), sec = (n.min - since) * 60;
    if (run.b.c === 'sleep') h += `<div class="timer-live"><span class="pulse"></span><div style="flex:1"><div class="label">Asleep since ${fmtT(run.b.s)}</div><div class="t" id="timer-t">${fmtClock(sec)}</div></div><button type="button" class="btn-primary" data-act="awake">I'm awake</button></div>`;
    else h += `<div class="timer-live"><span class="pulse"></span><div style="flex:1;min-width:0"><div class="label">Logging since ${fmtT(run.b.s)}</div><div class="t" id="timer-t">${esc(nameOf(run.b))} · ${fmtClock(sec)}</div></div><button type="button" class="btn-primary" data-act="stop-timer">Stop</button></div>`;
  } else {
    h += `<div class="label">Log what you're doing now</div>${catChips('data-start', cb ? cb.c : null)}`;
  }
  if (!run || run.b.c !== 'sleep') h += `<div class="row-actions"><button type="button" class="btn-ghost" data-act="sleep">Going to sleep</button>${n.min >= 1020 ? '<button type="button" class="btn-ghost" data-act="shutdown">Close the day</button>' : ''}</div>`;
  h += '</div>';
  if (nx) h += `<div class="next"><span class="dot" style="background:${cat(nx.c).color};width:8px;height:8px"></span><span>Next <b>${esc(nameOf(nx))}</b> at ${fmtT(nx.s)}</span></div>`;
  el.innerHTML = h;
}
function renderAgenda() {
  const el = $('agenda-card'), k = S.sel, t = todayKey(), n = now();
  if (!S.settings) { el.innerHTML = '<div class="card-h"><h2 id="agenda-h">Plan</h2></div>'; return; }
  const plan = vis(k, 'plan'), planned = plan.filter(b => !b.closed).reduce((s, b) => s + b.e - b.s, 0), mk = C.marketDay(k);
  let h = `<div class="card-h"><h2 id="agenda-h">Plan</h2><span class="aside num">${plan.length} blocks · ${fmtD(planned)}</span></div>
    <form class="qa" id="qa-form" autocomplete="off"><input id="qa-input" type="text" placeholder="Add a block: gym 6–7:30pm" aria-label="Quick add a block"><button class="btn-ghost" type="submit">Add</button></form>`;
  if (!plan.length) {
    h += `<div class="empty"><span>No blocks for ${relLabel(k) ? relLabel(k).toLowerCase() : longDate(k)}. Drag around the outer ring, type one above, or start from a template.</span>${(S.settings.templates || []).length ? `<div class="chips">${S.settings.templates.map(p => `<button type="button" class="chip" data-tpl="${p.id}">${esc(p.name)}</button>`).join('')}</div>` : ''}</div>`;
  } else {
    h += '<ul class="ag">'; let cur = 0; const rows = [];
    for (const b of plan) { if (b.s - cur >= 15) rows.push({ free: true, s: cur, e: b.s }); rows.push(b); cur = Math.max(cur, b.e); }
    if (MIN - cur >= 15) rows.push({ free: true, s: cur, e: MIN });
    for (const r of rows) {
      if (r.free) { h += `<li><div class="ag-row free"><span class="dot"></span><div style="min-width:0"><div class="t">Free</div></div><div class="r num">${fmtD(r.e - r.s)}<small>${fmtR(r.s, r.e)}</small></div></div></li>`; continue; }
      const c = cat(r.c), isNow = k === t && r.s <= n.min && n.min < r.e && !r.closed, ck = r.k || [], dn = ck.filter(x => x.d).length;
      const sub = [r.closed ? r.market.label : '', r.ny && !r.closed ? 'Follows New York time' : '', r.spill ? 'From yesterday' : '', r.cutEnd ? 'Ends ' + fmtT(r.fullE) + ' tomorrow' : '', (r.t && r.t !== c.name) ? c.name : '', ck.length ? dn + '/' + ck.length + ' done' : '', r.f ? 'First step: ' + r.f : '', r.skipped ? "Didn't happen" : ''].filter(Boolean).join(' · ');
      const range = r.spill ? fmtR(r.fullS - MIN, r.e) : r.cutEnd ? fmtR(r.s, r.fullE) : fmtR(r.s, r.e);
      h += `<li><button type="button" class="ag-row${r.closed ? ' closed' : ''}" data-edit="${r.id}" data-src="${r.srcKey}"><span class="dot" style="background:${c.color}"></span><div style="min-width:0"><div class="t">${esc(nameOf(r))}${r.top ? '<span class="tag soft">Top 3</span>' : ''}${isNow ? '<span class="tag now">now</span>' : ''}</div><div class="s">${esc(sub)}</div></div><div class="r num">${fmtD((r.cutEnd ? r.fullE : r.e) - (r.spill ? r.fullS - MIN : r.s))}<small>${range}</small></div></button></li>`;
    }
    h += '</ul>';
  }
  h += `<div class="ag-foot"><button type="button" class="btn-text" data-act="add-block">+ Add a block</button>${plan.length ? '<button type="button" class="btn-text" data-act="save-tpl">Save day as template</button>' : ''}</div>`;
  el.innerHTML = h;
}
const gripSVG = '<svg viewBox="0 0 14 14" fill="currentColor"><circle cx="4" cy="3" r="1.3"/><circle cx="10" cy="3" r="1.3"/><circle cx="4" cy="7" r="1.3"/><circle cx="10" cy="7" r="1.3"/><circle cx="4" cy="11" r="1.3"/><circle cx="10" cy="11" r="1.3"/></svg>';
function renderInbox() {
  const el = $('inbox-card'); if (!S.settings) { el.innerHTML = ''; return; }
  const items = (S.inbox.items || []).filter(i => !i.done), t = todayKey();
  let h = `<div class="card-h"><h2 id="inbox-h">Inbox</h2><span class="aside">${items.length ? items.length + ' open' : ''}</span></div>
    <form class="qa" id="ib-form" autocomplete="off"><input id="ib-input" type="text" placeholder="Capture a task, e.g. review trades 30m" aria-label="Add a task to the inbox"><button class="btn-ghost" type="submit">Add</button></form>`;
  if (!items.length) h += `<p class="note">Tasks without a time live here. Drag one onto the dial to give it a time.</p>`;
  else {
    h += '<ul class="ib">';
    for (const it of items) {
      const due = it.due ? (it.due === t ? 'Due today' : it.due === addDays(t, 1) ? 'Tomorrow' : it.due < t ? 'Was due ' + shortDate(it.due) : shortDate(it.due)) : '';
      const sub = [it.c ? cat(it.c).name : '', fmtD(it.dur || 60), due].filter(Boolean).join(' · ');
      h += `<li><button type="button" class="handle" data-grip="${it.id}" aria-label="Drag ${esc(it.t)} onto the dial">${gripSVG}</button><button type="button" class="it" data-item="${it.id}"><div class="t">${esc(it.t)}</div><div class="s">${esc(sub)}</div></button><button type="button" class="btn-text" data-sched="${it.id}">Schedule</button></li>`;
    }
    h += '</ul>';
  }
  el.innerHTML = h;
}
function rangeKeys() {
  if (S.reviewRange === 'week') { const m = C.mondayOf(S.sel); return Array.from({ length: 7 }, (_, i) => addDays(m, i)); }
  const [y, m] = dateParts(S.view === 'month' && S.monthAnchor ? S.monthAnchor : S.sel); const n = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Array.from({ length: n }, (_, i) => C.keyFromParts(y, m, i + 1));
}
function renderReview(elId, hId) {
  const el = $(elId); if (!S.settings) { el.innerHTML = ''; return; }
  const keys = rangeKeys(), n = now(), t = n.key, agg = {};
  let done = 0, assumed = 0, missed = 0;
  for (const k of keys) {
    const tt = C.dayTotals(S.days, k, TZ, n);
    for (const c in tt) { const a = agg[c] || (agg[c] = { plan: 0, done: 0, assumed: 0 }); a.plan += tt[c].plan; a.done += tt[c].done; a.assumed += tt[c].assumed; done += tt[c].done; assumed += tt[c].assumed; }
    if (k <= t) for (const b of vis(k, 'plan')) if (b.skipped && !b.spill) missed += b.e - b.s;
  }
  const order = cats().map(c => c.id).concat(Object.keys(agg).filter(id => !cats().find(c => c.id === id))).filter(id => agg[id] && (agg[id].plan || agg[id].done || agg[id].assumed));
  const max = Math.max(1, ...order.map(id => Math.max(agg[id].plan, agg[id].done + agg[id].assumed)));
  const [y0, m0, d0] = dateParts(keys[0]);
  const label = S.reviewRange === 'week' ? (C.mondayOf(S.sel) === C.mondayOf(t) ? 'This week' : 'Week of ' + MON[m0 - 1].slice(0, 3) + ' ' + d0) : MON[m0 - 1] + ' ' + y0;
  let h = `<div class="card-h" style="align-items:center"><h2 id="${hId}">${label}</h2><div class="seg" style="margin-left:auto" role="group" aria-label="Review range"><button type="button" data-range="week" aria-pressed="${S.reviewRange === 'week'}">Week</button><button type="button" data-range="month" aria-pressed="${S.reviewRange === 'month'}">Month</button></div></div>`;
  if (!order.length) { el.innerHTML = h + `<div class="empty">Nothing planned or logged in this ${S.reviewRange} yet. Totals per category appear here as the days fill.</div>`; return; }
  h += `<p class="finding"><b class="num" style="font-weight:600">${fmtD(done)}</b> confirmed · <span class="num">${fmtD(assumed)} assumed${missed ? ' · ' + fmtD(missed) + " didn't happen" : ''}</span>${assumed > done ? '<br><span>Check in after each block so the assumed time becomes real numbers.</span>' : ''}</p><div class="rv">`;
  for (const id of order) {
    const c = cat(id), a = agg[id], pct = v => (v / max * 100).toFixed(2);
    h += `<div class="rv-row"><div class="rv-top"><span class="rv-name"><span class="dot" style="background:${c.color};width:8px;height:8px"></span>${esc(c.name)}</span><span class="rv-val num"><b>${fmtD(a.done)}</b> done${a.assumed ? ' · ' + fmtD(a.assumed) + ' assumed' : ''} · ${fmtD(a.plan)} planned</span></div>
      <div class="rv-track"><span class="pl" style="width:${pct(a.plan)}%"></span><span style="left:0;width:${pct(a.done)}%;background:${c.color}"></span><span style="left:${pct(a.done)}%;width:${pct(a.assumed)}%;background:${c.color};opacity:.4"></span>${a.plan ? `<span class="tk" style="left:calc(${pct(a.plan)}% - 1px)"></span>` : ''}</div></div>`;
  }
  el.innerHTML = h + `</div><p class="rv-note">Solid: confirmed. Faded: assumed from your plan. Tick: planned for the whole ${S.reviewRange}. A missed block costs nothing; each day starts clean.</p>`;
}
function renderMonth() {
  const el = $('month-card'), [y, m] = dateParts(S.monthAnchor || S.sel), t = todayKey();
  const first = C.keyFromParts(y, m, 1), start = addDays(first, -((C.weekday(first) + 6) % 7));
  let h = `<div class="month-head"><h1 id="month-title">${MON[m - 1]} ${y}</h1><div class="nav"><button type="button" class="icon-btn" data-act="month-prev" aria-label="Previous month">${chev('l')}</button><button type="button" class="icon-btn" data-act="month-next" aria-label="Next month">${chev('r')}</button></div></div><div class="mgrid">`;
  h += ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map(w => `<div class="wk">${w}</div>`).join('');
  for (let i = 0; i < 42; i++) {
    const k = addDays(start, i), [, mm, dd] = dateParts(k); if (i >= 35 && mm !== m) break;
    h += `<button type="button" class="mcell${mm !== m ? ' out' : ''}${k === t ? ' is-today' : ''}" data-day="${k}" aria-label="${longDate(k)}"><span class="n">${dd}</span>${miniSVG(k)}</button>`;
  }
  el.innerHTML = h + '</div>';
}
function render() {
  if (mode === 'cloud' && !uid) return;
  const t = todayKey();
  $('day-view').hidden = S.view !== 'day'; $('week').hidden = S.view !== 'day'; $('month-view').hidden = S.view !== 'month';
  $('nav-day').setAttribute('aria-pressed', S.view === 'day'); $('nav-month').setAttribute('aria-pressed', S.view === 'month');
  if (S.view === 'month') { renderMonth(); renderReview('review-card-m', 'review-h-m'); return; }
  const mk = C.marketDay(S.sel);
  $('day-title').textContent = longDate(S.sel);
  $('day-rel').textContent = relLabel(S.sel) + (mk.status === 'closed' || mk.status === 'early' ? (relLabel(S.sel) ? ' · ' : '') + mk.label : '');
  $('go-today').hidden = S.sel === t;
  renderWeek(); renderDial(); renderNow(); renderAgenda(); renderInbox(); renderReview('review-card', 'review-h');
}

/* ---------- pointer on the dial: draw, move, resize, tap ---------- */
function svgPoint(ev) { const p = dialEl.createSVGPoint(); p.x = ev.clientX; p.y = ev.clientY; const q = p.matrixTransform(dialEl.getScreenCTM().inverse()); const dx = q.x - CX, dy = q.y - CX; let a = Math.atan2(dx, -dy); if (a < 0) a += Math.PI * 2; return { r: Math.hypot(dx, dy), m: a / (Math.PI * 2) * MIN }; }
function buzz() { try { navigator.vibrate && navigator.vibrate(4); } catch (_) {} }
function neighbours(k, ring, block) {
  const list = occ(k, ring, block.id);
  const lo = list.filter(x => x.e <= block.s).reduce((s, x) => Math.max(s, x.e), 0);
  const hi = list.filter(x => x.s >= block.e).reduce((s, x) => Math.min(s, x.s), MIN);
  return [Math.max(0, lo), Math.min(MIN, hi)];
}
dialEl.addEventListener('pointerdown', ev => {
  if (!S.settings || ev.button > 0) return;
  const { r, m } = svgPoint(ev); let ring = null;
  if (r >= 196 && r <= 266) ring = 'plan'; else if (r >= 158 && r < 196) ring = 'actual'; else return;
  const k = S.sel, n = now();
  if (ring === 'actual' && k > n.key) { toast('The inner ring fills in as the day happens'); return; }
  const limit = ring === 'actual' ? (k === n.key ? n.min : MIN) : MIN;
  const list = ring === 'plan' ? vis(k, 'plan') : eff(k), hit = list.find(b => b.s <= m && m < b.e);
  if (hit) {
    const editable = !hit.spill && !hit.closed && !hit.running && !(ring === 'actual' && hit.carried) && !hit.cutEnd;
    const edgeTol = Math.max(8, (hit.e - hit.s) * 0.12);
    let mode = 'tap', edge = null;
    if (editable && hit.e - hit.s >= 30) { if (m - hit.s < edgeTol) { mode = 'resize'; edge = 's'; } else if (hit.e - m < edgeTol) { mode = 'resize'; edge = 'e'; } }
    S.drag = { mode, ring, block: hit, edge, a: hit.s, b: hit.e, x: ev.clientX, y: ev.clientY, last: m, acc: 0, canMove: editable, limit, bounds: editable ? neighbours(k, ring, hit) : null };
  } else {
    const busy = occ(k, ring); const gap = C.freeGap(busy, m); if (!gap) return;
    const lo = Math.max(0, gap[0]), hi = Math.min(MIN, gap[1], limit); if (hi - lo < 15) { if (ring === 'actual' && m > limit) toast('You can only log time that has passed'); return; }
    const anchor = Math.min(Math.max(snap(m), lo), hi);
    S.drag = { mode: 'draw', ring, anchor, lo, hi, a: anchor, b: anchor, last: m, acc: 0, x: ev.clientX, y: ev.clientY };
  }
  dialEl.setPointerCapture(ev.pointerId); ev.preventDefault();
});
dialEl.addEventListener('pointermove', ev => {
  const D = S.drag; if (!D) return;
  const { m } = svgPoint(ev); let dm = m - D.last; if (dm > 720) dm -= MIN; if (dm < -720) dm += MIN; D.acc += dm; D.last = m;
  if (D.mode === 'tap') { if (Math.hypot(ev.clientX - D.x, ev.clientY - D.y) > 8 && D.canMove) { D.mode = 'move'; } else return; }
  let a = D.a, b = D.b;
  if (D.mode === 'draw') {
    const cur = D.anchor + D.acc; a = Math.max(D.lo, snap(Math.min(D.anchor, cur))); b = Math.min(D.hi, snap(Math.max(D.anchor, cur)));
  } else if (D.mode === 'move') {
    const dur = D.block.e - D.block.s, [lo, hi] = D.bounds;
    a = Math.min(Math.max(lo, D.block.s + Math.round(D.acc / 15) * 15), hi - dur); b = a + dur;
  } else if (D.mode === 'resize') {
    const [lo, hi] = D.bounds;
    if (D.edge === 's') a = Math.min(D.block.e - 15, Math.max(lo, snap(D.block.s + D.acc)));
    else b = Math.max(D.block.s + 15, Math.min(hi, D.limit, snap(D.block.e + D.acc)));
  }
  if (a !== D.a || b !== D.b) { if (b - a !== D.b - D.a || D.mode === 'move') buzz(); D.a = a; D.b = b; renderDial(); }
});
function endDrag(ev, cancel) {
  const D = S.drag; if (!D) return; S.drag = null;
  try { dialEl.releasePointerCapture(ev.pointerId); } catch (_) {}
  if (cancel) { renderDial(); return; }
  if (D.mode === 'tap') { openEditor(D.ring, D.block); return; }
  if (D.mode === 'move' || D.mode === 'resize') {
    if (D.a === D.block.s && D.b === D.block.e) { renderDial(); return; }
    const src = D.block.srcKey;
    change(['d-' + src], () => {
      const raw = ensureDay(src)[D.ring].find(x => x.id === D.block.id); if (!raw) return;
      if (raw.ny) { raw.s = C.localToNy(src, D.a, TZ); raw.e = C.localToNy(src, D.b, TZ); }
      else { raw.s = D.a; if (raw.e != null) raw.e = D.b; }
    }, (D.mode === 'move' ? 'Moved ' : 'Changed ') + nameOf(D.block) + ' to ' + fmtR(D.a, D.b));
    return;
  }
  if (D.b - D.a < 15) { renderDial(); if (D.b === D.a) toast('Drag along the ring to draw a block'); return; }
  openNewBlock(D.ring, D.a, D.b);
}
dialEl.addEventListener('pointerup', ev => endDrag(ev));
dialEl.addEventListener('pointercancel', ev => endDrag(ev, true));

/* ---------- inbox drag onto the dial ---------- */
let idrag = null;
document.addEventListener('pointerdown', ev => {
  const g = ev.target.closest('[data-grip]'); if (!g) return;
  const it = S.inbox.items.find(i => i.id === g.dataset.grip); if (!it) return;
  idrag = { it, id: ev.pointerId, moved: false, x: ev.clientX, y: ev.clientY, el: g };
  document.body.style.userSelect = 'none'; document.body.style.webkitUserSelect = 'none';
  g.setPointerCapture(ev.pointerId); ev.preventDefault();
});
document.addEventListener('pointermove', ev => {
  if (!idrag || ev.pointerId !== idrag.id) return;
  if (!idrag.moved && Math.hypot(ev.clientX - idrag.x, ev.clientY - idrag.y) < 6) return;
  idrag.moved = true;
  const gh = $('drag-ghost'); gh.hidden = false; gh.textContent = idrag.it.t; gh.style.left = ev.clientX + 'px'; gh.style.top = ev.clientY + 'px';
  const rect = dialEl.getBoundingClientRect(), inside = ev.clientX >= rect.left && ev.clientX <= rect.right && ev.clientY >= rect.top && ev.clientY <= rect.bottom;
  let next = null;
  if (inside && S.view === 'day') {
    const { r, m } = svgPoint(ev);
    if (r > 120 && r < 300) {
      const dur = idrag.it.dur || 60; let a = snap(m - dur / 2); a = Math.max(0, Math.min(MIN - dur, a));
      const ok = !C.clash(occ(S.sel, 'plan'), a, a + dur);
      next = { a, b: a + dur, ok, name: idrag.it.t };
    }
  }
  $('dial-wrap').classList.toggle('drop-hover', !!next);
  if (JSON.stringify(next) !== JSON.stringify(S.drop)) { S.drop = next; renderDial(); }
});
function endIdrag(ev, cancel) {
  if (!idrag || ev.pointerId !== idrag.id) return;
  const d = idrag; idrag = null; $('drag-ghost').hidden = true; document.body.style.userSelect = ''; document.body.style.webkitUserSelect = ''; $('dial-wrap').classList.remove('drop-hover');
  const drop = S.drop; S.drop = null;
  if (!d.moved) { renderDial(); openItem(d.it.id); return; }
  if (cancel || !drop) { renderDial(); return; }
  if (!drop.ok) { renderDial(); toast('That time is taken. Drop it on a free part of the outer ring.'); return; }
  const k = S.sel, blk = { id: newId(), s: drop.a, e: drop.b, c: d.it.c || S.settings.lastCat || 'study', t: d.it.t, k: d.it.k || undefined };
  change(['d-' + k, 'inbox'], () => { ensureDay(k).plan.push(blk); S.inbox.items = S.inbox.items.filter(i => i.id !== d.it.id); }, d.it.t + ' · ' + fmtR(drop.a, drop.b));
  ink(blk.id);
}
document.addEventListener('pointerup', ev => endIdrag(ev));
document.addEventListener('pointercancel', ev => endIdrag(ev, true));
function ink(id) { S.lastInk = id; renderDial(); setTimeout(() => { S.lastInk = null; }, 700); }

/* ---------- sheets ---------- */
const sheetRoot = $('sheet-root'); let lastFocus = null;
const sheetOpen = () => !!sheetRoot.innerHTML;
function openSheet(html, onMount) {
  lastFocus = document.activeElement;
  sheetRoot.innerHTML = `<div class="backdrop" data-close="1"><div class="sheet" role="dialog" aria-modal="true">${html}</div></div>`;
  const sh = sheetRoot.querySelector('.sheet'); onMount && onMount(sh);
  const f = sh.querySelector('[autofocus]') || sh.querySelector('button, input, select'); f && f.focus({ preventScroll: true });
  return sh;
}
function closeSheet() { sheetRoot.innerHTML = ''; S.selected = null; render(); if (lastFocus && lastFocus.isConnected) lastFocus.focus({ preventScroll: true }); }
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && sheetOpen()) closeSheet();
  if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) { e.preventDefault(); undo(); }
});
sheetRoot.addEventListener('click', e => { if (e.target.dataset.close) closeSheet(); });
function timeOpts(sel, from, to, nextDayFrom = MIN) {
  let o = ''; const vals = []; for (let m = from; m <= to; m += 15) vals.push(m);
  if (sel != null && !vals.includes(sel) && sel >= from && sel <= to) { vals.push(sel); vals.sort((a, b) => a - b); }
  for (const m of vals) o += `<option value="${m}"${m === sel ? ' selected' : ''}>${fmtT(m)}${m >= nextDayFrom ? ' (next day)' : ''}</option>`;
  return o;
}

function openNewBlock(ring, a, b) {
  const last = S.settings.lastCat || 'study';
  S.selected = null; renderDial();
  openSheet(`<div><h3>${ring === 'plan' ? 'New block' : 'What happened?'}</h3><div class="sub num">${fmtR(a, b)} · ${fmtD(b - a)}</div></div>
    <div class="field"><span class="lab">Category</span>${catChips('data-pick', null, true)}</div>
    <div class="field"><label for="nb-title">Name (optional)</label><input id="nb-title" type="text" placeholder="e.g. Backtest gap fades"></div>
    <div class="sheet-foot"><button type="button" class="btn-text" data-x="cancel">Cancel</button><span class="grow"></span><span class="note">Tap a category to add</span></div>`, sh => {
    sh.addEventListener('click', e => { const p = e.target.closest('[data-pick]'); if (p) create(p.dataset.pick); if (e.target.closest('[data-x="cancel"]')) closeSheet(); });
    sh.querySelector('#nb-title').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); create(C.guessCat(e.target.value, cats()) || last); } });
  });
  function create(c) {
    const t = sheetRoot.querySelector('#nb-title')?.value.trim() || '', k = S.sel;
    if (C.clash(occ(k, ring), a, b)) { toast('That time is taken'); return; }
    const blk = { id: newId(), s: a, e: b, c, t: t || cat(c).name };
    sheetRoot.innerHTML = '';
    change(['d-' + k, 'settings'], () => { ensureDay(k)[ring].push(blk); S.settings.lastCat = c; }, 'Added ' + blk.t);
    ink(blk.id);
  }
}
function findPlanDay(planId, nearKey) {
  for (const k of [nearKey, addDays(nearKey, -1), addDays(nearKey, 1)]) if (S.days[k] && S.days[k].plan.some(b => b.id === planId)) return k;
  return null;
}
function openEditor(ring, vb) {
  const k = S.sel;
  // A carried segment becomes a real entry the moment you open it.
  if (ring === 'actual' && vb.carried) {
    const nb = { id: newId(), s: vb.s, e: vb.e, c: vb.c, t: vb.t, from: vb.from };
    checkpoint(['d-' + k]); ensureDay(k).actual.push(nb); saveDay(k);
    vb = { ...nb, srcKey: k, fullS: nb.s, fullE: nb.e };
  }
  const src = vb.srcKey || k, d = ensureDay(src), raw = d[ring].find(x => x.id === vb.id);
  if (!raw) { toast('That block no longer exists'); render(); return; }
  S.selected = { ring, id: raw.id }; renderDial();
  const running = raw.e == null, n = now();
  const s0 = vb.fullS ?? vb.s, e0 = running ? null : (vb.fullE ?? vb.e);
  const isPastBlock = !running && (src < n.key || (src === n.key && e0 <= n.min));
  const ck = (raw.k || []).map(x => ({ ...x }));
  const capEnd = ring === 'actual' ? Math.max(s0 + 15, minutesSince(src)) : s0 + MIN;
  const drawCk = () => { const box = sheetRoot.querySelector('#ck-list'); if (box) box.innerHTML = ck.map((x, i) => `<div class="ck-item${x.d ? ' done' : ''}"><input type="checkbox" id="ck-${i}" data-ck="${i}"${x.d ? ' checked' : ''}><span><label for="ck-${i}">${esc(x.x)}</label></span><button type="button" class="icon-btn" data-ckdel="${i}" aria-label="Remove item" style="width:28px;height:28px"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M5 5l10 10M15 5 5 15"/></svg></button></div>`).join(''); };
  const sub = (relLabel(src) || longDate(src)) + ' · ' + (running ? 'running since ' + fmtT(s0) : fmtR(s0, e0) + ' · ' + fmtD(e0 - s0));
  openSheet(`<div><h3>${ring === 'plan' ? 'Planned block' : 'What happened'}</h3><div class="sub num">${esc(sub)}${raw.ny ? ' · follows New York time' : ''}</div></div>
    <div class="field"><label for="ed-title">Name</label><input id="ed-title" type="text" value="${esc(raw.t || '')}"></div>
    <div class="field"><span class="lab">Category</span>${catChips('data-ecat', raw.c)}</div>
    <div class="two"><div class="field"><label for="ed-s">Starts</label><select id="ed-s">${timeOpts(s0, 0, MIN - 15)}</select></div>
      <div class="field"><label for="ed-e">Ends</label>${running ? '<button type="button" class="btn-primary" data-x="stop" style="height:40px">Stop now</button>' : `<select id="ed-e">${timeOpts(e0, s0 + 15, capEnd)}</select>`}</div></div>
    ${ring === 'plan' ? `<label class="switch"><span>Follow New York time<br><span class="note">Moves with US clock changes; for market sessions</span></span><input type="checkbox" id="ed-ny"${raw.ny ? ' checked' : ''}></label>
      <label class="switch"><span>One of the day's top 3</span><input type="checkbox" id="ed-top"${raw.top ? ' checked' : ''}></label>
      <div class="field"><label for="ed-first">First step</label><input id="ed-first" type="text" value="${esc(raw.f || '')}" placeholder="The very first action, e.g. open the chart and mark levels"></div>` : ''}
    <div class="field"><span class="lab">Checklist</span><div class="ck" id="ck-list"></div><div class="qa" style="margin:0"><input id="ck-new" type="text" placeholder="Add an item" aria-label="Add a checklist item"><button type="button" class="btn-ghost" data-x="ck-add">Add</button></div></div>
    ${isPastBlock ? `<div class="field"><span class="lab">How did it feel?</span><div class="chips" role="group" aria-label="How did it feel">${['Drained', 'Okay', 'Energised'].map(f => `<button type="button" class="chip" data-feel="${f.toLowerCase()}" aria-pressed="${raw.feel === f.toLowerCase()}">${f}</button>`).join('')}</div></div>` : ''}
    <div class="err" id="ed-err" hidden></div>
    <div class="sheet-foot"><button type="button" class="btn-text danger" data-x="del">${ring === 'actual' && raw.from ? "Didn't happen" : 'Delete'}</button><span class="grow"></span><button type="button" class="btn-text" data-x="cancel">Cancel</button><button type="button" class="btn-primary" data-x="save">Save</button></div>`, sh => {
    drawCk();
    let selCat = raw.c, feel = raw.feel || null;
    const err = m => { const e = sh.querySelector('#ed-err'); e.hidden = false; e.textContent = m; };
    const sSel = sh.querySelector('#ed-s'), eSel = sh.querySelector('#ed-e');
    sSel.addEventListener('change', () => { if (!eSel) return; const ns = +sSel.value, keep = Math.max(ns + 15, +eSel.value); eSel.innerHTML = timeOpts(Math.min(keep, ring === 'actual' ? Math.max(ns + 15, minutesSince(src)) : ns + MIN), ns + 15, ring === 'actual' ? Math.max(ns + 15, minutesSince(src)) : ns + MIN); });
    sh.addEventListener('click', e => {
      const c = e.target.closest('[data-ecat]'); if (c) { selCat = c.dataset.ecat; sh.querySelectorAll('[data-ecat]').forEach(x => x.setAttribute('aria-pressed', x === c)); return; }
      const f = e.target.closest('[data-feel]'); if (f) { feel = feel === f.dataset.feel ? null : f.dataset.feel; sh.querySelectorAll('[data-feel]').forEach(x => x.setAttribute('aria-pressed', x.dataset.feel === feel)); return; }
      const cd = e.target.closest('[data-ckdel]'); if (cd) { ck.splice(+cd.dataset.ckdel, 1); drawCk(); return; }
      const x = e.target.closest('[data-x]')?.dataset.x;
      if (x === 'ck-add') addItem();
      if (x === 'cancel') closeSheet();
      if (x === 'stop') { sheetRoot.innerHTML = ''; stopTimer(); }
      if (x === 'del') {
        sheetRoot.innerHTML = ''; S.selected = null;
        if (ring === 'plan') change(['d-' + src], () => { d.plan = d.plan.filter(b => b.id !== raw.id); }, 'Deleted ' + nameOf(raw));
        else {
          const pk = raw.from ? findPlanDay(raw.from, src) : null;
          change(['d-' + src].concat(pk && pk !== src ? ['d-' + pk] : []), () => {
            d.actual = d.actual.filter(b => b.id !== raw.id);
            if (pk) { const pd = ensureDay(pk); if (!pd.skip.includes(raw.from)) pd.skip.push(raw.from); }
          }, raw.from ? 'Marked as not happened' : 'Deleted');
        }
      }
      if (x === 'save') {
        const ns = +sSel.value, ne = running ? null : +eSel.value;
        if (!running && ne <= ns) return err('The end has to be after the start.');
        const hit = C.clash(occ(src, ring, raw.id), ns, running ? ns + 1 : ne);
        if (hit) return err('That overlaps ' + (hit.t || 'another block') + '. Pick a free time.');
        const ny = ring === 'plan' && sh.querySelector('#ed-ny').checked;
        sheetRoot.innerHTML = ''; S.selected = null;
        change(['d-' + src], () => {
          raw.t = sh.querySelector('#ed-title').value.trim() || cat(selCat).name; raw.c = selCat; raw.k = ck;
          if (ny) { raw.ny = true; raw.s = C.localToNy(src, ns, TZ); raw.e = C.localToNy(src, ne, TZ); }
          else { delete raw.ny; raw.s = ns; if (!running) raw.e = ne; }
          if (ring === 'plan') { raw.f = sh.querySelector('#ed-first').value.trim(); raw.top = sh.querySelector('#ed-top').checked || undefined; }
          if (feel) raw.feel = feel; else delete raw.feel;
        }, 'Saved');
      }
    });
    sh.addEventListener('change', e => { const i = e.target.dataset.ck; if (i != null) { ck[+i].d = e.target.checked; drawCk(); } });
    sh.querySelector('#ck-new').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addItem(); } });
    function addItem() { const inp = sh.querySelector('#ck-new'); const v = inp.value.trim(); if (!v) return; ck.push({ x: v, d: false }); inp.value = ''; drawCk(); inp.focus(); }
  });
}

/* ---------- check-ins ---------- */
function answerCheckin(k, id, ans) {
  const d = ensureDay(k), raw = d.plan.find(b => b.id === id); if (!raw) return;
  const b = C.resolvePlanBlock(k, raw, TZ), name = nameOf(b);
  if (ans === 'no') { change(['d-' + k], () => { if (!d.skip.includes(id)) d.skip.push(id); }, name + ": didn't happen"); return; }
  const segs = C.subtract([{ s: b.s, e: b.e }], occ(k, 'actual'));
  const made = segs.map(sg => ({ id: newId(), s: sg.s, e: sg.e, c: b.c, t: b.t, from: id }));
  if (!made.length) made.push({ id: newId(), s: b.s, e: b.s, c: b.c, t: b.t, from: id });
  change(['d-' + k], () => { d.actual.push(...made); }, ans === 'yes' ? name + ' confirmed' : null);
  if (ans === 'partly') { const m = made[0]; S.sel = k; openEditor('actual', { ...m, srcKey: k, fullS: m.s, fullE: m.e }); }
}
function openCheckins() {
  const draw = () => {
    const list = C.pendingCheckins(S.days, TZ, now());
    if (!list.length) { closeSheet(); toast('All checked in'); return; }
    sheetRoot.querySelector('#ci-list').innerHTML = list.map(p => `<div class="ci-row"><span class="dot" style="background:${cat(p.c).color}"></span><div style="min-width:0"><div class="t">${esc(nameOf(p))}</div><div class="s num">${p.srcKey === todayKey() ? 'Today' : 'Yesterday'} · ${fmtR(p.s, p.e)}</div></div><div class="seg-ans"><button type="button" class="yes" data-ci="yes" data-k="${p.srcKey}" data-id="${p.id}">Yes</button><button type="button" data-ci="partly" data-k="${p.srcKey}" data-id="${p.id}">Partly</button><button type="button" data-ci="no" data-k="${p.srcKey}" data-id="${p.id}">No</button></div></div>`).join('');
  };
  openSheet(`<div><h3>Check in</h3><div class="sub">Did these happen as planned?</div></div><div id="ci-list"></div><div class="sheet-foot"><button type="button" class="btn-text" data-x="all">All happened as planned</button><span class="grow"></span><button type="button" class="btn-primary" data-x="done">Done</button></div>`, sh => {
    draw();
    sh.addEventListener('click', e => {
      const x = e.target.closest('[data-x]')?.dataset.x;
      if (x === 'done') closeSheet();
      if (x === 'all') { for (const p of C.pendingCheckins(S.days, TZ, now())) answerCheckin(p.srcKey, p.id, 'yes'); draw(); }
      const b = e.target.closest('[data-ci]'); if (b) { e.stopPropagation(); if (b.dataset.ci === 'partly') { answerCheckin(b.dataset.k, b.dataset.id, 'partly'); return; } answerCheckin(b.dataset.k, b.dataset.id, b.dataset.ci); draw(); }
    });
  });
}

/* ---------- timers and sleep ---------- */
function startTimer(c) {
  const n = now(), k = n.key, nm = Math.floor(n.min), run = findRunning();
  const ids = ['d-' + k]; if (run && run.k !== k) ids.push('d-' + run.k);
  change(ids.concat('settings'), () => {
    if (run) run.b.e = Math.max(run.b.s + 1, Math.ceil(minutesSince(run.k)));
    const d = ensureDay(k);
    d.actual = d.actual.filter(b => b.s < nm).map(b => (b.e != null && b.e > nm ? { ...b, e: nm } : b));
    d.actual.push({ id: newId(), s: nm, e: null, c, t: cat(c).name });
    S.settings.lastCat = c === 'sleep' ? S.settings.lastCat : c;
  }, c === 'sleep' ? 'Good night. Tap "I’m awake" when you get up.' : 'Logging ' + cat(c).name);
}
function stopTimer() {
  const run = findRunning(); if (!run) return;
  const e = Math.max(run.b.s + 1, Math.ceil(minutesSince(run.k)));
  change(['d-' + run.k], () => { run.b.e = e; }, nameOf(run.b) + ' · ' + fmtD(e - run.b.s) + ' logged');
  return run;
}

/* ---------- morning glance ---------- */
function maybeGlance(force) {
  if (!S.settings || sheetOpen() || S.view !== 'day') return;
  const n = now(), seen = (() => { try { return localStorage.getItem('meridian-glance'); } catch (_) { return null; } })();
  const run = findRunning();
  if (!force && (seen === n.key || n.min < 240 || n.min > 900 || (run && run.b.c === 'sleep'))) return;
  try { localStorage.setItem('meridian-glance', n.key); } catch (_) {}
  const k = n.key, plan = vis(k, 'plan').filter(b => !b.closed && b.c !== 'sleep');
  const first = plan.find(b => b.e > n.min), tops = plan.filter(b => b.top), due = S.inbox.items.filter(i => !i.done && i.due && i.due <= k);
  const yPending = C.pendingCheckins(S.days, TZ, n).filter(p => p.srcKey < k).length, mk = C.marketDay(k);
  openSheet(`<div><h3>${longDate(k)}</h3><div class="sub">${plan.length ? fmtD(plan.reduce((s, b) => s + b.e - b.s, 0)) + ' planned' : 'Nothing planned yet'}${mk.status !== 'open' && mk.status !== 'weekend' ? ' · ' + mk.label : ''}</div></div>
    ${first ? `<div class="glance-first"><span class="label">${first.s <= n.min ? 'Now' : 'First up at ' + fmtT(first.s)}</span><div class="big">${esc(nameOf(first))}</div><span class="label">${first.f ? 'First step: <span style="color:var(--text)">' + esc(first.f) + '</span>' : fmtR(first.s, first.e)}</span></div>` : '<div class="empty">No blocks yet today. Start from a template or draw on the dial.</div>'}
    ${tops.length ? `<div class="field"><span class="lab">What matters most today</span>${tops.map(b => `<div class="ci-row"><span class="dot" style="background:${cat(b.c).color}"></span><div><div class="t">${esc(nameOf(b))}</div><div class="s num">${fmtR(b.s, b.e)}${b.f ? ' · ' + esc(b.f) : ''}</div></div><span></span></div>`).join('')}</div>` : ''}
    ${due.length ? `<div class="field"><span class="lab">From your inbox, due today</span><p class="note" style="color:var(--text)">${due.map(i => esc(i.t)).join(' · ')}</p></div>` : ''}
    ${yPending ? `<button type="button" class="btn-ghost" data-x="ci" style="justify-self:start">${yPending} block${yPending > 1 ? 's' : ''} from yesterday to check in</button>` : ''}
    <div class="sheet-foot"><span class="grow"></span><button type="button" class="btn-primary" data-x="go" autofocus>Start the day</button></div>`, sh => {
    sh.addEventListener('click', e => { const x = e.target.closest('[data-x]')?.dataset.x; if (x === 'go') closeSheet(); if (x === 'ci') { sheetRoot.innerHTML = ''; openCheckins(); } });
  });
}

/* ---------- evening shutdown ---------- */
function openShutdown(step = 0) {
  const n = now(), today = n.min < 240 ? addDays(n.key, -1) : n.key, tmr = addDays(today, 1);
  const steps = ['Today', 'Inbox', 'Tomorrow', 'Done'];
  const bar = `<div class="steps" aria-hidden="true">${steps.map((_, i) => `<i class="${i <= step ? 'on' : ''}"></i>`).join('')}</div>`;
  const foot = (nextLabel = 'Next') => `<div class="sheet-foot">${step ? '<button type="button" class="btn-text" data-x="back">Back</button>' : '<button type="button" class="btn-text" data-x="close">Not now</button>'}<span class="grow"></span><button type="button" class="btn-primary" data-x="next">${nextLabel}</button></div>`;
  let html = '';
  if (step === 0) {
    const pend = C.pendingCheckins(S.days, TZ, n).filter(p => p.srcKey <= today);
    const tt = C.dayTotals(S.days, today, TZ, n); let done = 0, assumed = 0; for (const c in tt) { done += tt[c].done; assumed += tt[c].assumed; }
    html = `${bar}<div><h3>How today went</h3><div class="sub num">${fmtD(done)} confirmed${assumed ? ' · ' + fmtD(assumed) + ' still assumed' : ''}</div></div>
      ${pend.length ? `<div>${pend.map(p => `<div class="ci-row"><span class="dot" style="background:${cat(p.c).color}"></span><div style="min-width:0"><div class="t">${esc(nameOf(p))}</div><div class="s num">${fmtR(p.s, p.e)}</div></div><div class="seg-ans"><button type="button" class="yes" data-ci="yes" data-k="${p.srcKey}" data-id="${p.id}">Yes</button><button type="button" data-ci="no" data-k="${p.srcKey}" data-id="${p.id}">No</button></div></div>`).join('')}</div><button type="button" class="btn-text" data-x="all" style="justify-self:start">All happened as planned</button>` : '<p class="note">Everything is checked in. Whatever happened today, tomorrow starts clean.</p>'}${foot()}`;
  } else if (step === 1) {
    const items = S.inbox.items.filter(i => !i.done);
    html = `${bar}<div><h3>Empty your head</h3><div class="sub">Give every open task a day, or let it go. Anything still on your mind goes in here too.</div></div>
      <form class="qa" id="sd-ib" autocomplete="off" style="margin:0"><input id="sd-ib-in" type="text" placeholder="Something on your mind…" aria-label="Add to inbox"><button class="btn-ghost" type="submit">Add</button></form>
      ${items.length ? `<div>${items.map(i => `<div class="ci-row" style="grid-template-columns:minmax(0,1fr) auto"><div style="min-width:0"><div class="t">${esc(i.t)}</div><div class="s">${i.due === tmr ? 'Tomorrow' : i.due ? 'Due ' + shortDate(i.due) : 'No day yet'}</div></div><div class="seg-ans"><button type="button" class="${i.due === tmr ? 'yes' : ''}" data-ib="tmr" data-id="${i.id}">Tomorrow</button><button type="button" data-ib="later" data-id="${i.id}">Later</button><button type="button" data-ib="done" data-id="${i.id}">Done</button><button type="button" data-ib="drop" data-id="${i.id}">Drop</button></div></div>`).join('')}</div>` : '<p class="note">Your inbox is empty.</p>'}${foot()}`;
  } else if (step === 2) {
    const plan = vis(tmr, 'plan').filter(b => !b.closed && !b.spill), tpls = S.settings.templates || [], mk = C.marketDay(tmr);
    const dueT = S.inbox.items.filter(i => !i.done && i.due === tmr);
    html = `${bar}<div><h3>${longDate(tmr)}</h3><div class="sub">${plan.length ? fmtD(plan.reduce((s, b) => s + b.e - b.s, 0)) + ' planned' : 'Nothing planned yet'}${mk.status !== 'open' ? ' · ' + mk.label : ''}</div></div>
      ${!plan.length && tpls.length ? `<div class="field"><span class="lab">Start from a template</span><div class="chips">${tpls.map(p => `<button type="button" class="chip" data-tplsd="${p.id}">${esc(p.name)}</button>`).join('')}</div></div>` : ''}
      ${dueT.length ? `<div class="field"><span class="lab">Due tomorrow from your inbox</span>${dueT.map(i => `<div class="ci-row" style="grid-template-columns:minmax(0,1fr) auto"><div class="t">${esc(i.t)} <span class="note">· ${fmtD(i.dur || 60)}</span></div><button type="button" class="btn-ghost" data-auto="${i.id}">Find a time</button></div>`).join('')}</div>` : ''}
      ${plan.length ? `<div class="field"><span class="lab">Pick up to 3 that matter most, and their first step</span>${plan.map(b => `<div class="ck-item" style="flex-wrap:wrap"><input type="checkbox" id="top-${b.id}" data-top="${b.id}"${b.top ? ' checked' : ''}><span><label for="top-${b.id}">${esc(nameOf(b))} <span class="note num">· ${fmtR(b.s, b.e)}</span></label></span>${b.top ? `<input type="text" data-first="${b.id}" value="${esc(b.f || '')}" placeholder="First step" aria-label="First step for ${esc(nameOf(b))}" style="flex-basis:100%;height:36px;border-radius:10px;border:1px solid #34312d;background:var(--face);padding:0 10px">` : ''}</div>`).join('')}</div>
        <button type="button" class="btn-text" data-x="open-tmr" style="justify-self:start">Open tomorrow on the dial</button>` : ''}${foot()}`;
  } else {
    const plan = vis(tmr, 'plan').filter(b => !b.closed && b.c !== 'sleep' && !b.spill), first = plan[0];
    html = `${bar}<div><h3>Day closed</h3><div class="sub">${first ? 'Tomorrow starts with ' + esc(nameOf(first)) + ' at ' + fmtT(first.s) + (first.f ? '. First step: ' + esc(first.f) : '') + '.' : 'Tomorrow is open.'}</div></div>
      <p class="note">Everything open now has a time or a place. You can let it go for tonight.</p>
      <div class="sheet-foot"><button type="button" class="btn-text" data-x="close">Done</button><span class="grow"></span><button type="button" class="btn-primary" data-x="sleep">Going to sleep</button></div>`;
  }
  openSheet(html, sh => {
    sh.addEventListener('click', e => {
      saveFirsts(sh);
      const x = e.target.closest('[data-x]')?.dataset.x;
      if (x === 'next') { openShutdown(step + 1); return; }
      if (x === 'back') { saveFirsts(sh); openShutdown(step - 1); return; }
      if (x === 'close') { saveFirsts(sh); closeSheet(); return; }
      if (x === 'sleep') { sheetRoot.innerHTML = ''; startTimer('sleep'); return; }
      if (x === 'all') { for (const p of C.pendingCheckins(S.days, TZ, now()).filter(p => p.srcKey <= today)) answerCheckin(p.srcKey, p.id, 'yes'); openShutdown(0); return; }
      if (x === 'open-tmr') { saveFirsts(sh); sheetRoot.innerHTML = ''; S.sel = tmr; S.view = 'day'; render(); return; }
      const ci = e.target.closest('[data-ci]'); if (ci) { answerCheckin(ci.dataset.k, ci.dataset.id, ci.dataset.ci); openShutdown(0); return; }
      const ib = e.target.closest('[data-ib]'); if (ib) {
        const it = S.inbox.items.find(i => i.id === ib.dataset.id); if (!it) return;
        checkpoint(['inbox']);
        if (ib.dataset.ib === 'tmr') it.due = tmr; if (ib.dataset.ib === 'later') delete it.due;
        if (ib.dataset.ib === 'done' || ib.dataset.ib === 'drop') S.inbox.items = S.inbox.items.filter(i => i.id !== it.id);
        save('inbox'); openShutdown(1); return;
      }
      const tp = e.target.closest('[data-tplsd]'); if (tp) { const p = S.settings.templates.find(t => t.id === tp.dataset.tplsd); checkpoint(['d-' + tmr]); applyTemplate(tmr, p); openShutdown(2); return; }
      const au = e.target.closest('[data-auto]'); if (au) { autoSchedule(au.dataset.auto, tmr); openShutdown(2); return; }
      const tc = e.target.closest('[data-top]'); if (tc) {
        const d = ensureDay(tmr), raw = d.plan.find(b => b.id === tc.dataset.top); if (!raw) return;
        if (tc.checked && d.plan.filter(b => b.top).length >= 3) { tc.checked = false; toast('Three is the limit. Untick one first.'); return; }
        saveFirsts(sh); raw.top = tc.checked || undefined; saveDay(tmr); openShutdown(2);
      }
    });
    const f = sh.querySelector('#sd-ib'); if (f) f.addEventListener('submit', e => { e.preventDefault(); const v = sh.querySelector('#sd-ib-in').value.trim(); if (!v) return; addInboxItem(v, tmr); openShutdown(1); });
  });
  function saveFirsts(sh) {
    const inputs = sh.querySelectorAll('[data-first]'); if (!inputs.length) return;
    const d = ensureDay(tmr); let changed = false;
    inputs.forEach(inp => { const raw = d.plan.find(b => b.id === inp.dataset.first); if (raw && (raw.f || '') !== inp.value.trim()) { raw.f = inp.value.trim(); changed = true; } });
    if (changed) saveDay(tmr);
  }
}

/* ---------- inbox ---------- */
function parseItem(text) {
  let t = text.trim(), dur = 60;
  const m = t.match(/\s(\d+(?:\.\d+)?)\s*(h|hr|hrs|hours?|m|min|mins|minutes?)$/i);
  if (m) { const n = parseFloat(m[1]); dur = Math.max(15, Math.min(480, Math.round((m[2][0].toLowerCase() === 'h' ? n * 60 : n) / 15) * 15)); t = t.slice(0, m.index).trim(); }
  return { t: t || text.trim(), dur, c: C.guessCat(t, cats()) || undefined };
}
function addInboxItem(text, due) {
  const it = { id: newId(), ...parseItem(text), created: todayKey() }; if (due) it.due = due;
  change(['inbox'], () => { S.inbox.items.push(it); });
  return it;
}
function firstFree(k, dur, from = 480, to = 1320) {
  const busy = occ(k, 'plan'); let start = from;
  if (k === todayKey()) start = Math.max(start, Math.ceil(now().min / 15) * 15);
  for (let s = start; s + dur <= to; s += 15) if (!C.clash(busy, s, s + dur)) return s;
  return null;
}
function autoSchedule(itemId, k) {
  const it = S.inbox.items.find(i => i.id === itemId); if (!it) return;
  const dur = it.dur || 60, s = firstFree(k, dur);
  if (s == null) { toast('No free ' + fmtD(dur) + ' between 8 am and 10 pm'); return; }
  const blk = { id: newId(), s, e: s + dur, c: it.c || S.settings.lastCat || 'study', t: it.t };
  change(['d-' + k, 'inbox'], () => { ensureDay(k).plan.push(blk); S.inbox.items = S.inbox.items.filter(i => i.id !== itemId); }, it.t + ' · ' + (relLabel(k) || shortDate(k)) + ' ' + fmtR(s, s + dur));
}
function openItem(id) {
  const it = S.inbox.items.find(i => i.id === id); if (!it) return;
  const t = todayKey(), days = [t, addDays(t, 1), addDays(t, 2), addDays(t, 3), addDays(t, 4), addDays(t, 5), addDays(t, 6)];
  if (!days.includes(S.sel) && S.sel > t) days.push(S.sel);
  const durs = [15, 30, 45, 60, 90, 120, 180, 240];
  openSheet(`<div><h3>Inbox task</h3><div class="sub">Give it a time, or keep it here.</div></div>
    <div class="field"><label for="it-t">Task</label><input id="it-t" type="text" value="${esc(it.t)}"></div>
    <div class="field"><span class="lab">Category</span>${catChips('data-icat', it.c)}</div>
    <div class="two"><div class="field"><label for="it-dur">Length</label><select id="it-dur">${durs.map(d => `<option value="${d}"${d === (it.dur || 60) ? ' selected' : ''}>${fmtD(d)}</option>`).join('')}</select></div>
      <div class="field"><label for="it-day">Day</label><select id="it-day">${days.map(k => `<option value="${k}"${k === (S.sel >= t ? S.sel : t) ? ' selected' : ''}>${relLabel(k) || longDate(k)}</option>`).join('')}</select></div></div>
    <div class="field"><label for="it-at">Time</label><select id="it-at"></select></div>
    <div class="err" id="it-err" hidden></div>
    <div class="sheet-foot"><button type="button" class="btn-text danger" data-x="del">Delete</button><button type="button" class="btn-text" data-x="keep">Keep in inbox</button><span class="grow"></span><button type="button" class="btn-primary" data-x="sched">Schedule</button></div>`, sh => {
    let c = it.c;
    const fill = () => {
      const k = sh.querySelector('#it-day').value, dur = +sh.querySelector('#it-dur').value, busy = occ(k, 'plan');
      let opts = ''; const from = k === t ? Math.ceil(now().min / 15) * 15 : 0; const best = firstFree(k, dur);
      for (let s = from; s + dur <= MIN; s += 15) if (!C.clash(busy, s, s + dur)) opts += `<option value="${s}"${s === best ? ' selected' : ''}>${fmtR(s, s + dur)}</option>`;
      sh.querySelector('#it-at').innerHTML = opts || '<option value="">No free time that day</option>';
    };
    fill(); sh.querySelector('#it-day').onchange = fill; sh.querySelector('#it-dur').onchange = fill;
    const upd = () => { it.t = sh.querySelector('#it-t').value.trim() || it.t; it.c = c; it.dur = +sh.querySelector('#it-dur').value; };
    sh.addEventListener('click', e => {
      const ch = e.target.closest('[data-icat]'); if (ch) { c = ch.dataset.icat; sh.querySelectorAll('[data-icat]').forEach(x => x.setAttribute('aria-pressed', x === ch)); return; }
      const x = e.target.closest('[data-x]')?.dataset.x;
      if (x === 'del') { sheetRoot.innerHTML = ''; change(['inbox'], () => { S.inbox.items = S.inbox.items.filter(i => i.id !== id); }, 'Deleted ' + it.t); }
      if (x === 'keep') { sheetRoot.innerHTML = ''; change(['inbox'], upd); }
      if (x === 'sched') {
        const at = sh.querySelector('#it-at').value; if (at === '') { const e2 = sh.querySelector('#it-err'); e2.hidden = false; e2.textContent = 'No free time that day. Try another day or a shorter length.'; return; }
        const k = sh.querySelector('#it-day').value, s = +at, dur = +sh.querySelector('#it-dur').value;
        upd(); const blk = { id: newId(), s, e: s + dur, c: it.c || S.settings.lastCat || 'study', t: it.t };
        sheetRoot.innerHTML = ''; S.sel = k;
        change(['d-' + k, 'inbox'], () => { ensureDay(k).plan.push(blk); S.inbox.items = S.inbox.items.filter(i => i.id !== id); }, it.t + ' · ' + (relLabel(k) || shortDate(k)) + ' ' + fmtR(s, s + dur));
        ink(blk.id);
      }
    });
  });
}

/* ---------- settings ---------- */
function urlB64(b64) { const p = '='.repeat((4 - b64.length % 4) % 4), raw = atob((b64 + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from([...raw].map(c => c.charCodeAt(0))); }
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
async function pushStatus() {
  if (mode !== 'cloud') return { ok: false, text: 'Sign in first.' };
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return { ok: false, text: isIOS() && !standalone() ? 'On iPhone and iPad: tap Share, then "Add to Home Screen", and open Meridian from your Home Screen to turn notifications on.' : 'This browser can’t receive notifications.' };
  if (Notification.permission === 'denied') return { ok: false, text: 'Notifications are blocked for Meridian. Allow them in your device settings.' };
  try { const reg = await navigator.serviceWorker.ready; const sub = await reg.pushManager.getSubscription(); return { ok: true, on: !!sub && Notification.permission === 'granted' }; } catch (_) { return { ok: true, on: false }; }
}
async function enablePush() {
  try {
    const perm = await Notification.requestPermission(); if (perm !== 'granted') { toast('Notifications were not allowed'); return false; }
    const reg = await navigator.serviceWorker.ready;
    const r = await fetch('/api/push-key', { cache: 'no-store' }); const j = await r.json(); if (!j.publicKey) { toast(j.error || 'The server isn’t ready for notifications yet'); return false; }
    let sub = await reg.pushManager.getSubscription(); if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64(j.publicKey) });
    const js = sub.toJSON();
    const { error } = await sb.from('push_subs').upsert({ endpoint: js.endpoint, user_id: uid, sub: js, tz: TZ });
    if (error) { toast('Could not save this device: ' + error.message); return false; }
    toast('Notifications are on for this device'); return true;
  } catch (e) { console.warn(e); toast('Could not turn on notifications: ' + (e.message || e)); return false; }
}
async function testPush() {
  const { data } = await sb.auth.getSession(); const tok = data.session && data.session.access_token;
  const r = await fetch('/api/push-test', { method: 'POST', headers: { authorization: 'Bearer ' + tok } }); const j = await r.json().catch(() => ({}));
  toast(r.ok ? 'Test sent to ' + j.sent + ' device' + (j.sent === 1 ? '' : 's') : (j.error || 'Test failed'));
}
function openSettings() {
  const cs = cats().map(c => ({ ...c })), st = S.settings, nt = { start: true, checkin: true, shutdown: true, ...(st.notify || {}) };
  const drawCats = () => { sheetRoot.querySelector('#cat-list').innerHTML = cs.map((c, i) => `<div class="cat-row"><button type="button" class="swatch" data-sw="${i}" style="background:${c.color}" aria-label="Change colour of ${esc(c.name)}"></button><input type="text" data-cn="${i}" value="${esc(c.name)}" aria-label="Category name"><button type="button" class="icon-btn" data-cdel="${i}" aria-label="Remove ${esc(c.name)}"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M5 5l10 10M15 5 5 15"/></svg></button></div>`).join(''); };
  const drawTpls = () => { const tp = st.templates || []; sheetRoot.querySelector('#tpl-list').innerHTML = tp.length ? tp.map(p => `<div class="tpl-row"><span>${esc(p.name)} <span class="note">· ${p.blocks.length} blocks</span></span><button type="button" class="btn-text danger" data-tdel="${p.id}">Remove</button></div>`).join('') : '<p class="note">No templates. Open a day you like and choose "Save day as template".</p>'; };
  openSheet(`<div><h3>Settings</h3><div class="sub">${mode === 'cloud' ? 'Signed in as ' + esc(S.email || '') + ' · synced across your devices' : 'Saved on this device only'}</div></div>
    <div class="field"><h4>Notifications</h4><p class="note" id="push-status">Checking this device…</p><div class="row-actions" id="push-actions"></div>
      <label class="switch"><span>When a block starts</span><input type="checkbox" id="n-start"${nt.start ? ' checked' : ''}></label>
      <label class="switch"><span>Check-in when a block ends</span><input type="checkbox" id="n-checkin"${nt.checkin ? ' checked' : ''}></label>
      <label class="switch"><span>Evening shutdown</span><input type="checkbox" id="n-shutdown"${nt.shutdown ? ' checked' : ''}></label>
      <div class="field"><label for="n-at">Shutdown time</label><select id="n-at">${timeOpts(st.shutdownAt ?? 1305, 960, 1425)}</select></div></div>
    <div class="field"><h4>Categories</h4><div class="ck" id="cat-list"></div><button type="button" class="btn-text" data-x="cat-add" style="justify-self:start">+ Add a category</button></div>
    <div class="field"><h4>Templates</h4><div id="tpl-list"></div></div>
    <div class="field"><h4>Your data</h4><p class="note">Copy a full backup, or paste data exported from the first version of Meridian.</p>
      <div class="row-actions"><button type="button" class="btn-ghost" data-x="export">Copy backup</button></div>
      <textarea id="imp" placeholder="Paste exported data here"></textarea><div class="row-actions"><button type="button" class="btn-ghost" data-x="import">Import</button></div></div>
    ${isIOS() && !standalone() ? '<p class="note">Tip: on iPhone, tap Share, then "Add to Home Screen" to open Meridian like an app.</p>' : ''}
    <div class="sheet-foot">${mode === 'cloud' ? '<button type="button" class="btn-text" data-x="signout">Sign out</button>' : ''}<span class="grow"></span><button type="button" class="btn-text" data-x="cancel">Cancel</button><button type="button" class="btn-primary" data-x="save">Save</button></div>`, sh => {
    drawCats(); drawTpls();
    pushStatus().then(ps => {
      const s = sh.querySelector('#push-status'), a = sh.querySelector('#push-actions'); if (!s) return;
      if (!ps.ok) { s.textContent = ps.text; return; }
      s.textContent = ps.on ? 'On for this device.' : 'Off for this device.';
      a.innerHTML = (ps.on ? '' : '<button type="button" class="btn-primary" data-x="push-on">Turn on for this device</button>') + (ps.on ? '<button type="button" class="btn-ghost" data-x="push-test">Send a test</button>' : '');
    });
    sh.addEventListener('click', async e => {
      const sw = e.target.closest('[data-sw]'); if (sw) { const c = cs[+sw.dataset.sw]; c.color = PALETTE[(PALETTE.indexOf(c.color) + 1) % PALETTE.length]; drawCats(); return; }
      const cd = e.target.closest('[data-cdel]'); if (cd) { cs.splice(+cd.dataset.cdel, 1); drawCats(); return; }
      const td = e.target.closest('[data-tdel]'); if (td) { checkpoint(['settings']); st.templates = st.templates.filter(p => p.id !== td.dataset.tdel); save('settings'); drawTpls(); return; }
      const x = e.target.closest('[data-x]')?.dataset.x;
      if (x === 'cat-add') { sh.querySelectorAll('[data-cn]').forEach(inp => { cs[+inp.dataset.cn].name = inp.value.trim() || 'Untitled'; }); const used = cs.map(c => c.color); cs.push({ id: 'c-' + newId(), name: 'New category', color: PALETTE.find(p => !used.includes(p)) || PALETTE[0] }); drawCats(); sh.querySelector(`[data-cn="${cs.length - 1}"]`).select(); }
      if (x === 'push-on') { if (await enablePush()) { sh.querySelector('#push-status').textContent = 'On for this device.'; sh.querySelector('#push-actions').innerHTML = '<button type="button" class="btn-ghost" data-x="push-test">Send a test</button>'; } }
      if (x === 'push-test') testPush();
      if (x === 'export') { const txt = JSON.stringify({ meridian: 2, settings: S.settings, days: S.days, inbox: S.inbox }); try { await navigator.clipboard.writeText(txt); toast('Backup copied'); } catch (_) { sh.querySelector('#imp').value = txt; sh.querySelector('#imp').select(); toast('Select all and copy the text below'); } }
      if (x === 'import') importData(sh.querySelector('#imp').value);
      if (x === 'signout') { await sb.auth.signOut(); }
      if (x === 'cancel') closeSheet();
      if (x === 'save') {
        sh.querySelectorAll('[data-cn]').forEach(inp => { cs[+inp.dataset.cn].name = inp.value.trim() || 'Untitled'; });
        sheetRoot.innerHTML = '';
        change(['settings'], () => {
          const removed = st.cats.filter(c => !cs.find(x => x.id === c.id));
          st.cats = cs; st.retired = (st.retired || []).filter(r => !cs.find(c => c.id === r.id)).concat(removed);
          st.notify = { start: sh.querySelector('#n-start').checked, checkin: sh.querySelector('#n-checkin').checked, shutdown: sh.querySelector('#n-shutdown').checked };
          st.shutdownAt = +sh.querySelector('#n-at').value;
        }, 'Settings saved');
      }
    });
  });
}
function importData(text) {
  let data; try { data = JSON.parse(text); } catch (_) { toast('That isn’t Meridian data. Copy it again and paste the whole text.'); return; }
  if (!data || !data.days) { toast('No days found in that data'); return; }
  const ids = []; let added = 0;
  checkpoint(Object.keys(data.days).map(k => 'd-' + k).concat(['settings', 'inbox']));
  for (const k of Object.keys(data.days)) {
    const src = data.days[k], d = ensureDay(k);
    for (const ring of ['plan', 'actual']) for (const b0 of (src[ring] || [])) {
      if (d[ring].some(x => x.id === b0.id)) continue;
      const b = clone(b0);
      if (ring === 'plan' && !b.ny && b.c === 'trading' && /trading/i.test(b.t || '')) { b.ny = true; b.s = C.localToNy(k, b.s, TZ); b.e = C.localToNy(k, b.e, TZ); }
      const r = ring === 'plan' ? C.resolvePlanBlock(k, b, TZ) : b;
      if (C.clash(occ(k, ring), r.s, r.e ?? r.s + 1)) continue;
      d[ring].push(b); added++;
    }
    for (const sId of (src.skip || [])) if (!d.skip.includes(sId)) d.skip.push(sId);
    ids.push('d-' + k);
  }
  if (data.settings && data.settings.cats) for (const c of data.settings.cats) if (!S.settings.cats.find(x => x.id === c.id)) S.settings.cats.push(c);
  if (data.inbox && data.inbox.items) for (const it of data.inbox.items) if (!S.inbox.items.find(x => x.id === it.id)) S.inbox.items.push(it);
  ids.concat(['settings', 'inbox']).forEach(save);
  closeSheet(); toast('Imported ' + added + ' block' + (added === 1 ? '' : 's'), true);
}
function openSaveTemplate() {
  const plan = (S.days[S.sel] || { plan: [] }).plan;
  openSheet(`<div><h3>Save day as template</h3><div class="sub">${plan.length} blocks from ${relLabel(S.sel) || longDate(S.sel)}</div></div>
    <div class="field"><label for="tpl-name">Template name</label><input id="tpl-name" type="text" autofocus placeholder="e.g. Weekend, Uni day"></div>
    <div class="sheet-foot"><span class="grow"></span><button type="button" class="btn-text" data-x="cancel">Cancel</button><button type="button" class="btn-primary" data-x="ok">Save</button></div>`, sh => {
    const go = () => { const n = sh.querySelector('#tpl-name').value.trim(); if (!n) return; sheetRoot.innerHTML = ''; change(['settings'], () => { S.settings.templates = (S.settings.templates || []).concat({ id: 'tpl-' + newId(), name: n, blocks: plan.map(b => { const x = { s: b.s, e: b.e, c: b.c, t: b.t }; if (b.ny) x.ny = true; if (b.f) x.f = b.f; return x; }) }); }, 'Saved "' + n + '"'); };
    sh.addEventListener('click', e => { const a = e.target.closest('[data-x]')?.dataset.x; if (a === 'ok') go(); if (a === 'cancel') closeSheet(); });
    sh.querySelector('#tpl-name').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
  });
}

/* ---------- global clicks and forms ---------- */
document.addEventListener('click', e => {
  if (e.target.closest('#sheet-root')) return;
  const t = e.target;
  const day = t.closest('[data-day]'); if (day) { S.sel = day.dataset.day; S.view = 'day'; S.reviewRange = 'week'; render(); window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
  const tp = t.closest('[data-tpl]'); if (tp) { const p = S.settings.templates.find(x => x.id === tp.dataset.tpl); if (p) { checkpoint(['d-' + S.sel]); applyTemplate(S.sel, p); render(); } return; }
  const st = t.closest('[data-start]'); if (st) { startTimer(st.dataset.start); return; }
  const ci = t.closest('[data-ci]'); if (ci) { answerCheckin(ci.dataset.k, ci.dataset.id, ci.dataset.ci); return; }
  const ed = t.closest('[data-edit]'); if (ed) { const v = vis(S.sel, 'plan').find(b => b.id === ed.dataset.edit && b.srcKey === ed.dataset.src); if (v) openEditor('plan', v); return; }
  const sc = t.closest('[data-sched]'); if (sc) { openItem(sc.dataset.sched); return; }
  const it = t.closest('[data-item]'); if (it) { openItem(it.dataset.item); return; }
  const rg = t.closest('[data-range]'); if (rg) { S.reviewRange = rg.dataset.range; render(); return; }
  const act = t.closest('[data-act]')?.dataset.act; if (!act) return;
  if (act === 'week-prev') { S.sel = addDays(S.sel, -7); render(); }
  if (act === 'week-next') { S.sel = addDays(S.sel, 7); render(); }
  if (act === 'go-today') { S.sel = todayKey(); render(); }
  if (act === 'stop-timer') stopTimer();
  if (act === 'sleep') startTimer('sleep');
  if (act === 'awake') { stopTimer(); setTimeout(() => maybeGlance(true), 350); }
  if (act === 'shutdown') openShutdown(0);
  if (act === 'checkins') openCheckins();
  if (act === 'add-block') addBlockSheet();
  if (act === 'save-tpl') openSaveTemplate();
  if (act === 'month-prev' || act === 'month-next') { const [y, m] = dateParts(S.monthAnchor || S.sel); const d = new Date(Date.UTC(y, m - 1 + (act === 'month-next' ? 1 : -1), 1)); S.monthAnchor = C.keyFromParts(d.getUTCFullYear(), d.getUTCMonth() + 1, 1); render(); }
});
document.addEventListener('submit', e => {
  if (e.target.id === 'qa-form') {
    e.preventDefault();
    const inp = $('qa-input'), v = inp.value.trim(); if (!v) return;
    const r = C.parseQuick(v, cats(), S.sel === todayKey() ? now().min : 540, S.settings.lastCat); if (r.error) { toast(r.error); return; }
    const o = C.clash(occ(S.sel, 'plan'), r.s, r.e); if (o) { toast('That overlaps ' + (o.t || cat(o.c).name)); return; }
    const blk = { id: newId(), ...r }, k = S.sel;
    change(['d-' + k], () => { ensureDay(k).plan.push(blk); }, 'Added ' + blk.t + ' · ' + fmtR(blk.s, blk.e));
    ink(blk.id); $('qa-input')?.focus();
  }
  if (e.target.id === 'ib-form') {
    e.preventDefault(); const inp = $('ib-input'), v = inp.value.trim(); if (!v) return;
    addInboxItem(v); $('ib-input')?.focus();
  }
});
function addBlockSheet() {
  const k = S.sel, start = k === todayKey() ? Math.ceil(now().min / 15) * 15 : 540, busy = occ(k, 'plan');
  let s = start; while (s < MIN - 15 && C.clash(busy, s, s + 15)) s += 15;
  let e = s + 15; while (e < Math.min(MIN, s + 60) && !C.clash(busy, s, e + 15)) e += 15;
  if (C.clash(busy, s, e)) { toast('No free time left on this day'); return; }
  openNewBlock('plan', s, e);
}
function handleHash() {
  const h = location.hash;
  if (!S.settings) return;
  if (h === '#shutdown') { history.replaceState(null, '', location.pathname); openShutdown(0); }
  else if (h === '#checkin') { history.replaceState(null, '', location.pathname); S.sel = todayKey(); render(); if (C.pendingCheckins(S.days, TZ, now()).length) openCheckins(); }
}
window.addEventListener('hashchange', handleHash);

/* ---------- top bar ---------- */
$('nav-day').onclick = () => { S.view = 'day'; S.reviewRange = 'week'; render(); };
$('nav-month').onclick = () => { S.view = 'month'; S.monthAnchor = S.sel; S.reviewRange = 'month'; render(); };
$('nav-month-sm').onclick = () => { S.view = S.view === 'month' ? 'day' : 'month'; S.monthAnchor = S.sel; S.reviewRange = S.view === 'month' ? 'month' : 'week'; render(); };
$('shutdown-btn').onclick = () => S.settings && openShutdown(0);
$('open-settings').onclick = () => S.settings && openSettings();
$('prev-day').onclick = () => { S.sel = addDays(S.sel, -1); render(); };
$('next-day').onclick = () => { S.sel = addDays(S.sel, 1); render(); };
$('go-today').onclick = () => { S.sel = todayKey(); render(); };
const mq = window.matchMedia('(max-width: 680px)');
const syncSm = () => { $('nav-month-sm').hidden = !mq.matches; }; syncSm(); mq.addEventListener && mq.addEventListener('change', syncSm);
window.addEventListener('scroll', () => $('top').classList.toggle('scrolled', window.scrollY > 4), { passive: true });

/* ---------- toast ---------- */
let toastT = null;
function toast(msg, withUndo) {
  const r = $('toast-root');
  r.innerHTML = `<div class="toast" role="status"><span>${esc(msg)}</span>${withUndo && undoStack.length ? '<button type="button" id="undo-btn">Undo</button>' : ''}</div>`;
  const u = $('undo-btn'); if (u) u.onclick = () => { r.innerHTML = ''; undo(); };
  clearTimeout(toastT); toastT = setTimeout(() => { r.innerHTML = ''; }, withUndo ? 5000 : 2800);
}

/* ---------- the clock ---------- */
let lastMinute = -1, lastDay = todayKey();
setInterval(() => {
  if (!S.settings) return;
  const n = now(), t = n.key;
  if (t !== lastDay) { if (S.sel === lastDay) S.sel = t; lastDay = t; render(); return; }
  const run = findRunning();
  if (run && S.view === 'day' && S.sel === t) { const el = $('timer-t'); if (el) { const since = run.b.s + (run.k === t ? 0 : -MIN), sec = (n.min - since) * 60; el.textContent = run.b.c === 'sleep' ? fmtClock(sec) : nameOf(run.b) + ' · ' + fmtClock(sec); } }
  const m = Math.floor(n.min);
  if (m !== lastMinute && !S.drag && !idrag && !sheetOpen()) {
    if (lastMinute >= 0 && !(('Notification' in window) && Notification.permission === 'granted')) { const b = vis(t, 'plan').find(x => !x.closed && Math.floor(x.s) === m && !x.spill); if (b) toast(nameOf(b) + ' starts now'); }
    lastMinute = m;
    if (S.view === 'day') { if (S.sel === t) { renderDial(); renderNow(); renderWeek(); } } else renderMonth();
  }
}, 1000);

boot();
