// Tells the app where your Supabase project is. Both values are public by design.
export default async () => {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_PUBLISHABLE_KEY;
  const body = url && key ? { configured: true, url, key } : { configured: false };
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
};
