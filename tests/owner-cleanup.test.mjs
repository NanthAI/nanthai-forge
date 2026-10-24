// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { cleanupOwner, registerOwnerPresence, stopOwnerCheckControllers } from './owner-cleanup.mjs';
import { initNative } from '../dist/native-work.js';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { processAlive, processIdentity } from '../dist/local-process.js';

// Use a standalone process so no unrelated referenced handle can hide an unref'd join.
test('cleanup joins a late detached child before removing its owner', async () => {
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { cleanupOwner } from ${JSON.stringify(new URL('./owner-cleanup.mjs', import.meta.url).href)};
    import { spawn } from 'node:child_process';
    import { mkdtempSync, existsSync } from 'node:fs';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    const root = mkdtempSync(join(tmpdir(), 'forge-cleanup-late-'));
    let writer;
    setImmediate(() => {
      const child = writer = spawn(process.execPath, ['-e', "setTimeout(()=>require('fs').writeFileSync('done', 'done'), 100)"], { cwd: root, stdio: 'ignore', detached: true });
      child.unref();
    });
    await cleanupOwner(root);
    if (writer?.exitCode !== 0) throw new Error('Writer did not finish before removal');
    if (existsSync(root)) throw new Error('Owner survived cleanup');
    console.log('joined');
  `,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '',
    errors = '';
  child.stdout.on('data', bytes => (output += bytes));
  child.stderr.on('data', bytes => (errors += bytes));
  const status = await new Promise(resolve => child.once('close', resolve));
  assert.equal(status, 0, errors);
  assert.match(output, /joined/);
});

test('cleanup stops a detached CLI presence owner before removing its records', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-cleanup-presence-'));
  writeFileSync(join(root, 'a.txt'), 'fixture\n');
  initNative(root);
  await new AgentWorkflow(root).dispatch({ action: 'start', outcome: 'Keep Lane present' });
  const pid = Number(
    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
    import { spawn } from 'node:child_process';
    const child = spawn(process.execPath, [${JSON.stringify(resolve('dist/presence-worker.js'))}, ${JSON.stringify(root)}], { detached: true, stdio: 'ignore' });
    child.unref();
    console.log(child.pid);
  `,
      ],
      { encoding: 'utf8' },
    ),
  );
  const identity = processIdentity(pid);
  registerOwnerPresence(root, identity);
  const other = mkdtempSync(join(tmpdir(), 'forge-cleanup-other-'));
  initNative(other);
  await new AgentWorkflow(other).dispatch({ action: 'start', outcome: 'Unrelated owner stays active' });
  const peer = spawn(process.execPath, [resolve('dist/presence-worker.js'), other], {
    detached: true,
    stdio: 'ignore',
  });
  const peerIdentity = processIdentity(peer.pid);
  peer.unref();
  try {
    await cleanupOwner(root);
    assert.equal(processAlive(identity), false);
    assert.equal(existsSync(root), false);
    assert.equal(processAlive(peerIdentity), true, 'Other owners are outside this teardown');
  } finally {
    await cleanupOwner(other);
  }
});

test('failed-replay teardown stops only a leased controller in its synthetic owner', async t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-cleanup-controller-'));
  writeFileSync(join(root, 'a.txt'), 'synthetic\n');
  initNative(root);
  const ready = join(root, 'ready');
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { WorkStore } from ${JSON.stringify(new URL('../dist/work-store.js', import.meta.url).href)};
    import { withQueueSlot } from ${JSON.stringify(new URL('../dist/landing-queue.js', import.meta.url).href)};
    const store = new WorkStore(process.argv[1]);
    setInterval(()=>{},60000);
    await withQueueSlot(join(store.directory,'check-controllers','synthetic'),async()=>{
      writeFileSync(${JSON.stringify(ready)}, 'ready');
      await new Promise(()=>{});
    },{anchor:store.directory});
  `,
      root,
    ],
    { detached: true, stdio: 'ignore', cwd: root },
  );
  child.unref();
  t.after(async () => {
    if (existsSync(root)) await cleanupOwner(root, undefined, { stopChecks: true });
  });
  const deadline = Date.now() + 20_000;
  while (!existsSync(ready)) {
    assert.ok(Date.now() < deadline, 'synthetic controller acquired its lease');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  const identity = processIdentity(child.pid);
  const other = mkdtempSync(join(tmpdir(), 'forge-cleanup-unrelated-'));
  initNative(other);
  try {
    const lane = (await new AgentWorkflow(other).dispatch({ action: 'start', outcome: 'Synthetic guard' }))
      .result;
    await assert.rejects(stopOwnerCheckControllers(lane.path), /limited to synthetic/);
    await cleanupOwner(root, undefined, { stopChecks: true });
    assert.equal(processAlive(identity), false);
    assert.equal(existsSync(root), false);
    assert.equal(existsSync(other), true, 'unrelated owners are untouched');
  } finally {
    await cleanupOwner(other);
  }
});
