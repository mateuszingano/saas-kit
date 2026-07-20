import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, cpSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  ignoreEntry,
  redactUrlCredentials,
  renamePackage,
  resolveSource,
  scaffoldLocal,
  scaffoldRepo,
  pruneIgnored,
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
  assert.equal(validateRepo('  https://h/r.git  '), 'https://h/r.git'); // trims
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

// ONDA 1 — Windows rejects these at the Win32 API level, but Node creates them
// through the \?\ prefix. The result was a directory that exists, is visible,
// and cannot be entered or deleted with normal tools — while the CLI printed
// "✔ Scaffolded" and told the user to `cd` into it.
test('project names invalid on Windows are refused', () => {
  for (const bad of ['victim..', 'a.', 'test..', 'con', 'CON', 'nul', 'aux', 'prn', 'com1', 'lpt9'])
    assert.throws(() => validateProjectName(bad), `expected "${bad}" to be rejected`);
  // and normal names still work — including legitimate interior dots
  for (const ok of ['my-app', 'app.v2', 'a1', 'my_app'])
    assert.equal(validateProjectName(ok), ok, `expected "${ok}" to be accepted`);
});

// A private-repo clone over `https://user:TOKEN@host/...` is the flow the README
// recommends; printing it raw put the token in CI logs and screenshots. git
// itself redacts this — we were less careful than the tool we shell out to.
test('clone failures redact credentials embedded in the repo URL', () => {
  const out = redactUrlCredentials('https://mateus:ghp_SUPERSECRET123@github.com/owner/repo.git');
  assert.ok(!out.includes('ghp_SUPERSECRET123'), 'the token must not survive');
  assert.equal(out, 'https://***@github.com/owner/repo.git');
  // URLs without credentials are untouched
  assert.equal(redactUrlCredentials('https://github.com/owner/repo.git'), 'https://github.com/owner/repo.git');
});

// finalize() runs AFTER the copy and can throw (malformed template package.json).
// Without rollback the command exited non-zero leaving a half-written project —
// and on the --repo path `.git` was already stripped, so the user had an orphan
// copy and was blocked from retrying by the overwrite guard.
test('a failure after the copy removes the directory we created', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'saas-kit-rollback-'));
  const tpl = join(tmp, 'tpl');
  mkdirSync(tpl);
  writeFileSync(join(tpl, 'package.json'), '{ this is not json');
  const dest = join(tmp, 'myapp');
  assert.throws(() => scaffoldLocal({ name: 'myapp', from: tpl, dest }));
  assert.equal(existsSync(dest), false, 'no half-written project may be left behind');
});

test('rollback never deletes a directory that already existed', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'saas-kit-rollback2-'));
  const tpl = join(tmp, 'tpl');
  mkdirSync(tpl);
  writeFileSync(join(tpl, 'package.json'), '{ bad');
  const dest = join(tmp, 'existing');
  mkdirSync(dest);
  writeFileSync(join(dest, 'important.txt'), 'do not delete me');
  // the overwrite guard rejects it first — and the user's file survives
  assert.throws(() => scaffoldLocal({ name: 'existing', from: tpl, dest }), /refusing to overwrite/);
  assert.equal(existsSync(join(dest, 'important.txt')), true);
});

// Cloning a TEMPLATE over plaintext http:// is a trivial MITM: whoever sits on
// the path injects code into a project the developer is about to run and deploy.
// There is no integrity check in this flow (no commit pin, no checksum), which
// is fine over TLS and not fine without it.
test('validateRepo refuses plaintext http://', () => {
  assert.throws(() => validateRepo('http://evil.example/t.git'), /plaintext http/);
  assert.throws(() => validateRepo('HTTP://evil.example/t.git'), /plaintext http/);
  // https and the other accepted shapes are unaffected
  assert.equal(validateRepo('https://github.com/o/r.git'), 'https://github.com/o/r.git');
  assert.equal(validateRepo('git@github.com:o/r.git'), 'git@github.com:o/r.git');
});

// The local-template path filtered IGNORE entry by entry; the clone path did
// not — so `--repo`, which is the DEFAULT source, carried the template author's
// `.env`, a nested `sub/.env` and a committed `node_modules` into the new
// project. And because a `.env` arrived, finalize skipped seeding from
// `.env.example`, so the developer never saw the config template and ran with
// someone else's secrets.
test('scaffoldRepo prunes ignored entries, at any depth', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'saas-kit-prune-'));
  const tpl = join(tmp, 'tpl');
  mkdirSync(join(tpl, 'sub'), { recursive: true });
  mkdirSync(join(tpl, 'node_modules'), { recursive: true });
  writeFileSync(join(tpl, 'package.json'), '{"name":"t","version":"1.0.0"}');
  writeFileSync(join(tpl, '.env'), 'SECRET=leaked-top');
  writeFileSync(join(tpl, '.env.example'), 'SECRET=');
  writeFileSync(join(tpl, 'sub', '.env'), 'SECRET=leaked-nested');
  writeFileSync(join(tpl, 'node_modules', 'dep.js'), '// vendored');
  writeFileSync(join(tpl, 'sub', 'keep.js'), '// real source');

  const dest = join(tmp, 'app');
  // Stand in for git: copy the template wholesale, exactly as a clone would.
  scaffoldRepo({ name: 'app', repo: 'https://example.com/t.git', dest, clone: (_r, d) => cpSync(tpl, d, { recursive: true }) });

  assert.equal(existsSync(join(dest, 'sub', '.env')), false, 'a nested .env must not survive the clone');
  assert.equal(existsSync(join(dest, 'node_modules')), false, 'node_modules must not survive the clone');
  assert.equal(existsSync(join(dest, 'sub', 'keep.js')), true, 'real source must survive');
  // and the .env is the SEEDED one, not the template author's
  assert.equal(readFileSync(join(dest, '.env'), 'utf8').includes('leaked-top'), false, "the author's secrets must not arrive");
});

// Pruning the working tree is not enough on its own: a clone also brings the
// HISTORY, and `git show HEAD:.env` would hand back the template author's
// secret even after the file is deleted from the tree. `finalize` strips `.git`,
// which closes that — this test exists so the two stay closed together.
test('a cloned project keeps no path back to the template author secrets', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'saas-kit-history-'));
  const tpl = join(tmp, 'tpl');
  mkdirSync(tpl, { recursive: true });
  writeFileSync(join(tpl, 'package.json'), '{"name":"t","version":"1.0.0"}');
  writeFileSync(join(tpl, '.env'), 'SECRET=leaked-in-history');
  writeFileSync(join(tpl, '.env.example'), 'SECRET=');
  execFileSync('git', ['init', '-q'], { cwd: tpl });
  execFileSync('git', ['add', '-A', '-f'], { cwd: tpl });
  execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-qm', 'i'], { cwd: tpl });

  const dest = join(tmp, 'app');
  scaffoldRepo({
    name: 'app',
    repo: 'https://example.com/t.git',
    dest,
    clone: (_r, d) => execFileSync('git', ['clone', '-q', '--', tpl, d]),
  });

  assert.equal(existsSync(join(dest, '.git')), false, '.git must not survive — it carries the history');
  assert.equal(readFileSync(join(dest, '.env'), 'utf8').includes('leaked-in-history'), false);
});

// `pruneIgnored` deletes recursively. It must remove the LINK, never walk it —
// otherwise an ignored entry that happens to be a symlink would take data
// outside the project down with it.
test('pruneIgnored removes a symlinked ignore entry without touching its target', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'saas-kit-symlink-'));
  const outside = join(tmp, 'outside');
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'precious.txt'), 'do not delete me');
  const proj = join(tmp, 'proj');
  mkdirSync(join(proj, 'sub'), { recursive: true });
  writeFileSync(join(proj, 'sub', 'keep.js'), '// real source');
  try {
    symlinkSync(outside, join(proj, 'node_modules'), 'junction');
  } catch {
    return; // no privilege to create links on this machine — nothing to assert
  }
  pruneIgnored(proj);
  assert.equal(existsSync(join(proj, 'node_modules')), false, 'the link itself goes');
  assert.equal(existsSync(join(outside, 'precious.txt')), true, 'what it pointed at stays');
  assert.equal(existsSync(join(proj, 'sub', 'keep.js')), true);
});
