#!/usr/bin/env node
// Publish gate: prove the suite actually RAN before shipping.
//
// `node --test` exits 0 in a directory with no test files at all — same shape as
// the `check` bug this repo just fixed: "I ran nothing" rendering as success. So
// if a refactor moves, renames, or drops test/ out of the discovery pattern,
// `npm publish` would stay green and the suite would vanish silently while the
// README still advertises a test count.
//
// This asserts a floor: the suite must run at least MIN_TESTS passing tests
// across at least MIN_FILES discovered test files, with zero failures. Raise the
// floors as coverage grows.

import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const MIN_FILES = 5
const MIN_TESTS = 70

const res = spawnSync(process.execPath, ['--test', '--test-reporter=tap'], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
})
const out = `${res.stdout || ''}${res.stderr || ''}`

const num = (label) => {
  const m = new RegExp(`^# ${label} (\\d+)$`, 'm').exec(out)
  return m ? Number(m[1]) : 0
}
const pass = num('pass')
const fail = num('fail')
// Count the test FILES on disk. (Parsing them out of TAP is unreliable — every
// individual test also emits a `# Subtest:` line, which counts tests, not files.)
const files = (() => {
  try {
    const dir = fileURLToPath(new URL('../test/', import.meta.url))
    return readdirSync(dir).filter((f) => f.endsWith('.test.mjs')).length
  } catch {
    return 0 // test/ is gone entirely — exactly the case this gate exists for
  }
})()

const problems = []
if (res.status !== 0) problems.push(`node --test exited ${res.status}`)
if (fail > 0) problems.push(`${fail} failing test(s)`)
if (pass < MIN_TESTS) problems.push(`only ${pass} passing test(s), floor is ${MIN_TESTS}`)
if (files < MIN_FILES) problems.push(`only ${files} test file(s) discovered, floor is ${MIN_FILES}`)

if (problems.length) {
  console.error('✖ publish blocked — the test suite did not run as expected:')
  for (const p of problems) console.error(`  · ${p}`)
  console.error('\nIf you intentionally added/removed tests, update the floors in scripts/assert-tests-ran.mjs.')
  process.exit(1)
}

console.log(`✔ suite verified: ${pass} passing test(s) across ${files} file(s).`)
