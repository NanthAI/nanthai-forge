// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { promisify } from 'node:util';
import { actionsRunnerFixture } from './actions-runner-fixture.mjs';

// Pause a separate fake API process in the middle of its filesystem write. A
// concurrent discovery must see either the old complete record or the new one.
test('Actions fixture publishes complete run records to concurrent discovery', async t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-actions-fixture-'));
  const provider = actionsRunnerFixture(root);
  const id = '12345678-1234-4234-8234-123456789abc';
  const check = join(root, `check-${id}`);
  mkdirSync(check);
  writeFileSync(join(check, 'github-actions.json'), JSON.stringify({ commit: 'a'.repeat(40) }));
  const marker = join(root, 'writing');
  const release = join(root, 'release');
  const preload = join(root, 'partial-write.mjs');
  writeFileSync(
    preload,
    `import fs from 'node:fs';
const write=fs.writeFileSync.bind(fs);
fs.writeFileSync=(file,bytes,...options)=>{
 if(String(file).includes('/run-')){
  write(file,String(bytes).slice(0,8),...options);
  write(${JSON.stringify(marker)},'ready');
  while(!fs.existsSync(${JSON.stringify(release)}))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
 }
 return write(file,bytes,...options);
};`,
  );
  const child = spawn(
    process.execPath,
    [
      '--import',
      preload,
      join(provider.bin, 'gh'),
      'api',
      'repos/synthetic/checks/actions/workflows/forge-check.yml/dispatches',
    ],
    { stdio: ['pipe', 'ignore', 'pipe'] },
  );
  const closed = once(child, 'close');
  child.stderr.resume();
  child.stdin.end(JSON.stringify({ ref: `forge-check/${id}` }));
  t.after(async () => {
    writeFileSync(release, 'go');
    await closed;
    rmSync(root, { recursive: true, force: true });
  });
  const deadline = Date.now() + 10_000;
  while (!existsSync(marker) && Date.now() < deadline) await pause(10);
  assert.ok(existsSync(marker), 'fake API reached its staged write');
  const discover = async () => {
    const { stdout } = await promisify(execFile)(process.execPath, [
      join(provider.bin, 'gh'),
      'api',
      `repos/synthetic/checks/actions/runs?branch=${encodeURIComponent(`forge-check/${id}`)}`,
    ]);
    return JSON.parse(stdout).workflow_runs;
  };
  assert.deepEqual(await discover(), [], 'unpublished record is invisible');
  writeFileSync(release, 'go');
  assert.deepEqual(await closed, [0, null]);
  const runs = await discover();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].head_sha, 'a'.repeat(40));
});

// A fast synthetic command must read its input just as Git does. Otherwise a
// Linux spawn can report EPIPE before the parent finishes writing index bytes.
test('Actions fixture drains Git export input before completing update-index', t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-actions-fixture-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const provider = actionsRunnerFixture(root);
  const source = join(root, 'check-input', 'modal-source');
  mkdirSync(source, { recursive: true });
  const output = execFileSync(
    join(provider.bin, 'git'),
    ['-C', source, 'update-index', '-z', '--index-info'],
    {
      input: Buffer.alloc(1024 * 1024, 120),
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10_000,
    },
  );
  assert.equal(output.length, 0);
});
