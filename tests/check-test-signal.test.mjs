// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SIGNAL_BASELINE,
  countsOf,
  initialBaseline,
  lowerBaseline,
  scanSet,
  testSignalFindings,
} from '../scripts/check-test-signal.mjs';

// Fixture lines are assembled from parts so this file does not carry the patterns it detects.
const timer = 'set' + 'Timeout';
const now = 'Date' + '.now()';
const perf = 'performance' + '.now()';
const sleepLine = `await new Promise(resolve => ${timer}(resolve, 20));`;
const elapsedLine = `assert.ok(${now} - started < 5000);`;
const docsLine = `const doc = readFileSync(${'new' + ' URL'}('../${'do' + 'cs'}/agents/workflow.md', import.meta.url), 'utf8');`;
const pauseCall = `await ${'pa' + 'use'}(10);`;
const sleepCall = `await ${'sle' + 'ep'}(5);`;
const base = { version: 1, files: {} };

test('a new real sleep, elapsed-time assert or docs read in a test fails with file, lines and pattern', () => {
  const source = [
    'test("x", async () => {',
    `  ${sleepLine}`,
    `  ${elapsedLine}`,
    `  ${docsLine}`,
    '});',
  ].join('\n');
  const findings = testSignalFindings('tests/new.test.mjs', source, base);
  assert.equal(findings.length, 3);
  assert.match(
    findings[0],
    /^tests\/new\.test\.mjs:2: 1 sleep signal\(s\), baseline 0 \(real sleeps or timer waits\)/,
  );
  assert.match(findings[1], /^tests\/new\.test\.mjs:3: 1 elapsed signal\(s\), baseline 0/);
  assert.match(findings[2], /^tests\/new\.test\.mjs:4: 1 docs signal\(s\), baseline 0/);
  assert.ok(!findings.join('\n').includes('workflow.md'), 'findings never echo source');
});

test('the same pattern aliased: helper sleeps, timers/promises aliases, monotonic clock and delta variables', () => {
  const source = [
    "import { setTimeout as pause } from 'node:timers/promises';",
    pauseCall,
    sleepCall,
    `const took = ${perf} - began;`,
    'assert.ok(took < 100);',
    `assert.ok(${perf} < deadline);`,
    'assert.equal(took, took);',
  ].join('\n');
  assert.deepEqual(countsOf(source), { sleep: 2, elapsed: 2, docs: 0 });
});

test('a file at or below its baseline passes; one more signal than the baseline fails', () => {
  const source = `${sleepLine}\n${sleepLine}\n`;
  const at = { version: 1, files: { 'tests/a.test.mjs': { sleep: 2 } } };
  assert.deepEqual(testSignalFindings('tests/a.test.mjs', source, at), []);
  assert.deepEqual(testSignalFindings('tests/a.test.mjs', `${sleepLine}\n`, at), []);
  const below = { version: 1, files: { 'tests/a.test.mjs': { sleep: 1 } } };
  assert.match(testSignalFindings('tests/a.test.mjs', source, below)[0], /2 sleep signal\(s\), baseline 1/);
  // Another pattern in a file with a sleep baseline has its own baseline of 0.
  assert.match(
    testSignalFindings('tests/a.test.mjs', `${elapsedLine}\n`, at)[0],
    /1 elapsed signal\(s\), baseline 0/,
  );
});

test('a deadline, a stored timestamp and an injected clock are not elapsed-time asserts', () => {
  const source = [
    `const deadline = ${now} + 5000;`,
    `assert.ok(${now} < deadline, 'timed out waiting');`,
    `assert(row.expiresAt <= ${now});`,
    'assert.ok(clock.advance(5000) < 5001);',
    `// ${sleepLine}`,
    "const text = readFileSync(join(fixtureRoot, 'docs/status.md'), 'utf8');",
  ].join('\n');
  assert.deepEqual(countsOf(source), { sleep: 0, elapsed: 0, docs: 0 });
});

test('the allow marker exempts its own line or the next, only with a reason', () => {
  const source = [
    `${sleepLine} // test-signal: allow child process has no event to wait on`,
    '// test-signal: allow the watcher has no completion event',
    sleepLine,
    `${sleepLine} // test-signal: allow`,
    '// test-signal: allow because',
    'const unrelated = 1;',
    sleepLine,
  ].join('\n');
  const findings = testSignalFindings('tests/a.test.mjs', source, base);
  assert.equal(findings.length, 1);
  assert.match(findings[0], /^tests\/a\.test\.mjs:4,7: 2 sleep signal\(s\)/);
});

test('--update lowers counts after deletions and never raises or adds a file', () => {
  const baseline = {
    version: 1,
    files: {
      'tests/a.test.mjs': { sleep: 3, docs: 1 },
      'tests/gone.test.mjs': { sleep: 2 },
      'tests/clean.test.mjs': { elapsed: 1 },
    },
  };
  const current = new Map([
    ['tests/a.test.mjs', { sleep: 1, elapsed: 0, docs: 4 }],
    ['tests/clean.test.mjs', { sleep: 0, elapsed: 0, docs: 0 }],
    ['tests/new.test.mjs', { sleep: 9, elapsed: 0, docs: 0 }],
  ]);
  assert.deepEqual(lowerBaseline(baseline, current), {
    version: 1,
    files: { 'tests/a.test.mjs': { sleep: 1, docs: 1 } },
  });
  assert.deepEqual(initialBaseline(current), {
    version: 1,
    files: { 'tests/a.test.mjs': { sleep: 1, docs: 4 }, 'tests/new.test.mjs': { sleep: 9 } },
  });
});

test('the standard check scans only changed test files, or all when the baseline or scanner changes', () => {
  const files = new Map(
    ['tests/a.test.mjs', 'tests/b.test.mjs', 'tests/helper.mjs', 'docs/x.md', 'src/x.ts'].map(path => [
      path,
      '',
    ]),
  );
  assert.deepEqual(scanSet(files, ['tests/b.test.mjs', 'src/x.ts', 'tests/deleted.test.mjs']), [
    'tests/b.test.mjs',
  ]);
  assert.deepEqual(scanSet(files, []), []);
  assert.deepEqual(scanSet(files, null), ['tests/a.test.mjs', 'tests/b.test.mjs']);
  assert.deepEqual(scanSet(files, [SIGNAL_BASELINE]), ['tests/a.test.mjs', 'tests/b.test.mjs']);
  assert.deepEqual(scanSet(files, ['scripts/check-test-signal.mjs']), [
    'tests/a.test.mjs',
    'tests/b.test.mjs',
  ]);
});

test('the CLI exits 1 on a raise and --init refuses to overwrite a committed baseline', () => {
  const script = fileURLToPath(new URL('../scripts/check-test-signal.mjs', import.meta.url));
  const repo = mkdtempSync(join(tmpdir(), 'forge-test-signal-'));
  mkdirSync(join(repo, 'scripts'));
  mkdirSync(join(repo, 'tests'));
  writeFileSync(join(repo, 'scripts/check-test-signal.mjs'), readFileSync(script));
  writeFileSync(join(repo, 'tests/a.test.mjs'), `${sleepLine}\n`);
  const run = (...args) =>
    spawnSync(process.execPath, ['scripts/check-test-signal.mjs', ...args], { cwd: repo, encoding: 'utf8' });
  assert.equal(run().status, 1, 'no baseline: the sleep is new');
  assert.equal(run('--init').status, 0);
  assert.equal(run().status, 0, 'at baseline');
  assert.equal(run('--init').status, 1, 'a baseline is never rewritten from scratch');
  writeFileSync(join(repo, 'tests/a.test.mjs'), `${sleepLine}\n${sleepLine}\n`);
  assert.equal(run().status, 1, 'one more sleep than the baseline');
  assert.equal(run('--update').status, 1, '--update does not raise the baseline');
  assert.deepEqual(JSON.parse(readFileSync(join(repo, SIGNAL_BASELINE), 'utf8')).files, {
    'tests/a.test.mjs': { sleep: 1 },
  });
  writeFileSync(join(repo, 'tests/a.test.mjs'), 'const none = 1;\n');
  assert.equal(run('--update').status, 0);
  assert.deepEqual(JSON.parse(readFileSync(join(repo, SIGNAL_BASELINE), 'utf8')).files, {});
});
