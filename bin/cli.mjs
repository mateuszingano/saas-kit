#!/usr/bin/env node
// saas-kit — companion CLI for the SaaS boilerplate.
//   saas-kit new <name> (--repo <url> | --from <dir>)   scaffold a new project
//   saas-kit doctor [--env <path>]                        check env + Supabase reachability
//   saas-kit gen:migration <name>                         RLS-safe migration
//   saas-kit check [--skip-e2e]                           pre-deploy gate

import { resolve, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { parseArgs } from '../src/args.mjs';
import { genMigration, detectTenancy } from '../src/gen-migration.mjs';
import { scaffold, validateProjectName } from '../src/new.mjs';
import { loadEnvDetailed, checkEnv, probeSupabase } from '../src/doctor.mjs';
import { runCheck } from '../src/check.mjs';

const HELP = `saas-kit — companion CLI for the SaaS boilerplate

Usage:
  saas-kit new <name> [--repo <url> | --from <dir>]   Scaffold a new project
  saas-kit doctor [--env <path>]                      Check env + Supabase reachability
  saas-kit gen:migration <name>                       Create an RLS-safe migration
  saas-kit check [--skip-e2e]                         Run the pre-deploy gate
  saas-kit --help                                     Show this help

Template source for \`new\` (defaults to the free public starter):
  (default)          the free nextjs-supabase-starter
  --repo <git-url>   clone another repo (public or private — uses your git auth)
  --from <dir>       copy a local template
  or set SAAS_KIT_TEMPLATE

Examples:
  saas-kit new my-app                       # from the free starter
  saas-kit new my-app --repo <paid-repo>    # from the paid boilerplate you own
  saas-kit gen:migration add_projects
  SUPABASE_DB_URL=postgres://... saas-kit check
`;

async function cmdDoctor(flags) {
  // No --env means the whole Next chain (.env, .env.local, …), not just `.env`.
  const envPath = typeof flags.env === 'string' ? flags.env : null;
  const { env, sources, unparsed, files } = loadEnvDetailed(envPath, process.env);
  const { results, ok } = checkEnv(env);

  console.log(`\nsaas-kit doctor — ${files.length ? files.join(', ') : 'process env'}\n`);
  for (const r of results) {
    const mark = r.status === 'ok' ? '✔' : r.status === 'warn' ? '!' : '✖';
    const from = r.present && sources[r.key] ? `  ← ${sources[r.key]}` : '';
    console.log(`  ${mark} ${r.key}${r.present ? '' : '  (missing)'}${from}`);
    if (r.status !== 'ok') console.log(`      ${r.hint}`);
  }

  // A line that could not be turned into a key is NOT reported as fine. This is
  // how `export FOO=bar` hid a leaked key for a whole release: the parser
  // dropped it in silence, so there was nothing on screen to be suspicious of.
  if (unparsed.length) {
    console.log('');
    for (const { file, line } of unparsed) {
      console.log(`  ! ${file}: could not parse "${line.slice(0, 60)}" — this line was NOT checked.`);
    }
  }

  const probe = await probeSupabase(env);
  if (probe.skipped) {
    console.log('\n  · Supabase probe skipped (fill the env first).');
  } else if (probe.reachable) {
    console.log(`\n  ✔ Supabase reachable (HTTP ${probe.status}).`);
    console.log('  · For a real RLS audit, run: npx airlock-rls "$SUPABASE_DB_URL"');
  } else if (probe.refused) {
    // Not "could not reach" — we declined to try, and saying so tells the user
    // it is their URL that needs fixing, not their network.
    console.log(`\n  ✖ Probe refused: ${probe.error}`);
  } else {
    console.log(`\n  ✖ Could not reach Supabase (${probe.error || 'HTTP ' + probe.status}).`);
  }

  console.log('');
  process.exit(ok && (probe.skipped || probe.reachable) ? 0 : 1);
}

function cmdNew(positional, flags) {
  const raw = positional[0];
  if (!raw) throw new Error('usage: saas-kit new <name> (--repo <url> | --from <dir>)');
  // Validate/normalize the project name BEFORE any clone or disk write, so an
  // invalid name fails fast instead of leaving a half-cloned directory behind.
  const name = validateProjectName(raw);
  const dest = resolve(process.cwd(), name);
  scaffold({ name, dest, flags, env: process.env });
  console.log(`\n✔ Scaffolded ${name} at ${dest}`);
  console.log('\nNext:');
  console.log(`  cd ${name}`);
  console.log('  npm install');
  console.log('  # fill .env, then: supabase start && npm run dev');
  console.log('  saas-kit doctor\n');
}

function cmdGenMigration(positional) {
  const name = positional.join(' ').trim();
  const tenancy = detectTenancy();
  const path = genMigration({ name, tenancy });
  console.log(`✔ Created ${path}`);
  // Say which shape was emitted. The workspace variant needs public.workspaces
  // and public.user_workspace_ids(), which only the paid boilerplate ships —
  // emitting it into a project that lacks them produced SQL that could not be
  // applied at all, with nothing on screen to explain why.
  console.log(
    tenancy === 'workspace'
      ? '  Scoped to the workspace (public.workspaces detected).'
      : '  Scoped to the row owner (no public.workspaces here — auth.users only).'
  );
  console.log('  Edit the columns; keep the RLS block. Then: supabase db push');
}

function cmdCheck(flags) {
  const pkgPath = resolve(process.cwd(), 'package.json');
  if (!existsSync(pkgPath)) throw new Error('no package.json here — run inside a project');
  const scripts = JSON.parse(readFileSync(pkgPath, 'utf8')).scripts || {};
  const dbUrl = process.env.SUPABASE_DB_URL || '';
  console.log('\nsaas-kit check — pre-deploy gate\n');
  const { ok } = runCheck(scripts, { dbUrl, skipE2e: !!flags['skip-e2e'] });
  console.log('');
  process.exit(ok ? 0 : 1);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  // --repo/--from pick the template source; a bare flag must error loudly, not
  // silently fall back to the free starter.
  const { flags, positional } = parseArgs(rest, { valueFlags: ['repo', 'from'] });

  if (!command || command === '--help' || command === '-h' || flags.help) {
    console.log(HELP);
    return;
  }

  switch (command) {
    case 'new':
      return cmdNew(positional, flags);
    case 'doctor':
      return cmdDoctor(flags);
    case 'gen:migration':
    case 'migration':
      return cmdGenMigration(positional);
    case 'check':
      return cmdCheck(flags);
    default:
      console.error(`Unknown command: ${command}\n`);
      console.log(HELP);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(`✖ ${err.message}`);
  process.exit(1);
});
