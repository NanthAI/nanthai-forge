// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { queueEntries } from '../dist/check-queue.js';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { NativeSource } from '../dist/native-source.js';
import { initNative } from '../dist/native-work.js';
import { WorkStore } from '../dist/work-store.js';
import { syncTestHooks } from '../dist/agent-sync.js';
import { trustAgents } from './autonomy-fixture.mjs';

const storeUrl = new URL('../dist/work-store.js', import.meta.url).href;
async function until(condition, timeoutMs = 30000, details = () => '') {
  const end = Date.now() + timeoutMs;
  while (!condition()) {
    assert.ok(Date.now() < end, `fixture did not reach its barrier\n${details()}`);
    await delay(20);
  }
}
function fixture(t, text = 'base\n') {
  const root = mkdtempSync(join(tmpdir(), 'forge-lock-queue-'));
  writeFileSync(join(root, 'source.txt'), text);
  initNative(root);
  trustAgents(root);
  const children = [];
  t.after(async () => {
    for (const { proc } of children)
      if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
    await Promise.allSettled(children.map(child => child.done));
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  t.children = children;
  return new AgentWorkflow(root);
}
async function start(agent) {
  return (await agent.dispatch({ action: 'start', outcome: 'Queue fixture' })).result;
}
function child(t, root, body, args = [], env = {}, observeStderr = () => {}) {
  const proc = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import {WorkStore} from ${JSON.stringify(storeUrl)};import fs from 'node:fs';const store=new WorkStore(process.argv[1]);${body}`,
      root,
      ...args,
    ],
    { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stdout = '',
    stderr = '';
  proc.stdout.on('data', data => (stdout += data));
  proc.stderr.on('data', data => {
    stderr += data;
    observeStderr(stderr);
  });
  let closed = false;
  const done = new Promise((resolve, reject) => {
    proc.on('error', reject);
    proc.on('close', code => {
      closed = true;
      resolve({ code, stdout, stderr });
    });
  });
  const result = { proc, done, closed: () => closed, stderr: () => stderr };
  t.children.push(result);
  return result;
}
const hold = `const ready=process.argv[2], release=process.argv[3];store.locked(()=>{fs.writeFileSync(ready,'ready');while(!fs.existsSync(release))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);},{operation:'long fixture',actor:'holder agent'});`;

test('Work waiters enter FIFO, report the holder once, and trace hold durations', async t => {
  const agent = fixture(t),
    root = agent.work.store.root,
    directory = agent.work.store.directory;
  const ready = join(root, 'ready'),
    release = join(root, 'release'),
    order = join(root, 'order'),
    trace = join(root, 'trace');
  const holder = child(t, root, hold, [ready, release], { FORGE_WORK_LOCK_TRACE: trace });
  await until(() => existsSync(ready));
  const first = child(
    t,
    root,
    `store.locked(()=>fs.appendFileSync(process.argv[2],'first\\n'),{operation:'first',waitMs:10000});`,
    [order],
  );
  await until(() =>
    readdirSync(join(directory, 'lock-queue')).some(name => name.startsWith(first.proc.pid + '.')),
  );
  // A ticket precedes progress output. Keep the named holder alive until the
  // waiter reports it, rather than racing that read against holder release.
  await until(() => first.stderr().length > 0);
  const second = child(
    t,
    root,
    `store.locked(()=>fs.appendFileSync(process.argv[2],'second\\n'),{operation:'second',waitMs:10000});`,
    [order],
  );
  await until(() =>
    readdirSync(join(directory, 'lock-queue')).some(name => name.startsWith(second.proc.pid + '.')),
  );
  writeFileSync(release, 'release');
  for (const reply of await Promise.all([holder.done, first.done, second.done]))
    assert.equal(reply.code, 0, reply.stderr);
  assert.equal(readFileSync(order, 'utf8'), 'first\nsecond\n');
  const reply = await first.done;
  assert.match(reply.stderr, /waiting for long fixture by holder agent \(started \d+[sm] ago\)/);
  assert.equal(reply.stderr.trim().split('\n').length, 1);
  const timing = JSON.parse(readFileSync(trace, 'utf8').trim());
  assert.equal(timing.operation, 'long fixture');
  assert.equal(typeof timing.holdMs, 'number');
  assert.equal(typeof timing.waitMs, 'number');
});

test('timeout preserves a live lock and holder details; killed holder and queued waiter recover', async t => {
  const agent = fixture(t),
    store = agent.work.store,
    root = store.root;
  const ready = join(root, 'ready'),
    release = join(root, 'release');
  const holder = child(t, root, hold, [ready, release]);
  await until(() => existsSync(ready));
  const original = readFileSync(join(store.directory, 'lock'));
  assert.throws(
    () => store.locked(() => assert.fail(), { waitMs: 30 }),
    error => error.code === 'WORK_BUSY' && /holder agent/.test(error.message),
  );
  assert.deepEqual(readFileSync(join(store.directory, 'lock')), original);
  const abandoned = child(t, root, `store.locked(()=>{}, {waitMs:30000});`);
  await until(() =>
    readdirSync(join(store.directory, 'lock-queue')).some(name => name.startsWith(abandoned.proc.pid + '.')),
  );
  abandoned.proc.kill('SIGKILL');
  await abandoned.done;
  holder.proc.kill('SIGKILL');
  await holder.done;
  assert.equal(
    store.locked(() => 42, { waitMs: 10000 }),
    42,
  );
  assert.equal(existsSync(join(store.directory, 'lock')), false);
});

test('same-Lane checkpoints queue while different Lanes proceed and both saves survive', async t => {
  const agent = fixture(t),
    a = await start(agent),
    b = await start(agent),
    root = agent.work.store.root;
  writeFileSync(join(a.path, 'source.txt'), 'lane a\n');
  writeFileSync(join(b.path, 'source.txt'), 'lane b\n');
  const ready = join(root, 'ready'),
    release = join(root, 'release');
  const holder = child(
    t,
    root,
    `store.laneLocked(process.argv[4],()=>{fs.writeFileSync(process.argv[2],'ready');while(!fs.existsSync(process.argv[3]))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);},{operation:'lane fixture'});`,
    [ready, release, a.laneId],
  );
  await until(() => existsSync(ready));
  const command = {
    action: 'checkpoint',
    lockWaitMs: 10000,
    operationId: randomUUID(),
    laneId: a.laneId,
    message: 'a',
  };
  const waiting = child(
    t,
    root,
    `const {AgentWorkflow}=await import(${JSON.stringify(new URL('../dist/agent-workflow.js', import.meta.url).href)});console.log(JSON.stringify(await new AgentWorkflow(store.root).dispatch(JSON.parse(process.argv[2]))));`,
    [JSON.stringify(command)],
  );
  await until(
    () => readdirSync(join(agent.work.store.directory, 'lane-locks', a.laneId + '-queue')).length === 2,
  );
  const saved = (await agent.dispatch({ action: 'checkpoint', laneId: b.laneId, message: 'b' })).result;
  assert.notEqual(saved.head, b.head);
  assert.equal(existsSync(release), false);
  writeFileSync(release, 'release');
  assert.equal((await holder.done).code, 0);
  const reply = await waiting.done;
  assert.equal(reply.code, 0, reply.stderr);
  assert.notEqual(JSON.parse(reply.stdout).result.head, a.head);
  assert.equal(
    agent.work.store.load().lanes.reduce((n, lane) => n + lane.checkpoints.length, 0),
    2,
  );
});

test('sync publishes over unrelated concurrent metadata and writes files outside the owner lock', async t => {
  const agent = fixture(t),
    a = await start(agent),
    b = await start(agent),
    store = agent.work.store;
  const source = new NativeSource(store.root),
    files = source.state(a.head).files;
  const target = source.writeState(
    [...files, { path: 'main.txt', mode: 'file', blob: source.put(Buffer.from('main\n')) }],
    [a.head],
    'main',
    new Date().toISOString(),
  );
  // A pinned target exercises the same internal owner used by finish sync.
  const { agentSync } = await import('../dist/agent-sync.js');
  syncTestHooks.beforeWorkspace = () => {
    assert.equal(existsSync(join(store.directory, 'lock')), false);
    const peer = new WorkStore(store.root);
    peer.locked(() => {
      const tx = peer.records();
      tx.patchFields('lanes', b.laneId, { name: 'Peer survived' });
      tx.patchFields('lanes', a.laneId, { name: 'Fresh same-Lane metadata' });
      peer.commitRecords(tx);
    });
  };
  t.after(() => {
    delete syncTestHooks.beforeWorkspace;
  });
  const reply = agentSync(
    store,
    { operationId: randomUUID(), laneId: a.laneId, expectedHead: a.head, channel: 'main' },
    { target },
  );
  assert.equal(reply.result.status, 'merged');
  assert.equal(store.select('lanes', b.laneId).name, 'Peer survived');
  assert.equal(store.select('lanes', a.laneId).name, 'Fresh same-Lane metadata');
  assert.equal(readFileSync(join(a.path, 'main.txt'), 'utf8'), 'main\n');
});

test('sync rejects a source-head race without overwriting the newer head', async t => {
  const agent = fixture(t),
    lane = await start(agent),
    store = agent.work.store,
    source = new NativeSource(store.root),
    target = source.writeState(
      [
        ...source.state(lane.head).files,
        { path: 'new.txt', mode: 'file', blob: source.put(Buffer.from('new')) },
      ],
      [lane.head],
      'target',
      new Date().toISOString(),
    );
  const { agentSync } = await import('../dist/agent-sync.js');
  syncTestHooks.beforeWorkspace = () =>
    store.locked(() => {
      const tx = store.records();
      tx.patchFields('lanes', lane.laneId, { head: target });
      store.commitRecords(tx);
    });
  t.after(() => {
    delete syncTestHooks.beforeWorkspace;
  });
  assert.throws(
    () =>
      agentSync(
        store,
        {
          operationId: randomUUID(),
          laneId: lane.laneId,
          expectedHead: lane.head,
          channel: 'main',
        },
        { target },
      ),
    error => error.code === 'LANE_STALE',
  );
  assert.equal(store.select('lanes', lane.laneId).head, target);
});

test('compose traverses outside the owner lock, rejects stale publication and restores collected merge objects', async t => {
  const agent = fixture(t, 'one\ntwo\nthree\nfour\n'),
    a = await start(agent),
    b = (await agent.dispatch({ action: 'start', intentId: a.intentId, outcome: 'Sibling' })).result,
    store = agent.work.store;
  writeFileSync(join(a.path, 'source.txt'), 'local\ntwo\nthree\nfour\n');
  writeFileSync(join(b.path, 'source.txt'), 'one\ntwo\nthree\npeer\n');
  const ca = (await agent.dispatch({ action: 'checkpoint', laneId: a.laneId, message: 'local' })).result,
    cb = (await agent.dispatch({ action: 'checkpoint', laneId: b.laneId, message: 'peer' })).result;
  const command = {
    action: 'compose',
    operationId: randomUUID(),
    intentId: a.intentId,
    inputs: [
      { laneId: a.laneId, head: ca.head },
      { laneId: b.laneId, head: cb.head },
    ],
  };
  const originalCompose = NativeSource.prototype.compose;
  let changed = false;
  NativeSource.prototype.compose = function (...args) {
    assert.equal(existsSync(join(store.directory, 'lock')), false);
    if (!changed) {
      changed = true;
      const peer = new WorkStore(store.root);
      peer.locked(() => {
        const tx = peer.records();
        tx.patchFields('lanes', a.laneId, { name: 'Concurrent metadata' });
        peer.commitRecords(tx);
      });
    }
    return originalCompose.apply(this, args);
  };
  t.after(() => {
    NativeSource.prototype.compose = originalCompose;
  });
  await assert.rejects(agent.dispatch(command), error => error.code === 'WORK_STALE');
  const { nativeObjects } = await import('../dist/native-objects.js');
  const locked = store.locked.bind(store);
  const removed = new Set();
  store.locked = (...args) => {
    // Publication may retry: retain evidence from every collection, including
    // the empty collection before the locked restoration fallback.
    for (const id of nativeObjects(new WorkStore(store.root), { action: 'collect-native-objects' }).result
      .removed)
      removed.add(id);
    return locked(...args);
  };
  t.after(() => {
    store.locked = locked;
  });
  const reply = (await agent.dispatch(command)).result;
  store.locked = locked;
  assert.equal(reply.status, 'clean');
  assert.ok(removed.size >= 2, 'unpublished merge State and blob should be collected');
  const source = new NativeSource(store.root);
  const file = source.state(reply.head).files.find(file => file.path === 'source.txt');
  assert.equal(source.object(file.blob).toString(), 'local\ntwo\nthree\npeer\n');
  assert.equal(store.select('lanes', a.laneId).name, 'Concurrent metadata');
  assert.equal((await agent.dispatch(command)).result.viewId, reply.viewId);
});

test('checkpoint and sync on different Lanes finish while an exact-View check is running', async t => {
  const agent = fixture(t),
    a = await start(agent),
    b = await start(agent),
    c = await start(agent),
    root = agent.work.store.root;
  const ready = join(root, 'check-ready'),
    release = join(root, 'check-release');
  await agent.dispatch({
    action: 'define-check',
    name: 'verify',
    executable: process.execPath,
    args: [
      '-e',
      `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(ready)},'ready');const deadline=setTimeout(()=>process.exit(1),60000);const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearTimeout(deadline);clearInterval(timer);}},20);`,
    ],
  });
  writeFileSync(join(a.path, 'a.txt'), 'a\n');
  const finish = child(
    t,
    root,
    `const {AgentWorkflow}=await import(${JSON.stringify(new URL('../dist/agent-workflow.js', import.meta.url).href)});console.log(JSON.stringify(await new AgentWorkflow(store.root).dispatch(JSON.parse(process.argv[2]))));`,
    [JSON.stringify({ action: 'finish', laneId: a.laneId, message: 'a', accept: true })],
  );
  // The process can reach its barrier before its short spawn journal is published.
  await until(() => existsSync(ready) && !existsSync(join(agent.work.store.directory, 'lock')));
  assert.equal(existsSync(join(agent.work.store.directory, 'lock')), false);
  assert.equal(existsSync(join(agent.work.store.directory, 'lane-locks', a.laneId)), false);
  writeFileSync(join(b.path, 'b.txt'), 'b\n');
  assert.ok((await agent.dispatch({ action: 'checkpoint', laneId: b.laneId, message: 'b' })).result.head);
  const { agentSync } = await import('../dist/agent-sync.js');
  assert.equal(
    agentSync(
      agent.work.store,
      { operationId: randomUUID(), laneId: c.laneId, expectedHead: c.head, channel: 'main' },
      { target: agent.work.store.select('lanes', a.laneId).head },
    ).result.status,
    'merged',
  );
  assert.equal(existsSync(release), false);
  writeFileSync(release, 'release');
  const reply = await finish.done;
  assert.equal(reply.code, 0, reply.stderr);
  assert.equal(JSON.parse(reply.stdout).result.status, 'accepted');
});

test('sync restores composed objects collected before publication and remains replayable', async t => {
  const agent = fixture(t, 'one\ntwo\nthree\nfour\n'),
    lane = await start(agent),
    store = agent.work.store;
  writeFileSync(join(lane.path, 'source.txt'), 'local\ntwo\nthree\nfour\n');
  const checkpoint = (await agent.dispatch({ action: 'checkpoint', laneId: lane.laneId, message: 'local' }))
    .result;
  const source = new NativeSource(store.root),
    target = source.writeState(
      [
        ...source.state(lane.head).files.filter(file => file.path !== 'source.txt'),
        { path: 'source.txt', mode: 'file', blob: source.put(Buffer.from('one\ntwo\nthree\nmain\n')) },
      ],
      [lane.head],
      'main',
      new Date().toISOString(),
    );
  store.locked(() => {
    const data = store.load();
    data.nativeHead = target;
    data.revision++;
    store.save(data);
  });
  const { agentSync } = await import('../dist/agent-sync.js');
  const { nativeObjects } = await import('../dist/native-objects.js');
  let removed = [];
  syncTestHooks.afterWorkspace = () => {
    removed = nativeObjects(store, { action: 'collect-native-objects' }).result.removed;
  };
  t.after(() => {
    delete syncTestHooks.afterWorkspace;
  });
  const command = {
    operationId: randomUUID(),
    laneId: lane.laneId,
    expectedHead: checkpoint.head,
    channel: 'main',
  };
  const result = agentSync(store, command, { target });
  assert.ok(removed.length >= 2, 'collector should encounter the unpublished State and merged blob');
  for (const file of source.state(result.result.head).files) source.object(file.blob);
  assert.deepEqual(agentSync(store, command, { target }).result, result.result);
});

for (const cancel of [false, true])
  test(`pre-spawn contention retains the prepared run and capacity ticket until ${cancel ? 'cancellation' : 'single execution'}`, async t => {
    const agent = fixture(t),
      lane = await start(agent),
      store = agent.work.store,
      root = store.root;
    const executed = join(root, 'executed'),
      ready = join(root, 'spawn-lock-ready'),
      release = join(root, 'spawn-lock-release');
    await agent.dispatch({
      action: 'define-check',
      name: 'verify',
      executable: process.execPath,
      args: ['-e', `require('node:fs').appendFileSync(${JSON.stringify(executed)},'executed\\n')`],
    });
    const view = (
      await agent.dispatch({
        action: 'compose',
        operationId: randomUUID(),
        intentId: lane.intentId,
        inputs: [{ laneId: lane.laneId, head: lane.head }],
      })
    ).result;
    const operationId = randomUUID(),
      original = NativeSource.prototype.materialize;
    let materializations = 0,
      holder;
    NativeSource.prototype.materialize = function (...args) {
      const result = original.apply(this, args);
      if (this.owner !== root || !args[1].includes('/check-')) return result;
      materializations++;
      holder = child(
        t,
        root,
        `store.locked(()=>{fs.writeFileSync(process.argv[2],'ready');const end=Date.now()+15000;while(!fs.existsSync(process.argv[3])&&Date.now()<end)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);if(process.argv[5]==='cancel'){const tx=store.records(),selected=tx.find('runs',process.argv[4]);selected.record.cancelRequested=true;tx.replace('runs',selected.position,selected.record);store.commitRecords(tx);}},{operation:'pre-spawn probe'});`,
        [ready, release, operationId, cancel ? 'cancel' : 'execute'],
      );
      const end = Date.now() + 10000;
      while (!existsSync(ready)) {
        assert.ok(Date.now() < end, 'external holder did not acquire the post-materialization lock');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
      return result;
    };
    t.after(() => {
      NativeSource.prototype.materialize = original;
    });
    const command = { action: 'run', operationId, viewId: view.viewId, wait: false, lockWaitMs: 0 };
    try {
      const pending = (await agent.dispatch(command)).result;
      assert.equal(pending.status, 'preparing');
      const tickets = queueEntries()
        .map(item => item.path)
        .sort();
      assert.equal(tickets.length, 1);
      await delay(250);
      assert.equal(store.select('runs', operationId).status, 'preparing');
      assert.equal(store.select('runs', operationId).childPid, undefined);
      assert.deepEqual(
        queueEntries()
          .map(item => item.path)
          .sort(),
        tickets,
      );
      assert.equal(materializations, 1);
      assert.equal(existsSync(executed), false);
      writeFileSync(release, 'release');
      const released = await holder.done;
      assert.equal(released.code, 0, released.stderr);
      const observed = (await agent.dispatch({ action: 'observe', operationId, waitMs: 60000 })).result;
      assert.equal(observed.status, cancel ? 'cancelled' : 'passed');
      assert.equal(observed.runId, operationId);
      assert.equal(observed.error, undefined);
      assert.equal(materializations, 1);
      assert.equal(store.load().runs.length, 1);
      assert.equal((await agent.dispatch(command)).result.status, observed.status);
      assert.equal(materializations, 1);
      if (cancel) assert.equal(existsSync(executed), false);
      else assert.equal(readFileSync(executed, 'utf8'), 'executed\n');
    } finally {
      NativeSource.prototype.materialize = original;
      if (holder?.proc.exitCode === null) {
        writeFileSync(release, 'release');
        await holder.done;
      }
    }
  });

test('four parallel CLI finishes queue behind an owner writer, report check/landing progress and reconcile', async t => {
  const agent = fixture(t),
    store = agent.work.store,
    root = store.root;
  await agent.dispatch({
    action: 'define-check',
    name: 'verify',
    executable: process.execPath,
    args: [
      '-e',
      `const fs=require('node:fs'),path=require('node:path');const release=path.join(${JSON.stringify(root)},path.basename(path.dirname(process.cwd()))+'-release');const deadline=setTimeout(()=>process.exit(1),60000);const timer=setInterval(()=>{if(fs.existsSync(release)){clearTimeout(deadline);clearInterval(timer);}},20);`,
    ],
  });
  const lanes = [];
  for (let i = 0; i < 4; i++) {
    const lane = await start(agent);
    writeFileSync(join(lane.path, `parallel-${i}.txt`), `${i}\n`);
    lanes.push(lane);
  }
  const ready = join(root, 'parallel-ready'),
    release = join(root, 'parallel-release');
  const holder = child(t, root, hold, [ready, release]);
  await until(() => existsSync(ready));
  const commands = lanes.map(lane => ({
    action: 'finish',
    operationId: randomUUID(),
    actor: 'parallel agent',
    laneId: lane.laneId,
    message: 'parallel finish',
    accept: true,
    maxRetries: 6,
    lockWaitMs: 15000,
  }));
  // Concurrent reads and bounded landing waits can return resumable receipts.
  // Reconcile the original operation and resolved pins, as callers must, while
  // retaining the same completion deadline and all final acceptance assertions.
  const body = `
    const {AgentWorkflow}=await import(${JSON.stringify(new URL('../dist/agent-workflow.js', import.meta.url).href)});
    const assert=(await import('node:assert/strict')).default;
    const agent=new AgentWorkflow(store.root), command=JSON.parse(process.argv[2]);
    const end=Date.now()+60000;
    let reply;
    for (;;) {
      reply=await agent.dispatch({...command,...reply?.result.resolved});
      if(!['source-changed','waiting to land'].includes(reply.result.status))break;
      assert.equal(reply.result.operationId,command.operationId);
      if(reply.result.status==='source-changed')assert.equal(reply.result.code,'SOURCE_CHANGED');
      else {
        assert.equal(reply.result.phase,'accept');
        assert.equal(reply.result.run.status,'passed');
        assert.ok(reply.result.position>=1);
      }
      assert.equal(reply.result.terminal,false);
      assert.equal(reply.result.complete,false);
      assert.ok(Date.now()<end,'finish did not reconcile concurrent Work publications or landing waits');
    }
    console.log(JSON.stringify(reply));
  `;
  const { CheckQueue } = await import('../dist/check-queue.js');
  const capacity = new CheckQueue(undefined, {
    limit: 1,
    identity: { actor: 'capacity holder', phase: 'running check', runId: randomUUID() },
  });
  t.after(() => capacity.release());
  const released = new Set();
  const processes = commands.map(command =>
    child(
      t,
      root,
      body,
      [JSON.stringify(command)],
      { FORGE_WORK_LOCK_WAIT_MS: '15000', FORGE_MAX_CONCURRENT_CHECKS: '1' },
      stderr => {
        // Release each exact check only after its driver reports running,
        // including fresh checks after another finish advances main.
        for (const match of stderr.matchAll(/running check:.*?run=([0-9a-f-]{36})/g)) {
          if (released.has(match[1])) continue;
          released.add(match[1]);
          writeFileSync(join(root, `check-${match[1]}-release`), 'release');
        }
      },
    ),
  );
  await until(() => readdirSync(join(store.directory, 'lock-queue')).length >= 4);
  writeFileSync(release, 'go');
  assert.equal((await holder.done).code, 0);
  try {
    await until(() => {
      try {
        return store.load().runs.filter(run => run.status === 'queued').length === 4;
      } catch (error) {
        if (error.code === 'SOURCE_CHANGED') return false;
        throw error;
      }
    });
    await until(() => processes.every(p => /queued for check:/.test(p.stderr())));
  } finally {
    capacity.release();
  }
  await until(
    () => processes.every(p => p.closed()),
    120000,
    () => processes.map(p => `pid=${p.proc.pid} closed=${p.closed()}\n${p.stderr()}`).join('\n'),
  );
  const replies = await Promise.all(processes.map(p => p.done));
  for (let i = 0; i < replies.length; i++) {
    const reply = replies[i];
    assert.equal(reply.code, 0, reply.stderr);
    const result = JSON.parse(reply.stdout).result;
    assert.equal(result.status, 'accepted', JSON.stringify(result));
    assert.match(reply.stderr, /waiting for lock:.*queue position=\d+.*elapsed=\d+s/);
    assert.match(reply.stderr, /running check:.*run=/);
    for (const line of reply.stderr.split('\n').filter(line => line.startsWith('running check:')))
      assert.equal((line.match(/run=/g) ?? []).length, 1, line);
    assert.match(reply.stderr, /landing:.*run=.*queue position=/);
    assert.doesNotMatch(reply.stderr, /unknown holder|pid undefined/);
    assert.match(reply.stderr, /holder agent|parallel agent|pid \d+/);
    const replay = (await agent.dispatch({ ...commands[i], ...result.resolved })).result;
    // Advisory peers refresh on every dispatch; other finishes may have landed
    // between the original reply and replay. Only the saved receipt is stable.
    const { resolved, peers: _originalPeers, ...canonical } = result;
    const { peers: _replayedPeers, ...replayedReceipt } = replay;
    assert.deepEqual(replayedReceipt, canonical);
  }
  assert.ok(replies.some(reply => /queued for check:.*queue position=[2-9]/.test(reply.stderr)));
  const moves = store.load().channelMoves;
  assert.equal(moves.length, 4);
  const source = new NativeSource(root),
    files = source.state(moves.at(-1).head).files;
  for (let i = 0; i < lanes.length; i++) {
    const file = files.find(file => file.path === `parallel-${i}.txt`);
    assert.ok(file, `accepted main retains Lane ${i}'s file`);
    assert.equal(source.object(file.blob).toString(), `${i}\n`);
  }
});

test('a passed finish resumes a bounded landing wait without repeating its check', async t => {
  const agent = fixture(t),
    root = agent.work.store.root;
  await agent.dispatch({
    action: 'define-check',
    name: 'verify',
    executable: process.execPath,
    args: ['-e', ''],
  });
  const lane = await start(agent);
  writeFileSync(join(lane.path, 'bounded.txt'), 'bounded landing\n');
  const ready = join(root, 'landing-ready'),
    release = join(root, 'landing-release');
  const holder = child(
    t,
    root,
    `const {withLandingSlot}=await import(${JSON.stringify(new URL('../dist/landing-queue.js', import.meta.url).href)});
     await withLandingSlot(store,'main',async()=>{
       fs.writeFileSync(process.argv[2],'ready');
       while(!fs.existsSync(process.argv[3]))await new Promise(resolve=>setTimeout(resolve,20));
     });`,
    [ready, release],
  );
  await until(() => existsSync(ready));
  const command = {
    action: 'finish',
    operationId: randomUUID(),
    laneId: lane.laneId,
    message: 'bounded landing',
    accept: true,
    lockWaitMs: 1000,
  };
  const waiting = (await agent.dispatch(command)).result;
  assert.equal(waiting.status, 'waiting to land', JSON.stringify(waiting));
  assert.equal(waiting.phase, 'accept');
  assert.equal(waiting.terminal, false);
  assert.equal(waiting.complete, false);
  assert.equal(waiting.position, 2);
  assert.equal(waiting.run.status, 'passed');
  assert.equal(agent.work.store.load().channelMoves.length, 0);
  writeFileSync(release, 'release');
  assert.equal((await holder.done).code, 0);
  const resumed = (await agent.dispatch({ ...command, ...waiting.resolved })).result;
  assert.equal(resumed.operationId, command.operationId);
  assert.equal(resumed.status, 'accepted', JSON.stringify(resumed));
  assert.equal(resumed.terminal, true);
  assert.equal(resumed.complete, true);
  assert.equal(resumed.run.runId, waiting.run.runId);
  const data = agent.work.store.load();
  assert.equal(data.runs.length, 1);
  assert.equal(data.channelMoves.length, 1);
  assert.equal(
    new NativeSource(root).state(data.channelMoves[0].head).files.some(file => file.path === 'bounded.txt'),
    true,
  );
});

test('unpublished holder and bounded landing waits never become bare internal failures', async t => {
  const agent = fixture(t),
    store = agent.work.store;
  writeFileSync(join(store.directory, 'lock'), '{unpublished');
  let output = '';
  t.mock.method(process.stderr, 'write', chunk => {
    output += chunk;
    return true;
  });
  assert.throws(
    () => store.locked(() => assert.fail(), { waitMs: 20 }),
    error => error.code === 'WORK_BUSY' && /queue position=1/.test(error.message),
  );
  assert.doesNotMatch(output, /unknown holder/);
  assert.match(output, /holder details not published/);
  rmSync(join(store.directory, 'lock'));
  const { withQueueSlot } = await import('../dist/landing-queue.js');
  const { CheckQueue } = await import('../dist/check-queue.js');
  const queue = join(store.directory, 'bounded-queue'),
    blocker = new CheckQueue(queue, { limit: 1 });
  try {
    const result = await withQueueSlot(queue, () => assert.fail(), { waitMs: 20 });
    assert.equal(result.waiting.position, 2);
  } finally {
    blocker.release();
  }
});
