import { trustAgents } from './autonomy-fixture.mjs';
// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { CheckQueue, queueEntries } from '../dist/check-queue.js';
import { diskGuard } from '../dist/disk-guard.js';
import { processIdentity } from '../dist/local-process.js';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { initNative } from '../dist/native-work.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) {
  const end = Date.now() + 10000;
  while (!fn()) {
    assert.ok(Date.now() < end, 'Timed out waiting for fixture');
    await sleep(50);
  }
}
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'forge-local-reliability-'));
  const previous = { ...process.env };
  process.env.FORGE_CHECK_QUEUE_DIR = join(root, 'queue');
  process.env.FORGE_MAX_CONCURRENT_CHECKS = '1';
  delete process.env.FORGE_DISK_WARN_GB;
  delete process.env.FORGE_DISK_BLOCK_GB;
  t.after(() => {
    for (const key of [
      'FORGE_CHECK_QUEUE_DIR',
      'FORGE_MAX_CONCURRENT_CHECKS',
      'FORGE_DISK_WARN_GB',
      'FORGE_DISK_BLOCK_GB',
    ]) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}
function child(t, script, environment = {}) {
  const proc = spawn(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, ...environment },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let errors = '';
  proc.stderr.on('data', chunk => {
    errors += chunk;
  });
  const messages = [];
  proc.on('message', value => messages.push(value));
  t.after(() => {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
  });
  return { proc, messages, errors: () => errors };
}
const queueModule = new URL('../dist/check-queue.js', import.meta.url).href;
const processModule = new URL('../dist/local-process.js', import.meta.url).href;
const agentModule = new URL('../dist/agent-workflow.js', import.meta.url).href;
function holder(t, group = false) {
  return child(
    t,
    `
    import { CheckQueue } from ${JSON.stringify(queueModule)};
    import { processIdentity } from ${JSON.stringify(processModule)};
    import { spawn } from 'node:child_process';
    const queue = new CheckQueue();
    process.send({state:'queued'});
    const poll = setInterval(() => {
      if (!queue.tryAcquire()) return;
      clearInterval(poll);
      ${group ? `const child = spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});queue.child(child.pid,processIdentity(child.pid).startTime);process.send({state:'acquired',pid:child.pid});` : `process.send({state:'acquired'});`}
    }, 50);
    process.on('message', () => { queue.release(); process.send({state:'released'}); process.exit(); });
  `,
  );
}

test('machine queue enforces one slot across processes, then admits the next ticket', async t => {
  fixture(t);
  const a = holder(t);
  await until(() => a.messages.some(m => m.state === 'acquired'));
  const b = holder(t);
  await until(() => b.messages.some(m => m.state === 'queued'));
  await sleep(300);
  assert.equal(
    b.messages.some(m => m.state === 'acquired'),
    false,
    b.errors(),
  );
  a.proc.send('release');
  await until(() => b.messages.some(m => m.state === 'acquired'));
  b.proc.send('release');
  await once(b.proc, 'exit');
});

test('a crashed holder is reclaimed, while an orphaned process group retains capacity', async t => {
  fixture(t);
  const a = holder(t);
  await until(() => a.messages.some(m => m.state === 'acquired'));
  const next = new CheckQueue();
  assert.equal(next.tryAcquire(), false);
  a.proc.kill('SIGKILL');
  await once(a.proc, 'exit');
  assert.equal(next.tryAcquire(), true);
  next.release();
  if (process.platform === 'win32') return;
  const orphan = holder(t, true);
  await until(() => orphan.messages.some(m => m.state === 'acquired'));
  const pid = orphan.messages.find(m => m.state === 'acquired').pid;
  t.after(() => {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {}
  });
  orphan.proc.kill('SIGKILL');
  await once(orphan.proc, 'exit');
  const queued = new CheckQueue();
  assert.equal(queued.tryAcquire(), false);
  process.kill(-pid, 'SIGKILL');
  await until(() => queued.tryAcquire());
  queued.release();
});

async function candidate(t, script = 'process.exit(0)') {
  const parent = fixture(t),
    root = join(parent, 'owner');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(root);
  writeFileSync(join(root, 'a.txt'), 'source');
  initNative(root);
  trustAgents(root);
  const agent = new AgentWorkflow(root);
  const lane = (await agent.dispatch({ action: 'start', outcome: 'Reliability fixture' })).result;
  const view = (
    await agent.dispatch({
      action: 'compose',
      operationId: randomUUID(),
      intentId: lane.intentId,
      inputs: [{ laneId: lane.laneId, head: lane.head }],
    })
  ).result;
  const check = (
    await agent.dispatch({
      action: 'define-check',
      name: 'Fixture',
      executable: process.execPath,
      args: ['-e', script],
    })
  ).result;
  const command = {
    action: 'run',
    operationId: randomUUID(),
    viewId: view.viewId,
    expectedHead: view.head,
    checkId: check.checkId,
    wait: false,
  };
  return { root, parent, agent, lane, view, check, command };
}

test('queued run receipts, cancellation and original-id replay do not materialize or execute', async t => {
  const s = await candidate(t, 'throw new Error("Queued run must not execute")');
  const blocker = new CheckQueue();
  t.after(() => blocker.release());
  const run = (await s.agent.dispatch(s.command)).result;
  assert.equal(run.status, 'queued');
  assert.equal(
    (await s.agent.dispatch({ action: 'observe', operationId: run.runId })).result.status,
    'queued',
  );
  assert.equal(existsSync(join(s.agent.work.store.directory, `check-${run.runId}`, 'workspace')), false);
  await s.agent.dispatch({ action: 'cancel', operationId: run.runId });
  await until(() => s.agent.work.store.select('runs', run.runId).status === 'cancelled');
  assert.equal((await s.agent.dispatch(s.command)).result.status, 'cancelled');
  assert.equal(existsSync(join(s.agent.work.store.directory, `check-${run.runId}`, 'workspace')), false);
  assert.equal(queueEntries().length, 1);
});

test('another live runner is preserved; dead runner and reused PID are interrupted and never repeated', async t => {
  const s = await candidate(t, 'setInterval(()=>{},1000)');
  const runner = child(
    t,
    `import { AgentWorkflow } from ${JSON.stringify(agentModule)};const a=new AgentWorkflow(${JSON.stringify(s.root)});process.send((await a.dispatch(${JSON.stringify(s.command)})).result);setInterval(()=>{},1000);`,
    { TZ: 'Pacific/Honolulu' },
  );
  await until(() => runner.messages.length > 0);
  const id = s.command.operationId;
  const saved = s.agent.work.store.select('runs', id);
  t.after(() => {
    try {
      process.kill(process.platform === 'win32' ? saved.childPid : -saved.childPid, 'SIGKILL');
    } catch {}
  });
  assert.equal(saved.runner.pid, runner.proc.pid);
  assert.ok(saved.runner.startTime);
  assert.equal((await s.agent.dispatch({ action: 'observe', operationId: id })).result.status, 'running');
  assert.equal((await s.agent.dispatch({ action: 'status' })).result.runs.items[0].status, 'running');
  runner.proc.kill('SIGKILL');
  await once(runner.proc, 'exit');
  const dead = (await s.agent.dispatch({ action: 'observe', operationId: id })).result;
  assert.equal(dead.status, 'interrupted');
  assert.match(dead.diagnostic, /Runner process ended/);
  assert.equal((await s.agent.dispatch(s.command)).result.status, 'interrupted');
  const store = s.agent.work.store;
  store.locked(() => {
    const data = store.load();
    data.runs[0].status = 'running';
    delete data.runs[0].endedAt;
    data.runs[0].runner = { ...data.runs[0].runner, ...processIdentity(), startTime: 'reused PID identity' };
    data.revision++;
    store.save(data);
  });
  // A dry run must not reconcile Work; applying cleanup still reconciles dead runners.
  const beforeClean = store.pointer();
  await s.agent.dispatch({ action: 'clean', kinds: ['check-workspaces'] });
  assert.ok(store.pointer().equals(beforeClean));
  assert.equal(store.select('runs', id).status, 'running');
  await s.agent.dispatch({ action: 'clean', kinds: ['check-workspaces'], apply: true });
  assert.equal(store.select('runs', id).status, 'interrupted');
});

test('disk guard probes owner free space, warns at 5 GB, refuses below 2 GB, and never deletes', t => {
  const root = fixture(t);
  writeFileSync(join(root, 'keep.txt'), 'retained');
  let probed;
  const probe = bytes => owner => {
    probed = owner;
    return bytes;
  };
  assert.deepEqual(diskGuard(root, probe(6e9)), []);
  assert.equal(probed, root);
  assert.match(diskGuard(root, probe(5e9))[0], /5.00 GB free/);
  assert.equal(diskGuard(root, probe(2e9)).length, 1);
  assert.throws(
    () => diskGuard(root, probe(2e9 - 1)),
    e => e.code === 'DISK_LOW' && /clean \(dry run\)/.test(e.message),
  );
  process.env.FORGE_DISK_WARN_GB = '8';
  process.env.FORGE_DISK_BLOCK_GB = '3';
  assert.equal(diskGuard(root, probe(7e9)).length, 1);
  assert.throws(
    () => diskGuard(root, probe(2.5e9)),
    e => e.code === 'DISK_LOW',
  );
  assert.equal(readFileSync(join(root, 'keep.txt'), 'utf8'), 'retained');
});

test('disk refusal reaches Lane start and check registration; warnings appear in receipts', async t => {
  const s = await candidate(t);
  process.env.FORGE_DISK_BLOCK_GB = String(Number.MAX_SAFE_INTEGER);
  await assert.rejects(s.agent.dispatch({ action: 'start', outcome: 'No disk' }), e => e.code === 'DISK_LOW');
  await assert.rejects(s.agent.dispatch(s.command), e => e.code === 'DISK_LOW');
  assert.equal(s.agent.work.store.select('runs', s.command.operationId), undefined);
  process.env.FORGE_DISK_BLOCK_GB = '0';
  process.env.FORGE_DISK_WARN_GB = String(Number.MAX_SAFE_INTEGER);
  const lane = (await s.agent.dispatch({ action: 'start', outcome: 'Warn' })).result;
  assert.match(lane.warnings[0], /free on the owner filesystem/);
  const run = (await s.agent.dispatch({ ...s.command, wait: true })).result;
  assert.equal(run.status, 'passed');
  assert.ok(run.warnings.length);
});

test('actual checks from different owners/processes share the queue', async t => {
  const s = await candidate(t, 'setInterval(()=>{},1000)');
  const first = child(
    t,
    `import { AgentWorkflow } from ${JSON.stringify(agentModule)};const a=new AgentWorkflow(${JSON.stringify(s.root)});process.send((await a.dispatch(${JSON.stringify(s.command)})).result);setInterval(()=>{},1000);`,
  );
  await until(() => first.messages.length > 0);
  const otherRoot = join(s.parent, 'other-owner');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(otherRoot);
  writeFileSync(join(otherRoot, 'a.txt'), 'other source');
  initNative(otherRoot);
  const other = new AgentWorkflow(otherRoot);
  const lane = (await other.dispatch({ action: 'start', outcome: 'Second owner' })).result;
  const view = (
    await other.dispatch({
      action: 'compose',
      operationId: randomUUID(),
      intentId: lane.intentId,
      inputs: [{ laneId: lane.laneId, head: lane.head }],
    })
  ).result;
  const check = (
    await other.dispatch({
      action: 'define-check',
      name: 'Quick',
      executable: process.execPath,
      args: ['-e', 'process.exit(0)'],
    })
  ).result;
  const command = {
    action: 'run',
    operationId: randomUUID(),
    viewId: view.viewId,
    expectedHead: view.head,
    checkId: check.checkId,
    wait: false,
  };
  const second = child(
    t,
    `import { AgentWorkflow } from ${JSON.stringify(agentModule)};const a=new AgentWorkflow(${JSON.stringify(otherRoot)});process.send((await a.dispatch(${JSON.stringify(command)})).result);setInterval(()=>{},1000);`,
  );
  await until(() => second.messages.length > 0);
  assert.equal(second.messages[0].status, 'queued');
  assert.equal(
    existsSync(join(other.work.store.directory, `check-${command.operationId}`, 'workspace')),
    false,
  );
  await s.agent.dispatch({ action: 'cancel', operationId: s.command.operationId });
  await until(() => {
    try {
      return other.work.store.select('runs', command.operationId).status === 'passed';
    } catch (error) {
      // The child atomically replaces the Work manifest as it finishes. An
      // observation overlapping that replacement asks its caller to retry.
      if (error.code === 'SOURCE_CHANGED') return false;
      throw error;
    }
  });
  assert.equal(s.agent.work.store.select('runs', s.command.operationId).status, 'cancelled');
});

test('bounded finish returns a queued receipt and replays the original operation after admission', async t => {
  const s = await candidate(t);
  const blocker = new CheckQueue();
  t.after(() => blocker.release());
  const command = {
    action: 'finish',
    operationId: randomUUID(),
    laneId: s.lane.laneId,
    message: 'Queued finish',
    checkId: s.check.checkId,
    expectedDefinition: s.check.definition,
    waitMs: 0,
    accept: true,
  };
  const pending = (await s.agent.dispatch(command)).result;
  assert.equal(pending.status, 'queued');
  assert.equal(pending.terminal, false);
  assert.equal(pending.acceptance, null);
  const before = Date.now();
  await sleep(300);
  blocker.release();
  await until(() => s.agent.work.store.select('runs', pending.run.runId).status === 'passed');
  const saved = s.agent.work.store.select('runs', pending.run.runId);
  assert.ok(Date.parse(saved.startedAt) > before);
  const accepted = (await s.agent.dispatch(command)).result;
  assert.equal(accepted.status, 'accepted');
  assert.equal(accepted.run.runId, pending.run.runId);
  assert.equal(s.agent.work.store.load().runs.length, 1);
});

test('disk drop during queueing records DISK_LOW without materializing the check workspace', async t => {
  const s = await candidate(t);
  const blocker = new CheckQueue();
  t.after(() => blocker.release());
  const queued = (await s.agent.dispatch(s.command)).result;
  process.env.FORGE_DISK_BLOCK_GB = String(Number.MAX_SAFE_INTEGER);
  blocker.release();
  await until(() => s.agent.work.store.select('runs', queued.runId).status === 'failed');
  const result = (await s.agent.dispatch({ action: 'observe', operationId: queued.runId })).result;
  assert.equal(result.error.code, 'DISK_LOW');
  assert.match(result.error.message, /clean \(dry run\)/);
  assert.equal(existsSync(join(s.agent.work.store.directory, `check-${queued.runId}`, 'workspace')), false);
});

test('DISK_LOW after materialization retains files and never starts the selected command', async t => {
  const s = await candidate(t, 'throw new Error("Must not execute after DISK_LOW")');
  const { NativeSource } = await import('../dist/native-source.js');
  const materialize = NativeSource.prototype.materialize;
  NativeSource.prototype.materialize = function (...args) {
    materialize.apply(this, args);
    process.env.FORGE_DISK_BLOCK_GB = String(Number.MAX_SAFE_INTEGER);
  };
  t.after(() => {
    NativeSource.prototype.materialize = materialize;
  });
  const run = (await s.agent.dispatch({ ...s.command, wait: true })).result;
  assert.equal(run.status, 'failed');
  assert.equal(run.error.code, 'DISK_LOW');
  const path = join(s.agent.work.store.directory, `check-${run.runId}`, 'workspace');
  assert.equal(readFileSync(join(path, 'a.txt'), 'utf8'), 'source');
  assert.equal(s.agent.work.store.select('runs', run.runId).childPid, undefined);
  const clean = (await s.agent.dispatch({ action: 'clean', kinds: ['check-workspaces'] })).result;
  assert.equal(clean.mode, 'dry-run');
  assert.ok(clean.candidates[0].items.some(item => item.path === path));
  assert.equal(existsSync(path), true);
});

test('cancellation racing queue admission prevents materialization', async t => {
  const s = await candidate(t, 'throw new Error("Must not execute")');
  const blocker = new CheckQueue();
  t.after(() => blocker.release());
  const run = (await s.agent.dispatch(s.command)).result;
  const store = s.agent.work.store,
    locked = store.locked.bind(store);
  let raced = false;
  store.locked = fn =>
    locked(() => {
      // Model a peer cancellation committed between the queue poll and admission lock.
      if (!raced) {
        const tx = store.records(),
          found = tx.find('runs', run.runId);
        if (found?.record.status === 'queued') {
          found.record.cancelRequested = true;
          tx.replace('runs', found.position, found.record);
          store.commitRecords(tx);
          raced = true;
        }
      }
      return fn();
    });
  t.after(() => {
    store.locked = locked;
  });
  blocker.release();
  await until(() => store.select('runs', run.runId).status === 'cancelled');
  assert.equal(raced, true);
  assert.equal(existsSync(join(store.directory, `check-${run.runId}`, 'workspace')), false);
});

test('indexed native Lane mutations warn/refuse, while other source materialization stays available', async t => {
  const s = await candidate(t);
  const command = { action: 'lane', intentId: s.lane.intentId, name: 'Direct Work Lane' };
  const before = s.agent.work.store.load().lanes.length;
  process.env.FORGE_DISK_BLOCK_GB = String(Number.MAX_SAFE_INTEGER);
  assert.throws(
    () => s.agent.work.execute(command, s.agent.work.store.revision()),
    e => e.code === 'DISK_LOW',
  );
  assert.equal(s.agent.work.store.load().lanes.length, before);
  const { NativeSource } = await import('../dist/native-source.js');
  const source = new NativeSource(s.root),
    restored = join(s.parent, 'source-copy');
  source.materialize(s.lane.head, restored, false);
  assert.equal(readFileSync(join(restored, 'a.txt'), 'utf8'), 'source');
  process.env.FORGE_DISK_BLOCK_GB = '0';
  process.env.FORGE_DISK_WARN_GB = String(Number.MAX_SAFE_INTEGER);
  const result = s.agent.work.execute(command, s.agent.work.store.revision()).result;
  assert.match(result.warnings[0], /free on the owner filesystem/);
});
