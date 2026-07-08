// check — the pre-deploy gate. Runs the quality steps the boilerplate ships
// (typecheck, lint, test, e2e) plus a real RLS audit via Airlock, and stops at
// the first failure. One command answers "is this safe to ship?" instead of
// remembering four.

import { execSync } from 'node:child_process';

// Canonical order: cheapest/fastest signal first, so failures surface early.
const STEP_ORDER = ['typecheck', 'lint', 'test', 'e2e'];

/**
 * Can `airlock-rls` be resolved/run at all? We ask npx to print the binary's
 * version — cheap, no DB touched. Returns true only when that succeeds. Any
 * failure (offline, package unpublished, registry down) → false, and we skip
 * the audit with a clear note instead of failing the whole gate.
 * `probe` is injectable for tests.
 */
export function airlockAvailable(probe = defaultProbe) {
  try {
    probe('npx --no-install airlock-rls --version');
    return true;
  } catch {
    try {
      probe('npx --yes airlock-rls --version');
      return true;
    } catch {
      return false;
    }
  }
}

function defaultProbe(cmd) {
  execSync(cmd, { stdio: 'ignore' });
}

/**
 * Pure: given a package.json `scripts` object and options, produce the ordered
 * list of steps to run. Only includes scripts that actually exist; appends an
 * RLS audit when a DB url is available (skips it otherwise, and says so).
 * Returns [{ name, cmd }].
 */
export function buildCheckSteps(scripts = {}, { dbUrl = '', skipE2e = false } = {}) {
  const steps = STEP_ORDER.filter((s) => {
    if (s === 'e2e' && skipE2e) return false;
    return typeof scripts[s] === 'string';
  }).map((s) => ({ name: s, cmd: `npm run ${s}` }));

  if (dbUrl) {
    steps.push({ name: 'rls-audit', cmd: `npx airlock-rls "${dbUrl}"` });
  }
  return steps;
}

/** Human summary of what will run and what's skipped, for the header. */
export function planSummary(scripts = {}, opts = {}) {
  const steps = buildCheckSteps(scripts, opts);
  const names = steps.map((s) => s.name);
  const missing = STEP_ORDER.filter((s) => typeof scripts[s] !== 'string');
  const notes = [];
  if (!opts.dbUrl) notes.push('rls-audit skipped (set SUPABASE_DB_URL to enable)');
  if (missing.length) notes.push(`no script for: ${missing.join(', ')}`);
  return { steps, names, notes };
}

/**
 * Run the steps in order, stopping at the first non-zero exit.
 * `run` is injectable for tests. `isAirlockAvailable` is injectable too; when it
 * reports the RLS auditor can't be run (offline / package unpublished), the
 * rls-audit step is SKIPPED with a clear note rather than failing the gate —
 * a missing optional tool must not read as "your app is unsafe to ship".
 * Returns { ok, ran, failed, skipped }.
 */
export function runCheck(scripts, opts = {}, run = defaultRun, isAirlockAvailable = airlockAvailable) {
  const { steps, notes } = planSummary(scripts, opts);
  for (const note of notes) console.log(`  · ${note}`);
  if (!steps.length) {
    console.log('\n  ✖ nothing to run — is this a boilerplate project?');
    return { ok: false, ran: [], failed: null, skipped: [] };
  }

  const ran = [];
  const skipped = [];
  for (const step of steps) {
    if (step.name === 'rls-audit' && !isAirlockAvailable()) {
      console.log(
        '\n  · rls-audit skipped: airlock-rls is not installable here ' +
          '(offline or not published). Install it, or run ' +
          '`npx airlock-rls "$SUPABASE_DB_URL"` yourself.'
      );
      skipped.push(step.name);
      continue;
    }
    console.log(`\n▶ ${step.name}: ${step.cmd}`);
    try {
      run(step.cmd);
      ran.push(step.name);
    } catch {
      console.log(`\n  ✖ ${step.name} failed — stopping.`);
      return { ok: false, ran, failed: step.name, skipped };
    }
  }
  const tail = skipped.length ? ` — skipped: ${skipped.join(', ')}` : '';
  console.log(`\n  ✔ all checks passed (${ran.join(', ')})${tail}.`);
  return { ok: true, ran, failed: null, skipped };
}

function defaultRun(cmd) {
  execSync(cmd, { stdio: 'inherit' });
}
