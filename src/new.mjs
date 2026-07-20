// new — scaffold a fresh project from a template. Works three ways:
//   (default)      clone the free public starter (DEFAULT_TEMPLATE below)
//   --from <dir>   copy a local template (offline; used in dev/tests)
//   --repo <url>   git clone any template (public OR private — uses the caller's
//                  git credentials, so a buyer invited to the paid private repo
//                  can scaffold straight from it)
// The default is the FREE starter, never the paid boilerplate — a free CLI must
// not hand out a paid repo. Point --repo at the paid one when you own it.

// The free, public top-of-funnel starter. Cloning this is the zero-arg path.
export const DEFAULT_TEMPLATE = 'https://github.com/mateuszingano/nextjs-supabase-starter.git';

import { redactUrlCredentials } from './redact.mjs';
import {
  cpSync,
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

// Never carry build artifacts, deps, or local secrets into a new project.
//
// This was an exact-match list of three `.env` spellings, which is a losing
// game: `.env.production`, `.env.staging` and `.env.development` were not on it
// and travelled, and neither was `.npmrc` — the one that hurts most, because it
// holds an npm auth token and lives in the repo root of anyone who publishes
// packages. The README promises "the template author's secrets do not travel",
// so the rule has to be a CLASS of file, not a list of the ones we remembered.
const IGNORE = new Set(['node_modules', '.next', '.git', 'coverage', 'test-results', 'tsconfig.tsbuildinfo']);

// Anything starting with these is a secret-bearing dotfile by convention.
const IGNORE_PREFIX = ['.env'];

// Credential files that carry no common prefix. Each one holds a live token.
const IGNORE_EXACT_SECRETS = new Set([
  '.npmrc',        // npm auth token
  '.yarnrc.yml',   // may carry npmAuthToken
  '.netrc',
  '.git-credentials',
  '.envrc',        // direnv — arbitrary exports, routinely secrets
  '.vercel',       // project + org ids linked to the author's account
  '.aws',
  '.terraform',
  '.terraformrc',
]);

// The ONE .env-prefixed file that must survive: the template's committed
// placeholder file, which `finalize` copies to `.env` in the new project. It is
// meant to be public and the scaffold depends on it.
const IGNORE_PREFIX_ALLOW = new Set(['.env.example', '.env.sample', '.env.template']);

/** Pure: should this entry be skipped when scaffolding? Applies at any depth. */
export function ignoreEntry(name) {
  if (IGNORE_PREFIX_ALLOW.has(name)) return false;
  if (IGNORE_PREFIX.some((p) => name === p || name.startsWith(`${p}.`))) return true;
  if (IGNORE_EXACT_SECRETS.has(name)) return true;
  return IGNORE.has(name);
}

/**
 * Validate a project/package name against npm's rules, before we touch the disk.
 * Returns the trimmed name on success; throws a clear error otherwise. Kept
 * conservative on purpose (this becomes both the directory and package.json
 * "name"): lowercase, url/path-safe, no leading dot/underscore, <=214 chars.
 */
export function validateProjectName(raw) {
  const name = String(raw ?? '').trim();
  if (!name) throw new Error('project name is required');
  if (name.length > 214) throw new Error('project name must be 214 characters or fewer');
  if (name !== name.toLowerCase()) throw new Error(`project name must be lowercase: "${name}"`);
  if (name.startsWith('.') || name.startsWith('_')) {
    throw new Error('project name cannot start with a dot or underscore');
  }
  if (/[\\/]/.test(name)) throw new Error('project name cannot contain path separators');
  // Windows rejects these at the Win32 API level even though Node can create
  // them through the \\?\ path prefix. The result is a directory that exists, is
  // visible, and cannot be entered or deleted with normal tools — and we used to
  // print "✔ Scaffolded" and tell the user to `cd` into it. Refuse up front.
  if (/[. ]$/.test(name)) {
    throw new Error(`project name cannot end with a dot or space: "${name}" (Windows cannot open such a directory)`);
  }
  // Windows treats the reserved name PLUS ANY EXTENSION as the device too:
  // `nul.js`, `aux.config.js`, `com1.txt` all resolve to the device, not a file.
  // The guard therefore matches the base name before the first dot, not just the
  // bare name. `console`, `communications`, `nullable`, `com1-api` are NOT
  // devices (the base name is not exactly one of these) and stay allowed.
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(name)) {
    throw new Error(`"${name}" is a reserved device name on Windows — pick another project name`);
  }
  // npm-safe unscoped name: letters, digits, and - _ . only. (No scopes here —
  // the name is also a directory, so we keep it to a single plain segment.)
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) {
    throw new Error(
      `invalid project name: "${name}". Use lowercase letters, digits, and - _ . ` +
        '(start with a letter or digit).'
    );
  }
  return name;
}

/** Set the "name" field of a package.json string to `name`, reset version. */
export function renamePackage(pkgJson, name) {
  const pkg = JSON.parse(pkgJson);
  pkg.name = name;
  pkg.version = '0.1.0';
  return JSON.stringify(pkg, null, 2) + '\n';
}

/**
 * Pure: decide where the template comes from, from flags + env.
 * A value that looks like a git URL is treated as a repo, otherwise local dir.
 * Returns { kind: 'local' | 'repo', value }. There is always a source: with no
 * flags or env it defaults to the free public starter, so 'none' never happens.
 */
export function resolveSource(flags = {}, env = {}) {
  if (typeof flags.from === 'string') return { kind: 'local', value: flags.from };
  if (typeof flags.repo === 'string') return { kind: 'repo', value: flags.repo };
  const tmpl = env.SAAS_KIT_TEMPLATE;
  if (tmpl) {
    const looksGit = /^https?:\/\/|^git@|\.git$/.test(tmpl);
    return { kind: looksGit ? 'repo' : 'local', value: tmpl };
  }
  // No explicit source → default to the free public starter.
  return { kind: 'repo', value: DEFAULT_TEMPLATE };
}

/** Post-clone/copy cleanup: strip .git, rename package, seed .env. */
export function finalize(dest, name) {
  const gitDir = join(dest, '.git');
  if (existsSync(gitDir)) rmSync(gitDir, { recursive: true, force: true });

  const pkgPath = join(dest, 'package.json');
  if (existsSync(pkgPath)) {
    writeFileSync(pkgPath, renamePackage(readFileSync(pkgPath, 'utf8'), name), 'utf8');
  }

  const envPath = join(dest, '.env');
  const examplePath = join(dest, '.env.example');
  if (!existsSync(envPath) && existsSync(examplePath)) {
    writeFileSync(envPath, readFileSync(examplePath, 'utf8'), 'utf8');
  }
  return dest;
}

/** Copy a local template dir into dest, honoring IGNORE. */
export function scaffoldLocal({ name, from, dest }) {
  if (!name) throw new Error('usage: saas-kit new <name>');
  if (!from || !existsSync(from)) throw new Error(`template not found: ${from}`);
  if (existsSync(dest)) throw new Error(`refusing to overwrite existing directory: ${dest}`);

  return withRollback(dest, () => {
    cpSync(from, dest, {
      recursive: true,
      filter: (src) => {
        const rel = src.slice(resolve(from).length).replace(/^[\\/]/, '');
        // Check EVERY path segment, not just the top one: a nested secret like
        // `sub/.env` or a nested `sub/.git` must be dropped too, not only a
        // top-level one. Split on both separators for cross-platform paths.
        const segments = rel.split(/[\\/]/).filter(Boolean);
        return !segments.some((seg) => ignoreEntry(seg));
      },
    });
    return finalize(dest, name);
  });
}

/**
 * Run a scaffold step and, if it throws, remove the directory WE created.
 *
 * `finalize` runs after the copy/clone and can fail (a template with malformed
 * package.json, for one). Without this the command exits non-zero having left a
 * half-written project on disk — and in the --repo path `.git` is already gone,
 * so the user is left with an orphaned copy AND blocked from retrying by the
 * "refusing to overwrite existing directory" guard.
 *
 * Only cleans up when the destination did NOT exist beforehand: never delete
 * something we did not create.
 */
export function withRollback(dest, work) {
  const preexisting = existsSync(dest);
  try {
    return work();
  } catch (err) {
    if (!preexisting) {
      try {
        rmSync(dest, { recursive: true, force: true });
      } catch {
        // Cleanup is best-effort — surface the ORIGINAL failure, not this one.
      }
    }
    throw err;
  }
}

/**
 * Validate a template repo source BEFORE it reaches `git clone`, and return the
 * trimmed value. Two dangers to shut down:
 *   1. Argument injection — a repo that starts with `-` (e.g.
 *      `--upload-pack=touch /tmp/pwned`) is read by git as a FLAG, not a URL,
 *      turning `git clone` into remote code execution. We reject any leading `-`.
 *   2. Unexpected sources — we only accept the forms we actually mean to clone:
 *      http(s) URLs, scp-like `git@host:...`, or a relative local path
 *      (`./` / `../`). Anything else is rejected with a clear error.
 * The clone itself also passes `--` before the repo (defense in depth), so even
 * a value that slipped past here can never be parsed as an option by git.
 */
export function validateRepo(raw) {
  const value = String(raw ?? '').trim();
  if (!value) throw new Error('template repo is required');
  if (value.startsWith('-')) {
    throw new Error(
      `invalid --repo: "${value}" cannot start with "-" (git would read it as a flag).`
    );
  }
  // Defense in depth: a scp-like `git@-host:path` puts a leading "-" in the host, which
  // pre-2017 git could treat as an option. Reject it explicitly (belt to the `--` in clone).
  if (/^git@-/.test(value)) {
    throw new Error(`invalid --repo: "${value}" has a host starting with "-".`);
  }
  // Plaintext http:// is refused. Cloning a TEMPLATE over an unauthenticated
  // channel is a trivial MITM: whoever sits on the path injects code into a
  // project the developer is about to run and deploy. There is no integrity
  // check anywhere in this flow (no commit pin, no checksum), which is fine over
  // TLS and not fine without it.
  if (/^http:\/\//i.test(value)) {
    throw new Error(
      `invalid --repo: "${value}" uses plaintext http://. Use https:// — a template ` +
        'cloned over an unencrypted connection can be modified in transit.'
    );
  }
  if (!/^(https:\/\/|git@|\.\/|\.\.\/)/.test(value)) {
    throw new Error(
      `invalid --repo: "${value}". Use an https:// URL, a git@host:path URL, ` +
        'or a ./relative local path.'
    );
  }
  return value;
}

/** Shallow git clone a template repo into dest, then finalize. */
/**
 * Remove every IGNORE-listed entry from a freshly cloned tree, at any depth.
 *
 * `cpSync`'s filter does this for the local-template path. A clone has no
 * filter, so the same rule has to be applied afterwards — otherwise the two
 * ways of scaffolding give different guarantees, and the one people use by
 * default is the weaker one.
 */
export function pruneIgnored(root) {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return; // unreadable directory — nothing to prune
  }
  for (const e of entries) {
    const p = join(root, e.name);
    if (ignoreEntry(e.name)) rmSync(p, { recursive: true, force: true });
    else if (e.isDirectory()) pruneIgnored(p);
  }
}

export function scaffoldRepo({ name, repo, dest, clone = defaultClone }) {
  if (!name) throw new Error('usage: saas-kit new <name>');
  // Validate the source BEFORE we touch git or the disk, so a hostile --repo
  // fails fast and the clone never runs.
  const safeRepo = validateRepo(repo);
  if (existsSync(dest)) throw new Error(`refusing to overwrite existing directory: ${dest}`);
  return withRollback(dest, () => {
    clone(safeRepo, dest);
    // The local-template path filters IGNORE entry by entry; the clone path did
    // not, so `--repo` — which is the DEFAULT — carried the template author's
    // `.env`, any nested `sub/.env`, and a committed `node_modules` straight
    // into the new project. Worse, arriving with a `.env` made `finalize` skip
    // seeding from `.env.example`, so the developer never saw the config
    // template and ran with someone else's secrets. Same guarantee on both
    // paths now.
    pruneIgnored(dest);
    return finalize(dest, name);
  });
}

// Real clone (injectable so tests don't hit the network). The `--` separator
// ends git's option parsing, so `repo`/`dest` are always treated as operands,
// never as flags — the arg-injection belt-and-suspenders alongside validateRepo.
// `exec` is injectable so the redaction path can be tested without a real git
// or network: the credential leak lived in this catch block, and the only test
// that touched redaction exercised the pure function, never this call site — so
// deleting the redaction here left the suite green.
export function defaultClone(repo, dest, exec = (r, d) => execFileSync('git', ['clone', '--depth', '1', '--', r, d], { stdio: 'pipe' })) {
  try {
    exec(repo, dest);
  } catch (err) {
    const detail = err.stderr ? err.stderr.toString().trim() : err.message;
    // Redact credentials embedded in the URL. `https://user:TOKEN@host/repo` is
    // the common way to clone a private repo — the exact flow the README
    // recommends — and printing it raw puts the token in CI logs, terminal
    // scrollback and bug-report screenshots. git itself redacts this in its own
    // output; we were being less careful than the tool we shell out to.
    throw new Error(`git clone failed for ${redactUrlCredentials(repo)}\n  ${detail}`);
  }
}

// Defined in ./redact.mjs so `doctor` can use the same redactor (it was printing
// fetch errors with the URL raw). Imported AND re-exported: `defaultClone` above
// calls it locally, and callers/tests already import it from this module — a
// bare `export … from` would satisfy the second and break the first.
export { redactUrlCredentials };

/**
 * Top-level scaffold: resolves the source and dispatches. `dest` is absolute.
 * `resolveSource` always yields a source (defaults to the free starter), so
 * there is no "no source" branch to handle here.
 */
export function scaffold({ name, dest, flags = {}, env = {}, clone }) {
  const source = resolveSource(flags, env);
  if (source.kind === 'local') {
    return scaffoldLocal({ name, from: resolve(source.value), dest });
  }
  return scaffoldRepo({ name, repo: source.value, dest, clone });
}
