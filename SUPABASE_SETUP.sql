-- Preventivi Pro: schema cloud Supabase
-- Esegui questo script nel SQL Editor del progetto nzvzoamhtmucshsrarqq.
-- Ogni utente può leggere/modificare esclusivamente il proprio workspace.
create table if not exists public.preventivi_workspace (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null default '{"quotes":[],"items":[],"clients":[],"settings":{"name":"LA TUA AZIENDA","defaultVat":10}}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.preventivi_workspace enable row level security;

drop policy if exists "Users can read their own workspace" on public.preventivi_workspace;
create policy "Users can read their own workspace"
on public.preventivi_workspace
for select to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists "Users can insert their own workspace" on public.preventivi_workspace;
create policy "Users can insert their own workspace"
on public.preventivi_workspace
for insert to authenticated
with check ((select auth.uid()) = user_id);

drop policy if exists "Users can update their own workspace" on public.preventivi_workspace;
create policy "Users can update their own workspace"
on public.preventivi_workspace
for update to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

revoke all on table public.preventivi_workspace from anon, public;
grant usage on schema public to authenticated;
grant select, insert, update on table public.preventivi_workspace to authenticated;
