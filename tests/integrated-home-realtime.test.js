import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('the integrated home exposes Preventivi plus all operational entry points', async () => {
  const app = await read('../src/App.jsx');
  const css = await read('../src/styles.css');
  const expected = ['preventivi', 'jobs', 'calendar', 'clients', 'sites', 'deadlines', 'invoices', 'inventory', 'settings'];
  const homeModuleBlock = app.match(/const HOME_MODULES = \[([\s\S]*?)\];/);
  assert.ok(homeModuleBlock, 'home modules configuration exists');
  for (const id of expected) assert.match(homeModuleBlock[1], new RegExp(`id: '${id}'`));
  assert.match(app, /\{view === 'home' && <section className="module-home">/);
  assert.match(app, /\{view === 'preventivi' && <>/);
  assert.match(app, /onClick=\{\(\) => setPage\(id\)\}/);
  assert.match(css, /\.module-launcher-grid\s*\{[^}]*grid-template-columns:\s*repeat\(3/);
  assert.match(css, /\.module-tone-preventivi\s*\{[^}]*linear-gradient/);
  assert.match(css, /\.module-tone-deadlines\s*\{[^}]*linear-gradient/);
});

test('Fill App example customers are not imported; module launchers use existing Preventivi Pro data only', async () => {
  const app = await read('../src/App.jsx');
  const migration = await read('../supabase/migrations/20261031010000_preventivi_pro_operativo_realtime.sql');
  assert.match(app, /db\.quotes\.length/);
  assert.match(app, /setPage\('clients'\)/);
  assert.match(migration, /from public\.preventivi_workspace w/);
  assert.doesNotMatch(migration, /fill-app|fill_app|localStorage/i);
  assert.match(migration, /legacy_tax_identifier/);
  assert.match(migration, /tax_code text/);
  assert.match(migration, /vat_number text/);
});

test('workspace changes are subscribed through authenticated Postgres Changes with owner filter', async () => {
  const app = await read('../src/App.jsx');
  const migration = await read('../supabase/migrations/20261031010000_preventivi_pro_operativo_realtime.sql');
  assert.match(app, /supabase\.channel\(`preventivi-workspace-\$\{user\.id\}`\)/);
  assert.match(app, /event: '\*', schema: 'public', table: 'preventivi_workspace'/);
  assert.match(app, /filter: `user_id=eq\.\$\{user\.id\}`/);
  assert.match(migration, /alter publication supabase_realtime add table public\.%I/);
  assert.match(migration, /'preventivi_workspace'/);
});

test('concurrent edits are protected by an invoker RPC with compare-and-swap semantics', async () => {
  const app = await read('../src/App.jsx');
  const migration = await read('../supabase/migrations/20261031010000_preventivi_pro_operativo_realtime.sql');
  assert.match(app, /supabase\.rpc\('pp_save_workspace'/);
  assert.match(app, /Carica versione cloud/);
  assert.match(app, /Mantieni questa versione/);
  assert.match(migration, /function public\.pp_save_workspace\([\s\S]*?security invoker/i);
  assert.match(migration, /w\.updated_at is not distinct from p_expected_updated_at/);
  assert.match(migration, /return query select false, null::timestamptz/);
});

test('operational database tables enforce owner RLS and are included in Realtime publication', async () => {
  const migration = await read('../supabase/migrations/20261031010000_preventivi_pro_operativo_realtime.sql');
  for (const table of ['pp_clients','pp_company_settings','pp_sites','pp_jobs','pp_deadlines','pp_site_documents','pp_inventory_items','pp_inventory_movements','pp_invoices','pp_invoice_lines','pp_payments']) {
    assert.ok(migration.includes(`'${table}'`), `${table} is declared in security/realtime table set`);
    assert.match(migration, new RegExp(`create table if not exists public\\.${table}`));
  }
  assert.match(migration, /alter table public\.%I enable row level security/);
  assert.match(migration, /\(select auth\.uid\(\)\) = owner_id/);
  assert.match(migration, /pp-site-documents/);
});

test('the app checks that the workspace is really in the Realtime publication before showing Live', async () => {
  const app = await read('../src/App.jsx');
  const migration = await read('../supabase/migrations/20261031010000_preventivi_pro_operativo_realtime.sql');
  assert.match(app, /supabase\.rpc\('pp_realtime_enabled'\)/);
  assert.match(app, /data === true \? 'connected' : 'not-enabled'/);
  assert.match(migration, /function public\.pp_realtime_enabled\(\)/);
  assert.match(migration, /tablename = 'preventivi_workspace'/);
});
