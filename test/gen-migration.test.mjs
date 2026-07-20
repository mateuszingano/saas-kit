import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  migrationTimestamp,
  slugify,
  migrationFilename,
  migrationSkeleton,
  genMigration,
  detectTenancy,
  stripSqlNoise,
} from '../src/gen-migration.mjs';

const FIXED = new Date(Date.UTC(2026, 6, 7, 12, 30, 0)); // 2026-07-07 12:30:00 UTC

test('migrationTimestamp formats YYYYMMDDHHmmss in UTC', () => {
  assert.equal(migrationTimestamp(FIXED), '20260707123000');
});

test('slugify lowercases and snake_cases', () => {
  assert.equal(slugify('Add Projects'), 'add_projects');
  assert.equal(slugify('  billing-events!! '), 'billing_events');
});

test('slugify throws on empty-after-slug names', () => {
  assert.throws(() => slugify('!!!'), /empty/);
});

test('migrationFilename joins timestamp + slug + .sql', () => {
  assert.equal(migrationFilename('Add Projects', FIXED), '20260707123000_add_projects.sql');
});

test('skeleton enables RLS and scopes all four verbs', () => {
  const sql = migrationSkeleton('projects');
  assert.match(sql, /enable row level security/);
  assert.match(sql, /for select/);
  assert.match(sql, /for insert/);
  assert.match(sql, /for update/);
  assert.match(sql, /for delete/);
  // never a permissive policy
  assert.doesNotMatch(sql, /using \(true\)/i);
  // scoped to the workspace helper, not wide open
  assert.match(sql, /user_workspace_ids\(\)/);
});

test('skeleton flattens a multi-line name so it cannot inject SQL', () => {
  const sql = migrationSkeleton('projects\n-- injected\ndrop table users;');
  const firstLine = sql.split('\n')[0];
  // the whole name stays on the single comment line, whitespace flattened
  assert.equal(firstLine, '-- projects -- injected drop table users;');
  // no bare (non-comment) injected statement leaked out
  assert.doesNotMatch(sql, /^drop table users;/m);
});

test('genMigration writes the file and refuses to clobber', () => {
  const dir = mkdtempSync(join(tmpdir(), 'saaskit-'));
  const path = genMigration({ name: 'add_projects', dir, date: FIXED });
  assert.ok(existsSync(path));
  assert.match(readFileSync(path, 'utf8'), /create table public.add_projects/);
  // second call with same name+timestamp must not overwrite
  assert.throws(() => genMigration({ name: 'add_projects', dir, date: FIXED }), /overwrite/);
});

// --- B13.1 · the generated artifact must APPLY to the project that made it ---

// The workspace skeleton references public.workspaces and
// public.user_workspace_ids(), which ship in the PAID boilerplate. `saas-kit new`
// clones the FREE starter, which has neither — so the README's own two-line
// quickstart produced SQL that died on `relation "public.workspaces" does not
// exist`. Detection reads the project instead of assuming.
test('detectTenancy: a project with no migrations at all is owner-scoped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'saaskit-'));
  assert.equal(detectTenancy(join(dir, 'does-not-exist')), 'owner');
  assert.equal(detectTenancy(dir), 'owner', 'an empty migrations dir is not evidence of workspaces');
});

test('detectTenancy: finds the workspace primitives when they are there', () => {
  for (const sql of [
    'create table public.workspaces (id uuid primary key);',
    'create table if not exists public.workspaces (id uuid);',
    'create function public.user_workspace_ids() returns setof uuid as $$ $$;',
    'create policy p on public.notes for select using (workspace_id in (select public.user_workspace_ids()));',
  ]) {
    const dir = mkdtempSync(join(tmpdir(), 'saaskit-'));
    writeFileSync(join(dir, '20260101000000_init.sql'), sql);
    assert.equal(detectTenancy(dir), 'workspace', sql.slice(0, 40));
  }
});

test('detectTenancy: a project with unrelated migrations stays owner-scoped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'saaskit-'));
  writeFileSync(join(dir, '20260101000000_init.sql'), 'create table public.profiles (id uuid primary key);');
  assert.equal(detectTenancy(dir), 'owner');
});

// Only EXECUTABLE lines are a dependency — the explanatory comment legitimately
// mentions workspaces to tell the reader how to migrate up. Strip comments first.
const executableSql = (sql) =>
  sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

test('the owner skeleton references nothing but auth.users', () => {
  const sql = executableSql(migrationSkeleton('projects', { tenancy: 'owner' }));
  assert.doesNotMatch(sql, /workspaces|user_workspace_ids/, 'must not depend on the paid boilerplate');
  assert.match(sql, /references auth\.users/);
  // Same security bar as the workspace variant: RLS on, all four verbs, never
  // permissive. A variant that applies but is wide open would be worse.
  assert.match(sql, /enable row level security/);
  for (const verb of ['select', 'insert', 'update', 'delete']) {
    assert.match(sql, new RegExp(`for ${verb}`), `${verb} must be scoped`);
  }
  assert.doesNotMatch(sql, /using \(true\)/i);
  assert.doesNotMatch(sql, /to anon/, 'anon can never own a row — no grant for it');
});

test('genMigration on a free-starter-shaped project emits the applicable variant', () => {
  const dir = mkdtempSync(join(tmpdir(), 'saaskit-'));
  writeFileSync(join(dir, '20260101000000_init.sql'), 'create table public.profiles (id uuid primary key);');
  const path = genMigration({ name: 'add_projects', dir, date: FIXED });
  const sql = executableSql(readFileSync(path, 'utf8'));
  assert.doesNotMatch(sql, /public\.workspaces/, 'the quickstart must produce SQL that applies');
  assert.match(sql, /owner_id/);
});

test('genMigration on the paid boilerplate still emits the workspace variant', () => {
  const dir = mkdtempSync(join(tmpdir(), 'saaskit-'));
  writeFileSync(join(dir, '20260101000000_workspaces.sql'), 'create table public.workspaces (id uuid primary key);');
  const path = genMigration({ name: 'add_projects', dir, date: FIXED });
  assert.match(readFileSync(path, 'utf8'), /user_workspace_ids\(\)/, 'no regression for the paid path');
});

// --- detectTenancy must read executable SQL, not comments or strings ----------

// A raw substring match over the file would read `-- see user_workspace_ids()`
// as a dependency and emit the workspace variant into an owner project — which
// does not apply, re-opening B13.1 through a narrow trigger.
test('detectTenancy ignores the primitives when they appear only in a comment', () => {
  const dir = mkdtempSync(join(tmpdir(), 'saaskit-'));
  writeFileSync(join(dir, '0.sql'), 'create table public.profiles(id uuid primary key);\n-- TODO: migrate to user_workspace_ids() someday\n');
  assert.equal(detectTenancy(dir), 'owner');
});

test('detectTenancy ignores the primitives inside a string literal', () => {
  const dir = mkdtempSync(join(tmpdir(), 'saaskit-'));
  writeFileSync(join(dir, '0.sql'), "insert into notes(body) values ('create table public.workspaces (id uuid)');");
  assert.equal(detectTenancy(dir), 'owner');
});

test('detectTenancy still fires on real executable workspace SQL', () => {
  for (const sql of [
    'create table public.workspaces (id uuid primary key);',
    'create policy p on t for select using (workspace_id in (select public.user_workspace_ids()));',
  ]) {
    const dir = mkdtempSync(join(tmpdir(), 'saaskit-'));
    writeFileSync(join(dir, '0.sql'), sql);
    assert.equal(detectTenancy(dir), 'workspace', sql.slice(0, 30));
  }
});

test('stripSqlNoise removes comments and string literals, keeps executable SQL', () => {
  const out = stripSqlNoise("select 1; -- user_workspace_ids()\n/* public.workspaces */ create table public.workspaces (x int);");
  assert.doesNotMatch(out, /user_workspace_ids/);
  assert.match(out, /create table public\.workspaces/);
});
