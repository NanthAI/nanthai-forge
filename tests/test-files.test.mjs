// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileTimeout } from '../scripts/test-files.mjs';

test('whole-file timeout defaults to ten minutes and validates its override', () => {
  assert.equal(fileTimeout({}), 600000);
  assert.equal(fileTimeout({ FORGE_TEST_FILE_TIMEOUT_MS: '1200000' }), 1200000);
  for (const value of ['', '0', '-1', '1.5', 'Infinity', '2147483648'])
    assert.throws(() => fileTimeout({ FORGE_TEST_FILE_TIMEOUT_MS: value }), /FORGE_TEST_FILE_TIMEOUT_MS/);
});

test('file supervisor kills module hangs and leaked children, names failures and continues queued files', async t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-test-files-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const blocked = join(root, 'blocked.mjs'),
    leaked = join(root, 'leaked.mjs'),
    passed = join(root, 'passed.mjs');
  const pid = join(root, 'child.pid'),
    marker = join(root, 'passed');
  writeFileSync(blocked, 'while (true) {}');
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
  assert.ok(existsSync(pid), 'leaked child fixture must have started');
  assert.ok(existsSync(marker), result.output);
  assert.match(result.output, /# pass 1/);
});

test('file supervisor preserves assertion failures and successful file totals', async t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-test-files-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
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
  t.after(() => rmSync(root, { recursive: true, force: true }));
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
