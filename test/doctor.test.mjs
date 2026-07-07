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

