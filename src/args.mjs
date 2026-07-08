// Tiny arg parser shared by the CLI and its tests. Pulls flags out of argv,
// leaving positionals in order. Supported forms:
//   --key value     value in the next token
//   --key=value     value glued with '='  (value may start with '-')
//   --flag          boolean true (no value, or followed by another --flag)
// With `--key value`, a `value` that itself starts with '--' is treated as the
// next flag (so `--key` stays boolean); a single-dash value like `-x` IS taken
// as the value, since only '--' starts a flag here.

export function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const body = arg.slice(2);
      const eq = body.indexOf('=');
      if (eq !== -1) {
        // --key=value  (value can start with '-', be empty, or contain '=')
        flags[body.slice(0, eq)] = body.slice(eq + 1);
        continue;
      }
      const next = argv[i + 1];
      // Consume the next token as the value unless it's another --flag.
      if (next !== undefined && !next.startsWith('--')) {
        flags[body] = next;
        i++;
      } else {
        flags[body] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}
