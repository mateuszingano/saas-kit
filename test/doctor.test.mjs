import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEnv, parseEnvDetailed, loadEnvDetailed, envChain, checkEnv, classifySupabaseUrl, probeSupabase } from '../src/doctor.mjs';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ANON = 'anon-key';
const ENV = { NEXT_PUBLIC_SUPABASE_URL: 'https://proj.supabase.co', NEXT_PUBLIC_SUPABASE_ANON_KEY: ANON };

/** A fetch stand-in that records calls and replies with a fixed status. */
function fakeFetch(status, calls = []) {
  return async (url, init) => {
    calls.push({ url, init });
    return { status, ok: status >= 200 && status < 300 };
  };
}

test('parseEnv reads pairs, skips comments and blanks, strips quotes', () => {
  const env = parseEnv('# comment\nA=1\n\nB="two"\nC=\n');
  assert.deepEqual(env, { A: '1', B: 'two', C: '' });
});

test('checkEnv flags missing required vars as errors', () => {
  const { results, ok } = checkEnv({ NEXT_PUBLIC_SUPABASE_URL: 'http://x' });
  assert.equal(ok, false); // anon key missing
  const anon = results.find((r) => r.key === 'NEXT_PUBLIC_SUPABASE_ANON_KEY');
  assert.equal(anon.status, 'error');
});

test('checkEnv passes when required present, service key only warns', () => {
  const { results, ok } = checkEnv({
    NEXT_PUBLIC_SUPABASE_URL: 'http://x',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon',
  });
  assert.equal(ok, true);
  const svc = results.find((r) => r.key === 'SUPABASE_SERVICE_ROLE_KEY');
  assert.equal(svc.status, 'warn');
});

test('checkEnv treats a public service role key as an error (leak)', () => {
  const { ok, results } = checkEnv({
    NEXT_PUBLIC_SUPABASE_URL: 'http://x',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon',
    NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY: 'leaked',
  });
  assert.equal(ok, false);
  assert.ok(results.some((r) => r.key === 'NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY' && r.status === 'error'));
});


// ONDA 1 — doctor used to look only at variable NAMES, so the mistake people
// actually make (copying the wrong key out of the dashboard into the anon slot)
// passed clean. NEXT_PUBLIC_ ships that value to every browser, and a
// service_role key bypasses RLS entirely — the exact leak airlock-rls exists to
// hunt, missed by the CLI from the same house.
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwtWithRole = (role) => `eyJhbGciOiJIUzI1NiJ9.${b64({ iss: 'supabase', role })}.sig`;
const BASE = { NEXT_PUBLIC_SUPABASE_URL: 'https://x.supabase.co' };

test('doctor: a service_role key in the public ANON slot is an error', () => {
  const r = checkEnv({
    ...BASE,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: jwtWithRole('service_role'),
    SUPABASE_SERVICE_ROLE_KEY: jwtWithRole('service_role'),
  });
  assert.equal(r.ok, false);
  const hit = r.results.find((x) => x.key === 'NEXT_PUBLIC_SUPABASE_ANON_KEY' && x.status === 'error');
  assert.ok(hit, 'must flag the anon slot as an error');
  assert.match(hit.hint, /rotate/i, 'and tell the user to rotate it');
});

test('doctor: a correct pairing stays clean (no false positive)', () => {
  const r = checkEnv({
    ...BASE,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: jwtWithRole('anon'),
    SUPABASE_SERVICE_ROLE_KEY: jwtWithRole('service_role'),
  });
  assert.equal(r.ok, true);
});

test('doctor: the anon key in the service-role slot is a warning', () => {
  const r = checkEnv({
    ...BASE,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: jwtWithRole('anon'),
    SUPABASE_SERVICE_ROLE_KEY: jwtWithRole('anon'),
  });
  assert.ok(r.results.some((x) => x.key === 'SUPABASE_SERVICE_ROLE_KEY' && x.status === 'warn'));
});

test('doctor: non-JWT key formats are ignored rather than misread', () => {
  const r = checkEnv({
    ...BASE,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'sb_publishable_abc123',
    SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_xyz789',
  });
  assert.equal(r.ok, true, 'the newer sb_* format carries no claims — must not crash or false-positive');
})

// Supabase's CURRENT key format (`sb_publishable_…` / `sb_secret_…`) carries no
// claims, so a JWT-only check skipped it entirely and reported "ok" — the exact
// leak this feature exists to catch, missed on the keys people are handed today.
// The previous fixture tested `sb_*` only in the CORRECT slots, which is how the
// gap survived: it proved the happy path of the new format and never the
// dangerous one.
test('doctor: sb_secret_ in a public slot is an error, in both key formats', () => {
  for (const bad of ['sb_secret_9f8a7b6c5d4e', jwtWithRole('service_role')]) {
    const r = checkEnv({ ...BASE, NEXT_PUBLIC_SUPABASE_ANON_KEY: bad, SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_x' });
    assert.equal(r.ok, false, `${bad.slice(0, 14)}… in the anon slot must be an error`);
    assert.ok(r.results.some((x) => x.key === 'NEXT_PUBLIC_SUPABASE_ANON_KEY' && x.status === 'error'));
  }
});

// The variable NAME is the part a developer invents freely; the key's identity
// is in the VALUE. Checking a fixed list of names missed every invented one.
test('doctor: a service-role key in ANY NEXT_PUBLIC_ variable is an error', () => {
  for (const name of ['NEXT_PUBLIC_SUPABASE_KEY', 'NEXT_PUBLIC_ADMIN_KEY', 'NEXT_PUBLIC_WHATEVER']) {
    const r = checkEnv({
      ...BASE,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: 'sb_publishable_ok',
      SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_ok',
      [name]: 'sb_secret_leaked',
    });
    assert.equal(r.ok, false, `${name} holding a service key must be an error`);
    assert.ok(r.results.some((x) => x.key === name && x.status === 'error'));
  }
});

test('doctor: correct pairings stay clean in both formats, and one leak is reported once', () => {
  assert.equal(checkEnv({ ...BASE, NEXT_PUBLIC_SUPABASE_ANON_KEY: 'sb_publishable_a', SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_b' }).ok, true);
  assert.equal(checkEnv({ ...BASE, NEXT_PUBLIC_SUPABASE_ANON_KEY: jwtWithRole('anon'), SUPABASE_SERVICE_ROLE_KEY: jwtWithRole('service_role') }).ok, true);
  // no duplicate finding for the same variable
  const r = checkEnv({ ...BASE, NEXT_PUBLIC_SUPABASE_ANON_KEY: 'sb_secret_x', SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_y' });
  assert.equal(r.results.filter((x) => x.key === 'NEXT_PUBLIC_SUPABASE_ANON_KEY' && x.status === 'error').length, 1);
});

// --- B9.1 · the probe refuses to hand the anon key to a plaintext host --------

test('classifySupabaseUrl accepts https', () => {
  assert.equal(classifySupabaseUrl('https://proj.supabase.co').ok, true);
});

test('classifySupabaseUrl allows http only on loopback (where `supabase start` runs)', () => {
  for (const url of ['http://localhost:54321', 'http://127.0.0.1:54321', 'http://[::1]:54321']) {
    assert.equal(classifySupabaseUrl(url).ok, true, url);
    assert.equal(classifySupabaseUrl(url).local, true, url);
  }
});

test('classifySupabaseUrl refuses plaintext http to a remote host', () => {
  const v = classifySupabaseUrl('http://proj.supabase.co');
  assert.equal(v.ok, false);
  assert.match(v.reason, /plaintext http/);
});

// Obfuscated IP forms are the classic way past a hand-rolled hostname check.
// Here they need no defence: WHATWG `new URL()` normalizes decimal, hex and
// octal to 127.0.0.1, so they take the loopback branch — allowed for exactly the
// reason http://127.0.0.1 is allowed, because they ARE it. This test pins that
// the normalization is what protects us; if a future refactor swaps `new URL()`
// for a regex, these become a real bypass and this test is where it shows up.
test('classifySupabaseUrl: obfuscated IP forms normalize to loopback, not to a bypass', () => {
  for (const url of ['http://2130706433:8742', 'http://0x7f000001', 'http://017700000001']) {
    const v = classifySupabaseUrl(url);
    assert.equal(v.ok, true, url);
    assert.equal(v.local, true, `${url} must be recognised as loopback, not as a remote host`);
  }
  // The same trick pointed at a genuinely remote host stays refused.
  assert.equal(classifySupabaseUrl('http://3232235777').ok, false, '192.168.1.1 is not loopback');
});

test('classifySupabaseUrl refuses odd schemes and garbage', () => {
  assert.equal(classifySupabaseUrl('ftp://proj.supabase.co').ok, false);
  assert.equal(classifySupabaseUrl('not a url').ok, false);
});

test('probeSupabase refuses a plaintext URL WITHOUT making the request', () => {
  const calls = [];
  return probeSupabase(
    { ...ENV, NEXT_PUBLIC_SUPABASE_URL: 'http://evil.example' },
    { fetchImpl: fakeFetch(200, calls) }
  ).then((probe) => {
    assert.equal(probe.reachable, false);
    assert.equal(probe.refused, true);
    // The key must never leave the process — asserting on the verdict alone
    // would still pass if we fetched first and judged afterwards.
    assert.equal(calls.length, 0);
  });
});

// --- B9.2 · a redirect does not walk the anon key off to another host --------

test('probeSupabase does not follow redirects, and reports the 302 as unreachable', async () => {
  const calls = [];
  const probe = await probeSupabase(ENV, { fetchImpl: fakeFetch(302, calls) });
  assert.equal(calls[0].init.redirect, 'manual');
  assert.equal(probe.reachable, false);
  assert.match(probe.error, /redirect/);
});

test('probeSupabase still treats 200 and 404 as reachable', async () => {
  assert.equal((await probeSupabase(ENV, { fetchImpl: fakeFetch(200) })).reachable, true);
  assert.equal((await probeSupabase(ENV, { fetchImpl: fakeFetch(404) })).reachable, true);
  assert.equal((await probeSupabase(ENV, { fetchImpl: fakeFetch(500) })).reachable, false);
});

test('probeSupabase skips when the env is not filled in', async () => {
  assert.equal((await probeSupabase({}, { fetchImpl: fakeFetch(200) })).skipped, true);
  assert.equal((await probeSupabase({ NEXT_PUBLIC_SUPABASE_URL: 'https://x' })).skipped, true);
});

// --- A15.1 · the probe does not echo credentials back into the log ----------

test('probeSupabase redacts userinfo out of the fetch error it reports', async () => {
  const throwing = async () => {
    // The shape of the real failure: fetch embeds the URL, userinfo included.
    throw new Error(
      'Request cannot be constructed from a URL that includes credentials: https://user:hunter2@proj.supabase.co/rest/v1/'
    );
  };
  const probe = await probeSupabase(
    { ...ENV, NEXT_PUBLIC_SUPABASE_URL: 'https://user:hunter2@proj.supabase.co' },
    { fetchImpl: throwing }
  );
  assert.equal(probe.reachable, false);
  assert.ok(!probe.error.includes('hunter2'), `password leaked: ${probe.error}`);
  assert.match(probe.error, /\*\*\*/);
});

test('probeSupabase reports a timeout as a timeout, not as a generic failure', async () => {
  const timingOut = async () => {
    const err = new Error('The operation was aborted due to timeout');
    err.name = 'TimeoutError';
    throw err;
  };
  const probe = await probeSupabase(ENV, { fetchImpl: timingOut });
  assert.equal(probe.reachable, false);
  assert.match(probe.error, /10s/);
});

// --- A6.3 / A7.1 · the parser must not drop lines in silence ----------------

// `export FOO=bar` is the form used by anyone who also `source .env`. Without
// stripping the prefix the key became the literal "export NEXT_PUBLIC_ADMIN_KEY",
// which does not start with NEXT_PUBLIC_, so the by-value service-role sweep
// skipped it and doctor exited 0 on a project shipping an RLS-bypassing key to
// every browser. Seven characters of prefix defeated the whole feature.
test('parseEnv strips the `export ` prefix', () => {
  const env = parseEnv('export A=1\nexport   B=2\nC=3\n');
  assert.deepEqual(env, { A: '1', B: '2', C: '3' });
});

test('doctor: a service_role key behind `export ` is still an error', () => {
  for (const line of ['export NEXT_PUBLIC_ADMIN_KEY=sb_secret_leaked', 'export NEXT_PUBLIC_SUPABASE_ANON_KEY=sb_secret_leaked']) {
    const env = parseEnv(`NEXT_PUBLIC_SUPABASE_URL=https://x.supabase.co\n${line}\n`);
    assert.equal(checkEnv(env).ok, false, `must flag: ${line}`);
  }
});

test('parseEnv survives a BOM on the first line', () => {
  assert.deepEqual(parseEnv('﻿NEXT_PUBLIC_SUPABASE_URL=https://x'), {
    NEXT_PUBLIC_SUPABASE_URL: 'https://x',
  });
});

// The silent `continue` was half the bug: the key vanished with NO output, so
// there was nothing on screen to be suspicious of. Any future unhandled prefix
// must surface here instead of failing the same way, just as quietly.
test('parseEnvDetailed reports lines it could not turn into a key', () => {
  const { env, unparsed } = parseEnvDetailed('A=1\nthis line has no equals\n=novalue\n# comment\n');
  assert.deepEqual(env, { A: '1' });
  assert.equal(unparsed.length, 2);
  assert.ok(unparsed.some((l) => /no equals/.test(l)));
});

// --- A10.2 · the doctor reads the chain the app actually runs with ----------

test('envChain is in Next precedence order, later wins', () => {
  assert.deepEqual(envChain('development'), ['.env', '.env.development', '.env.local', '.env.development.local']);
});

test('doctor: a leak in .env.local is found even when .env is clean', () => {
  const dir = mkdtempSync(join(tmpdir(), 'saas-kit-env-'));
  try {
    // The shape that audited clean: placeholders committed in .env, the real
    // (wrong) key in the gitignored .env.local that Next actually loads.
    writeFileSync(join(dir, '.env'), 'NEXT_PUBLIC_SUPABASE_URL=https://x.supabase.co\nNEXT_PUBLIC_SUPABASE_ANON_KEY=sb_publishable_ok\n');
    writeFileSync(join(dir, '.env.local'), 'NEXT_PUBLIC_SUPABASE_ANON_KEY=sb_secret_leaked\n');

    const { env, sources } = loadEnvDetailed(null, {}, { cwd: dir });
    assert.equal(env.NEXT_PUBLIC_SUPABASE_ANON_KEY, 'sb_secret_leaked', '.env.local must win, like Next');
    assert.match(sources.NEXT_PUBLIC_SUPABASE_ANON_KEY, /\.env\.local$/, 'and the report must name the file');
    assert.equal(checkEnv(env).ok, false, 'the leak must fail the gate');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('doctor: an explicit --env path audits ONLY that file, not the chain', () => {
  const dir = mkdtempSync(join(tmpdir(), 'saas-kit-env-'));
  try {
    writeFileSync(join(dir, '.env'), 'A=from-dot-env\n');
    writeFileSync(join(dir, 'custom.env'), 'A=from-custom\n');
    const { env, files } = loadEnvDetailed(join(dir, 'custom.env'), {});
    assert.equal(env.A, 'from-custom');
    assert.equal(files.length, 1, '--env must not silently expand into the chain');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('doctor: process env still wins over every file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'saas-kit-env-'));
  try {
    writeFileSync(join(dir, '.env.local'), 'A=from-file\n');
    const { env, sources } = loadEnvDetailed(null, { A: 'from-process' }, { cwd: dir });
    assert.equal(env.A, 'from-process');
    assert.equal(sources.A, 'process env');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// F7(a) · the 10s timeout is a documented promise (README:41) but removing it
// left the suite green. Pin that the probe actually configures an abort signal.
test('probeSupabase arms an abort signal on the request', async () => {
  const calls = [];
  await probeSupabase(ENV, { fetchImpl: fakeFetch(200, calls) });
  assert.ok(calls[0].init.signal, 'no signal → an unresponsive host hangs the CI gate forever');
  assert.equal(typeof calls[0].init.signal.aborted, 'boolean', 'must be an AbortSignal');
});
