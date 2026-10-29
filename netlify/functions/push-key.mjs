import { admin, vapid } from '../lib/server.mjs';

// The public half of the notification key, which a device needs to subscribe.
export default async () => {
  const sb = admin();
  if (!sb) return new Response(JSON.stringify({ error: 'Server keys are not set in Netlify yet.' }), { status: 503, headers: { 'content-type': 'application/json' } });
  const keys = await vapid(sb);
  return new Response(JSON.stringify({ publicKey: keys.publicKey }), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
};
