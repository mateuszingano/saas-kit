import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEnv, checkEnv } from '../src/doctor.mjs';

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
