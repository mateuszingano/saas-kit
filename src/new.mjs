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

import {
  cpSync,
  existsSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

// Never carry build artifacts, deps, or local secrets into a new project.
const IGNORE = new Set([
  'node_modules',
  '.next',
  '.git',
  'coverage',
  'test-results',
  '.env',
  '.env.local',
  '.env.test',
  'tsconfig.tsbuildinfo',
]);

/** Pure: should this top-level entry be skipped when scaffolding? */
export function ignoreEntry(name) {
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
}

/** Shallow git clone a template repo into dest, then finalize. */
export function scaffoldRepo({ name, repo, dest, clone = defaultClone }) {
  if (!name) throw new Error('usage: saas-kit new <name>');
  if (existsSync(dest)) throw new Error(`refusing to overwrite existing directory: ${dest}`);
  clone(repo, dest);
  return finalize(dest, name);
}

// Real clone (injectable so tests don't hit the network).
function defaultClone(repo, dest) {
  try {
    execFileSync('git', ['clone', '--depth', '1', repo, dest], { stdio: 'pipe' });
  } catch (err) {
    const detail = err.stderr ? err.stderr.toString().trim() : err.message;
    throw new Error(`git clone failed for ${repo}\n  ${detail}`);
  }
}

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
