import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ignoreEntry,
  renamePackage,
  resolveSource,
  scaffoldLocal,
  scaffoldRepo,
  DEFAULT_TEMPLATE,
} from '../src/new.mjs';

test('ignoreEntry skips build artifacts and secrets, keeps source', () => {
  assert.equal(ignoreEntry('node_modules'), true);
  assert.equal(ignoreEntry('.env'), true);
  assert.equal(ignoreEntry('src'), false);
});

test('renamePackage sets name and resets version', () => {
  const pkg = JSON.parse(renamePackage('{"name":"x","version":"9.9.9"}', 'my-app'));
  assert.equal(pkg.name, 'my-app');
  assert.equal(pkg.version, '0.1.0');
});

test('resolveSource: --from is local, --repo is repo', () => {
  assert.deepEqual(resolveSource({ from: 'dir' }), { kind: 'local', value: 'dir' });
  assert.deepEqual(resolveSource({ repo: 'x.git' }), { kind: 'repo', value: 'x.git' });
});

test('resolveSource: env template detects git url vs local path', () => {
  assert.equal(resolveSource({}, { SAAS_KIT_TEMPLATE: 'https://h/r.git' }).kind, 'repo');
  assert.equal(resolveSource({}, { SAAS_KIT_TEMPLATE: './local' }).kind, 'local');
});

test('resolveSource: nothing configured defaults to the free public starter', () => {
  const s = resolveSource({}, {});
  assert.equal(s.kind, 'repo');
  assert.equal(s.value, DEFAULT_TEMPLATE);
  assert.match(s.value, /nextjs-supabase-starter/);
});

test('resolveSource: explicit --from/--repo override the default', () => {
  assert.equal(resolveSource({ from: 'dir' }).kind, 'local');
  assert.equal(resolveSource({ repo: 'x.git' }).value, 'x.git');
});

test('scaffoldLocal copies source, drops ignored, renames, seeds .env', () => {
  const root = mkdtempSync(join(tmpdir(), 'saaskit-'));
  const from = join(root, 'template');
  mkdirSync(join(from, 'src'), { recursive: true });
  mkdirSync(join(from, 'node_modules'), { recursive: true });
  writeFileSync(join(from, 'src', 'index.ts'), 'export {}');
  writeFileSync(join(from, 'package.json'), '{"name":"tmpl","version":"1.0.0"}');
  writeFileSync(join(from, '.env.example'), 'KEY=');
  writeFileSync(join(from, 'node_modules', 'junk.js'), '//');

  const dest = join(root, 'my-app');
  scaffoldLocal({ name: 'my-app', from, dest });

  assert.ok(existsSync(join(dest, 'src', 'index.ts')), 'copies src');
  assert.ok(!existsSync(join(dest, 'node_modules')), 'drops node_modules');
  assert.equal(JSON.parse(readFileSync(join(dest, 'package.json'), 'utf8')).name, 'my-app');
  assert.equal(readFileSync(join(dest, '.env'), 'utf8'), 'KEY=', 'seeds .env from example');
});

test('scaffoldRepo finalizes: strips .git, renames (clone injected)', () => {
  const root = mkdtempSync(join(tmpdir(), 'saaskit-'));
  const dest = join(root, 'cloned');
  // fake clone: create a repo-like dir with a .git folder
  const fakeClone = (repo, target) => {
    mkdirSync(join(target, '.git'), { recursive: true });
    writeFileSync(join(target, 'package.json'), '{"name":"tmpl","version":"2.0.0"}');
  };
  scaffoldRepo({ name: 'cloned', repo: 'x.git', dest, clone: fakeClone });

  assert.ok(!existsSync(join(dest, '.git')), 'strips .git after clone');
  assert.equal(JSON.parse(readFileSync(join(dest, 'package.json'), 'utf8')).name, 'cloned');
});

test('scaffold refuses to overwrite an existing directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'saaskit-'));
  const from = join(root, 'template');
  mkdirSync(from, { recursive: true });
  writeFileSync(join(from, 'package.json'), '{"name":"t"}');
  const dest = join(root, 'exists');
  mkdirSync(dest, { recursive: true });
  assert.throws(() => scaffoldLocal({ name: 'exists', from, dest }), /overwrite/);
});
