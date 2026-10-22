// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { agentWait, waitText } from '../dist/agent-wait.js';
import { registerAgentWorkflow } from '../dist/mcp-agent-workflow.js';
import { initNative } from '../dist/native-work.js';
import { drainPostAccept } from '../dist/post-accept-main.js';
import { FinishJournal } from '../dist/agent-finish-journal.js';
import { checkEnvironment } from '../dist/check-environment.js';
import { CoordinationJournal } from '../dist/agent-coordination-journal.js';
import { trustAgents } from './autonomy-fixture.mjs';
const exec = promisify(execFile);
async function fixture(t, exitCode = 0) {
  const root = mkdtempSync(join(tmpdir(), 'forge-wait-'));
  writeFileSync(join(root, 'file.txt'), 'base\n');
  initNative(root);
  trustAgents(root);
  const agent = new AgentWorkflow(root),
    store = agent.work.store;
  const gate = join(store.directory, 'gate');
  await agent.dispatch({
    action: 'define-check',
    name: 'verify',
    executable: process.execPath,
    args: [
      '-e',
      `const f=require('fs'); const timer=setInterval(()=>{if(f.existsSync(${JSON.stringify(gate)})){clearInterval(timer);process.exit(${exitCode});}},20);`,
    ],
  });
  const lane = (await agent.dispatch({ action: 'start', outcome: 'Synthetic wait' })).result;
  writeFileSync(join(lane.path, 'file.txt'), 'changed\n');
  const save = (
    await agent.dispatch({ action: 'checkpoint', laneId: lane.laneId, message: 'Synthetic change' })
  ).result;
  lane.head = save.head;
  const view = (
    await agent.dispatch({
      action: 'compose',
      operationId: randomUUID(),
      intentId: lane.intentId,
      inputs: [{ laneId: lane.laneId, head: lane.head }],
      dependencies: [],
    })
  ).result;
  t.after(async () => {
    writeFileSync(gate, 'release');
    if (store.load().channelMoves.some(move => move.postAccept)) await drainPostAccept(store);
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  });
  return { root, agent, store, lane, gate, view };
}
function waiting(store, input, onEvent = () => {}) {
  const events = [];
  return {
    events,
    done: agentWait(store, { timeoutSeconds: 15, ...input }, event => {
      events.push(event);
      onEvent(event);
    }),
  };
}

test('Lane and parent land stream checking through landed, with no post-terminal events', async t => {
  const { agent, store, lane, gate } = await fixture(t);
  const operationId = randomUUID();
  const wait = waiting(store, { laneIds: [lane.laneId], operationIds: [operationId] }, event => {
    if (event.type === 'check') writeFileSync(gate, 'release');
  });
  const landed = await agent.dispatch({ action: 'land', operationId, laneIds: [lane.laneId] });
  assert.equal(landed.result.complete, true);
  const summary = await wait.done;
  assert.equal(summary.exitCode, 0);
  assert.ok(wait.events.some(e => e.type === 'lane' && e.status === 'checking'));
  assert.ok(wait.events.some(e => e.type === 'operation' && e.id === operationId && e.status === 'landed'));
  assert.equal(wait.events.at(-1).type, 'summary');
  const count = wait.events.length;
  writeFileSync(join(store.directory, 'unrelated'), 'later');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(wait.events.length, count);
});

test('failed local check returns reason and retained log paths without a Work lock', async t => {
  const { agent, store, lane, gate } = await fixture(t, 1);
  const runId = randomUUID();
  await agent.dispatch({ action: 'run', operationId: runId, laneId: lane.laneId, wait: false });
  writeFileSync(gate, 'release');
  const wait = waiting(store, { operationIds: [runId] });
  const summary = await wait.done;
  assert.equal(summary.exitCode, 0);
  assert.equal(summary.successful, false);
  const failed = summary.targets[0];
  assert.equal(failed.status, 'failed');
  assert.equal(failed.failureClass, 'check');
  assert.ok(failed.reason);
  assert.equal(existsSync(failed.logPath), true);
  mkdirSync(join(store.directory, 'lock'));
  try {
    assert.equal((await agentWait(store, { operationIds: [runId], timeoutSeconds: 0 })).exitCode, 0);
  } finally {
    rmSync(join(store.directory, 'lock'), { recursive: true, force: true });
  }
});

test('any-change ignores baseline and watches a Lane update', async t => {
  const { agent, store, lane } = await fixture(t);
  const wait = waiting(store, { laneIds: [lane.laneId], until: 'any-change' });
  await agent.dispatch({ action: 'complete', laneId: lane.laneId });
  const result = await wait.done;
  assert.equal(result.exitCode, 0);
  assert.ok(['terminal', 'changed'].includes(result.status));
  assert.equal(wait.events.filter(e => e.type === 'lane').length, 2);
});

test('timeout includes all pending targets; initial state alone is not any-change', async t => {
  const { store, lane } = await fixture(t);
  const operationId = randomUUID();
  const wait = waiting(store, {
    laneIds: [lane.laneId, lane.laneId],
    operationIds: [operationId],
    until: 'any-change',
    timeoutSeconds: 0.05,
  });
  const result = await wait.done;
  assert.equal(result.exitCode, 2);
  assert.equal(result.status, 'timeout');
  assert.equal(result.targets.length, 2);
  assert.equal(result.targets[1].status, 'unknown');
});

test('cancellation cleans watchers and leaves the Lane unchanged', async t => {
  const { store, lane } = await fixture(t);
  const controller = new AbortController();
  const before = store.pointer();
  const promise = agentWait(store, { laneIds: [lane.laneId] }, () => {}, controller.signal);
  controller.abort();
  assert.equal((await promise).exitCode, 130);
  assert.deepEqual(store.pointer(), before);
});

async function retainedRun(t) {
  const f = await fixture(t);
  const view = f.view;
  const data = f.store.load(),
    check = data.checks[0];
  const dead = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' }).pid;
  const run = {
    id: randomUUID(),
    viewId: view.viewId,
    head: view.head,
    base: view.base,
    inputs: [{ laneId: f.lane.laneId, head: f.lane.head }],
    dependencies: [],
    check,
    environment: checkEnvironment(),
    status: 'running',
    startedAt: new Date().toISOString(),
    runner: { pid: dead, host: hostname() },
    details: 'Synthetic run',
  };
  data.runs.push(run);
  f.store.save(data);
  return { ...f, run };
}

test('dead local runner is infrastructure interruption, without mutation or restart', async t => {
  const { store, run } = await retainedRun(t);
  const pointer = store.pointer();
  const result = await agentWait(store, { operationIds: [run.id] });
  assert.equal(result.exitCode, 0);
  assert.equal(result.successful, false);
  assert.equal(result.targets[0].status, 'interrupted');
  assert.equal(result.targets[0].failureClass, 'infrastructure');
  assert.deepEqual(store.pointer(), pointer);
});

test('durable receipt wins over dead runner and reports failing shard path and progress', async t => {
  const { store, run } = await retainedRun(t);
  const path = join(store.directory, `check-${run.id}`);
  mkdirSync(path);
  writeFileSync(
    join(path, 'result.json'),
    JSON.stringify({
      status: 'failed',
      endedAt: new Date().toISOString(),
      details: 'Synthetic assertion failed',
      exitCode: 1,
    }),
  );
  writeFileSync(join(path, 'modal-plan.json'), JSON.stringify({ groups: [['tests/synthetic.test.mjs']] }));
  writeFileSync(
    join(path, 'modal-shard-logs.json'),
    JSON.stringify([{ executionId: 'synthetic-static', index: 1, attempt: 0, exitCode: 1 }]),
  );
  const events = [];
  const result = await agentWait(store, { operationIds: [run.id] }, e => events.push(e));
  assert.equal(result.targets[0].failureClass, 'check');
  assert.deepEqual(result.targets[0].failingShardLogPaths, [join(path, 'shards', 'static.log')]);
  assert.ok(events.some(e => e.type === 'shard' && e.status === 'failed'));
  assert.deepEqual(result.targets[0].shards, { started: 1, completed: 1 });
});

test('remote controller loss stays pending and does not adopt a remote execution', async t => {
  const { store, run } = await retainedRun(t);
  const data = store.load();
  data.runs[0].backend = { requested: 'modal', actual: 'modal' };
  store.save(data);
  const pointer = store.pointer();
  const result = await agentWait(store, { operationIds: [run.id], timeoutSeconds: 0.02 });
  assert.equal(result.status, 'timeout');
  assert.deepEqual(store.pointer(), pointer);
});

test('parent finish journal observes terminal infrastructure outcome', async t => {
  const { store, lane, run } = await retainedRun(t);
  const id = randomUUID();
  const check = store.load().checks[0];
  const journal = new FinishJournal(
    store,
    {
      action: 'finish',
      operationId: id,
      laneId: lane.laneId,
      expectedHead: lane.head,
      message: 'Synthetic',
      dependencies: [],
      checkId: check.id,
      expectedDefinition: check.definition,
    },
    lane.head,
  );
  journal.state.attempts[0].operations.run = run.id;
  journal.save();
  const result = await agentWait(store, { operationIds: [id] });
  assert.equal(result.targets[0].status, 'interrupted');
  assert.equal(result.targets[0].failureClass, 'infrastructure');
});

test('recorded overlap notices are streamed, including one physical line in text mode', async t => {
  const { store, lane } = await fixture(t);
  new CoordinationJournal(store).record([
    {
      noticeId: 'a'.repeat(64),
      kind: 'conflict-notice',
      granularity: 'file',
      participants: [{ lane: lane.laneId }],
      proposedOrder: [lane.laneId],
      reason: 'Synthetic\noverlap',
      choices: ['split'],
      conflicts: [{ path: 'file.txt', kind: 'text' }],
    },
  ]);
  const events = [];
  await agentWait(store, { laneIds: [lane.laneId], timeoutSeconds: 0 }, e => events.push(e));
  const notice = events.find(e => e.type === 'notice');
  assert.ok(notice);
  assert.equal(waitText(notice).split('\n').length, 1);
});

test('CLI streams JSON and --text, returns timeout status, and rejects empty selection', async t => {
  const { root, lane } = await fixture(t);
  const cli = resolve('dist/cli.js');
  for (const text of [false, true]) {
    await assert.rejects(
      exec(
        process.execPath,
        [
          cli,
          'agent',
          root,
          'wait',
          JSON.stringify({ laneIds: [lane.laneId], timeoutSeconds: 0 }),
          ...(text ? ['--text'] : []),
        ],
        { env: { ...process.env } },
      ),
      error => {
        assert.equal(error.code, 2);
        const lines = error.stdout.trim().split('\n');
        assert.equal(lines.length, 2);
        if (text) assert.match(lines[0], /^lane /);
        else assert.equal(JSON.parse(lines[1]).type, 'summary');
        return true;
      },
    );
  }
  await assert.rejects(agentWait(new AgentWorkflow(root).work.store, {}), { code: 'BAD_ARGUMENT' });
});

test('MCP exposes forge_wait and live progress notifications with cancellation', async t => {
  const { root, lane } = await fixture(t);
  const tools = new Map();
  registerAgentWorkflow(
    {
      registerTool(name, definition, handler) {
        tools.set(name, { definition, handler });
      },
    },
    root,
  );
  const tool = tools.get('forge_wait');
  assert.ok(tool);
  assert.equal(tool.definition.annotations.readOnlyHint, true);
  const controller = new AbortController(),
    notifications = [];
  const result = await tool.handler(
    { laneIds: [lane.laneId], timeoutSeconds: 0 },
    {
      signal: controller.signal,
      _meta: { progressToken: 'fixture' },
      async sendNotification(n) {
        notifications.push(n);
      },
    },
  );
  assert.equal(result.isError, true);
  assert.equal(notifications.length, 2);
  assert.equal(JSON.parse(notifications[0].params.message).type, 'lane');
  assert.equal(JSON.parse(result.content[0].text.split('\n').at(-1)).status, 'timeout');
});

test('settled Lane stays frozen while another target is pending', async t => {
  const { agent, store, lane } = await fixture(t);
  await agent.dispatch({ action: 'complete', laneId: lane.laneId });
  const controller = new AbortController(),
    events = [];
  const promise = agentWait(
    store,
    { laneIds: [lane.laneId], operationIds: [randomUUID()] },
    e => events.push(e),
    controller.signal,
  );
  await agent.dispatch({ action: 'reopen', laneId: lane.laneId });
  controller.abort();
  const summary = await promise;
  assert.equal(summary.targets[0].status, 'completed');
  assert.equal(events.filter(e => e.type === 'lane').length, 1);
});

test('live shard progress wakes any-change without changing Work metadata', async t => {
  const { store, run } = await retainedRun(t);
  const data = store.load();
  data.runs[0].runner = { pid: process.pid, host: hostname() };
  store.save(data);
  const path = join(store.directory, `check-${run.id}`);
  mkdirSync(path);
  writeFileSync(join(path, 'stdout.log'), '');
  const before = store.pointer();
  const wait = waiting(store, { operationIds: [run.id], until: 'any-change' });
  writeFileSync(join(path, 'stdout.log'), '[modal 1] Completed shard 0 (exit 0)\n');
  const summary = await wait.done;
  assert.equal(summary.status, 'changed');
  assert.ok(wait.events.some(e => e.type === 'progress' && e.reason === 'Completed shard 0 (exit 0)'));
  assert.deepEqual(store.pointer(), before);
});
