// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileTimeout } from '../scripts/test-files.mjs';

test('whole-file timeout defaults to ten minutes and validates its override', () => {
  assert.equal(fileTimeout({}), 600000);
  assert.equal(fileTimeout({ FORGE_TEST_FILE_TIMEOUT_MS: '1200000' }), 1200000);
  for (const value of ['', '0', '-1', '1.5', 'Infinity', '2147483648'])
    assert.throws(() => fileTimeout({ FORGE_TEST_FILE_TIMEOUT_MS: value }), /FORGE_TEST_FILE_TIMEOUT_MS/);
});

test('file supervisor kills module hangs and leaked children, names failures and continues queued files', async t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-test-files-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const blocked = join(root, 'blocked.mjs'),
    leaked = join(root, 'leaked.mjs'),
    passed = join(root, 'passed.mjs');
  const tempPaths = join(root, 'temp-paths.json');
  const pid = join(root, 'child.pid'),
    marker = join(root, 'passed');
  writeFileSync(
    blocked,
    `import {mkdtempSync,writeFileSync} from 'node:fs';
    import {tmpdir} from 'node:os'; import {join} from 'node:path';
    writeFileSync(${JSON.stringify(tempPaths)}, JSON.stringify(['forge-batch-','forge-machine-check-','forge-landing-tlc-','forge-direct-job-','scale-'].map(prefix => mkdtempSync(join(tmpdir(), prefix)))));
    while (true) {}`,
  );
  writeFileSync(
    leaked,
    `import { spawn } from 'node:child_process';
    import { writeFileSync } from 'node:fs';
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio:'inherit'});
    writeFileSync(${JSON.stringify(pid)}, String(child.pid));`,
  );
  writeFileSync(
    passed,
    `import test from 'node:test';
    import { writeFileSync } from 'node:fs';
    test('queued file still runs', () => writeFileSync(${JSON.stringify(marker)}, 'ok'));`,
  );
  const result = await run([blocked, leaked, passed], {
    FORGE_TEST_FILE_TIMEOUT_MS: '10000',
    FORGE_TEST_WORKERS: '1',
  });
  assert.equal(result.code, 1);
  for (const file of [blocked, leaked]) {
    assert.ok(result.output.includes(`${file}: exceeded per-file timeout (10000ms)`), result.output);
    assert.ok(result.output.includes(`Failed test file: ${file}`));
  }
  assert(
    JSON.parse(readFileSync(tempPaths, 'utf8')).every(path => !existsSync(path)),
    'SIGKILL timeout reclaims all five fixture prefixes',
  );
  assert.ok(existsSync(pid), 'leaked child fixture must have started');
  assert.ok(existsSync(marker), result.output);
  assert.match(result.output, /# pass 1/);
});

test('file supervisor preserves assertion failures and successful file totals', async t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-test-files-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const file = join(root, 'assertion.mjs');
  writeFileSync(
    file,
    `import test from 'node:test'; import assert from 'node:assert/strict';
    test('pass', () => {}); test('fail', () => assert.equal(1, 2));`,
  );
  const result = await run([file], { FORGE_TEST_FILE_TIMEOUT_MS: '30000' });
  assert.equal(result.code, 1);
  assert.match(result.output, /ERR_ASSERTION/);
  assert.match(result.output, /# pass 1/);
  assert.match(result.output, /# fail 1/);
  writeFileSync(file, `import test from 'node:test'; test('pass', () => {});`);
  const success = await run([file], { FORGE_TEST_FILE_TIMEOUT_MS: '30000' });
  assert.equal(success.code, 0, success.output);
  assert.match(success.output, /# pass 1/);
});

test('dceb1bef: files of one run share one module cache, compile each module once, and never read stale output', async t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-test-files-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const loader = new URL('./convex-module.mjs', import.meta.url).href;
  const top = pathToFileURL(join(root, 'top.ts')).href;
  writeFileSync(join(root, 'leaf.ts'), 'export const leaf: number = 1;\n');
  writeFileSync(
    join(root, 'top.ts'),
    "import { leaf } from './leaf';\nexport const top: number = leaf + 1;\n",
  );
  const out = join(root, 'loads.jsonl');
  const files = ['first.mjs', 'second.mjs'].map(name => join(root, name));
  for (const file of files)
    writeFileSync(
      file,
      `import test from 'node:test'; import { appendFileSync, existsSync, readdirSync, statSync } from 'node:fs';
      import { fileURLToPath } from 'node:url'; import { moduleUrl } from ${JSON.stringify(loader)};
      test('load', async () => {
        const dir = process.env.FORGE_TEST_MODULE_DIRECTORY;
        const before = existsSync(dir) ? readdirSync(dir).length : 0;
        const url = moduleUrl(new URL(${JSON.stringify(top)}));
        const { top } = await import(url);
        appendFileSync(${JSON.stringify(out)}, JSON.stringify({ dir, before, url, top, ino: statSync(fileURLToPath(url)).ino }) + '\\n');
      });`,
    );
  const loads = () =>
    readFileSync(out, 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
  const environment = { FORGE_TEST_WORKERS: '1', FORGE_TEST_FILE_TIMEOUT_MS: '60000' };
  const result = await run(files, { ...environment, FORGE_TEST_MODULE_DIRECTORY: '' });
  assert.equal(result.code, 0, result.output);
  const [first, second] = loads();
  assert.ok(first.dir && first.dir === second.dir, 'both files of the run use the one supervisor cache');
  assert.equal(first.before, 0);
  assert.equal(second.before, 2, "the second file finds the first file's outputs");
  assert.deepEqual(
    [second.url, second.ino, second.top],
    [first.url, first.ino, 2],
    'compiled once, not twice',
  );
  assert.equal(existsSync(first.dir), false, 'the supervisor removes the cache it created');

  // An inherited cache is kept for its owner; a changed module gets a new key and is never served stale.
  const shared = join(root, 'shared');
  rmSync(out);
  assert.equal((await run([files[0]], { ...environment, FORGE_TEST_MODULE_DIRECTORY: shared })).code, 0);
  writeFileSync(join(root, 'leaf.ts'), 'export const leaf: number = 41;\n');
  assert.equal((await run([files[1]], { ...environment, FORGE_TEST_MODULE_DIRECTORY: shared })).code, 0);
  const [cold, edited] = loads();
  assert.equal(cold.dir, shared);
  assert.equal(edited.top, 42, 'the edited dependency is compiled, not read from the earlier output');
  assert.notEqual(edited.url, cold.url);
  assert.ok(existsSync(shared), 'an inherited cache belongs to whoever set it');
});

function run(files, overrides) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/test-files.mjs', ...files], {
      env: { ...process.env, ...overrides },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => {
      output += chunk;
    });
    child.stderr.on('data', chunk => {
      output += chunk;
    });
    child.once('error', reject);
    child.once('close', code => resolve({ code, output }));
  });
}

test('machine reports keep file attribution and nested names despite concurrent console output', async t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-test-events-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const first = join(root, 'first.mjs'),
    second = join(root, 'second.mjs');
  writeFileSync(
    first,
    `import {describe,it} from 'node:test'; describe('first suite',()=>{it('same name',()=>{throw Error('synthetic')})});`,
  );
  writeFileSync(
    second,
    `import {describe,it} from 'node:test'; describe('second suite',()=>{it('same name',()=>{})});`,
  );
  const result = await run([first, second], { FORGE_TEST_EVENTS: '1' });
  assert.equal(result.code, 1);
  const reports = result.output
    .split('\n')
    .filter(line => line.startsWith('__FORGE_TESTS__'))
    .map(line => JSON.parse(line.slice('__FORGE_TESTS__'.length)));
  assert.equal(reports.length, 2);
  assert.ok(reports.every(report => report.complete));
  assert.ok(reports.every(report => Number.isFinite(report.durationMs) && report.durationMs > 0));
  assert.ok(
    reports
      .find(report => report.file === first)
      .results.some(item => item.name === 'first suite > same name' && !item.passed),
  );
  assert.ok(
    reports
      .find(report => report.file === second)
      .results.some(item => item.name === 'second suite > same name' && item.passed),
  );
});

test('687d1eda: a file whose every test skipped is reported as skipped, not as a pass', async t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-test-skips-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const skipped = join(root, 'skipped.mjs'),
    partial = join(root, 'partial.mjs');
  // Incident 687d1eda: a browser test skipped (no browser) and the check counted it as passed.
  writeFileSync(
    skipped,
    `import test from 'node:test'; test('a', t => t.skip('no browser')); test('b', t => t.skip('no browser'));`,
  );
  writeFileSync(
    partial,
    `import test from 'node:test'; test('a', t => t.skip('mac only')); test('b', () => {});`,
  );
  const result = await run([skipped, partial], { FORGE_TEST_EVENTS: '1' });
  assert.equal(result.code, 0, result.output);
  const reports = Object.fromEntries(
    result.output
      .split('\n')
      .filter(line => line.startsWith('__FORGE_TESTS__'))
      .map(line => JSON.parse(line.slice('__FORGE_TESTS__'.length)))
      .map(report => [report.file, report]),
  );
  assert.equal(reports[skipped].skipped, true);
  assert.equal(reports[partial].skipped, undefined, 'one test ran, so the file is evidence');
  assert(result.output.includes(`# Skipped test file: ${skipped}; every test skipped, so it is not a pass`));
});

test('one isolated retry runs every failing file within budget and retains both named attempts', async t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-test-retry-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const files = ['flake', 'persistent', 'affected', 'clean'].map(name => join(root, `${name}.mjs`));
  for (const [index, file] of files.entries())
    writeFileSync(
      file,
      `
    import test from 'node:test'; import assert from 'node:assert/strict';
    import { readFileSync, writeFileSync, existsSync } from 'node:fs';
    const path = ${JSON.stringify(file + '.count')};
    const count = existsSync(path) ? Number(readFileSync(path)) + 1 : 1;
    writeFileSync(path, String(count));
    test('result', () => assert.ok(${index === 0 ? 'count > 1' : index === 3 ? 'true' : 'false'}));
  `,
    );
  const result = await run(files, {
    FORGE_TEST_EVENTS: '1',
    FORGE_TEST_RETRY_FILES: JSON.stringify(files.slice(0, 2)),
  });
  assert.equal(result.code, 1, result.output);
  const { readFileSync } = await import('node:fs');
  assert.deepEqual(
    files.map(file => Number(readFileSync(file + '.count'))),
    [2, 2, 2, 1],
  );
  const reports = result.output
    .split('\n')
    .filter(line => line.startsWith('__FORGE_TESTS__'))
    .map(line => JSON.parse(line.slice(15)));
  assert.equal(reports.length, 4);
  assert.deepEqual(reports.find(report => report.file === files[0]).retry.results, [
    { name: 'result', passed: false },
  ]);
  assert.equal(reports.find(report => report.file === files[0]).results[0].passed, true);
  assert.equal(reports.find(report => report.file === files[1]).results[0].passed, false);
  assert.ok(reports.find(report => report.file === files[2]).retry);
  assert.equal(reports.find(report => report.file === files[3]).retry, undefined);
  const flake = reports.find(report => report.file === files[0]);
  assert.equal(flake.flaky, true);
  assert.ok(flake.retry.durationMs > 0);
  assert.match(flake.retry.firstError, /error:/);
  assert.match(result.output, /Flaky test file:/);
});
