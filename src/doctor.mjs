// doctor — is this project wired up right? Checks the env vars the boilerplate
// needs, then (best effort, online) pings Supabase with a reachability probe:
// a GET /rest/v1/ that confirms the URL + anon key can reach the REST API. It
// is a connectivity check, not an RLS check — it does not inspect policies or
// prove any table is protected.

import { readFileSync, existsSync } from 'node:fs';
import { redactUrlCredentials } from './redact.mjs';

// Loopback hosts, where plaintext http:// is the normal, correct thing: this is
// exactly what `supabase start` prints (http://127.0.0.1:54321). Everything else
// must be TLS — see `classifySupabaseUrl`.
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * Is this URL safe to send the anon key to?
 *
 * The probe attaches the key as a header. Over plaintext http:// to a non-local
 * host, anyone on the path reads it — and `validateRepo` already refuses http://
 * for exactly this reason, with a paragraph explaining why. The two paths of the
 * same binary disagreed; this closes the gap.
 *
 * The obfuscated IP forms (http://2130706433, 0x7f000001, 017700000001) need no
 * special handling: WHATWG `new URL()` normalizes all of them to 127.0.0.1, so
 * they land on the loopback branch and are allowed for the same reason
 * http://127.0.0.1 is — they ARE loopback. There is no bypass to close here, and
 * a hand-rolled check for them would be strictly worse than the parser. Verified
 * in test rather than assumed.
 *
 * Returns a verdict rather than throwing, so `doctor` can report it as a failed
 * check alongside the others instead of dying with a stack trace.
 */
export function classifySupabaseUrl(raw) {
  let parsed;
  try {
    parsed = new URL(String(raw));
  } catch {
    return { ok: false, reason: `NEXT_PUBLIC_SUPABASE_URL is not a valid URL: ${redactUrlCredentials(raw)}` };
  }
  if (parsed.protocol === 'https:') return { ok: true };
  if (parsed.protocol === 'http:') {
    if (LOOPBACK.has(parsed.hostname)) return { ok: true, local: true };
    return {
      ok: false,
      reason:
        `refusing to send the anon key to ${redactUrlCredentials(parsed.origin)} over plaintext http://. ` +
        'Use https:// (http:// is allowed only for localhost, where `supabase start` runs).',
    };
  }
  return { ok: false, reason: `unsupported scheme "${parsed.protocol}" — Supabase URLs are https://.` };
}

/**
 * Best-effort online check: can the anon key reach REST?
 *
 * `fetchImpl` is injectable so this is testable without the network — it used to
 * live in bin/cli.mjs, where nothing could import it without executing the CLI,
 * which is why none of its behaviour was covered.
 */
export async function probeSupabase(env, { fetchImpl = fetch } = {}) {
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return { skipped: true };

  const verdict = classifySupabaseUrl(url);
  if (!verdict.ok) return { reachable: false, refused: true, error: verdict.reason };

  try {
    // Bounded. Without a timeout, a host that ACCEPTS the connection and then
    // never answers hangs this forever — measured at 40s and still going before
    // being killed. The README positions `doctor` as a CI gate, and a hang is
    // worse there than a failure: the job only dies at the runner's global
    // timeout, with no indication of why.
    //
    // `redirect: 'manual'` because following one hands the anon key to whatever
    // host the redirect names. Node drops `Authorization` across origins but
    // keeps the custom `apikey` header, so a 302 was enough to walk the key off
    // to an arbitrary listener — and the probe still printed "reachable".
    const res = await fetchImpl(`${url.replace(/\/$/, '')}/rest/v1/`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
      redirect: 'manual',
    });
    if (res.status >= 300 && res.status < 400) {
      return {
        reachable: false,
        status: res.status,
        error:
          `the host answered with an HTTP ${res.status} redirect, which was not followed. ` +
          'A Supabase REST root does not redirect — check the URL.',
      };
    }
    // 404 counts: the REST root answers 404 on some project configurations, and
    // the point of the probe is "the host is up and speaking HTTP to this key".
    return { reachable: res.ok || res.status === 404, status: res.status };
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError';
    // fetch embeds the URL — userinfo included — in its own error text.
    return {
      reachable: false,
      error: timedOut
        ? 'no response after 10s (the host accepted the connection but never replied)'
        : redactUrlCredentials(err.message),
    };
  }
}

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

/**
 * Parse a .env file into a plain object. Tolerates comments, blanks, quotes,
 * a BOM, and the `export FOO=bar` form.
 *
 * `export ` matters more than it looks. It is the form used by everyone who also
 * `source .env` from a shell, and without stripping it the key became the literal
 * string "export NEXT_PUBLIC_ADMIN_KEY" — which does not start with
 * `NEXT_PUBLIC_`, so the service-role sweep in `checkEnv` skipped it entirely and
 * `doctor` exited 0 on a project shipping an RLS-bypassing key to every browser.
 * The whole feature, defeated by seven characters of prefix.
 *
 * `parseEnvDetailed` also returns the lines it could NOT turn into a key. The
 * silent `continue` was half the bug: the key vanished with no output at all, so
 * there was nothing to notice. A parser that drops input without saying so
 * cannot be trusted by a gate, and the next unhandled prefix would fail exactly
 * the same way, just as quietly.
 */
export function parseEnvDetailed(text) {
  const out = {};
  const unparsed = [];
  for (const raw of String(text).split(/\r?\n/)) {
    // Strip a UTF-8 BOM on the first line before anything else looks at it.
    const line = raw.replace(/^﻿/, '').trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) {
      unparsed.push(line);
      continue;
    }
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '').trim();
    if (!key) {
      unparsed.push(line);
      continue;
    }
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return { env: out, unparsed };
}

/** Parse a .env file into a plain object. See `parseEnvDetailed`. */
export function parseEnv(text) {
  return parseEnvDetailed(text).env;
}

/**
 * The Next.js env chain, in load order — LATER FILES WIN.
 *
 * Reading only `.env` was a hole big enough to drive the whole feature through:
 * `.env.local` overrides `.env` in Next, so it is the file whose values the app
 * ACTUALLY runs with, and it is where people put the real keys precisely because
 * it is gitignored. A `.env` full of placeholders next to a `.env.local` holding
 * a service-role key in the anon slot audited clean. The scaffold's own IGNORE
 * list already knew `.env.local` was sensitive; the doctor just never opened it.
 *
 * `.env.<mode>.local` is included for completeness; `mode` defaults to
 * development, which is what a developer running `doctor` locally has.
 */
export function envChain(mode = 'development') {
  return ['.env', `.env.${mode}`, '.env.local', `.env.${mode}.local`];
}

/**
 * Merge process.env over the .env chain (real env wins).
 *
 * An explicit `envPath` means "audit exactly this file" and does NOT expand into
 * the chain — the flag is how you point the doctor at something unusual, and
 * silently reading four other files would defeat that.
 *
 * Returns { env, sources, unparsed }: `sources` maps each var to the file it
 * finally came from, so the report can say WHERE the bad key lives. Finding a
 * leak and not saying which of four files holds it is a bad bug report.
 */
export function loadEnvDetailed(envPath = null, processEnv = {}, { mode = 'development', cwd = '.' } = {}) {
  const files = envPath ? [envPath] : envChain(mode).map((f) => `${cwd}/${f}`);
  const env = {};
  const sources = {};
  const unparsed = [];
  for (const file of files) {
    if (!existsSync(file)) continue;
    const parsed = parseEnvDetailed(readFileSync(file, 'utf8'));
    for (const [k, v] of Object.entries(parsed.env)) {
      env[k] = v;
      sources[k] = file;
    }
    for (const line of parsed.unparsed) unparsed.push({ file, line });
  }
  for (const [k, v] of Object.entries(processEnv)) {
    if (typeof v !== 'string') continue;
    env[k] = v;
    sources[k] = 'process env';
  }
  return { env, sources, unparsed, files: files.filter((f) => existsSync(f)) };
}

/** Merge process.env over the .env chain (real env wins). See `loadEnvDetailed`. */
export function loadEnv(envPath = null, processEnv = {}, opts = {}) {
  return loadEnvDetailed(envPath, processEnv, opts).env;
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
