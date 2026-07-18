// doctor — is this project wired up right? Checks the env vars the boilerplate
// needs, then (best effort, online) pings Supabase with a reachability probe:
// a GET /rest/v1/ that confirms the URL + anon key can reach the REST API. It
// is a connectivity check, not an RLS check — it does not inspect policies or
// prove any table is protected.

import { readFileSync, existsSync } from 'node:fs';

// The vars the app actually reads (grounded in the boilerplate .env.example).
export const ENV_SPEC = [
  {
    key: 'NEXT_PUBLIC_SUPABASE_URL',
    level: 'error',
    hint: 'Supabase project URL. Local: `supabase start` prints it. Prod: dashboard → Settings → API.',
  },
  {
    key: 'NEXT_PUBLIC_SUPABASE_ANON_KEY',
    level: 'error',
    hint: 'Anon public key from the same place. Safe to expose to the browser.',
  },
  {
    key: 'SUPABASE_SERVICE_ROLE_KEY',
    level: 'warn',
    hint: 'Server-only, bypasses RLS. Optional until you write privileged server code. NEVER prefix with NEXT_PUBLIC_.',
  },
];

/** Parse a .env file into a plain object. Tolerates comments, blanks, quotes. */
export function parseEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

/** Merge process.env over a .env file at `envPath` (real env wins). */
export function loadEnv(envPath = '.env', processEnv = {}) {
  const fromFile = existsSync(envPath) ? parseEnv(readFileSync(envPath, 'utf8')) : {};
  return { ...fromFile, ...processEnv };
}

/**
 * Pure check: given an env object, return one result per spec'd var.
 * A NEXT_PUBLIC_-prefixed service role key is flagged as an error (leak),
 * even though it's "present" — being set the wrong way is worse than unset.
 */
export function checkEnv(env, spec = ENV_SPEC) {
  const results = spec.map(({ key, level, hint }) => {
    const value = env[key];
    const present = typeof value === 'string' && value.length > 0;
    return {
      key,
      present,
      level,
      hint,
      status: present ? 'ok' : level, // 'ok' | 'error' | 'warn'
    };
  });

  // Extra guard: the service key must never be public.
  if (env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY) {
    results.push({
      key: 'NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY',
      present: true,
      level: 'error',
      hint: 'The service role key is exposed to the browser. Remove the NEXT_PUBLIC_ prefix immediately.',
      status: 'error',
    });
  }

  const hasError = results.some((r) => r.status === 'error');
  return { results, ok: !hasError };
}
