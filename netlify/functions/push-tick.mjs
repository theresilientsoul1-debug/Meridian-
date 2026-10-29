import { admin, vapid, setupPush, sendToUser } from '../lib/server.mjs';
import * as core from '../../public/core.js';

// Runs every minute: sends block starts, check-ins when a block ends, and the evening shutdown.
export const config = { schedule: '* * * * *' };

export default async () => {
  const sb = admin(); if (!sb) return new Response('not configured');
  const { data: subs, error } = await sb.from('push_subs').select('endpoint,user_id,sub,tz');
  if (error) { console.error(error); return new Response('error'); }
  if (!subs || !subs.length) return new Response('no subscribers');
  const wp = setupPush(await vapid(sb));
  const byUser = new Map();
  for (const s of subs) { if (!byUser.has(s.user_id)) byUser.set(s.user_id, []); byUser.get(s.user_id).push(s); }
  let total = 0;
  for (const [uid, list] of byUser) {
    try {
      let tz = list[0].tz || 'UTC';
      let now = core.zonedNow(Date.now(), tz);
      const ids = ['settings', 'd-' + core.addDays(now.key, -2), 'd-' + core.addDays(now.key, -1), 'd-' + now.key, 'd-' + core.addDays(now.key, 1)];
      const { data: rows } = await sb.from('docs').select('id,body').eq('user_id', uid).in('id', ids);
      let settings = null; const days = {};
      for (const r of rows || []) { if (r.id === 'settings') settings = r.body; else days[r.id.slice(2)] = r.body; }
      if (!settings) continue;
      if (settings.tz && settings.tz !== tz) { tz = settings.tz; now = core.zonedNow(Date.now(), tz); }
      const catName = id => ((settings.cats || []).find(c => c.id === id) || { name: 'Block' }).name;
      for (const ev of core.dueEvents(days, settings, tz, now, 3)) {
        if (ev.kind === 'end') {
          const d = days[ev.key.split(':')[0]];
          if (d && (d.actual || []).some(a => a.from === ev.b.id)) continue; // already checked in
        }
        const { error: dup } = await sb.from('push_log').insert({ user_id: uid, key: ev.key });
        if (dup) continue; // sent already
        const msg = core.eventMessage(ev, days, catName);
        total += await sendToUser(sb, wp, list, { ...msg, url: '/' + (ev.kind === 'shutdown' ? '#shutdown' : ev.kind === 'end' ? '#checkin' : '') });
      }
    } catch (e) { console.error('user tick failed', e); }
  }
  if (new Date().getUTCMinutes() === 7) await sb.from('push_log').delete().lt('sent_at', new Date(Date.now() - 3 * 864e5).toISOString());
  return new Response('sent ' + total);
};
