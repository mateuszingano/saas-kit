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
 * Read the `role` claim out of a Supabase JWT without verifying it.
 *
 * Triage, not authentication: we only want to know which KIND of key this is, so
 * an unverified decode is exactly right — we are not trusting the token, we are
 * classifying a string the developer pasted into a config file. Returns null for
 * anything that isn't a decodable JWT — including the newer `sb_*` format, which
 * carries no claims at all. Use `keyRole` (below) rather than this directly: it
 * covers both formats.
 */
export function jwtRole(key) {
  if (typeof key !== 'string') return null;
  const parts = key.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return typeof payload?.role === 'string' ? payload.role : null;
  } catch {
    return null;
  }
}

/**
 * Which KIND of Supabase key is this — across both key formats.
 *
 * Supabase now issues `sb_publishable_…` / `sb_secret_…`, which carry no claims
 * at all: `jwtRole` returns null for them, so a check built only on JWTs skips
 * the current format entirely and reports "ok". That is the exact leak this
 * whole feature exists to catch, missed on the keys people are being handed
 * today — the legacy JWT was covered and the modern one was not.
 *
 * The prefix is literal and documented, so no decoding is needed.
 */
export function keyRole(key) {
  if (typeof key !== 'string') return null;
  if (key.startsWith('sb_secret_')) return 'service_role';
  if (key.startsWith('sb_publishable_')) return 'anon';
  return jwtRole(key); // legacy JWT format
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

  // A service-role key is a leak in ANY public variable, not just the two we
  // happened to name. Checking a fixed list missed `NEXT_PUBLIC_SUPABASE_KEY`,
  // `NEXT_PUBLIC_ADMIN_KEY` and anything else a developer invents — and the
  // variable name is the part they choose freely, while the key's identity is
  // right there in the value. So scan the whole environment by VALUE.
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith('NEXT_PUBLIC_')) continue;
    if (keyRole(value) !== 'service_role') continue;
    results.push({
      key: name,
      present: true,
      level: 'error',
      hint:
        `A SERVICE ROLE key is sitting in ${name}. Next.js inlines every NEXT_PUBLIC_ variable into ` +
        `the browser bundle, and this key bypasses RLS for every visitor. Rotate it now, then read it ` +
        `server-side only (drop the NEXT_PUBLIC_ prefix).`,
      status: 'error',
    });
  }
  // Name-only guard, kept for the case where the variable is set to something we
  // cannot classify (an empty string, a placeholder) but is named unambiguously.
  if (env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY && keyRole(env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY) !== 'service_role') {
    results.push({
      key: 'NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY',
      present: true,
      level: 'error',
      hint: 'The service role key is exposed to the browser. Remove the NEXT_PUBLIC_ prefix immediately.',
      status: 'error',
    });
  }

  // NOTE: the anon slot holding a service-role key is already covered by the
  // by-value sweep above — `NEXT_PUBLIC_SUPABASE_ANON_KEY` is a NEXT_PUBLIC_
  // variable like any other. Keeping a second, slot-specific check here would
  // just report the same leak twice.

  // The mirror image: the anon key in the server slot. Harmless to leak, but
  // every server-side call silently loses its privileges, which surfaces as
  // confusing RLS denials rather than as a config error.
  const serviceRole = keyRole(env.SUPABASE_SERVICE_ROLE_KEY);
  if (serviceRole === 'anon') {
    results.push({
      key: 'SUPABASE_SERVICE_ROLE_KEY',
      present: true,
      level: 'warn',
      hint: 'This looks like the ANON key in the service-role slot. Server-side calls will be denied by RLS.',
      status: 'warn',
    });
  }

  const hasError = results.some((r) => r.status === 'error');
  return { results, ok: !hasError };
}
