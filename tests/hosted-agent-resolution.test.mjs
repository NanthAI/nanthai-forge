// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolutionFixture } from './hosted-agent-resolution-fixture.mjs';
import { waitHostedAgentSource } from '../dist/hosted-agent-source-wait.js';
import { registerHostedAgentWorkflow } from '../dist/mcp-hosted-agent.js';
import { agentFixture } from './hosted-agent-fixture.mjs';

test('incident replay: two Lanes change the same lines, one lands, the other finishes, edits, resolves and lands without a fake edit', async t => {
  const s = await resolutionFixture(t, { overlap: true }),
    f = s.f;
  const peer = await f.c.lane(
    f.c.state([f.c.file('a.txt', 'peer\nb\nc\n'), f.c.hidden], [f.c.baseline.sha256]),
  );
  const first = await f.landOriginal();
  assert(first.id);
  await s.transport().dispatch('open', { laneId: peer.laneId });
  const command = { laneId: peer.laneId, accept: true };
  const result = await s.transport().dispatch('finish', command);
  assert.equal(result.result.phase, 'conflict');
  const conflict = result.result.recovery.conflict;
  assert.deepEqual(conflict.paths, ['a.txt']);
  assert.match(conflict.command, / resolve /);
  assert.match(conflict.files[0].content, /<<<<<<< lane/);
  assert.equal((await f.readLane(peer.laneId)).head, peer.head, 'original Lane remains intact');
  writeFileSync(join(conflict.root, 'a.txt'), 'chosen\nb\nc\n');
  // An already-saved edit must still complete resolution with no fake edit.
  await s
    .transport(conflict.root)
    .dispatch('save', { operationId: randomUUID(), message: 'Save chosen bytes' });
  const resolve = { ...conflict.next };
  delete resolve.action;
  const tools = new Map();
  t.after(
    registerHostedAgentWorkflow(
      {
        registerTool(name, _config, call) {
          tools.set(name, call);
        },
      },
      s.transport(conflict.root),
    ),
  );
  const response = await tools.get('forge_task')(
    { command: { action: 'resolve', ...resolve } },
    { signal: new AbortController().signal },
  );
  assert(!response.isError, response.content[0].text);
  const fixed = JSON.parse(response.content[0].text);
  assert.equal(fixed.result.source.outcome.result.status, 'resolved');
  assert.equal(readFileSync(join(conflict.root, 'a.txt'), 'utf8'), 'chosen\nb\nc\n');
  const finish = { ...fixed.result.next };
  delete finish.action;
  const submitted = await s.transport(conflict.root).dispatch('finish', finish);
  await f.drain();
  await f.passChecks();
  await f.drain();
  assert.equal((await f.current(submitted.result.submission.id)).submission.phase, 'landed');
  assert.equal(f.text(f.currentMain().head, 'a.txt'), 'chosen\nb\nc\n');
  assert.equal(f.text(f.currentMain().head, 'selected.txt'), 'selected\n');
  const writes = s.calls
    .filter(call => call.name === 'projectHostedSync:prepare')
    .map(call => JSON.parse(call.args.request));
  assert.equal(writes.filter(request => request.kind === 'resolve').length, 1);
});

test('sync conflicts return the exact editing root and resolve command, and unresolved markers retain their draft', async t => {
  const s = await resolutionFixture(t, { overlap: true }),
    f = s.f;
  f.moveMain({ overlap: true });
  await s.transport().dispatch('open', { laneId: f.lane.laneId });
  const synced = await s.transport().dispatch('sync', { laneId: f.lane.laneId });
  const conflict = synced.result.conflict;
  assert.deepEqual(conflict.paths, ['a.txt']);
  assert(conflict.command.includes(conflict.laneId));
  await assert.rejects(
    s.transport(conflict.root).dispatch('resolve', { laneId: conflict.laneId, operationId: randomUUID() }),
    { code: 'CONFLICT_MARKERS' },
  );
  assert.equal((await f.readLane(conflict.laneId)).resolution.status, 'pending');
  assert.match(readFileSync(join(conflict.root, 'a.txt'), 'utf8'), /<<<<<<< lane/);
});

test('resolve rejects unsupported servers before writing or leaking private input', async t => {
  const s = agentFixture(t);
  s.caps.actions = s.caps.actions.filter(action => action !== 'resolve');
  await assert.rejects(s.transport().dispatch('resolve', { laneId: s.lane.laneId }), {
    code: 'HOSTED_ACTION_UNSUPPORTED',
  });
  assert.deepEqual(
    s.calls.map(call => call.name),
    ['projectHostedAgent:capabilities'],
  );
});

test('an active source wait subscribes once to the exact operation and closes on terminal or abort', async t => {
  const s = agentFixture(t),
    id = randomUUID();
  let subscriptions = 0,
    closed = 0,
    unsubscribed = 0;
  const subscribe = () => ({
    onUpdate(_ref, args, update) {
      subscriptions++;
      assert.equal(args.operationId, id);
      queueMicrotask(() =>
        update(JSON.stringify({ terminal: { outcome: { status: 'completed', result: 'exact' } } })),
      );
      return () => unsubscribed++;
    },
    async close() {
      closed++;
    },
  });
  const value = await waitHostedAgentSource(s.address, id, { status: 'submitted' }, undefined, subscribe);
  assert.equal(value.outcome.result, 'exact');
  assert.deepEqual([subscriptions, unsubscribed, closed], [1, 1, 1]);
  const controller = new AbortController();
  const waiting = waitHostedAgentSource(s.address, id, { status: 'submitted' }, controller.signal, () => ({
    onUpdate: () => () => unsubscribed++,
    close: async () => {
      closed++;
    },
  }));
  controller.abort();
  assert.deepEqual(await waiting, { status: 'submitted' });
  assert.deepEqual([unsubscribed, closed], [2, 2]);
});

test('resolving a composed selection preserves the unmerged Lane suffix', async t => {
  const s = await resolutionFixture(t, { overlap: true }),
    f = s.f;
  const suffix = await f.c.lane(
    f.c.state([f.c.baseFile, f.c.hidden, f.c.file('suffix.txt', 'keep me\n')], [f.c.baseline.sha256]),
  );
  f.moveMain({ overlap: true });
  const conflict = (
    await s.transport().dispatch('finish', { inputs: [{ laneId: f.lane.laneId }, { laneId: suffix.laneId }] })
  ).result.recovery.conflict;
  writeFileSync(join(conflict.root, 'a.txt'), 'both\nb\nc\n');
  const fixed = await s.transport(conflict.root).dispatch('resolve', { laneId: conflict.laneId });
  assert.equal(fixed.result.next.inputs.length, 3);
  const { action, ...finish } = fixed.result.next;
  assert.equal(action, 'finish');
  const submitted = await s.transport(conflict.root).dispatch(action, finish);
  await f.drain();
  await f.passChecks();
  await f.drain();
  assert.equal((await f.current(submitted.result.submission.id)).submission.phase, 'landed');
  assert.equal(f.text(f.currentMain().head, 'suffix.txt'), 'keep me\n');
});

test('resolution prefixes original dependencies before continuing the selected input suffix', async t => {
  const s = await resolutionFixture(t, { overlap: true }),
    f = s.f;
  const suffix = await f.c.lane(
    f.c.state(
      [f.c.baseFile, f.c.hidden, f.c.file('suffix.txt', 'keep dependency suffix\n')],
      [f.c.baseline.sha256],
    ),
  );
  const dependency = { candidateId: f.candidate.id, head: f.candidate.result.head };
  f.moveMain({ overlap: true });
  const conflict = (
    await s
      .transport()
      .dispatch('finish', { inputs: [{ laneId: suffix.laneId }], dependencies: [dependency] })
  ).result.recovery.conflict;
  writeFileSync(join(conflict.root, 'a.txt'), 'both\nb\nc\n');
  const fixed = await s.transport(conflict.root).dispatch('resolve', { laneId: conflict.laneId });
  assert.equal(fixed.result.next.dependencies.length, 2);
  assert.deepEqual(fixed.result.next.dependencies[1], dependency);
  const { action, ...finish } = fixed.result.next;
  const submitted = await s.transport(conflict.root).dispatch(action, finish);
  await f.drain();
  await f.passChecks();
  await f.drain();
  assert.equal((await f.current(submitted.result.submission.id)).submission.phase, 'landed');
  assert.equal(f.text(f.currentMain().head, 'suffix.txt'), 'keep dependency suffix\n');
});

test('lost conflict-recovery reply reuses the exact sibling and preserves subsequent edits; cached source rechecks access', async t => {
  const s = await resolutionFixture(t, { overlap: true }),
    f = s.f;
  f.moveMain({ overlap: true });
  const command = { laneId: f.lane.laneId };
  s.lose('projectHostedSyncJobs:submit');
  await assert.rejects(s.transport().dispatch('finish', command), { code: 'HOSTED_ACTION_FAILED' });
  const recovered = await s.transport().dispatch('finish', command),
    conflict = recovered.result.recovery.conflict;
  writeFileSync(join(conflict.root, 'a.txt'), 'do not overwrite\n');
  const replay = await s.transport().dispatch('finish', command);
  assert.equal(replay.result.recovery.conflict.laneId, conflict.laneId);
  assert.equal(readFileSync(join(conflict.root, 'a.txt'), 'utf8'), 'do not overwrite\n');
  const syncs = s.calls
    .filter(call => call.name === 'projectHostedSync:prepare')
    .map(call => call.args.request);
  assert.equal(new Set(syncs).size, 1);
  f.patch('hostedProjects', f.projectId, { removal: 'deleted' });
  await assert.rejects(s.transport().dispatch('finish', command), { code: 'PROJECT_UNAVAILABLE' });
});

test('new discovery falls back to the notice-only and legacy argument shapes without advertising resolve', async t => {
  for (const notices of [true, false]) {
    const s = agentFixture(t),
      original = s.exchange.client.query,
      attempts = [];
    s.caps.actions = s.caps.actions.filter(action => action !== 'resolve');
    s.exchange.client.query = async (ref, args) => {
      attempts.push(args);
      if (args.resolveVersion !== undefined || (!notices && args.noticeVersion !== undefined))
        throw new Error('ArgumentValidationError: legacy argument shape');
      return original(ref, args);
    };
    const result = await s.transport().dispatch('capabilities', {});
    assert(!result.result.actions.includes('resolve'));
    assert.equal(attempts.length, notices ? 2 : 3);
    assert.equal(attempts[0].resolveVersion, 1);
    assert.equal(attempts.at(-1).resolveVersion, undefined);
  }
});

test('resolve pins its own save receipt and refuses a concurrent newer source version', async t => {
  const s = await resolutionFixture(t, { overlap: true }),
    f = s.f;
  f.moveMain({ overlap: true });
  const conflict = (await s.transport().dispatch('finish', { laneId: f.lane.laneId })).result.recovery
    .conflict;
  writeFileSync(join(conflict.root, 'a.txt'), 'chosen\nb\nc\n');
  const original = s.exchange.client.mutation;
  let raced = false;
  s.exchange.client.mutation = async (ref, args) => {
    const result = await original(ref, args);
    if (!raced && getFunctionName(ref) === 'projectHostedSaveJobs:submit') {
      raced = true;
      await f.c.advance({ laneId: conflict.laneId });
    }
    return result;
  };
  await assert.rejects(s.transport(conflict.root).dispatch('resolve', { laneId: conflict.laneId }), {
    code: 'WORK_STALE',
  });
  assert(raced);
  assert.equal((await f.readLane(conflict.laneId)).resolution.status, 'pending');
});

test('a durable asynchronous finish automatically syncs its terminal conflict on replay without a separate sync command', async t => {
  const s = await resolutionFixture(t, { overlap: true }),
    f = s.f;
  f.moveMain({ overlap: true });
  s.eagerSource(false);
  const command = { laneId: f.lane.laneId };
  const preparing = await s.transport().dispatch('finish', command);
  assert(preparing.result.submission.preparing);
  await f.drain();
  s.eagerSource(true);
  const recovered = await s.transport().dispatch('finish', command);
  assert.equal(recovered.operationId, preparing.operationId);
  assert.equal(recovered.result.submission.error.code, 'COMPOSITION_CONFLICT');
  assert.deepEqual(recovered.result.recovery.conflict.paths, ['a.txt']);
  assert.match(recovered.result.recovery.conflict.files[0].content, /<<<<<<< lane/);
  assert.match(recovered.result.recovery.conflict.command, / resolve /);
});
