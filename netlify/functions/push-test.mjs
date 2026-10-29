import { admin, vapid, setupPush, sendToUser } from '../lib/server.mjs';

// Sends a test notification to every device of the signed-in person.
export default async (req) => {
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const sb = admin(); if (!sb) return json({ error: 'Server keys are not set in Netlify yet.' }, 503);
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const { data, error } = await sb.auth.getUser(token);
  if (error || !data || !data.user) return json({ error: 'Not signed in' }, 401);
  const { data: subs } = await sb.from('push_subs').select('endpoint,sub').eq('user_id', data.user.id);
  if (!subs || !subs.length) return json({ error: 'No device has notifications turned on yet.' }, 404);
  const wp = setupPush(await vapid(sb));
  const sent = await sendToUser(sb, wp, subs, { title: 'Meridian', body: 'Notifications work on this device.', tag: 'test', url: '/' });
  return json({ sent });
};
