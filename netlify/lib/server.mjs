import { createClient } from '@supabase/supabase-js';
import webpush from 'web-push';

export function admin() {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

// VAPID keys are made once, on first use, and kept in app_config (readable only with the secret key).
export async function vapid(sb) {
  const read = async () => (await sb.from('app_config').select('value').eq('key', 'vapid').maybeSingle()).data;
  let row = await read();
  if (row) return row.value;
  const keys = webpush.generateVAPIDKeys();
  await sb.from('app_config').insert({ key: 'vapid', value: keys });
  row = await read();
  return row ? row.value : keys;
}

export function setupPush(keys) {
  const subject = process.env.URL && process.env.URL.startsWith('https://') ? process.env.URL : 'mailto:meridian@example.com';
  webpush.setVapidDetails(subject, keys.publicKey, keys.privateKey);
  return webpush;
}

export async function sendToUser(sb, wp, subs, payload) {
  let sent = 0;
  for (const s of subs) {
    try { await wp.sendNotification(s.sub, JSON.stringify(payload), { TTL: 900, urgency: 'high' }); sent++; }
    catch (e) { if (e && (e.statusCode === 404 || e.statusCode === 410)) await sb.from('push_subs').delete().eq('endpoint', s.endpoint); else console.error('push failed', e && e.statusCode, e && e.body); }
  }
  return sent;
}
