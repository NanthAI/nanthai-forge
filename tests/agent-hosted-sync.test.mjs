// SPDX-License-Identifier: Apache-2.0
import { trustAgents } from './autonomy-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { getFunctionName } from 'convex/server';
import { convexToJson, jsonToConvex } from 'convex/values';
import { initNative } from '../dist/native-work.js';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { readHostState, updateHostState } from '../dist/host-binding.js';
import { queueAgentSync, flushAgentSync } from '../dist/agent-hosted-sync.js';
import { CheckQueue } from '../dist/check-queue.js';
import { hostCli } from '../dist/host-cli.js';
import { coordinationRequestSchema } from '../dist/coordination-types.js';
import { state } from './hosted-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { HOSTED_WORK_INDEX_FORMAT } from '../dist/work-hosted-summary.js';
const sync = await import(moduleUrl('../convex/projectOwnerSync.ts'));
const coordination = await import(moduleUrl('../convex/projectCoordination.ts'));
const index = await import(moduleUrl('../convex/projectWorkIndex.ts'));

function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), 'forge-agent-sync-')),
    root = join(directory, 'owner');
  mkdirSync(root);
  writeFileSync(join(root, 'hello.txt'), 'one\n');
  initNative(root);
  const workflow = new AgentWorkflow(root);
  // Keep detached transport out of synthetic-client tests; explicit flushes own delivery.
  const sender = new CheckQueue(join(workflow.work.store.directory, 'hosted-agent-sync-spawn'), {
    limit: 1,
    anchor: workflow.work.store.directory,
  });
  assert.equal(sender.tryAcquire(), true);
  t.after(() => sender.release());
  const oldConfig = process.env.XDG_CONFIG_HOME,
    oldToken = process.env.FORGE_AUTH_TOKEN,
    oldName = process.env.FORGE_AGENT_NAME;
  process.env.XDG_CONFIG_HOME = join(directory, 'config');
  delete process.env.FORGE_AUTH_TOKEN;
  process.env.FORGE_AGENT_NAME = 'gpt-b5-fixture';
  t.after(() => {
    for (const [key, value] of [
      ['XDG_CONFIG_HOME', oldConfig],
      ['FORGE_AUTH_TOKEN', oldToken],
      ['FORGE_AGENT_NAME', oldName],
    ])
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  });
  return { root, workflow, store: workflow.work.store };
}
function bind(store, deployment = 'http://127.0.0.1:1') {
  updateHostState(store, state => {
    state.binding = {
      operationId: randomUUID(),
      projectId: 'project',
      deployment,
      projectUrl: 'https://example.invalid/project',
      backupId: 'backup',
      name: 'Synthetic',
      visibility: 'private',
    };
  });
}
function hosted() {
  const s = state([]);
  s.tables.hostedProjects.set('project', {
    _id: 'project',
    owner: 'owner',
    name: 'Synthetic',
    visibility: 'private',
    work: { generationId: 'generation', backupId: 'backup', revision: 0 },
  });
  s.tables.projectWorkGenerations.set('generation', {
    _id: 'generation',
    projectId: 'project',
    backupId: 'backup',
    format: HOSTED_WORK_INDEX_FORMAT,
    status: 'ready',
    revision: 0,
    initialRevision: 0,
    metadata: JSON.stringify({ counts: {} }),
  });
  s.tables.projectBackups.set('backup', { _id: 'backup', projectId: 'project', status: 'stored' });
  return s;
}
const rows = (s, collection) =>
  [...s.tables.projectWorkRecords.values()]
    .filter(row => row.collection === collection)
    .map(row => JSON.parse(row.value));

test('bound lifecycle publishes named sessions and incremental metadata; offline and unknown replies replay original UUIDs', async t => {
  const { root, workflow, store } = setup(t),
    s = hosted(),
    calls = [];
  let offline = true,
    loseReply = true;
  const client = {
    mutation: async (ref, args) => {
      const name = getFunctionName(ref);
      calls.push({ name, args: structuredClone(args) });
      if (offline) throw new Error('offline');
      const response =
        name === 'projectCoordination:publish'
          ? await coordination.publish._handler(s.ctx, args)
          : await sync.publish._handler(s.ctx, args);
      if (loseReply) {
        loseReply = false;
        throw new Error('reply lost');
      }
      return response;
    },
  };
  bind(store);
  const start = await workflow.dispatch({ action: 'start', outcome: 'Synthetic presence task' });
  assert.equal(start.result.startedBy.name, 'gpt-b5-fixture');
  assert.equal(start.result.hostedSync.sourcePush, 'explicit');
  const first = structuredClone(readHostState(store).agentSync.pending[0]);
  await flushAgentSync(store, client);
  assert.equal(readHostState(store).agentSync.pending[0].operationId, first.operationId);
  offline = false;
  updateHostState(store, state => {
    state.agentSync.nextAttemptAt = 0;
  });
  await flushAgentSync(store, client); // server committed the activity but reply was lost
  updateHostState(store, state => {
    state.agentSync.nextAttemptAt = 0;
  });
  await flushAgentSync(store, client);
  assert.equal(readHostState(store).agentSync.pending.length, 0);
  assert.equal(s.tables.projectCoordinationEvents.size, 1);
  assert.equal(rows(s, 'lanes')[0].checkpointCount, 0);
  assert.equal(rows(s, 'intents')[0].status, 'active');
  assert.equal([...s.tables.projectCoordinationSessions.values()][0].name, 'gpt-b5-fixture');
  const session = [...s.tables.projectCoordinationSessions.values()][0].sessionId;
  writeFileSync(join(start.result.path, 'hello.txt'), 'two\n');
  const saved = await workflow.dispatch({
    action: 'checkpoint',
    laneId: start.result.laneId,
    message: 'Save two',
  });
  await flushAgentSync(store, client);
  assert.equal(rows(s, 'lanes')[0].checkpointCount, 1);
  const activity = [...s.tables.projectCoordinationSessions.values()][0];
  assert.equal(activity.sessionId, session);
  assert.deepEqual(activity.context.paths, ['hello.txt']);
  assert.equal(activity.context.head, saved.result.head);
  assert.ok(activity.sequence > first.activity.sequence);
  await workflow.dispatch({ action: 'complete', laneId: start.result.laneId });
  await flushAgentSync(store, client);
  assert.equal(rows(s, 'lanes')[0].state, 'completed');
  assert.equal([...s.tables.projectCoordinationSessions.values()][0].status, 'completed');
  assert.ok(
    calls.every(call => ['projectCoordination:publish', 'projectOwnerSync:publish'].includes(call.name)),
  );
  assert.ok(
    calls
      .filter(call => call.name === 'projectCoordination:publish')
      .slice(0, 3)
      .every(call => call.args.operationId === first.operationId),
  );
  assert.equal(s.tables.projectBackups.size, 1);
  assert.equal(s.tables.projectWorkEvents.size, 0);
  assert.ok(root);
});

test('no binding and opt-out preserve local commands; actor overrides and unchanged replay do not duplicate queued updates', async t => {
  const { root, workflow, store } = setup(t);
  const first = await workflow.dispatch({ action: 'start', outcome: 'Unbound' });
  assert.equal(first.result.hostedSync, undefined);
  bind(store);
  await hostCli([root, '--no-auto-sync']);
  await workflow.dispatch({ action: 'complete', laneId: first.result.laneId });
  assert.equal(readHostState(store).agentSync, undefined);
  await hostCli([root, '--auto-sync']);
  const request = { action: 'start', operationId: randomUUID(), outcome: 'Bound', actor: 'gpt-u4' };
  const started = await workflow.dispatch(request);
  const pending = readHostState(store).agentSync.pending;
  assert.equal(pending[0].activity.name, 'gpt-u4');
  await workflow.dispatch(request);
  assert.equal(readHostState(store).agentSync.pending.length, 1);
  queueAgentSync(store, { action: 'finish', laneId: started.result.laneId }, {}, true);
  assert.equal(readHostState(store).agentSync.pending.at(-1).activity.status, 'working');
});

test('presence lock contention only reports hosted deferral for an enabled binding', async t => {
  const { workflow, store } = setup(t);
  const lane = (await workflow.dispatch({ action: 'start', outcome: 'Presence contention' })).result;
  const locked = store.locked.bind(store);
  const contend = expected => {
    store.locked = () => {
      throw new Error('Synthetic owner lock contention');
    };
    try {
      assert.deepEqual(queueAgentSync(store, { action: 'checkpoint', laneId: lane.laneId }, {}), expected);
    } finally {
      store.locked = locked;
    }
  };
  contend(undefined);
  bind(store);
  contend({ status: 'deferred', sourcePush: 'explicit' });
  updateHostState(store, state => {
    state.binding.autoSync = false;
  });
  contend(undefined);
});

test('owner metadata checks current authority, preserves hosted notes, ignores older revisions and rejects changed retries', async () => {
  const s = hosted(),
    ownerId = randomUUID();
  const ids = new Map();
  const request = revision => ({
    projectId: 'project',
    operationId: ids.get(revision) ?? (ids.set(revision, randomUUID()), ids.get(revision)),
    metadata: JSON.stringify({
      ownerId,
      revision,
      entries: [
        {
          collection: 'intents',
          key: 'intent',
          parent: '',
          value: { id: 'intent', status: revision === 1 ? 'active' : 'completed' },
        },
      ],
    }),
  });
  await sync.publish._handler(s.ctx, request(2));
  const row = [...s.tables.projectWorkRecords.values()].find(row => row.collection === 'intents');
  row.value = JSON.stringify({
    ...JSON.parse(row.value),
    notes: [{ text: 'hosted note' }],
    outcome: 'Hosted title',
  });
  await sync.publish._handler(s.ctx, request(1));
  assert.equal(rows(s, 'intents')[0].status, 'completed');
  await sync.publish._handler(s.ctx, request(3));
  assert.equal(rows(s, 'intents')[0].outcome, 'Hosted title');
  assert.deepEqual(rows(s, 'intents')[0].notes, [{ text: 'hosted note' }]);
  const changed = request(3);
  changed.metadata = changed.metadata.replace('completed', 'active');
  await assert.rejects(
    sync.publish._handler(s.ctx, changed),
    error => error.data.code === 'WORK_OPERATION_CHANGED',
  );
  for (const caller of [undefined, 'other']) {
    s.caller(caller);
    await assert.rejects(sync.publish._handler(s.ctx, request(4)));
  }
  s.caller('owner');
  s.tables.hostedProjects.get('project').removal = 'trash';
  await assert.rejects(sync.publish._handler(s.ctx, request(4)));
});

test('fake Convex HTTP endpoint receives queued metadata and presence with saved operation pins', async t => {
  const { workflow, store } = setup(t),
    calls = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body);
    calls.push({ path: payload.path, args: jsonToConvex(payload.args[0]) });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ status: 'success', value: convexToJson(null) }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  bind(store, `http://127.0.0.1:${server.address().port}`);
  const started = await workflow.dispatch({
    action: 'start',
    // forge-path-fixture: synthetic
    outcome: 'HTTP sync /Users/synthetic/private/.forge/work/lane-fixture',
    actor: 'gpt-http',
  });
  // The spawned worker inherited no credential; the explicit replay uses a synthetic login.
  process.env.FORGE_AUTH_TOKEN = 'synthetic-owner-jwt';
  updateHostState(store, state => {
    state.agentSync.nextAttemptAt = 0;
  });
  await flushAgentSync(store);
  assert.deepEqual(
    calls.map(call => call.path),
    ['projectCoordination:publish', 'projectOwnerSync:publish'],
  );
  assert.equal(calls[0].args.command.context.laneId, started.result.laneId);
  assert.equal(calls[0].args.command.name, 'gpt-http');
  assert.doesNotMatch(JSON.stringify(calls), /Users\/synthetic|\.forge\/work\/lane-fixture/);
  assert.equal(readHostState(store).binding.deployment, `http://127.0.0.1:${server.address().port}`);
  assert.equal(readHostState(store).agentSync.pending.length, 0);
});

test('publish activity and message context defaults to an empty object', () => {
  const activity = coordinationRequestSchema.parse({
    action: 'publish',
    operationId: randomUUID(),
    command: {
      kind: 'activity',
      sessionId: randomUUID(),
      sequence: 1,
      name: 'Test',
      environment: 'Local',
      status: 'working',
      summary: '',
    },
  });
  assert.deepEqual(activity.command.context, {});
  const message = coordinationRequestSchema.parse({
    action: 'publish',
    operationId: randomUUID(),
    command: { kind: 'message', text: 'hello' },
  });
  assert.deepEqual(message.command.context, {});
});

test('finish queues working during checks; separate accept publishes main and completed metadata without source transfer', async t => {
  const { root, workflow, store } = setup(t),
    s = hosted(),
    activities = [];
  trustAgents(root);
  bind(store);
  updateHostState(store, state => {
    state.binding.acceptanceOwner = true;
  });
  await workflow.dispatch({
    action: 'define-check',
    name: 'verify',
    executable: process.execPath,
    args: ['-e', 'process.exit(0)'],
  });
  const lane = (await workflow.dispatch({ action: 'start', outcome: 'Land synthetic change' })).result;
  writeFileSync(join(lane.path, 'hello.txt'), 'landed\n');
  const finished = (
    await workflow.dispatch({ action: 'finish', laneId: lane.laneId, message: 'Land fixture' })
  ).result;
  assert.equal(finished.complete, true);
  assert.equal(finished.acceptance, null);
  const accepted = (await workflow.dispatch({ action: 'accept', viewId: finished.view.viewId })).result;
  const client = {
    mutation: async (ref, args) => {
      if (getFunctionName(ref) === 'projectCoordination:publish') {
        activities.push(args.command);
        return coordination.publish._handler(s.ctx, args);
      }
      return sync.publish._handler(s.ctx, args);
    },
  };
  await flushAgentSync(store, client);
  assert.equal(readHostState(store).agentSync.pending.length, 0);
  assert.equal(activities.length, 1); // Unsent snapshots for this session coalesce to acceptance.
  assert.equal(activities.at(-1).status, 'completed');
  assert.equal(rows(s, 'channels')[0].head, accepted.head);
  assert.equal(rows(s, 'channelMoves')[0].id, accepted.acceptanceId);
  assert.equal(rows(s, 'lanes')[0].state, 'completed');
  assert.equal(rows(s, 'intents')[0].status, 'completed');
  assert.equal(s.tables.projectBackups.size, 1);
  assert.equal(s.tables.projectWorkEvents.size, 0);
});

test('metadata transport failure retains the newest session snapshot with backoff', async t => {
  const { workflow, store } = setup(t);
  bind(store);
  const lane = (await workflow.dispatch({ action: 'start', outcome: 'Metadata offline' })).result;
  await workflow.dispatch({ action: 'complete', laneId: lane.laneId });
  const activity = [];
  await flushAgentSync(store, {
    mutation: async (ref, args) => {
      if (getFunctionName(ref) === 'projectOwnerSync:publish') throw new Error('not deployed yet');
      activity.push(args.command);
      return null;
    },
  });
  assert.equal(activity.at(-1).status, 'completed');
  assert.equal(readHostState(store).agentSync.pending.length, 1);
  assert.ok(readHostState(store).agentSync.nextAttemptAt > Date.now());
});

test('delayed delivery preserves real activity time and heartbeat does not turn an old edit into new work', async t => {
  const { workflow, store } = setup(t),
    s = hosted();
  t.mock.timers.enable({ apis: ['Date'], now: 10_000_000 });
  bind(store);
  const lane = (await workflow.dispatch({ action: 'start', outcome: 'Delayed synthetic presence' })).result;
  const original = Date.now();
  t.mock.timers.tick(91 * 60_000);
  await flushAgentSync(store, {
    mutation: (ref, args) =>
      getFunctionName(ref) === 'projectCoordination:publish'
        ? coordination.publish._handler(s.ctx, args)
        : sync.publish._handler(s.ctx, args),
  });
  const row = [...s.tables.projectCoordinationSessions.values()][0];
  assert.equal(row.lastActivity, original);
  assert.equal(row.lastSeen, Date.now());
  t.mock.timers.tick(30_000);
  await coordination.touch._handler(s.ctx, { projectId: 'project', sessionId: row.sessionId });
  assert.equal(row.lastActivity, original);
  await coordination.touch._handler(s.ctx, {
    projectId: 'project',
    sessionId: row.sessionId,
    activityKind: 'MCP call',
  });
  assert.equal(row.lastActivity, Date.now());
  assert.equal(row.activityKind, 'MCP call');
  queueAgentSync(store, { action: 'checkpoint', laneId: lane.laneId }, {}, false, 'edited files');
  const queued = readHostState(store).agentSync.pending.length;
  queueAgentSync(store, { action: 'checkpoint', laneId: lane.laneId }, {}, false, 'edited files');
  assert.equal(readHostState(store).agentSync.pending.length, queued);
  t.mock.timers.tick(60_000);
  queueAgentSync(store, { action: 'checkpoint', laneId: lane.laneId }, {}, false, 'edited files');
  assert.equal(readHostState(store).agentSync.pending.length, queued);
  assert.equal(readHostState(store).agentSync.pending.at(-1).activity.activityAt, Date.now());
});

test('abandon queues closed Lane/Intent metadata and completes presence; opt-out remains authoritative', async t => {
  const { workflow, store, root } = setup(t),
    s = hosted();
  bind(store);
  const client = {
    mutation: (ref, args) =>
      getFunctionName(ref) === 'projectCoordination:publish'
        ? coordination.publish._handler(s.ctx, args)
        : sync.publish._handler(s.ctx, args),
  };
  const lane = (await workflow.dispatch({ action: 'start', outcome: 'Superseded approach' })).result;
  await flushAgentSync(store, client);
  const command = {
    action: 'abandon',
    laneId: lane.laneId,
    reason: 'Superseded by main',
    operationId: randomUUID(),
  };
  const abandoned = await workflow.dispatch(command);
  assert.equal(abandoned.result.hostedSync.sourcePush, 'explicit');
  await flushAgentSync(store, client);
  assert.equal(rows(s, 'lanes')[0].state, 'abandoned');
  assert.equal([...s.tables.projectCoordinationSessions.values()][0].status, 'completed');
  await workflow.dispatch({ action: 'abandon', intentId: lane.intentId, reason: 'Superseded by main' });
  await flushAgentSync(store, client);
  assert.equal(rows(s, 'intents')[0].status, 'abandoned');
  await workflow.dispatch(command);
  assert.equal(readHostState(store).agentSync.pending.length, 0);
  await hostCli([root, '--no-auto-sync']);
  const other = (await workflow.dispatch({ action: 'start', outcome: 'Opted out' })).result;
  await workflow.dispatch({ action: 'abandon', laneId: other.laneId, reason: 'Superseded' });
  assert.equal(readHostState(store).agentSync.pending.length, 0);
});

test('owner publication metadata reaches hosted GitHub status with retry and authority checks', async () => {
  const s = hosted(),
    operationId = randomUUID();
  const metadata = JSON.stringify({
    ownerId: randomUUID(),
    revision: 1,
    entries: [
      {
        collection: 'githubSync',
        key: 'github',
        parent: '',
        value: {
          id: 'github',
          repository: 'example/project',
          branch: 'main',
          commits: [{ commit: 'a'.repeat(40), state: 'b'.repeat(64) }],
          pushed: 1,
          pushedAt: '2026-10-16T00:00:00Z',
        },
      },
    ],
  });
  await sync.publish._handler(s.ctx, { projectId: 'project', operationId, metadata });
  await sync.publish._handler(s.ctx, { projectId: 'project', operationId, metadata });
  assert.equal(rows(s, 'githubSync').length, 1);
  assert.equal(rows(s, 'githubSync')[0].repository, 'example/project');
  s.ctx.auth.getUserIdentity = async () => null;
  await assert.rejects(sync.publish._handler(s.ctx, { projectId: 'project', operationId, metadata }));
});
