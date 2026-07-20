// gen:migration — create a new Supabase migration that follows the boilerplate's
// RLS-first convention. A table never ships without Row Level Security here:
// the skeleton enables RLS, grants the API roles, and scopes all four verbs to
// the user's workspaces. Copy-paste-shipping a table with RLS off is the #1
// Supabase footgun; this template makes the safe path the default path.

import { writeFileSync, mkdirSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Two-digit zero-pad.
const p2 = (n) => String(n).padStart(2, '0');

/**
 * Build the `YYYYMMDDHHmmss` timestamp Supabase orders migrations by.
 * `date` is injectable so tests are deterministic.
 */
export function migrationTimestamp(date = new Date()) {
  return (
    date.getUTCFullYear().toString() +
    p2(date.getUTCMonth() + 1) +
    p2(date.getUTCDate()) +
    p2(date.getUTCHours()) +
    p2(date.getUTCMinutes()) +
    p2(date.getUTCSeconds())
  );
}

/** Turn a human name into a snake_case slug safe for a filename. */
export function slugify(name) {
  const slug = String(name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!slug) throw new Error('migration name is empty after slugifying');
  return slug;
}

/** `20260707123000_add_projects.sql` */
export function migrationFilename(name, date = new Date()) {
  return `${migrationTimestamp(date)}_${slugify(name)}.sql`;
}

/**
 * Does this project have the multi-tenant primitives the workspace skeleton
 * references? Reads the existing migrations rather than guessing.
 *
 * Returns 'workspace' only on positive evidence. The fallback is 'owner'
 * because owner-scoping depends on nothing but auth.users, which every Supabase
 * project has: a wrong guess there produces SQL that applies and is still safe,
 * while a wrong guess the other way produces SQL that will not apply at all.
 */
export function detectTenancy(dir = 'supabase/migrations') {
  if (!existsSync(dir)) return 'owner';
  let files;
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.sql'));
  } catch {
    return 'owner';
  }
  for (const f of files) {
    let sql;
    try {
      sql = readFileSync(join(dir, f), 'utf8');
    } catch {
      continue;
    }
    // Match on EXECUTABLE sql only. A comment mentioning the workspace primitives
    // (`-- TODO: move to user_workspace_ids()`) is not a dependency, but a raw
    // substring match would read it as one and emit the workspace variant into a
    // project that has no such table — re-opening the exact B13.1 failure. Strip
    // line comments (`-- …`), block comments (`/* … */`), and single-quoted
    // string literals before testing.
    if (/user_workspace_ids\s*\(|create\s+table\s+(if\s+not\s+exists\s+)?public\.workspaces\b/i.test(stripSqlNoise(sql))) {
      return 'workspace';
    }
  }
  return 'owner';
}

/** Remove comments and string literals so a detector matches only real SQL. */
export function stripSqlNoise(sql) {
  return String(sql)
    .replace(/\/\*[\s\S]*?\*\//g, ' ') // /* block comments */
    .replace(/--[^\n]*/g, ' ')          // -- line comments
    .replace(/'(?:[^']|'')*'/g, "''");  // 'single-quoted' string literals
}

/**
 * The RLS-first skeleton. `table` defaults to the slug so a name like
 * "projects" produces a ready-to-edit `public.projects` table; anything the
 * dev must decide is a clearly-marked TODO, never a silent gap.
 *
 * `tenancy` defaults to 'workspace' — the documented shape of the boilerplate
 * this CLI accompanies. `genMigration` overrides it from `detectTenancy`, so the
 * COMMAND adapts to the project while the pure function keeps a stable default.
 */
export function migrationSkeleton(name, { tenancy = 'workspace' } = {}) {
  const table = slugify(name);
  // Flatten all whitespace (incl. newlines) so a multi-line name can't break
  // out of this single-line `-- ` comment and inject raw SQL below it.
  const heading = String(name).replace(/\s+/g, ' ').trim();

  if (tenancy === 'owner') {
    // Owner-scoped variant, for projects WITHOUT the workspace primitives.
    //
    // This exists because the multi-tenant skeleton below references
    // public.workspaces and public.user_workspace_ids(), which ship in the PAID
    // boilerplate. `saas-kit new` clones the FREE starter, which has neither — so
    // the two-line quickstart in the README (`new` then `gen:migration` then
    // `supabase db push`) died on `relation "public.workspaces" does not exist`.
    // A free CLI whose documented happy path does not run is worse than one that
    // does less.
    //
    // Only dependency is auth.users, which every Supabase project has. No `anon`
    // grant: rows are owned by an authenticated user, so a select grant to anon
    // would give a role that can never match a row nothing but a wider surface.
    return `-- ${heading}
-- RLS-first: this table is scoped to its owner and can't ship exposed.
-- Adjust the columns; keep the security block.
--
-- Owner-scoped because this project has no public.workspaces table. If you move
-- to the multi-tenant boilerplate, re-scope these policies to the workspace.

create table public.${table} (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade default (select auth.uid()),
  -- TODO: your columns here
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index ${table}_owner_id_idx on public.${table} (owner_id);

alter table public.${table} enable row level security;

-- Table privileges for the API roles (RLS below governs which rows).
grant select, insert, update, delete on public.${table} to authenticated;
grant all on public.${table} to service_role;

create policy "read my ${table}"
  on public.${table} for select
  using (owner_id = (select auth.uid()));

create policy "create my ${table}"
  on public.${table} for insert
  with check (owner_id = (select auth.uid()));

create policy "update my ${table}"
  on public.${table} for update
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

create policy "delete my ${table}"
  on public.${table} for delete
  using (owner_id = (select auth.uid()));
`;
  }

  return `-- ${heading}
-- RLS-first: this table is scoped to a workspace and can't ship exposed.
-- Adjust the columns; keep the security block. The isolation test in the
-- boilerplate proves tenant A can't touch tenant B's rows.

create table public.${table} (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  author_id uuid not null references auth.users (id) on delete cascade,
  -- TODO: your columns here
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index ${table}_workspace_id_idx on public.${table} (workspace_id);

alter table public.${table} enable row level security;

-- Table privileges for the API roles (RLS below governs which rows).
grant select on public.${table} to anon;
grant select, insert, update, delete on public.${table} to authenticated;
grant all on public.${table} to service_role;

create policy "read ${table} in my workspaces"
  on public.${table} for select
  using (workspace_id in (select public.user_workspace_ids()));

create policy "create ${table} in my workspaces"
  on public.${table} for insert
  with check (
    workspace_id in (select public.user_workspace_ids())
    and author_id = (select auth.uid())
  );

create policy "update ${table} in my workspaces"
  on public.${table} for update
  using (workspace_id in (select public.user_workspace_ids()))
  with check (workspace_id in (select public.user_workspace_ids()));

create policy "delete ${table} in my workspaces"
  on public.${table} for delete
  using (workspace_id in (select public.user_workspace_ids()));
`;
}

/**
 * Write the migration. Returns the absolute path written.
 * Throws if the target file already exists (never clobber).
 */
export function genMigration({ name, dir = 'supabase/migrations', date = new Date(), tenancy }) {
  if (!name) throw new Error('usage: saas-kit gen:migration <name>');
  const filename = migrationFilename(name, date);
  // Detect BEFORE mkdir: creating the directory first would make an existing
  // project look like an empty one on the very first run.
  const mode = tenancy || detectTenancy(dir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = join(dir, filename);
  if (existsSync(path)) throw new Error(`refusing to overwrite existing migration: ${path}`);
  writeFileSync(path, migrationSkeleton(name, { tenancy: mode }), 'utf8');
  // Returns the path (a string), unchanged. Callers that need to know which
  // variant was emitted call `detectTenancy` themselves — widening this to an
  // object would break every existing caller for one extra field.
  return path;
}
