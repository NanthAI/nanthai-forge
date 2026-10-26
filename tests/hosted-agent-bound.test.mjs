// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentFixture } from './hosted-agent-fixture.mjs';
import { initNative } from '../dist/native-work.js';
import { NativeSource } from '../dist/native-source.js';
import { WorkStore } from '../dist/work-store.js';
import { updateHostState, readHostState } from '../dist/host-binding.js';
import { boundAgentSubmission } from '../dist/hosted-agent-bound.js';
import { ownerDrainBlockers, requireOwnerDrained } from '../dist/hosted-agent-owner-drain.js';
import { transitionBoundSourceAuthority } from '../dist/source-authority-client.js';
import { agentCli } from '../dist/agent-cli.js';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { canonicalPayload } from '../dist/hosted-source-operation.js';
import { hostedRecordSchema } from '../dist/hosted-records.js';
import { ConvexExchange } from '../dist/exchange-client.js';
import { getFunctionName } from 'convex/server';
import { ForgeError } from '../dist/errors.js';

const native = { mode: 'native-owner', epoch: 0 };
const code = c => e => e.code === c;
function fixture(t, mode = 'server') {
  const f = agentFixture(t);
  mkdirSync(f.root);
  initNative(f.root);
  const store = new WorkStore(f.root),
    source = new NativeSource(f.root);
  source.put(f.objects.get(f.lane.head));
  source.materialize(f.lane.head, store.path(f.lane.laneId));
  store.locked(() => {
    const data = store.load();
    data.intents.push({
      id: f.lane.intentId,
      outcome: 'Bound submission',
      constraints: '',
      base: f.lane.head,
      status: 'active',
      notes: [],
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    data.lanes.push({
      id: f.lane.laneId,
      intentId: f.lane.intentId,
      name: 'Bound',
      base: f.lane.head,
      head: f.lane.head,
      assignment: '',
      target: '',
      state: 'active',
      checkpoints: [],
    });
    data.revision++;
    store.save(data);
  });
  updateHostState(store, state => {
    state.binding = {
      projectId: f.address.projectId,
      operationId: randomUUID(),
      deployment: f.address.url,
      projectUrl: 'https://fixture.invalid/project',
      name: 'Fixture',
      visibility: 'private',
      backupId: 'fixture-backup',
      autoSync: false,
      sourceAuthority: mode === 'server' ? f.main.authority : native,
    };
  });
  const command = {
    action: 'finish',
    operationId: randomUUID(),
    laneId: f.lane.laneId,
    message: 'Bound change',
    accept: true,
    wait: false,
  };
  return { ...f, store, source, command };
}
const noNative = () =>
  assert.fail('Hosted submission must not execute native finish/land or wake its worker');
function http(t, f) {
  for (const name of [
    'upload',
    'uploadFile',
    'missing',
    'objects',
    'downloadBatch',
    'downloadToFile',
    'prepareDownloads',
  ])
    t.mock.method(ConvexExchange.prototype, name, (...args) => f.exchange[name](...args));
  const prior = process.env.FORGE_AUTH_TOKEN;
  process.env.FORGE_AUTH_TOKEN = 'synthetic-only';
  t.after(() => {
    if (prior === undefined) delete process.env.FORGE_AUTH_TOKEN;
    else process.env.FORGE_AUTH_TOKEN = prior;
  });
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert(String(url).startsWith(f.address.url));
    const body = JSON.parse(init.body);
    const { makeFunctionReference } = await import('convex/server');
    const value = await f.exchange.client[String(url).endsWith('/api/query') ? 'query' : 'mutation'](
      makeFunctionReference(body.path),
      body.args[0],
    );
    return new Response(JSON.stringify({ status: 'success', value }), {
      headers: { 'content-type': 'application/json' },
    });
  });
}

for (const action of ['finish', 'land'])
  test(`bound ${action} submits through hosted transport with the epoch and immutable replay`, async t => {
    const f = fixture(t),
      command =
        action === 'finish'
          ? f.command
          : { action, operationId: randomUUID(), laneIds: [f.lane.laneId], wait: false };
    const first = await boundAgentSubmission(f.store, command, noNative, f.transport());
    assert.equal(first.result.transport, 'hosted');
    assert.equal(first.result.status, 'queued');
    const queued = f.calls.find(c => c.name === 'projectHostedLanding:enqueue');
    assert.equal(JSON.parse(queued.args.request).authorityEpoch, 1);
    assert.equal(JSON.parse(queued.args.request).operationId, command.operationId);
    const again = await boundAgentSubmission(
      f.store,
      { action, operationId: command.operationId, wait: false },
      noNative,
      f.transport(),
    );
    assert.deepEqual(again.result, first.result);
    assert.equal(f.operations.size, 3, 'one save, compose and submission despite replay');
    assert(!existsSync(join(f.store.directory, 'agent-finish', `${command.operationId}.json`)));
    assert.equal(f.store.load().channelMoves.length, 0);
  });

test('CLI and the workflow used by native MCP route bound finish without explicit hosted addressing', async t => {
  const f = fixture(t);
  http(t, f);
  const first = await agentCli([f.root, 'finish', JSON.stringify(f.command)]);
  assert.equal(first.result.transport, 'hosted');
  const second = await new AgentWorkflow(f.root, true).dispatch({
    action: 'finish',
    operationId: f.command.operationId,
    wait: false,
  });
  assert.deepEqual(second.result, first.result);
});

test('native-owner admission keeps existing behavior and a pending native result blocks transition', async t => {
  const f = fixture(t, 'native-owner');
  const result = await boundAgentSubmission(
    f.store,
    f.command,
    async input => ({
      revision: 1,
      result: { operationId: input.operationId, status: 'checking', terminal: false },
    }),
    f.transport(),
  );
  assert.equal(result.result.status, 'checking');
  assert.equal(f.calls.length, 0, 'native owner needs no hosted transport');
  assert.equal(ownerDrainBlockers(f.store)[0].kind, 'native-submissions');
  let calls = 0;
  await assert.rejects(
    transitionBoundSourceAuthority(
      f.store,
      { operationId: randomUUID(), expected: native, mode: 'server' },
      {
        mutation: async () => {
          calls++;
        },
      },
    ),
    code('SOURCE_AUTHORITY_DRAIN_REQUIRED'),
  );
  assert.equal(calls, 0);
  assert.equal(readHostState(f.store).authorityTransition.mode, 'server');
  await boundAgentSubmission(
    f.store,
    { action: 'finish', operationId: f.command.operationId },
    async () => ({ revision: 1, result: { status: 'failed', terminal: true } }),
    f.transport(),
  );
  assert.deepEqual(ownerDrainBlockers(f.store), []);
});

test('handover retains captured bytes and resumes the same request after authority discovery', async t => {
  const f = fixture(t, 'native-owner');
  updateHostState(f.store, state => {
    state.authorityTransition = {
      projectId: f.address.projectId,
      deployment: f.address.url,
      operationId: randomUUID(),
      expected: native,
      mode: 'server',
    };
  });
  f.caps.authority = native;
  const pending = await boundAgentSubmission(f.store, f.command, noNative, f.transport());
  assert.equal(pending.result.status, 'pending-handover');
  writeFileSync(join(f.store.path(f.lane.laneId), 'later.txt'), 'newer draft must stay out\n');
  f.caps.authority = f.main.authority;
  const resumed = await boundAgentSubmission(
    f.store,
    { action: 'finish', operationId: f.command.operationId, wait: false },
    noNative,
    f.transport(),
  );
  assert.equal(resumed.result.status, 'queued');
  const captured = join(f.store.directory, 'hosted-inputs', f.command.operationId, f.lane.laneId);
  assert(!existsSync(join(captured, 'later.txt')));
  assert.equal(
    readFileSync(join(f.store.path(f.lane.laneId), 'later.txt'), 'utf8'),
    'newer draft must stay out\n',
  );
});

test('unknown enqueue response and caller reconnect preserve the original operation and request hash', async t => {
  const f = fixture(t);
  f.lose('projectHostedLanding:enqueue');
  await assert.rejects(
    boundAgentSubmission(f.store, f.command, noNative, f.transport()),
    code('HOSTED_ACTION_FAILED'),
  );
  const first = f.calls.filter(c => c.name === 'projectHostedLanding:enqueue').at(-1).args;
  await boundAgentSubmission(
    new WorkStore(f.root),
    { action: 'finish', operationId: f.command.operationId, wait: false },
    noNative,
    f.transport(),
  );
  assert.deepEqual(f.calls.filter(c => c.name === 'projectHostedLanding:enqueue').at(-1).args, first);
  await assert.rejects(
    boundAgentSubmission(f.store, { ...f.command, message: 'different' }, noNative, f.transport()),
    code('WORK_OPERATION_CHANGED'),
  );
});

test('check-only finish does not request landing; keepOpen is pinned on accepting finish', async t => {
  const f = fixture(t);
  const checked = await boundAgentSubmission(
    f.store,
    { ...f.command, accept: undefined },
    noNative,
    f.transport(),
  );
  assert.equal(checked.result.status, 'checking');
  assert(!f.calls.some(c => c.name === 'projectHostedLanding:enqueue'));
  await boundAgentSubmission(
    f.store,
    { ...f.command, operationId: randomUUID(), keepOpen: true },
    noNative,
    f.transport(),
  );
  assert.equal(
    JSON.parse(f.calls.find(c => c.name === 'projectHostedLanding:enqueue').args.request).keepOpen,
    true,
  );
});

test('owner drain includes journal-only waits, unsettled batches and missing acceptance receipts', t => {
  const f = fixture(t, 'native-owner');
  for (const [kind, value] of [
    [
      'agent-finish',
      { command: { accept: true }, attempts: [], result: { status: 'awaiting-review', terminal: false } },
    ],
    ['agent-land', { entries: [{ result: { status: 'waiting' } }] }],
  ]) {
    mkdirSync(join(f.store.directory, kind));
    writeFileSync(join(f.store.directory, kind, `${randomUUID()}.json`), JSON.stringify(value));
  }
  assert.deepEqual(
    ownerDrainBlockers(f.store)
      .map(b => b.kind)
      .sort(),
    ['agent-finish', 'agent-land'],
  );
  assert.throws(() => requireOwnerDrained(f.store), code('SOURCE_AUTHORITY_DRAIN_REQUIRED'));
});

test('saved land excludes dirty bytes and an automatically addressed finish reuses its operation', async t => {
  const f = fixture(t);
  writeFileSync(join(f.store.path(f.lane.laneId), 'draft.txt'), 'leave this draft local\n');
  const command = { action: 'land', laneIds: [f.lane.laneId], wait: false };
  const first = await boundAgentSubmission(f.store, command, noNative, f.transport());
  const again = await boundAgentSubmission(f.store, command, noNative, f.transport());
  assert.equal(again.result.operationId, first.result.operationId);
  assert(
    !existsSync(
      join(f.store.directory, 'hosted-inputs', first.result.operationId, f.lane.laneId, 'draft.txt'),
    ),
  );
  assert.equal(
    readFileSync(join(f.store.path(f.lane.laneId), 'draft.txt'), 'utf8'),
    'leave this draft local\n',
  );
});

test('a newer hosted Lane is never overwritten and its terminal failure survives reconnect', async t => {
  const f = fixture(t);
  f.lane.head = 'f'.repeat(64);
  const failed = await boundAgentSubmission(f.store, f.command, noNative, f.transport());
  assert.equal(failed.result.status, 'terminal-failed');
  assert.equal(failed.result.code, 'LANE_STALE');
  assert(
    !f.calls.some(c => c.name === 'projectHostedSaves:prepare' || c.name === 'projectHostedLanding:enqueue'),
  );
  const replay = await boundAgentSubmission(
    f.store,
    { action: 'finish', operationId: f.command.operationId },
    noNative,
    f.transport(),
  );
  assert.deepEqual(replay.result, failed.result);
});

test('a held queue driver reloads already captured input instead of recapturing on concurrent replay', async t => {
  const f = fixture(t);
  const [one, two] = await Promise.all([
    boundAgentSubmission(f.store, f.command, noNative, f.transport()),
    boundAgentSubmission(f.store, f.command, noNative, f.transport()),
  ]);
  assert.deepEqual(one.result, two.result);
  assert.equal(f.operations.size, 3);
});

test('hosted source staleness is retained as a source-specific terminal outcome, not WORK_STALE', async t => {
  const f = fixture(t),
    mutate = f.exchange.client.mutation;
  f.exchange.client.mutation = (ref, args) => {
    if (getFunctionName(ref) === 'projectHostedCompose:stage')
      throw new ForgeError('WORK_STALE', 'Selected source changed.');
    return mutate(ref, args);
  };
  const failed = await boundAgentSubmission(f.store, f.command, noNative, f.transport());
  assert.equal(failed.result.code, 'LANE_STALE');
  assert.equal(failed.result.terminal, true);
  assert(!f.calls.some(c => c.name === 'projectHostedLanding:enqueue'));
});

test('synchronous bound finish observes hosted versions; timeout is pending and reconnect receives landing', async t => {
  const f = fixture(t),
    query = f.exchange.client.query;
  let landed = false,
    state;
  f.exchange.client.query = async (ref, args) => {
    if (getFunctionName(ref) === 'projectHostedFinishObserve:page') {
      const queued = f.operations.get(args.operationId);
      state ??= {
        schema: 1,
        projectId: f.address.projectId,
        id: queued.id,
        operationId: args.operationId,
        actor: 'owner',
        at: '2026-01-01T00:00:00.000Z',
        request: queued.request,
        sequence: 1,
        version: 0,
        firstAttemptId: randomUUID(),
        attemptId: randomUUID(),
        phase: 'queued',
        observation: { state: 'pending', pendingReason: 'queued', cause: null },
        error: null,
      };
      if (landed)
        state = {
          ...state,
          phase: 'landed',
          version: 1,
          observation: { state: 'landed', pendingReason: null, cause: null },
          acceptance: { receiptId: randomUUID(), head: f.main.head },
        };
      return JSON.stringify({
        projectId: f.address.projectId,
        operationId: args.operationId,
        authority: f.main.authority,
        submission: state,
        pendingAttempt: null,
        events: [],
        nextVersion: state.version,
        isDone: true,
        resnapshot: false,
      });
    }
    if (getFunctionName(ref) === 'projectHostedFinish:inputs')
      return JSON.stringify({
        entries: landed
          ? [
              {
                submissionId: state.id,
                operationId: state.operationId,
                laneId: f.lane.laneId,
                attemptId: state.attemptId,
                terminal: true,
                complete: true,
              },
            ]
          : [],
        staged: landed,
        nextIndex: null,
      });
    return query(ref, args);
  };
  const first = await boundAgentSubmission(
    f.store,
    { ...f.command, wait: true, waitMs: 0 },
    noNative,
    f.transport(),
  );
  assert.equal(first.result.status, 'timeout');
  assert.equal(first.result.terminal, false);
  landed = true;
  const second = await boundAgentSubmission(
    new WorkStore(f.root),
    { action: 'finish', operationId: f.command.operationId, wait: true, waitMs: 0 },
    noNative,
    f.transport(),
  );
  assert.equal(second.result.terminal, true);
  assert.equal(second.result.complete, true);
});

test('async reconnect returns an existing hosted landing receipt rather than reporting it queued again', async t => {
  const f = fixture(t);
  await boundAgentSubmission(f.store, f.command, noNative, f.transport());
  const submission = f.operations.get(f.command.operationId);
  submission.phase = 'landed';
  submission.observation = { state: 'landed' };
  const replay = await boundAgentSubmission(
    f.store,
    { action: 'finish', operationId: f.command.operationId, wait: false },
    noNative,
    f.transport(),
  );
  assert.equal(replay.result.status, 'landed');
  assert.equal(replay.result.complete, true);
  assert.equal(replay.result.terminal, true);
});

test('a declared native dependency remains pending rather than being omitted at routing', async t => {
  const f = fixture(t),
    parentId = randomUUID();
  f.store.locked(() => {
    const data = f.store.load();
    data.intents.push({ ...data.intents[0], id: parentId });
    data.revision++;
    f.store.save(data);
  });
  const waiting = await boundAgentSubmission(
    f.store,
    { ...f.command, after: { intentId: parentId } },
    noNative,
    f.transport(),
  );
  assert.equal(waiting.result.phase, 'dependency');
  assert.equal(waiting.result.terminal, false);
  assert(!f.calls.some(c => c.name === 'projectHostedLanding:enqueue'));
});

test('terminal native receipts survive an authority switch and optional receipt fields remain JSON compatible', async t => {
  const f = fixture(t, 'native-owner');
  const result = await boundAgentSubmission(
    f.store,
    f.command,
    async () => ({
      revision: 1,
      result: { status: 'accepted', complete: true, acceptance: { id: 'retained', optional: undefined } },
    }),
    f.transport(),
  );
  assert.equal(result.result.complete, true);
  updateHostState(f.store, state => {
    state.binding.sourceAuthority = f.main.authority;
  });
  const replay = await boundAgentSubmission(
    f.store,
    { action: 'finish', operationId: f.command.operationId },
    noNative,
    f.transport(),
  );
  assert.equal(replay.result.acceptance.id, 'retained');
  assert.equal(f.calls.length, 0);
});

test('drain reconciles an admission whose driver saved a terminal receipt before losing its reply', async t => {
  const f = fixture(t, 'native-owner');
  await assert.rejects(
    boundAgentSubmission(
      f.store,
      f.command,
      async () => {
        mkdirSync(join(f.store.directory, 'agent-finish'));
        writeFileSync(
          join(f.store.directory, 'agent-finish', `${f.command.operationId}.json`),
          JSON.stringify({ command: f.command, result: { terminal: true, status: 'failed' } }),
        );
        throw new Error('synthetic caller loss after durable terminal result');
      },
      f.transport(),
    ),
    /synthetic caller loss/,
  );
  assert.deepEqual(ownerDrainBlockers(f.store), []);
});

test('reconnect never redirects a retained operation to a changed hosted binding', async t => {
  const f = fixture(t);
  await boundAgentSubmission(f.store, f.command, noNative, f.transport());
  updateHostState(f.store, state => {
    state.binding.projectId = 'different-project';
  });
  const before = f.calls.length;
  await assert.rejects(
    boundAgentSubmission(
      f.store,
      { action: 'finish', operationId: f.command.operationId },
      noNative,
      f.transport(),
    ),
    code('WORK_OPERATION_CHANGED'),
  );
  assert.equal(f.calls.length, before);
});
