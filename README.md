# Meridian

Your day on a 24-hour dial. Plan on the outer ring, confirm what happened on the inner ring, close the day in two minutes.

Hosted on Netlify, data and login in Supabase, installable on iPhone, iPad and PC.

## One-time setup

1. **Supabase → SQL Editor → New query.** Paste all of `supabase/schema.sql` and press Run.
2. **Supabase → Authentication → URL Configuration.** Set *Site URL* to your Netlify address (for example `https://meridian-movs.netlify.app`).
3. **Netlify → Add new site → Import an existing project → GitHub →** pick this repo. Leave the build settings as they are (they come from `netlify.toml`).
4. **Netlify → Site configuration → Environment variables.** Add three:
   - `SUPABASE_URL`: Supabase → Project Settings → API → Project URL
   - `SUPABASE_PUBLISHABLE_KEY`: the `sb_publishable_…` key
   - `SUPABASE_SECRET_KEY`: the `sb_secret_…` key (server only; never put it in the app or in chat)
5. **Netlify → Deploys → Trigger deploy** so the variables take effect.
6. Open the site, create your account, sign in.
7. **iPhone/iPad:** Safari → Share → *Add to Home Screen*, open Meridian from the Home Screen, then Settings → *Turn on for this device*. Do the same on each device.
8. Optional: once your account exists, Supabase → Authentication → Sign In / Providers → turn off *Allow new users to sign up*.

## How it works

- `public/` is the app (no build step). `public/core.js` holds all time logic and is shared with the server.
- `netlify/functions/push-tick.mjs` runs every minute and sends: block starts, a check-in when a block ends, and the evening shutdown.
- Trading blocks follow New York time, so they move with US clock changes and show NYSE holidays.
- Data is stored as documents in the `docs` table (`settings`, `inbox`, one per day `d-YYYY-MM-DD`), protected by row-level security.
