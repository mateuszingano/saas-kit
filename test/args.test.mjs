import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../src/args.mjs';

test('parseArgs separates positionals from flags', () => {
  const { flags, positional } = parseArgs(['new', 'my-app', '--repo', 'x.git']);
  assert.deepEqual(positional, ['new', 'my-app']);
  assert.equal(flags.repo, 'x.git');
});

test('parseArgs treats a flag with no value as boolean true', () => {
  const { flags } = parseArgs(['check', '--skip-e2e']);
  assert.equal(flags['skip-e2e'], true);
});

test('parseArgs: a flag followed by another flag is boolean', () => {
  const { flags } = parseArgs(['--help', '--from', 'dir']);
  assert.equal(flags.help, true);
  assert.equal(flags.from, 'dir');
});
