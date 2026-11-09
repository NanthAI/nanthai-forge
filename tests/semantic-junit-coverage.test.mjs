// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { semanticCheckCommand } from '../dist/semantic-check-command.js';
import { workspaceTestRunner } from '../dist/workspace-test-runner.js';

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
function run(t, reports, { exit = 0, junitDir = true, files = {}, tests, runner: project = runner } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'forge-semantic-junit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const reportDir = join(dir, 'reports');
  mkdirSync(reportDir);
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  const write = `const fs=require('node:fs');const d=process.env.FORGE_JUNIT_DIR;for(const [name,xml] of Object.entries(${JSON.stringify(reports)}))if(d)fs.writeFileSync(d+'/'+name,xml);process.exitCode=${exit}`;
  const command = semanticCheckCommand(
    [process.execPath, '-e', write],
    plan(tests),
    process.execPath,
    [],
    project,
  );
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

const suite = (name, cases) => `<testsuites><testsuite name="${name}">${cases}</testsuite></testsuites>`;
const pass = (classname, name = 'TestA') => `<testcase classname="${classname}" name="${name}" time="0.1"/>`;
const fail = (classname, name = 'TestA') =>
  `<testcase classname="${classname}" name="${name}"><failure message="boom">trace</failure></testcase>`;

test('M2-03: Go reports without a file attribute cover every _test.go file of the package', t => {
  const files = { 'go.mod': 'module example.com/shop\n\ngo 1.22\n' };
  const { result, ran } = run(
    t,
    { 'go.xml': suite('example.com/shop/pkg/billing', pass('example.com/shop/pkg/billing')) },
    { files },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(ran, [], 'gotestsum shape: the package report covers invoice_test.go and tax_test.go');
  // A failed package fails the union without a rerun; a different package covers nothing.
  assert.equal(
    run(t, { 'go.xml': suite('p', fail('example.com/shop/pkg/billing')) }, { files }).result.status,
    1,
  );
  assert.deepEqual(run(t, { 'go.xml': suite('p', pass('example.com/shop/pkg/other')) }, { files }).ran, GO);
  // A nested module's import path includes the module name; an external test package counts too.
  const nested = { 'pkg/go.mod': 'module example.com/shop/pkg\n' };
  assert.deepEqual(
    run(t, { 'go.xml': suite('p', pass('example.com/shop/pkg/billing_test')) }, { files: nested }).ran,
    [],
  );
});

test('M2-03: JVM reports cover the file that declares the class, nested classes included', t => {
  const java = ['src/test/java/com/acme/LedgerTest.java', 'src/test/java/com/acme/TaxTest.java'];
  const files = Object.fromEntries(
    java.map(path => [path, `package com.acme;\nclass ${path.match(/(\w+)\.java/)[1]} {}\n`]),
  );
  const reports = {
    'TEST-surefire.xml': suite(
      'com.acme.LedgerTest',
      pass('com.acme.LedgerTest', 'posts') + pass('com.acme.LedgerTest$Nested', 'x'),
    ),
  };
  const covered = run(t, reports, { files, tests: java, runner: runner });
  assert.equal(covered.result.status, 0, covered.result.stderr);
  assert.deepEqual(
    covered.ran,
    ['src/test/java/com/acme/TaxTest.java'],
    'only the class no report names reruns',
  );
  const failed = run(t, { 'a.xml': suite('x', fail('com.acme.TaxTest')) }, { files, tests: java });
  assert.equal(failed.result.status, 1);
  // LedgerTestHelper is not LedgerTest.
  const other = run(t, { 'a.xml': suite('x', pass('com.acme.LedgerTestHelper')) }, { files, tests: java });
  assert.deepEqual(other.ran, java);
});

test('M2-03: Rust nextest binaries cover the crate tests/<binary>.rs; unattributable entries cover nothing', t => {
  const rust = ['crates/core/tests/ledger.rs', 'crates/api/tests/ledger.rs'];
  const files = {
    'crates/core/Cargo.toml': '[package]\nname = "fx-core"\nversion = "0.1.0"\n',
    'crates/api/Cargo.toml': '[package]\nname = "fx-api"\n',
  };
  const reports = { 'nextest.xml': suite('fx-core::ledger', pass('fx-core::ledger', 'works')) };
  const { result, ran } = run(t, reports, { files, tests: rust });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(ran, ['crates/api/tests/ledger.rs'], 'a bare binary name would not say which crate');
  assert.deepEqual(
    run(t, { 'n.xml': suite('ledger', pass('ledger')) }, { files, tests: rust }).ran.sort(),
    [...rust].sort(),
  );
});

test('M2-03: an uncovered union file reruns as its package command, or is unavailable with a reason', t => {
  const files = {
    'a/go.mod': 'module example.com/a\n',
    'a/x.go': 'package a\n',
    'a/x_test.go': 'package a\n',
  };
  const tests = ['a/x_test.go'];
  const bare = path => ({
    status: 'available',
    runner: {
      source: 'package-graph',
      program: 'packages',
      globs: [],
      command: [],
      layout: 'packages',
      ecosystems: ['go'],
      fileCommands: path,
    },
  });
  const ok = run(
    t,
    {},
    {
      files,
      tests,
      runner: bare({ 'a/x_test.go': ['sh', '-c', 'echo ran >> ran.log; echo a/x_test.go >> ran.log'] }),
    },
  );
  assert.equal(ok.result.status, 0, ok.result.stderr);
  const missing = run(
    t,
    {},
    {
      files,
      tests,
      runner: bare({ 'a/x_test.go': { unavailable: 'package graph: the root package is affected' } }),
    },
  );
  assert.equal(missing.result.status, 2);
  assert.match(
    missing.result.stderr,
    /SEMANTIC_TESTS_UNAVAILABLE: a\/x_test\.go: package graph: the root package is affected/,
  );
  const absent = run(t, {}, { files, tests, runner: bare({}) });
  assert.equal(absent.result.status, 2);
  assert.match(absent.result.stderr, /SEMANTIC_TESTS_UNAVAILABLE: a\/x_test\.go: no package command/);
});

test('M2-03: a checkout with no package.json and no declared runner reruns union files as package commands', t => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-semantic-workspace-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [path, body] of Object.entries({
    'a/go.mod': 'module example.com/a\n',
    'a/x_test.go': 'package a\n',
    'a/internal/y_test.go': 'package internal\n',
    'go.mod': 'module example.com/root\n',
    'root_test.go': 'package root\n',
  })) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  const resolved = workspaceTestRunner(dir, ['a/x_test.go', 'a/internal/y_test.go', 'root_test.go']);
  assert.equal(resolved.status, 'available');
  assert.equal(resolved.runner.layout, 'packages');
  const commands = resolved.runner.fileCommands;
  assert.deepEqual(commands['a/x_test.go'], ['sh', '-c', '(cd a && go test ./...)']);
  assert.deepEqual(commands['a/internal/y_test.go'], ['sh', '-c', '(cd a && go test ./internal)']);
  // A file whose package the graph cannot isolate says why instead of guessing.
  assert.match(commands['root_test.go'].unavailable, /root package example\.com\/root \(go\) is affected/);
  // Declaring the runner in forge.json still wins over the package graph.
  writeFileSync(
    join(dir, 'forge.json'),
    JSON.stringify({ preflight: { tests: { glob: '**/*_test.go', command: ['go', 'test', '{files}'] } } }),
  );
  assert.equal(workspaceTestRunner(dir, ['a/x_test.go']).runner.layout, 'generic');
});
