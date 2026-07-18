// Tiny arg parser shared by the CLI and its tests. Pulls flags out of argv,
// leaving positionals in order. Supported forms:
//   --key value     value in the next token
//   --key=value     value glued with '='  (value may start with '-')
//   --flag          boolean true (no value, or followed by another --flag)
// With `--key value`, a `value` that itself starts with '--' is treated as the
// next flag (so `--key` stays boolean); a single-dash value like `-x` IS taken
// as the value, since only '--' starts a flag here.
//
// `valueFlags` names the flags that REQUIRE a value (e.g. --repo, --from): if
// one of them shows up bare (no value, or with an empty `--key=`), we throw a
// clear error instead of letting it become boolean `true` and silently falling
// through to the wrong default (e.g. the free starter instead of the paid repo).

export function parseArgs(argv, { valueFlags = [] } = {}) {
  const needsValue = new Set(valueFlags);
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const body = arg.slice(2);
      const eq = body.indexOf('=');
      if (eq !== -1) {
        // --key=value  (value can start with '-', be empty, or contain '=')
        const key = body.slice(0, eq);
        const value = body.slice(eq + 1);
        if (needsValue.has(key) && value === '') {
          throw new Error(`--${key} needs a value (e.g. --${key} <value>)`);
        }
        flags[key] = value;
        continue;
      }
      const next = argv[i + 1];
      // Consume the next token as the value unless it's another --flag.
      if (next !== undefined && !next.startsWith('--')) {
        flags[body] = next;
        i++;
      } else {
        if (needsValue.has(body)) {
          throw new Error(`--${body} needs a value (e.g. --${body} <value>)`);
        }
        flags[body] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}
