// gen:migration — create a new Supabase migration that follows the boilerplate's
// RLS-first convention. A table never ships without Row Level Security here:
// the skeleton enables RLS, grants the API roles, and scopes all four verbs to
// the user's workspaces. Copy-paste-shipping a table with RLS off is the #1
// Supabase footgun; this template makes the safe path the default path.

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
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
 * The RLS-first skeleton. `table` defaults to the slug so a name like
 * "projects" produces a ready-to-edit `public.projects` table; anything the
 * dev must decide is a clearly-marked TODO, never a silent gap.
 */
export function migrationSkeleton(name) {
  const table = slugify(name);
  return `-- ${name}
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
export function genMigration({ name, dir = 'supabase/migrations', date = new Date() }) {
  if (!name) throw new Error('usage: saas-kit gen:migration <name>');
  const filename = migrationFilename(name, date);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = join(dir, filename);
  if (existsSync(path)) throw new Error(`refusing to overwrite existing migration: ${path}`);
  writeFileSync(path, migrationSkeleton(name), 'utf8');
  return path;
}
