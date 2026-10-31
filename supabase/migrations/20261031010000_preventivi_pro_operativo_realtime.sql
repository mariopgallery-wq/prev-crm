-- Preventivi Pro: prima base relazionale per i moduli operativi + sincronizzazione live.
-- IMPORTANTE:
-- 1) Applicare esclusivamente al progetto Supabase usato da Preventivi Pro
--    (nzvzoamhtmucshsrarqq), mai al progetto storico Fill App.
-- 2) Non importa alcun record da Fill App: pp_clients viene popolata SOLO dal
--    workspace Preventivi Pro già presente in public.preventivi_workspace.
-- 3) Il workspace JSONB originale non viene cancellato, svuotato o riscritto.

begin;

-- Il workspace esistente rimane la fonte primaria durante la prima fase.
do $$
begin
  if to_regclass('public.preventivi_workspace') is null then
    raise exception 'Tabella public.preventivi_workspace non trovata: interrompo per evitare di applicare la migrazione al database sbagliato.';
  end if;
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    raise exception 'Publication supabase_realtime non trovata nel progetto Preventivi Pro.';
  end if;
end
$$;

alter table public.preventivi_workspace
  add column if not exists version bigint not null default 1;

-- Anagrafica normalizzata. Il campo fiscale legacy resta non classificato:
-- non viene mai interpretato automaticamente come P.IVA o codice fiscale.
create table if not exists public.pp_clients (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  legacy_key text not null,
  name text not null,
  client_type text not null default 'non_specificato',
  address text,
  locality text,
  legacy_tax_identifier text,
  tax_code text,
  vat_number text,
  phone text,
  email text,
  pec text,
  notes text,
  legacy_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pp_clients_owner_legacy_key_uq unique (owner_id, legacy_key),
  constraint pp_clients_id_owner_uq unique (id, owner_id),
  constraint pp_clients_type_ck check (client_type in ('non_specificato','privato','azienda','condominio','altro'))
);

-- Copia protetta dei soli clienti reali già salvati in Preventivi Pro.
-- ON CONFLICT DO NOTHING evita duplicazioni in caso di ri-esecuzione.
insert into public.pp_clients (
  owner_id, legacy_key, name, address, locality, legacy_tax_identifier,
  phone, email, pec, legacy_data
)
select
  w.user_id,
  md5(w.user_id::text || ':' || c.ordinality::text || ':' ||
      lower(btrim(coalesce(c.value->>'name',''))) || ':' ||
      coalesce(c.value->>'address','') || ':' || coalesce(c.value->>'tax','')),
  btrim(c.value->>'name'),
  nullif(btrim(c.value->>'address'),''),
  nullif(btrim(c.value->>'place'),''),
  nullif(btrim(c.value->>'tax'),''),
  nullif(btrim(c.value->>'phone'),''),
  nullif(btrim(c.value->>'email'),''),
  nullif(btrim(c.value->>'pec'),''),
  c.value
from public.preventivi_workspace w
cross join lateral jsonb_array_elements(
  case when jsonb_typeof(w.data->'clients') = 'array' then w.data->'clients' else '[]'::jsonb end
) with ordinality as c(value, ordinality)
where nullif(btrim(c.value->>'name'),'') is not null
on conflict (owner_id, legacy_key) do nothing;

-- Snapshot dei dati aziendali esistenti; la schermata attuale continua a usare
-- le impostazioni del workspace fino all'attivazione del repository unificato.
create table if not exists public.pp_company_settings (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  settings jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
insert into public.pp_company_settings(owner_id, settings)
select user_id, coalesce(data->'settings','{}'::jsonb)
from public.preventivi_workspace
on conflict (owner_id) do nothing;

create table if not exists public.pp_sites (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  client_id uuid not null,
  name text not null,
  address text,
  locality text,
  status text not null default 'attivo' check (status in ('attivo','sospeso','completato','archiviato')),
  start_date date,
  end_date date,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, client_id, owner_id),
  foreign key (client_id, owner_id) references public.pp_clients(id, owner_id) on delete restrict
);

create table if not exists public.pp_jobs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  client_id uuid,
  site_id uuid,
  title text not null,
  description text,
  scheduled_at timestamptz,
  estimated_minutes integer check (estimated_minutes is null or estimated_minutes > 0),
  status text not null default 'programmato' check (status in ('programmato','in_corso','completato','annullato')),
  priority text not null default 'normale' check (priority in ('bassa','normale','alta','urgente')),
  address_snapshot text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, client_id, owner_id),
  foreign key (client_id, owner_id) references public.pp_clients(id, owner_id) on delete restrict,
  foreign key (site_id, client_id, owner_id) references public.pp_sites(id, client_id, owner_id) on delete restrict,
  constraint pp_jobs_site_requires_client_ck check (site_id is null or client_id is not null)
);

create table if not exists public.pp_deadlines (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  client_id uuid,
  site_id uuid,
  job_id uuid,
  title text not null,
  description text,
  deadline_type text not null default 'altro',
  due_at timestamptz not null,
  status text not null default 'aperta' check (status in ('aperta','completata','annullata')),
  reminder_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (client_id, owner_id) references public.pp_clients(id, owner_id) on delete restrict,
  foreign key (site_id, client_id, owner_id) references public.pp_sites(id, client_id, owner_id) on delete restrict,
  foreign key (job_id, client_id, owner_id) references public.pp_jobs(id, client_id, owner_id) on delete restrict,
  constraint pp_deadlines_link_requires_client_ck check ((site_id is null and job_id is null) or client_id is not null)
);

create table if not exists public.pp_site_documents (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  client_id uuid not null,
  site_id uuid not null,
  file_name text not null,
  storage_path text not null,
  mime_type text,
  file_size bigint check (file_size is null or file_size >= 0),
  document_type text not null default 'altro',
  created_at timestamptz not null default now(),
  foreign key (site_id, client_id, owner_id) references public.pp_sites(id, client_id, owner_id) on delete cascade,
  unique (owner_id, storage_path)
);

create table if not exists public.pp_inventory_items (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  sku text,
  name text not null,
  unit text not null default 'pz',
  quantity numeric(14,3) not null default 0 check (quantity >= 0),
  minimum_quantity numeric(14,3) not null default 0 check (minimum_quantity >= 0),
  location text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, owner_id),
  unique (owner_id, sku)
);

create table if not exists public.pp_inventory_movements (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  inventory_item_id uuid not null,
  job_id uuid,
  client_id uuid,
  movement_type text not null check (movement_type in ('carico','scarico','reso','rettifica')),
  quantity numeric(14,3) not null check (quantity > 0),
  occurred_at timestamptz not null default now(),
  reference text,
  notes text,
  created_at timestamptz not null default now(),
  foreign key (inventory_item_id, owner_id) references public.pp_inventory_items(id, owner_id) on delete restrict,
  foreign key (job_id, client_id, owner_id) references public.pp_jobs(id, client_id, owner_id) on delete restrict,
  constraint pp_inventory_job_requires_client_ck check (job_id is null or client_id is not null)
);

create table if not exists public.pp_invoices (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  client_id uuid not null,
  site_id uuid,
  job_id uuid,
  quote_number_snapshot text,
  invoice_number text not null,
  status text not null default 'bozza' check (status in ('bozza','emessa','parziale','pagata','scaduta','annullata')),
  invoice_date date not null default current_date,
  due_date date,
  net_amount numeric(14,2) not null default 0 check (net_amount >= 0),
  vat_amount numeric(14,2) not null default 0 check (vat_amount >= 0),
  total_amount numeric(14,2) not null default 0 check (total_amount >= 0),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, owner_id),
  unique (owner_id, invoice_number),
  foreign key (client_id, owner_id) references public.pp_clients(id, owner_id) on delete restrict,
  foreign key (site_id, client_id, owner_id) references public.pp_sites(id, client_id, owner_id) on delete restrict,
  foreign key (job_id, client_id, owner_id) references public.pp_jobs(id, client_id, owner_id) on delete restrict
);

create table if not exists public.pp_invoice_lines (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  invoice_id uuid not null,
  description text not null,
  quantity numeric(14,3) not null default 1 check (quantity > 0),
  unit text not null default 'pz',
  unit_price numeric(14,2) not null default 0 check (unit_price >= 0),
  vat_rate numeric(5,2) not null default 10 check (vat_rate >= 0 and vat_rate <= 100),
  line_total numeric(14,2) not null default 0 check (line_total >= 0),
  position integer not null default 0,
  created_at timestamptz not null default now(),
  foreign key (invoice_id, owner_id) references public.pp_invoices(id, owner_id) on delete cascade
);

create table if not exists public.pp_payments (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  invoice_id uuid not null,
  amount numeric(14,2) not null check (amount > 0),
  paid_at timestamptz not null default now(),
  payment_method text,
  reference text,
  notes text,
  created_at timestamptz not null default now(),
  foreign key (invoice_id, owner_id) references public.pp_invoices(id, owner_id) on delete restrict
);

-- Indici per i filtri tipici delle schermate operative.
create index if not exists pp_sites_owner_client_idx on public.pp_sites(owner_id, client_id);
create index if not exists pp_jobs_owner_schedule_idx on public.pp_jobs(owner_id, scheduled_at);
create index if not exists pp_jobs_owner_status_idx on public.pp_jobs(owner_id, status);
create index if not exists pp_deadlines_owner_due_idx on public.pp_deadlines(owner_id, due_at);
create index if not exists pp_documents_owner_site_idx on public.pp_site_documents(owner_id, site_id);
create index if not exists pp_inventory_movements_owner_item_date_idx on public.pp_inventory_movements(owner_id, inventory_item_id, occurred_at desc);
create index if not exists pp_invoices_owner_date_idx on public.pp_invoices(owner_id, invoice_date desc);
create index if not exists pp_payments_owner_invoice_idx on public.pp_payments(owner_id, invoice_id);

-- Aggiorna updated_at in modo coerente per le entità modificabili.
create or replace function public.pp_touch_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  new.updated_at = clock_timestamp();
  return new;
end;
$$;
revoke all on function public.pp_touch_updated_at() from public, anon, authenticated;

do $$
declare t text;
begin
  foreach t in array array['pp_clients','pp_company_settings','pp_sites','pp_jobs','pp_deadlines','pp_inventory_items','pp_invoices'] loop
    execute format('drop trigger if exists pp_touch_updated_at on public.%I', t);
    execute format('create trigger pp_touch_updated_at before update on public.%I for each row execute function public.pp_touch_updated_at()', t);
  end loop;
end
$$;

-- RLS + permessi: ogni account può operare esclusivamente sulle proprie righe.
do $$
declare t text;
begin
  foreach t in array array[
    'pp_clients','pp_company_settings','pp_sites','pp_jobs','pp_deadlines',
    'pp_site_documents','pp_inventory_items','pp_inventory_movements',
    'pp_invoices','pp_invoice_lines','pp_payments'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('grant select, insert, update, delete on table public.%I to authenticated', t);
    execute format('drop policy if exists pp_owner_all on public.%I', t);
    execute format(
      'create policy pp_owner_all on public.%I for all to authenticated using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id)',
      t
    );
  end loop;
end
$$;

grant usage on schema public to authenticated;

-- Salvataggio ottimistico del workspace. L'UPDATE è atomico: se un altro
-- dispositivo ha già salvato, saved=false evita una sovrascrittura silenziosa.
create or replace function public.pp_save_workspace(
  p_data jsonb,
  p_expected_updated_at timestamptz
)
returns table(saved boolean, updated_at timestamptz)
language plpgsql
security invoker
set search_path = public
as $$
declare v_saved_at timestamptz;
begin
  if auth.uid() is null then
    raise exception 'Autenticazione richiesta';
  end if;

  update public.preventivi_workspace as w
     set data = p_data,
         updated_at = clock_timestamp(),
         version = coalesce(w.version, 0) + 1
   where w.user_id = (select auth.uid())
     and w.updated_at is not distinct from p_expected_updated_at
  returning w.updated_at into v_saved_at;

  if not found then
    return query select false, null::timestamptz;
  else
    return query select true, v_saved_at;
  end if;
end;
$$;
revoke all on function public.pp_save_workspace(jsonb, timestamptz) from public, anon;
grant execute on function public.pp_save_workspace(jsonb, timestamptz) to authenticated;

-- Segnale verificabile dal client: una connessione WebSocket da sola non
-- dimostra che la tabella è stata effettivamente aggiunta alla publication.
create or replace function public.pp_realtime_enabled()
returns boolean
language sql
stable
security invoker
set search_path = public
as $$
  select (select auth.uid()) is not null
     and exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = 'preventivi_workspace'
     );
$$;
revoke all on function public.pp_realtime_enabled() from public, anon;
grant execute on function public.pp_realtime_enabled() to authenticated;

-- Storage privato per i documenti di cantiere. Percorso previsto:
-- <owner_id>/<site_id>/<file_name>.
insert into storage.buckets(id, name, public)
values ('pp-site-documents', 'pp-site-documents', false)
on conflict (id) do update set public = false;

drop policy if exists pp_site_docs_select on storage.objects;
create policy pp_site_docs_select on storage.objects
for select to authenticated
using (bucket_id = 'pp-site-documents' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists pp_site_docs_insert on storage.objects;
create policy pp_site_docs_insert on storage.objects
for insert to authenticated
with check (bucket_id = 'pp-site-documents' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists pp_site_docs_update on storage.objects;
create policy pp_site_docs_update on storage.objects
for update to authenticated
using (bucket_id = 'pp-site-documents' and (storage.foldername(name))[1] = (select auth.uid())::text)
with check (bucket_id = 'pp-site-documents' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists pp_site_docs_delete on storage.objects;
create policy pp_site_docs_delete on storage.objects
for delete to authenticated
using (bucket_id = 'pp-site-documents' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- Abilita Postgres Changes per il workspace esistente e per i nuovi moduli.
do $$
declare t text;
begin
  foreach t in array array[
    'preventivi_workspace','pp_clients','pp_company_settings','pp_sites','pp_jobs',
    'pp_deadlines','pp_site_documents','pp_inventory_items','pp_inventory_movements',
    'pp_invoices','pp_invoice_lines','pp_payments'
  ] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end
$$;

notify pgrst, 'reload schema';

commit;
