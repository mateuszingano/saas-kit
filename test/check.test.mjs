import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCheckSteps, planSummary, runCheck, airlockAvailable } from '../src/check.mjs';

const SCRIPTS = { typecheck: 'tsc', lint: 'eslint', test: 'vitest', e2e: 'playwright' };

test('buildCheckSteps includes only existing scripts, in order', () => {
  const steps = buildCheckSteps({ test: 'vitest', typecheck: 'tsc' });
  assert.deepEqual(steps.map((s) => s.name), ['typecheck', 'test']);
});

test('buildCheckSteps: skipE2e drops e2e', () => {
  const steps = buildCheckSteps(SCRIPTS, { skipE2e: true });
  assert.ok(!steps.some((s) => s.name === 'e2e'));
});

test('buildCheckSteps: a dbUrl appends the RLS audit last', () => {
  const steps = buildCheckSteps(SCRIPTS, { dbUrl: 'postgres://x' });
  assert.equal(steps.at(-1).name, 'rls-audit');
  assert.match(steps.at(-1).cmd, /airlock-rls/);
});

test('rls-audit passes the DB url via env, never interpolated into the shell command', () => {
  // A password crafted to break out of a shell must NOT appear in the command line.
  const evil = 'postgres://u:p@h/db;$(touch /tmp/pwned)`whoami`';
  const audit = buildCheckSteps(SCRIPTS, { dbUrl: evil }).at(-1);
  // --no-install makes "never download-and-run" structural, not check-then-use.
  assert.equal(audit.cmd, 'npx --no-install airlock-rls', 'command carries NO url → no shell injection surface');
  assert.equal(audit.env.SUPABASE_DB_URL, evil, 'the url travels in env, where no shell parses it');
  assert.ok(!audit.cmd.includes('$('), 'the injection payload never reaches the shell command');
});

test('planSummary notes the skipped RLS audit and missing scripts', () => {
  const { notes } = planSummary({ test: 'vitest' }, {});
  assert.ok(notes.some((n) => /rls-audit skipped/.test(n)));
  assert.ok(notes.some((n) => /no script for/.test(n)));
});

test('runCheck runs every step when all pass', () => {
  const ran = [];
  const res = runCheck(SCRIPTS, {}, (step) => ran.push(step.cmd));
  assert.equal(res.ok, true);
  assert.deepEqual(res.ran, ['typecheck', 'lint', 'test', 'e2e']);
});

test('runCheck stops at the first failure', () => {
  const res = runCheck(SCRIPTS, {}, (step) => {
    if (step.cmd.includes('lint')) throw new Error('lint failed');
  });
  assert.equal(res.ok, false);
  assert.equal(res.failed, 'lint');
  assert.deepEqual(res.ran, ['typecheck']); // never reached test/e2e
});

test('runCheck fails clearly when there is nothing to run', () => {
  const res = runCheck({}, {}, () => {});
  assert.equal(res.ok, false);
});

test('airlockAvailable is true when the probe resolves the binary', () => {
  assert.equal(airlockAvailable(() => {}), true);
});

test('airlockAvailable is false when the probe always throws (unpublished/offline)', () => {
  assert.equal(
    airlockAvailable(() => {
      throw new Error('command not found');
    }),
    false
  );
});

test('runCheck skips rls-audit (not fail) when airlock is unavailable', () => {
  const ran = [];
  const res = runCheck(
    SCRIPTS,
    { dbUrl: 'postgres://x' },
    (step) => ran.push(step.cmd),
    () => false // airlock unavailable
  );
  assert.equal(res.ok, true, 'gate still passes');
  assert.deepEqual(res.skipped, ['rls-audit']);
  assert.ok(!ran.some((c) => c.includes('airlock-rls')), 'never invoked airlock');
});

test('runCheck runs rls-audit normally when airlock IS available', () => {
  const ran = [];
  const res = runCheck(
    SCRIPTS,
    { dbUrl: 'postgres://x' },
    (step) => ran.push(step.cmd),
    () => true
  );
  assert.equal(res.ok, true);
  assert.deepEqual(res.skipped, []);
  assert.ok(ran.some((c) => c.includes('airlock-rls')), 'ran the audit');
});

test('runCheck: a real rls-audit failure still fails the gate (not a skip)', () => {
  const res = runCheck(
    { test: 'vitest' },
    { dbUrl: 'postgres://x' },
    (step) => {
      if (step.cmd.includes('airlock-rls')) throw new Error('RLS hole found');
    },
    () => true // available, so it runs — and its failure must fail the gate
  );
  assert.equal(res.ok, false);
  assert.equal(res.failed, 'rls-audit');
});

// ONDA 0.1 — "planned" is not "executed". The `!steps.length` guard catches an
// empty PLAN, but rls-audit is dropped at RUNTIME when airlock-rls isn't
// installable — so with only that step planned we fell through to `ok: true`
// and printed `✔ all checks passed ()`, empty parens and all. In CI that is a
// green pre-deploy gate that verified nothing. Shape: a fresh project with no
// quality scripts yet, SUPABASE_DB_URL set, airlock not installed.
test('check: reports failure when every planned step was skipped (nothing verified)', () => {
  const r = runCheck({ build: 'next build' }, { dbUrl: 'postgres://x' }, () => {}, () => false);
  assert.equal(r.ok, false, 'a run that executed nothing must not report success');
  assert.deepEqual(r.ran, []);
  assert.deepEqual(r.skipped, ['rls-audit']);
  assert.equal(r.failed, null, 'nothing failed — nothing ran, which is a different thing');
});

test('check: still passes when at least one step actually executed', () => {
  const r = runCheck({ typecheck: 'tsc --noEmit' }, {}, () => {}, () => false);
  assert.equal(r.ok, true);
  assert.deepEqual(r.ran, ['typecheck']);
});

test('check: a skipped step alongside a real one does not spoil the pass', () => {
  const r = runCheck({ typecheck: 'tsc --noEmit' }, { dbUrl: 'postgres://x' }, () => {}, () => false);
  assert.equal(r.ok, true, 'one genuine execution is enough to have verified something');
  assert.deepEqual(r.ran, ['typecheck']);
  assert.deepEqual(r.skipped, ['rls-audit']);
});

// B1.2 / PR17 — "if nothing ends up running, check fails rather than reporting
// success" (README). An EMPTY script is a string, so a typeof check let it into
// the plan; `npm run test` on "" exits 0, the step counted as ran, and four
// empty scripts produced `✔ all checks passed` with exit 0. This is the same
// planned-is-not-executed bug the !ran.length guard exists for, one level up.
test('check: declared-but-empty scripts are not steps', () => {
  const { steps, notes } = planSummary({ typecheck: '', lint: '  ', test: '', e2e: '' }, {});
  assert.equal(steps.length, 0, 'an empty script must not become a step');
  assert.ok(notes.some((n) => /EMPTY/.test(n)), 'and the user must be told they are empty');
});

test('check: four empty scripts FAIL the gate instead of passing it', () => {
  const r = runCheck({ typecheck: '', lint: '', test: '', e2e: '' }, {}, () => {});
  assert.equal(r.ok, false, 'a gate that ran nothing must not report success');
  assert.deepEqual(r.ran, []);
});

test('check: a real script still runs (no false negative from the empty check)', () => {
  const ran = [];
  const r = runCheck({ typecheck: 'tsc --noEmit', test: '' }, {}, (s) => ran.push(s.name));
  assert.equal(r.ok, true);
  assert.deepEqual(ran, ['typecheck'], 'the empty one is dropped, the real one runs');
});
