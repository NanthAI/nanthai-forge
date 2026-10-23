// SPDX-License-Identifier: Apache-2.0
// Direct focused runs must also avoid the user's real check queue and saved login.
import './check-runtime.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { initNative } from '../dist/native-work.js';
import { NativeSource } from '../dist/native-source.js';
import { automaticCleanup } from '../dist/work-auto-clean.js';
import { allRecords } from '../dist/agent-lifecycle.js';
import { agentClean } from '../dist/agent-clean.js';
import { inspectArtifacts } from '../dist/work-artifacts.js';
import { applyOwnerLifecycle } from '../dist/owner-lifecycle.js';
import { withWorkLockOptions } from '../dist/work-lock.js';
import { mockProcessCoverage } from './cleanup-process-fixture.mjs';

let scan;
test.beforeEach(t => {
  scan = mockProcessCoverage(t);
});

const run = (agent, action, body = {}) =>
  agent.dispatch({ action, ...(action === 'set-policy' ? { operationId: randomUUID() } : {}), ...body });
async function fixture(t, enabled = true, script = "console.log('retained log')", artifactPaths) {
  const root = mkdtempSync(join(tmpdir(), 'forge-auto-clean-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'file.txt'), 'original\n');
  initNative(root);
  const agent = new AgentWorkflow(root),
    store = agent.work.store;
  await run(agent, 'set-policy', { preset: enabled ? 'autonomous' : 'trusted' });
  await run(agent, 'define-check', {
    name: 'verify',
    executable: process.execPath,
    args: ['-e', script],
    ...(artifactPaths ? { artifactPaths } : {}),
  });
  const start = async () => (await run(agent, 'start', { outcome: 'Synthetic cleanup' })).result;
  return { root, agent, store, start };
}
const removedLane = (cleanup, id) =>
  (cleanup.removed ?? []).flatMap(group => group.items).find(item => item.laneId === id);

for (const leaf of ['workspace', 'runtime']) {
  test(`a process in check ${leaf} retains both workspace and runtime until it exits`, async t => {
    const p = await fixture(t, true, "require('fs').writeFileSync('file.txt','changed')"),
      lane = await p.start();
    await run(p.agent, 'finish', { laneId: lane.laneId, message: 'Retain changed workspace' });
    const saved = allRecords(p.store, 'runs')[0],
      directory = join(p.store.directory, `check-${saved.id}`);
    writeFileSync(join(directory, 'workspace', 'file.txt'), 'original\n');
    scan.paths = [join(directory, leaf, 'nested')];
    const cleanup = automaticCleanup(p.store, randomUUID(), 'test', { runId: saved.id });
    assert.equal(cleanup.totals.count, 0);
    for (const copy of ['workspace', 'runtime']) {
      assert.ok(existsSync(join(directory, copy)), `${leaf} process still needs ${copy}`);
      assert.match(
        cleanup.skipped.find(item => item.id === join(directory, copy)).reason,
        /process is working/,
      );
    }
    scan.paths = [];
    const afterExit = automaticCleanup(p.store, randomUUID(), 'test', { runId: saved.id });
    assert.equal(afterExit.totals.count, 2);
    assert.equal(existsSync(join(directory, 'workspace')), false);
    assert.equal(existsSync(join(directory, 'runtime')), false);
  });
}

test('unavailable process coverage retains both terminal check copies', async t => {
  const p = await fixture(t, true, "require('fs').writeFileSync('file.txt','changed')"),
    lane = await p.start();
  await run(p.agent, 'finish', { laneId: lane.laneId, message: 'Retain changed workspace' });
  const saved = allRecords(p.store, 'runs')[0],
    directory = join(p.store.directory, `check-${saved.id}`);
  writeFileSync(join(directory, 'workspace', 'file.txt'), 'original\n');
  scan.unavailable = true;
  const cleanup = automaticCleanup(p.store, randomUUID(), 'test', { runId: saved.id });
  assert.equal(cleanup.totals.count, 0);
  for (const leaf of ['workspace', 'runtime']) {
    assert.ok(existsSync(join(directory, leaf)));
    assert.match(
      cleanup.skipped.find(item => item.id === join(directory, leaf)).reason,
      /coverage is unavailable/,
    );
  }
});

test('finish removes completed Lane; acceptance replay never deletes a reopened active Lane', async t => {
  const p = await fixture(t),
    lane = await p.start();
  writeFileSync(join(lane.path, 'saved.txt'), 'retained\n');
  const command = { laneId: lane.laneId, message: 'Save', accept: true, operationId: randomUUID() };
  const done = (await run(p.agent, 'finish', command)).result;
  assert.equal(done.status, 'accepted');
  assert.ok(removedLane(done.acceptance.completed.cleanup[0].cleanup, lane.laneId));
  assert.equal(existsSync(lane.path), false);
  await run(p.agent, 'finish', { ...command, ...done.resolved });
  assert.equal(existsSync(lane.path), false, 'terminal replay does not rematerialize a cleaned Lane');
  assert.equal(p.store.select('lanes', lane.laneId).state, 'completed');
  const actions = allRecords(p.store, 'automaticActions');
  const action = actions.find(item => item.result && removedLane(JSON.parse(item.result), lane.laneId));
  assert.ok(action);
  assert.match(action.action.undo, /reopen/);
  assert.match(action.action.summary, new RegExp(lane.laneId));
  await run(p.agent, 'reopen', { laneId: lane.laneId });
  assert.equal(readFileSync(join(lane.path, 'saved.txt'), 'utf8'), 'retained\n');
  await run(p.agent, 'finish', { ...command, ...done.resolved });
  assert.ok(existsSync(lane.path));
  assert.equal(p.store.select('lanes', lane.laneId).state, 'active');
});

test('complete reports dirty and active Lanes, and preserves their folders and dependencies', async t => {
  const p = await fixture(t),
    dirty = await p.start(),
    active = await p.start();
  writeFileSync(join(dirty.path, 'unsaved.txt'), 'keep me');
  mkdirSync(join(dirty.path, 'node_modules'));
  const completed = (await run(p.agent, 'complete', { laneId: dirty.laneId })).result;
  assert.match(
    completed.cleanup.skipped.find(item => item.laneId === dirty.laneId).reason,
    /[Uu]ncaptured edits/,
  );
  assert.ok(existsSync(join(dirty.path, 'node_modules')));
  const sweep = automaticCleanup(p.store, randomUUID(), 'test');
  assert.match(sweep.skipped.find(item => item.laneId === active.laneId).reason, /still active/);
  assert.equal(readFileSync(join(dirty.path, 'unsaved.txt'), 'utf8'), 'keep me');
  assert.ok(existsSync(active.path));
});

test('abandon removes saved Lane and reopen materializes head; replay retains reopened edits', async t => {
  const p = await fixture(t),
    lane = await p.start();
  writeFileSync(join(lane.path, 'saved.txt'), 'abandoned save');
  const command = {
    laneId: lane.laneId,
    reason: 'Different approach',
    saveFirst: true,
    operationId: randomUUID(),
  };
  const abandoned = (await run(p.agent, 'abandon', command)).result;
  assert.ok(scan.mock.callCount() > 0, 'automatic cleanup observed the controlled process scan');
  assert.ok(removedLane(abandoned.cleanup, lane.laneId), JSON.stringify(abandoned.cleanup.skipped));
  assert.equal(existsSync(lane.path), false);
  await run(p.agent, 'reopen', { laneId: lane.laneId });
  assert.equal(readFileSync(join(lane.path, 'saved.txt'), 'utf8'), 'abandoned save');
  writeFileSync(join(lane.path, 'later.txt'), 'new work');
  await run(p.agent, 'abandon', command);
  assert.equal(readFileSync(join(lane.path, 'later.txt'), 'utf8'), 'new work');
});

test('abandon retains saved Lane when process coverage is unavailable', async t => {
  scan.unavailable = true;
  const p = await fixture(t),
    lane = await p.start();
  writeFileSync(join(lane.path, 'saved.txt'), 'retained despite scan failure');
  const command = {
    laneId: lane.laneId,
    reason: 'Different approach',
    saveFirst: true,
    operationId: randomUUID(),
  };
  const abandoned = (await run(p.agent, 'abandon', command)).result;
  assert.ok(scan.mock.callCount() > 0);
  assert.equal(p.store.select('lanes', lane.laneId).state, 'abandoned');
  assert.equal(removedLane(abandoned.cleanup, lane.laneId), undefined);
  assert.match(
    abandoned.cleanup.skipped.find(item => item.laneId === lane.laneId).reason,
    /Local process coverage is unavailable/,
  );
  assert.equal(readFileSync(join(lane.path, 'saved.txt'), 'utf8'), 'retained despite scan failure');
  await run(p.agent, 'reopen', { laneId: lane.laneId });
  writeFileSync(join(lane.path, 'later.txt'), 'new work');
  await run(p.agent, 'abandon', command);
  assert.equal(p.store.select('lanes', lane.laneId).state, 'active');
  assert.equal(readFileSync(join(lane.path, 'later.txt'), 'utf8'), 'new work');
});

test('trusted preset keeps closed Lane copies until cleanup is explicitly enabled', async t => {
  const p = await fixture(t, false),
    lane = await p.start();
  await run(p.agent, 'complete', { laneId: lane.laneId });
  assert.ok(existsSync(lane.path));
  await run(p.agent, 'set-policy', { lifecycle: { cleanRegenerableCopies: true } });
  const next = await p.start();
  writeFileSync(join(next.path, 'next.txt'), 'accepted');
  await run(p.agent, 'finish', { laneId: next.laneId, message: 'Accepted', accept: true });
  assert.equal(existsSync(next.path), false);
  assert.equal(existsSync(lane.path), false, 'acceptance sweeps reconstructable backlog');
});

test('terminal check removes workspace and runtime while retained logs and artifacts remain readable', async t => {
  const script =
    "const fs=require('fs');fs.mkdirSync('build');fs.writeFileSync('build/output.txt','retained artifact');fs.writeFileSync(process.env.FORGE_CHECK_SELECTION,JSON.stringify({scope:'scoped',reason:'Synthetic evidence before cleanup',tests:['tests/synthetic.test.mjs']}));console.log('retained log')";
  const p = await fixture(t, true, script, ['build/output.txt']),
    lane = await p.start();
  const done = (await run(p.agent, 'finish', { laneId: lane.laneId, message: 'Check' })).result;
  assert.equal(done.run.status, 'passed');
  const saved = allRecords(p.store, 'runs')[0],
    directory = join(p.store.directory, `check-${saved.id}`);
  assert.equal(existsSync(join(directory, 'workspace')), false);
  assert.equal(existsSync(join(directory, 'runtime')), false);
  const receipt = JSON.parse(readFileSync(join(directory, 'result.json'), 'utf8'));
  assert.equal(receipt.status, 'passed');
  for (const [key, value] of Object.entries(receipt)) assert.deepEqual(saved[key], value, key);
  assert.deepEqual(saved.checkSelection, {
    scope: 'scoped',
    reason: 'Synthetic evidence before cleanup',
    tests: ['tests/synthetic.test.mjs'],
  });
  assert.match(saved.details, /Check selection: scoped; Synthetic evidence before cleanup/);
  assert.doesNotMatch(saved.details, /Cleanup /);
  automaticCleanup(p.store, randomUUID(), 'later sweep', { runId: saved.id });
  assert.deepEqual(p.store.select('runs', saved.id), saved);
  const log = (await run(p.agent, 'log', { operationId: saved.id })).result;
  assert.match(log.text ?? JSON.stringify(log), /retained log/);
  const artifacts = await inspectArtifacts(directory, saved);
  assert.equal(readFileSync(artifacts[0].path, 'utf8'), 'retained artifact');
  const action = allRecords(p.store, 'automaticActions').find(
    item =>
      item.result &&
      JSON.parse(item.result).removed.some(group => group.items.some(item => item.runId === saved.id)),
  );
  assert.match(action.action.undo, /Checks reconstruct workspaces/);
});

test('policy-off terminal cleanup preserves Work format and immutable run evidence without action records', async t => {
  const p = await fixture(t, false),
    lane = await p.start();
  writeFileSync(join(lane.path, 'prepared.txt'), 'saved check input');
  const checkpoint = (await run(p.agent, 'checkpoint', { laneId: lane.laneId, message: 'Prepare check' }))
      .result,
    view = (
      await run(p.agent, 'compose', {
        operationId: randomUUID(),
        intentId: lane.intentId,
        inputs: [{ laneId: lane.laneId, head: checkpoint.head }],
      })
    ).result,
    schema = p.store.load().schema,
    actions = p.store.load().automaticActions ?? [];
  const done = (await run(p.agent, 'run', { viewId: view.viewId })).result;
  assert.equal(done.status, 'passed');
  const saved = allRecords(p.store, 'runs')[0],
    directory = join(p.store.directory, `check-${saved.id}`),
    receipt = JSON.parse(readFileSync(join(directory, 'result.json'), 'utf8'));
  assert.equal(p.store.load().schema, schema);
  assert.deepEqual(p.store.load().automaticActions ?? [], actions);
  for (const [key, value] of Object.entries(receipt)) assert.deepEqual(saved[key], value, key);
  assert.equal(existsSync(join(directory, 'workspace')), false);
  assert.equal(existsSync(join(directory, 'runtime')), false);
  assert.ok(existsSync(lane.path));
});

test('policy-enabled cleanup retains DISK_LOW workspace and runtime through terminal handling and later sweeps', async t => {
  const p = await fixture(t, true, 'throw new Error("Must not execute")'),
    lane = await p.start(),
    materialize = NativeSource.prototype.materialize,
    previous = process.env.FORGE_DISK_BLOCK_GB;
  NativeSource.prototype.materialize = function (...args) {
    materialize.apply(this, args);
    process.env.FORGE_DISK_BLOCK_GB = String(Number.MAX_SAFE_INTEGER);
  };
  t.after(() => {
    NativeSource.prototype.materialize = materialize;
    if (previous === undefined) delete process.env.FORGE_DISK_BLOCK_GB;
    else process.env.FORGE_DISK_BLOCK_GB = previous;
  });
  const done = (await run(p.agent, 'finish', { laneId: lane.laneId, message: 'Refused check' })).result,
    saved = allRecords(p.store, 'runs')[0],
    directory = join(p.store.directory, `check-${saved.id}`);
  assert.equal(done.run.status, 'failed');
  assert.equal(saved.error.code, 'DISK_LOW');
  assert.equal(saved.childPid, undefined);
  assert.equal(readFileSync(join(directory, 'workspace', 'file.txt'), 'utf8'), 'original\n');
  assert.ok(existsSync(join(directory, 'runtime')));
  const swept = automaticCleanup(p.store, randomUUID(), 'test');
  assert.equal(swept.totals.count, 0);
  assert.match(swept.skipped.find(item => item.runId === saved.id).reason, /DISK_LOW/);
  assert.ok(existsSync(join(directory, 'workspace')));
  assert.ok(existsSync(join(directory, 'runtime')));
  const receipt = JSON.parse(readFileSync(join(directory, 'result.json'), 'utf8'));
  for (const [key, value] of Object.entries(receipt))
    assert.deepEqual(p.store.select('runs', saved.id)[key], value, key);
});

test('terminal check with changed source keeps workspace and records why', async t => {
  const p = await fixture(t, true, "require('fs').writeFileSync('file.txt','changed');console.log('done')"),
    lane = await p.start();
  await run(p.agent, 'finish', { laneId: lane.laneId, message: 'Check' });
  const saved = allRecords(p.store, 'runs')[0],
    directory = join(p.store.directory, `check-${saved.id}`);
  assert.equal(readFileSync(join(directory, 'workspace', 'file.txt'), 'utf8'), 'changed');
  const skipped = allRecords(p.store, 'automaticActions').flatMap(item =>
    item.result ? JSON.parse(item.result).skipped : [],
  );
  assert.match(skipped.find(item => item.runId === saved.id).reason, /[Ss]ource differs/);
});

test('running check survives automatic cleanup, then is cleaned after durable terminal evidence', async t => {
  const p = await fixture(t, true, 'setTimeout(()=>console.log("done"),500)'),
    lane = await p.start();
  const checked = (await run(p.agent, 'finish', { laneId: lane.laneId, message: 'Check', waitMs: 0 })).result;
  const saved = allRecords(p.store, 'runs')[0],
    directory = join(p.store.directory, `check-${saved.id}`);
  assert.ok(['running', 'preparing', 'queued'].includes(saved.status), JSON.stringify(checked));
  const sweep = automaticCleanup(p.store, randomUUID(), 'test');
  assert.match(sweep.skipped.find(item => item.runId === saved.id).reason, /recorded as/);
  assert.ok(existsSync(join(directory, 'workspace')));
  await run(p.agent, 'observe', { operationId: saved.id, waitMs: 60000 });
  for (let i = 0; i < 100 && existsSync(join(directory, 'workspace')); i++)
    await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(existsSync(join(directory, 'workspace')), false);
});

test('a reported process working in a completed Lane prevents automatic removal until it exits', async t => {
  const p = await fixture(t),
    lane = await p.start();
  scan.paths = [lane.path];
  const result = (await run(p.agent, 'complete', { laneId: lane.laneId })).result;
  assert.ok(existsSync(lane.path));
  assert.match(result.cleanup.skipped.find(item => item.laneId === lane.laneId).reason, /process is working/);
  scan.paths = [];
  assert.ok(removedLane(automaticCleanup(p.store, randomUUID(), 'test'), lane.laneId));
});

test('concurrent finish and cleanup preserve accepted bytes and keep an active Lane', async t => {
  const p = await fixture(t, true, 'setTimeout(()=>{},200)'),
    lane = await p.start(),
    active = await p.start();
  writeFileSync(join(lane.path, 'accepted.txt'), 'accepted once');
  const script = `import {mock} from 'node:test';import {mockProcessCoverage} from ${JSON.stringify(new URL('./cleanup-process-fixture.mjs', import.meta.url).href)};mockProcessCoverage({mock,after:()=>{}});import {AgentWorkflow} from ${JSON.stringify(new URL('../dist/agent-workflow.js', import.meta.url).href)};const agent=new AgentWorkflow(${JSON.stringify(p.root)});const result=await agent.dispatch({action:'finish',laneId:${JSON.stringify(lane.laneId)},message:'Concurrent',accept:true});console.log(JSON.stringify(result));`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    cwd: resolve('.'),
    env: { ...process.env, FORGE_WORK_LOCK_WAIT_MS: '30000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '',
    errors = '',
    exit;
  child.stdout.on('data', bytes => (output += bytes));
  child.stderr.on('data', bytes => (errors += bytes));
  const closed = once(child, 'close').then(([code]) => (exit = code));
  let sweeps = 0;
  while (exit === undefined) {
    try {
      withWorkLockOptions({ waitMs: 0 }, () =>
        agentClean(p.store, { action: 'clean', apply: true, kinds: ['lanes', 'check-workspaces'] }),
      );
      sweeps++;
    } catch (error) {
      if (error.code !== 'WORK_BUSY') throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  await closed;
  assert.equal(exit, 0, errors);
  assert.equal(JSON.parse(output).result.status, 'accepted');
  assert.ok(sweeps > 0);
  assert.equal(existsSync(lane.path), false);
  assert.ok(existsSync(active.path));
  await run(p.agent, 'reopen', { laneId: lane.laneId });
  assert.equal(readFileSync(join(lane.path, 'accepted.txt'), 'utf8'), 'accepted once');
});

test('owner lifecycle complete cleans and reopen re-materializes the retained head', async t => {
  const p = await fixture(t),
    lane = await p.start(),
    actor = { kind: 'person', name: 'Synthetic owner' };
  const command = {
    action: 'complete',
    collection: 'lanes',
    id: lane.laneId,
    expectedHead: lane.head,
    expectedState: 'active',
    reason: 'Done',
    saveFirst: false,
    cascade: false,
  };
  const closed = applyOwnerLifecycle(p.store, command, randomUUID(), actor);
  assert.ok(removedLane(closed.cleanup, lane.laneId));
  assert.equal(existsSync(lane.path), false);
  applyOwnerLifecycle(
    p.store,
    { ...command, action: 'reopen', expectedState: 'completed' },
    randomUUID(),
    actor,
  );
  assert.equal(readFileSync(join(lane.path, 'file.txt'), 'utf8'), 'original\n');
});

test('missing receipts and retained artifacts never authorize terminal workspace removal', async t => {
  const script =
    "const fs=require('fs');fs.mkdirSync('build');fs.writeFileSync('build/output.txt','artifact');fs.writeFileSync('file.txt','changed')";
  const p = await fixture(t, true, script, ['build/output.txt']),
    lane = await p.start();
  await run(p.agent, 'finish', { laneId: lane.laneId, message: 'Check' });
  const saved = allRecords(p.store, 'runs')[0],
    directory = join(p.store.directory, `check-${saved.id}`);
  writeFileSync(join(directory, 'workspace', 'file.txt'), 'original\n');
  rmSync(join(directory, 'artifacts', saved.artifacts[0].filename));
  const absentArtifact = automaticCleanup(p.store, randomUUID(), 'test', { runId: saved.id });
  assert.equal(absentArtifact.totals.count, 0);
  assert.match(absentArtifact.skipped[0].reason, /evidence|artifacts/);
  for (const leaf of ['workspace', 'runtime']) assert.ok(existsSync(join(directory, leaf)));
  rmSync(join(directory, 'result.json'));
  const absentReceipt = automaticCleanup(p.store, randomUUID(), 'test', { runId: saved.id });
  assert.equal(absentReceipt.totals.count, 0);
  assert.match(absentReceipt.skipped[0].reason, /receipt is unavailable/);
  for (const leaf of ['workspace', 'runtime']) assert.ok(existsSync(join(directory, leaf)));
});

test('unavailable process coverage retains terminal check copies even with valid evidence', async t => {
  // finish performs terminal cleanup too; coverage must be unavailable before it runs.
  scan.unavailable = true;
  const p = await fixture(t),
    lane = await p.start();
  await run(p.agent, 'finish', { laneId: lane.laneId, message: 'Check' });
  const saved = allRecords(p.store, 'runs')[0],
    directory = join(p.store.directory, `check-${saved.id}`),
    cleanup = automaticCleanup(p.store, randomUUID(), 'test', { runId: saved.id });
  assert.ok(scan.mock.callCount() > 0);
  assert.equal(saved.status, 'passed');
  assert.ok(existsSync(join(directory, 'result.json')));
  assert.equal(cleanup.totals.count, 0);
  for (const leaf of ['workspace', 'runtime']) {
    assert.ok(existsSync(join(directory, leaf)));
    assert.match(
      cleanup.skipped.find(item => item.id === join(directory, leaf)).reason,
      /Local process coverage is unavailable/,
    );
  }
});

test('pending source operations and missing retained objects keep completed Lane copies', async t => {
  const p = await fixture(t),
    lane = await p.start();
  p.store.locked(() => {
    const tx = p.store.records();
    tx.patchFields('lanes', lane.laneId, {
      pendingMerge: {
        parent: lane.head,
        channel: 'main',
        operation: { id: randomUUID(), request: 'a'.repeat(64) },
        conflicts: [],
      },
    });
    p.store.commitRecords(tx);
  });
  const result = (await run(p.agent, 'complete', { laneId: lane.laneId })).result;
  assert.match(result.cleanup.skipped[0].reason, /pending source operation/);
  assert.ok(existsSync(lane.path));
  const { NativeSource } = await import('../dist/native-source.js');
  const source = new NativeSource(p.root),
    file = source.state(lane.head).files.find(file => file.path === 'file.txt');
  p.store.locked(() => {
    const tx = p.store.records();
    tx.patchFields('lanes', lane.laneId, { pendingMerge: undefined });
    p.store.commitRecords(tx);
  });
  rmSync(join(source.directory, file.blob));
  const missing = automaticCleanup(p.store, randomUUID(), 'test', { laneIds: [lane.laneId] });
  assert.equal(missing.totals.count, 0);
  assert.match(missing.skipped[0].reason, /Source coverage/);
  assert.equal(readFileSync(join(lane.path, 'file.txt'), 'utf8'), 'original\n');
});

test('excluded local settings and arbitrary ignored files keep a closed Lane reconstructable', async t => {
  const p = await fixture(t),
    lane = await p.start();
  writeFileSync(join(lane.path, '.env.local'), 'SYNTHETIC_SETTING=local-only\n');
  const done = (await run(p.agent, 'complete', { laneId: lane.laneId })).result;
  assert.equal(done.cleanup.totals.count, 0);
  assert.match(done.cleanup.skipped[0].reason, /not retained in State/);
  assert.equal(readFileSync(join(lane.path, '.env.local'), 'utf8'), 'SYNTHETIC_SETTING=local-only\n');
  rmSync(join(lane.path, '.env.local'));
  writeFileSync(join(lane.path, '.gitignore'), 'local-only.txt\n');
  await run(p.agent, 'checkpoint', { laneId: lane.laneId, message: 'Ignore synthetic local file' });
  writeFileSync(join(lane.path, 'local-only.txt'), 'uncaptured ignored bytes');
  const ignored = automaticCleanup(p.store, randomUUID(), 'test', { laneIds: [lane.laneId] });
  assert.equal(ignored.totals.count, 0);
  assert.match(ignored.skipped[0].reason, /not retained in State/);
  assert.equal(readFileSync(join(lane.path, 'local-only.txt'), 'utf8'), 'uncaptured ignored bytes');
});
