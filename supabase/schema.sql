-- Meridian v2 schema. Paste all of this into Supabase → SQL Editor → New query → Run.

-- Your data: one row per document (settings, inbox, and one per day: d-YYYY-MM-DD).
create table if not exists public.docs (
  user_id uuid not null references auth.users(id) on delete cascade,
  id text not null,
  body jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);
alter table public.docs enable row level security;
drop policy if exists "docs: read own" on public.docs;
drop policy if exists "docs: insert own" on public.docs;
drop policy if exists "docs: update own" on public.docs;
drop policy if exists "docs: delete own" on public.docs;
create policy "docs: read own" on public.docs for select to authenticated using ((select auth.uid()) = user_id);
create policy "docs: insert own" on public.docs for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "docs: update own" on public.docs for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "docs: delete own" on public.docs for delete to authenticated using ((select auth.uid()) = user_id);

-- Devices that receive notifications.
create table if not exists public.push_subs (
  endpoint text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  sub jsonb not null,
  tz text,
  created_at timestamptz not null default now()
);
alter table public.push_subs enable row level security;
drop policy if exists "push: read own" on public.push_subs;
drop policy if exists "push: insert own" on public.push_subs;
drop policy if exists "push: update own" on public.push_subs;
drop policy if exists "push: delete own" on public.push_subs;
create policy "push: read own" on public.push_subs for select to authenticated using ((select auth.uid()) = user_id);
create policy "push: insert own" on public.push_subs for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "push: update own" on public.push_subs for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "push: delete own" on public.push_subs for delete to authenticated using ((select auth.uid()) = user_id);

-- Server-only tables (no policies: only the server's secret key can touch them).
create table if not exists public.push_log (
  user_id uuid not null,
  key text not null,
  sent_at timestamptz not null default now(),
  primary key (user_id, key)
);
alter table public.push_log enable row level security;

create table if not exists public.app_config (
  key text primary key,
  value jsonb not null
);
alter table public.app_config enable row level security;

grant select, insert, update, delete on public.docs, public.push_subs to authenticated;
grant all on public.docs, public.push_subs, public.push_log, public.app_config to service_role;

-- Live sync between your phone, iPad and computer.
do $$ begin
  alter publication supabase_realtime add table public.docs;
exception when duplicate_object then null; end $$;
