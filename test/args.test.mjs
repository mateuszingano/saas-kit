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

test('parseArgs accepts --key=value (glued with =)', () => {
  const { flags, positional } = parseArgs(['new', '--repo=x.git', '--from=./tmpl']);
  assert.equal(flags.repo, 'x.git');
  assert.equal(flags.from, './tmpl');
  assert.deepEqual(positional, ['new']);
});

test('parseArgs: --key=value keeps a value that itself contains =', () => {
  const { flags } = parseArgs(['--repo=https://h/r.git?ref=main']);
  assert.equal(flags.repo, 'https://h/r.git?ref=main');
});

test('parseArgs: --key=value tolerates an empty value', () => {
  const { flags } = parseArgs(['--body=']);
  assert.equal(flags.body, '');
});

test('parseArgs: a value that starts with a single dash is taken as the value', () => {
  const { flags } = parseArgs(['--repo', '-weird-name']);
  assert.equal(flags.repo, '-weird-name');
});

test('parseArgs: --key=-value keeps a dash-leading value glued with =', () => {
  const { flags } = parseArgs(['--tag=-rc1']);
  assert.equal(flags.tag, '-rc1');
});

test('parseArgs: a value-required flag with no value throws (not silent true)', () => {
  const opts = { valueFlags: ['repo', 'from'] };
  // bare flag at end of argv
  assert.throws(() => parseArgs(['new', 'app', '--repo'], opts), /--repo needs a value/);
  // followed by another flag
  assert.throws(() => parseArgs(['new', 'app', '--from', '--repo', 'x'], opts), /--from needs a value/);
  // empty glued value
  assert.throws(() => parseArgs(['new', 'app', '--repo='], opts), /--repo needs a value/);
});

test('parseArgs: value-required flag with a real value still parses', () => {
  const { flags } = parseArgs(['new', 'app', '--repo', 'x.git'], { valueFlags: ['repo', 'from'] });
  assert.equal(flags.repo, 'x.git');
});
