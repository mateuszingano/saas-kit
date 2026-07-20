// check — the pre-deploy gate. Runs the quality steps the boilerplate ships
// (typecheck, lint, test, e2e) plus a real RLS audit via Airlock, and stops at
// the first failure. One command answers "is this safe to ship?" instead of
// remembering four.

import { execSync } from 'node:child_process';

// Canonical order: cheapest/fastest signal first, so failures surface early.
const STEP_ORDER = ['typecheck', 'lint', 'test', 'e2e'];

/**
 * Is `airlock-rls` resolvable without installing anything? We ask npx to print
 * the binary's version with `--no-install`.
 *
 * What that guarantees, precisely: npx will never DOWNLOAD and execute a package
 * that isn't already present — so a hijacked package name cannot turn this gate
 * into remote code execution. That is the property worth having, and it holds.
 *
 * What it does NOT guarantee (both of these used to be claimed here and are
 * false — measured):
 *   · "no network fetch" — `npx --no-install` still CONSULTS the registry to
 *     resolve the spec; it just refuses to install. Nothing is downloaded or
 *     run, but a request does leave the machine.
 *   · "only from the project's own node_modules" — a GLOBAL install satisfies
 *     it too. Verified in an empty directory with no node_modules at all.
 *
 * If it isn't resolvable we return false and skip the audit with a clear note.
 * `probe` is injectable for tests.
 */
export function airlockAvailable(probe = defaultProbe) {
  try {
    probe('npx --no-install airlock-rls --version');
    return true;
  } catch {
    return false; // not installed locally → skip (never auto-fetch + run from the network)
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
    // Pass the DB url through the SUPABASE_DB_URL env var, NEVER interpolated into a
    // shell command. airlock-rls reads SUPABASE_DB_URL as a fallback when no
    // positional url is given, so the command line stays fixed ('npx airlock-rls')
    // and a password containing shell metacharacters ($(...) / backticks / ;) cannot
    // execute. The env value is never parsed by a shell.
    // `--no-install` here too, not just in the availability probe. Without it
    // the guarantee was check-then-use: we verified a local copy existed and
    // then ran a command that WOULD have installed one if it hadn't. Passing the
    // flag on the executed command makes "never download-and-run" structural
    // instead of incidental, and pins the version to whatever the consumer's own
    // lockfile resolved rather than whatever `latest` is at that moment.
    steps.push({ name: 'rls-audit', cmd: 'npx --no-install airlock-rls', env: { SUPABASE_DB_URL: dbUrl } });
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
      run(step);
      ran.push(step.name);
    } catch {
      console.log(`\n  ✖ ${step.name} failed — stopping.`);
      return { ok: false, ran, failed: step.name, skipped };
    }
  }
  // PLANNED IS NOT THE SAME AS EXECUTED.
  // The `!steps.length` guard above catches "nothing to plan", but a step can
  // still be dropped at RUNTIME (rls-audit skips when airlock-rls isn't
  // installable). With only that step planned, we used to fall through here and
  // print `✔ all checks passed ()` — note the empty parens — then exit 0. In CI
  // that is a green pre-deploy gate that verified nothing. The common shape:
  // a fresh project with no quality scripts yet, SUPABASE_DB_URL set, airlock
  // not installed.
  if (!ran.length) {
    const why = skipped.length ? ` Every planned step was skipped: ${skipped.join(', ')}.` : '';
    console.log(`\n  ✖ nothing actually ran — no check was executed, so nothing was verified.${why}`);
    return { ok: false, ran, failed: null, skipped };
  }

  const tail = skipped.length ? ` — skipped: ${skipped.join(', ')}` : '';
  console.log(`\n  ✔ all checks passed (${ran.join(', ')})${tail}.`);
  return { ok: true, ran, failed: null, skipped };
}

function defaultRun(step) {
  // Fixed command strings (npm run …, npx airlock-rls) with NO interpolated user
  // input → the shell is safe. Any per-step env (e.g. SUPABASE_DB_URL for the audit)
  // is layered on top of the process env, so secrets travel in env, not on argv.
  const env = step.env ? { ...process.env, ...step.env } : process.env;
  execSync(step.cmd, { stdio: 'inherit', env });
}
