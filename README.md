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

Exits non-zero when required vars are missing — safe to drop in CI.

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

## Why it's free
This CLI is the front door to the boilerplate. It's MIT and standalone; the paid
products are the boilerplate it scaffolds, the Pro tier, and Airlock for
continuous RLS monitoring. Use it on anything.

## Develop
```bash
npm test          # 44 tests, offline
node bin/cli.mjs --help
```

MIT © Mateus Zingano
