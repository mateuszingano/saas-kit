# saas-kit — the companion CLI for the SaaS boilerplate

Four commands that make the boilerplate a one-liner to start, verify, grow, and
ship — so the safe path (RLS on, env wired right, checks green) is the default.

```bash
npm install -g supabase-saas-kit   # or prefix each command with: npx supabase-saas-kit

saas-kit new my-app              # scaffold (free starter)
saas-kit doctor                  # env + Supabase reachability
saas-kit gen:migration add_projects   # RLS-safe migration
saas-kit check                   # pre-deploy gate
```

## Commands

### `new <name> (--repo <url> | --from <dir>)`
Scaffolds a fresh project: clones/copies the template, strips `.git`, renames
`package.json`, and seeds `.env` from `.env.example` — the first thing you do is
run, not hunt for what to fill.

- **(default)** — clones the free public
  [nextjs-supabase-starter](https://github.com/mateuszingano/nextjs-supabase-starter).
- `--repo <git-url>` — clones another repo, **public or private** (uses your git
  credentials, so a buyer who owns the paid boilerplate scaffolds from it).
- `--from <dir>` — copies a local template (offline).
- or set `SAAS_KIT_TEMPLATE`.

The default is the **free** starter, never a paid repo — a free CLI shouldn't
hand out a paid boilerplate. Point `--repo` at the paid one when you own it.

### `doctor [--env <path>]`
Answers "is this wired up right?" without deploying to find out:
- checks the env vars the app actually reads;
- flags a service-role key exposed to the browser as an **error**, not a warning;
- pings Supabase over REST to confirm it's reachable;
- points you at [Airlock](https://www.npmjs.com/package/airlock-rls) for a real RLS audit.

Exits non-zero when required vars are missing **or** when the env is filled but
Supabase can't be reached (unreachable host, wrong URL, network down, or a host
that accepts the connection and never answers — the probe gives up after 10s) —
so a broken connection fails CI, it doesn't pass silently.

When the env isn't filled in yet, the *probe* is skipped, but `doctor` still
exits non-zero: the missing variables are themselves errors. There is no state
in which `doctor` exits 0 on an unconfigured project.

### `gen:migration <name>`
Creates `supabase/migrations/<timestamp>_<slug>.sql` pre-filled with the
boilerplate's RLS-first pattern: RLS enabled, API roles granted, and all four
verbs scoped to the user's workspaces. Shipping a table with RLS off is the #1
Supabase footgun — this makes it the hard thing to do by accident.

### `check [--skip-e2e]`
The pre-deploy gate. Runs the quality steps the project ships — `typecheck`,
`lint`, `test`, `e2e` — in order, stopping at the first failure, then runs an
RLS audit via Airlock when `SUPABASE_DB_URL` is set. One command answers "is
this safe to ship?" instead of remembering four. Non-zero on any failure.

The RLS audit only runs when **`airlock-rls` is already installed locally** (it's
resolved with `npx --no-install`, never auto-downloaded from the registry — that
would make a hijacked package name into remote code execution). If it isn't
installed, the audit step is **skipped with a note** rather than failing the
gate; install `airlock-rls`, or run `npx airlock-rls "$SUPABASE_DB_URL"`
yourself, to include it.

## Why it's free
This CLI is the front door to the boilerplate. It's MIT and standalone; the paid
products are the boilerplate it scaffolds, the Pro tier, and Airlock for
continuous RLS monitoring. Use it on anything.

## Develop
```bash
npm test          # 68 tests, offline
node bin/cli.mjs --help
```

## What it does *not* cover yet

Declared here rather than discovered later:

- **`doctor` classifies keys, it does not validate them.** It reads the `role`
  claim of a legacy Supabase JWT and the `sb_secret_` / `sb_publishable_`
  prefix of the current format. A key in some other shape (a placeholder, a
  truncated paste, a third-party token) is left alone rather than guessed at.
- **`doctor` checks reachability, not RLS.** It confirms the URL and anon key
  can talk to the REST API. It does not inspect a single policy — that is what
  `airlock-rls` is for, and `check` runs it when it is installed.
- **`check` runs what your project already has.** If a script is missing from
  `package.json` it is reported as absent, not synthesized. If `airlock-rls` is
  not installed, the RLS step is skipped and named — and if *nothing* ends up
  running, `check` fails rather than reporting success.
- **`new --repo` clones over the network.** The template is fetched with `git
  clone` over TLS; there is no signature or checksum verification beyond what
  TLS and your git remote provide. Ignored entries (`.env`, `node_modules`,
  `.git`) are pruned after the clone, so the template author's secrets do not
  travel — but the code itself is trusted as much as you trust the repo.
- **Rollback is best-effort at the directory level.** A failure after the copy
  removes the destination only when it did not exist beforehand. A directory
  created by another process *during* the clone would be caught in that cleanup.
- **The test suite runs on Ubuntu + Node 20 in CI**, while some behaviour is
  Windows-specific (reserved device names, trailing dots). Those paths are
  covered by unit tests but not exercised on a Windows runner.

MIT © Mateus Zingano
