#!/usr/bin/env node
// saas-kit — companion CLI for the SaaS boilerplate.
//   saas-kit new <name> (--repo <url> | --from <dir>)   scaffold a new project
//   saas-kit doctor [--env <path>]                        check env + Supabase + RLS
//   saas-kit gen:migration <name>                         RLS-safe migration
//   saas-kit check [--skip-e2e]                           pre-deploy gate

import { resolve, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { parseArgs } from '../src/args.mjs';
import { genMigration } from '../src/gen-migration.mjs';
import { scaffold, validateProjectName } from '../src/new.mjs';
import { loadEnv, checkEnv } from '../src/doctor.mjs';
import { runCheck } from '../src/check.mjs';

const HELP = `saas-kit — companion CLI for the SaaS boilerplate

Usage:
  saas-kit new <name> [--repo <url> | --from <dir>]   Scaffold a new project
  saas-kit doctor [--env <path>]                      Check env, Supabase, RLS
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

// Best-effort online check: can the anon key reach REST?
async function probeSupabase(env) {
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return { skipped: true };
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/rest/v1/`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    return { reachable: res.ok || res.status === 404, status: res.status };
  } catch (err) {
    return { reachable: false, error: err.message };
  }
}

async function cmdDoctor(flags) {
  const envPath = typeof flags.env === 'string' ? flags.env : '.env';
  const env = loadEnv(envPath, process.env);
  const { results, ok } = checkEnv(env);

  console.log(`\nsaas-kit doctor — ${existsSync(envPath) ? envPath : 'process env'}\n`);
  for (const r of results) {
    const mark = r.status === 'ok' ? '✔' : r.status === 'warn' ? '!' : '✖';
    console.log(`  ${mark} ${r.key}${r.present ? '' : '  (missing)'}`);
    if (r.status !== 'ok') console.log(`      ${r.hint}`);
  }

  const probe = await probeSupabase(env);
  if (probe.skipped) {
    console.log('\n  · Supabase probe skipped (fill the env first).');
  } else if (probe.reachable) {
    console.log(`\n  ✔ Supabase reachable (HTTP ${probe.status}).`);
    console.log('  · For a real RLS audit, run: npx airlock-rls "$SUPABASE_DB_URL"');
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
  const path = genMigration({ name });
  console.log(`✔ Created ${path}`);
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
  const { flags, positional } = parseArgs(rest);

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
