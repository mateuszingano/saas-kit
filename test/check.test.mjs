import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCheckSteps, planSummary, runCheck } from '../src/check.mjs';

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

test('planSummary notes the skipped RLS audit and missing scripts', () => {
  const { notes } = planSummary({ test: 'vitest' }, {});
  assert.ok(notes.some((n) => /rls-audit skipped/.test(n)));
  assert.ok(notes.some((n) => /no script for/.test(n)));
});

test('runCheck runs every step when all pass', () => {
  const ran = [];
  const res = runCheck(SCRIPTS, {}, (cmd) => ran.push(cmd));
  assert.equal(res.ok, true);
  assert.deepEqual(res.ran, ['typecheck', 'lint', 'test', 'e2e']);
});

test('runCheck stops at the first failure', () => {
  const res = runCheck(SCRIPTS, {}, (cmd) => {
    if (cmd.includes('lint')) throw new Error('lint failed');
  });
  assert.equal(res.ok, false);
  assert.equal(res.failed, 'lint');
  assert.deepEqual(res.ran, ['typecheck']); // never reached test/e2e
});

test('runCheck fails clearly when there is nothing to run', () => {
  const res = runCheck({}, {}, () => {});
  assert.equal(res.ok, false);
});
