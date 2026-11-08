// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { semanticCheckCommand } from '../dist/semantic-check-command.js';

const GO = ['pkg/billing/invoice_test.go', 'pkg/billing/tax_test.go'];
const plan = (tests = GO) => {
  const primaryIntentId = randomUUID();
  return {
    primaryIntentId,
    members: [primaryIntentId, randomUUID()].map(intentId => ({
      intentId,
      outcome: 'Synthetic',
      version: 1,
      tests: tests.map(path => ({ path, durationMs: 10 })),
    })),
  };
};
/** A Go-style project runner whose command only records the files it is asked to run. */
const runner = {
  status: 'available',
  runner: {
    source: 'declared',
    program: 'declared',
    globs: ['**/*_test.go'],
    command: [
      process.execPath,
      '-e',
      'require("node:fs").appendFileSync("ran.log", process.argv[1] + "\\n")',
      '{files}',
    ],
    layout: 'generic',
  },
};
const junit = file =>
  `<testsuites><testsuite name="x"><testcase classname="pkg/billing" name="TestA" file="${file}" time="0.1"/></testsuite></testsuites>`;
const failedJunit = file =>
  `<testsuites><testsuite name="x"><testcase classname="pkg/billing" name="TestA" file="${file}"><failure message="boom">trace</failure></testcase></testsuite></testsuites>`;

/** Runs the wrapped command; the "configured check" writes `reports` to FORGE_JUNIT_DIR, then exits `exit`. */
function run(t, reports, { exit = 0, junitDir = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'forge-semantic-junit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const reportDir = join(dir, 'reports');
  mkdirSync(reportDir);
  const write = `const fs=require('node:fs');const d=process.env.FORGE_JUNIT_DIR;for(const [name,xml] of Object.entries(${JSON.stringify(reports)}))if(d)fs.writeFileSync(d+'/'+name,xml);process.exitCode=${exit}`;
  const command = semanticCheckCommand([process.execPath, '-e', write], plan(), process.execPath, [], runner);
  const env = { ...process.env };
  // The runner running this suite may set its own report directory; the check under test must not see it.
  if (junitDir) env.FORGE_JUNIT_DIR = reportDir;
  else delete env.FORGE_JUNIT_DIR;
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(command[0], command.slice(1), { cwd: dir, encoding: 'utf8', env });
  const ran = existsSync(join(dir, 'ran.log')) ? readFileSync(join(dir, 'ran.log'), 'utf8').trim() : '';
  return { result, ran: ran ? ran.split('\n').sort() : [] };
}

test('union tests that a JUnit report already covers are not run again', t => {
  const { result, ran } = run(t, { 'a.xml': junit(GO[0]), 'b.xml': junit(GO[1]) });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(ran, [], 'the full check already ran both Go test files');
});

test('only the union tests no report covers run afterwards', t => {
  const { result, ran } = run(t, { 'go.xml': junit(GO[0]) });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(ran, [GO[1]]);
});

test('a failed JUnit report fails the union even when the command exited zero, without a re-run', t => {
  const { result, ran } = run(t, { 'a.xml': failedJunit(GO[0]), 'b.xml': junit(GO[1]) });
  assert.equal(result.status, 1);
  assert.deepEqual(ran, []);
});

test('malformed or absent JUnit evidence keeps the old behaviour: every union file runs', t => {
  assert.deepEqual(run(t, { 'bad.xml': '<testsuite><testcase' }).ran, GO);
  assert.deepEqual(run(t, { 'a.xml': junit(GO[0]) }, { junitDir: false }).ran, GO);
});
