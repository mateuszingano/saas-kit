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
  validateProjectName,
  validateRepo,
  DEFAULT_TEMPLATE,
} from '../src/new.mjs';

test('validateProjectName accepts a clean npm-safe name', () => {
  assert.equal(validateProjectName('my-app'), 'my-app');
  assert.equal(validateProjectName('  my.app_2  '), 'my.app_2'); // trims
});

test('validateProjectName rejects empty, uppercase, and leading dot/underscore', () => {
  assert.throws(() => validateProjectName(''), /required/);
  assert.throws(() => validateProjectName('   '), /required/);
  assert.throws(() => validateProjectName('MyApp'), /lowercase/);
  assert.throws(() => validateProjectName('.hidden'), /dot or underscore/);
  assert.throws(() => validateProjectName('_priv'), /dot or underscore/);
});

test('validateProjectName rejects path separators and illegal characters', () => {
  assert.throws(() => validateProjectName('a/b'), /path separator/);
  assert.throws(() => validateProjectName('a\\b'), /path separator/);
  assert.throws(() => validateProjectName('my app'), /invalid project name/);
  assert.throws(() => validateProjectName('my@app'), /invalid project name/);
});

test('validateProjectName rejects names longer than 214 chars', () => {
  assert.throws(() => validateProjectName('a'.repeat(215)), /214/);
});

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

test('scaffoldLocal drops NESTED secrets and vcs dirs, not just top-level', () => {
  const root = mkdtempSync(join(tmpdir(), 'saaskit-'));
  const from = join(root, 'template');
  mkdirSync(join(from, 'sub'), { recursive: true });
  mkdirSync(join(from, 'sub', '.git'), { recursive: true });
  writeFileSync(join(from, 'package.json'), '{"name":"tmpl","version":"1.0.0"}');
  writeFileSync(join(from, 'sub', 'keep.ts'), 'export {}');
  writeFileSync(join(from, 'sub', '.env'), 'SECRET=1');
  writeFileSync(join(from, 'sub', '.git', 'config'), '[core]');

  const dest = join(root, 'my-app');
  scaffoldLocal({ name: 'my-app', from, dest });

  assert.ok(existsSync(join(dest, 'sub', 'keep.ts')), 'keeps nested source');
  assert.ok(!existsSync(join(dest, 'sub', '.env')), 'drops nested .env');
  assert.ok(!existsSync(join(dest, 'sub', '.git')), 'drops nested .git');
});

test('scaffoldRepo finalizes: strips .git, renames (clone injected)', () => {
  const root = mkdtempSync(join(tmpdir(), 'saaskit-'));
  const dest = join(root, 'cloned');
  // fake clone: create a repo-like dir with a .git folder
  const fakeClone = (repo, target) => {
    mkdirSync(join(target, '.git'), { recursive: true });
    writeFileSync(join(target, 'package.json'), '{"name":"tmpl","version":"2.0.0"}');
  };
  scaffoldRepo({ name: 'cloned', repo: 'https://example.test/x.git', dest, clone: fakeClone });

  assert.ok(!existsSync(join(dest, '.git')), 'strips .git after clone');
  assert.equal(JSON.parse(readFileSync(join(dest, 'package.json'), 'utf8')).name, 'cloned');
});

test('validateRepo accepts https, git@ and relative local sources', () => {
  assert.equal(validateRepo('https://github.com/o/r.git'), 'https://github.com/o/r.git');
  assert.equal(validateRepo('  http://h/r.git  '), 'http://h/r.git'); // trims
  assert.equal(validateRepo('git@github.com:o/r.git'), 'git@github.com:o/r.git');
  assert.equal(validateRepo('./local-template'), './local-template');
  assert.equal(validateRepo('../sibling'), '../sibling');
});

test('validateRepo rejects flag-like and unrecognized sources', () => {
  assert.throws(() => validateRepo('--upload-pack=touch /tmp/pwned'), /cannot start with/);
  assert.throws(() => validateRepo('-x'), /cannot start with/);
  assert.throws(() => validateRepo('ftp://evil/r.git'), /invalid --repo/);
  assert.throws(() => validateRepo('x.git'), /invalid --repo/);
  assert.throws(() => validateRepo('git@-evil.com:o/r.git'), /host starting with/);
  assert.throws(() => validateRepo(''), /required/);
  assert.throws(() => validateRepo('   '), /required/);
});

test('scaffoldRepo rejects an arg-injection --repo and NEVER runs the clone', () => {
  const root = mkdtempSync(join(tmpdir(), 'saaskit-'));
  const dest = join(root, 'evil');
  let called = false;
  const spyClone = () => {
    called = true;
  };
  assert.throws(
    () =>
      scaffoldRepo({
        name: 'evil',
        repo: '--upload-pack=touch /tmp/pwned',
        dest,
        clone: spyClone,
      }),
    /invalid --repo/
  );
  assert.equal(called, false, 'clone must not run for a flag-like repo');
  assert.ok(!existsSync(dest), 'no directory created for a rejected repo');
});

test('scaffoldRepo accepts a valid https repo and passes it to the clone', () => {
  const root = mkdtempSync(join(tmpdir(), 'saaskit-'));
  const dest = join(root, 'ok');
  let seen = null;
  const fakeClone = (repo, target) => {
    seen = repo;
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'package.json'), '{"name":"tmpl","version":"1.0.0"}');
  };
  scaffoldRepo({ name: 'ok', repo: 'https://example.test/r.git', dest, clone: fakeClone });
  assert.equal(seen, 'https://example.test/r.git', 'clone ran with the validated url');
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
