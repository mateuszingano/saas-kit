import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  migrationTimestamp,
  slugify,
  migrationFilename,
  migrationSkeleton,
  genMigration,
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
