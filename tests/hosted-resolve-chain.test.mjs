// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getFunctionName } from 'convex/server';
import { resolutionFixture } from './hosted-agent-resolution-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { HostedAgentTransport } from '../dist/hosted-agent-transport.js';
import { saveHostedLane } from '../dist/hosted-save-client.js';
import { readHostedLaneCheckout } from '../dist/hosted-lane-checkout-marker.js';
import { saveBytes, savePin } from '../dist/hosted-save.js';
import { chainStallMs } from '../dist/hosted-resolve-chain.js';

// save-then-resolve (1eef1b43): the resolve's save names the sync that follows it; the save's
// completion schedules the chain, and the CLI's one save subscription sees that sync finish.
const modules = Object.fromEntries(
  await Promise.all(
    [
      'projectHostedSaves',
      'projectHostedSaveJobs',
      'projectHostedSync',
      'projectHostedSyncJobs',
      'projectHostedResolveChainStore',
    ].map(async name => [name, await import(moduleUrl(`../convex/${name}.ts`))]),
  ),
);
const chainStore = modules.projectHostedResolveChainStore;
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(condition) {
  for (let i = 0; i < 5000 && !condition(); i++) await tick();
  assert(condition(), 'condition reached');
}

/** A conflicted Lane with its chosen bytes written, and a transport whose source subscription the
 * test pushes by hand (`pump`). */
async function conflicted(t) {
  const s = await resolutionFixture(t, { overlap: true }),
    f = s.f;
  f.moveMain({ overlap: true });
  const conflict = (await s.transport().dispatch('finish', { laneId: f.lane.laneId })).result.recovery
    .conflict;
  writeFileSync(join(conflict.root, 'a.txt'), 'chosen\nb\nc\n');
  s.eagerSource(false);
  const live = new Set();
  const subscribe = () => ({
    onUpdate(ref, args, update) {
      const entry = { name: getFunctionName(ref), args, update };
      live.add(entry);
      return () => live.delete(entry);
    },
    close: async () => {},
  });
  const pump = async () => {
    for (const entry of [...live]) {
      const [module, member] = entry.name.split(':');
      entry.update(await f.tx(`subscription:${entry.name}`, modules[module][member], entry.args));
    }
  };
  const transport = () => new HostedAgentTransport(conflict.root, s.address, s.exchange, subscribe);
  // Calls and syncs from here on are the resolve's (the finish above made its own conflict sync).
  return {
    s,
    f,
    conflict,
    live,
    pump,
    transport,
    mark: s.calls.length,
    syncs: f.tables.projectHostedSyncs.size,
  };
}
/** The trusted worker for one submitted job, as the fixture's eager mode runs it. */
async function completeSource(f, kind, operationId) {
  const table = kind === 'Save' ? 'projectHostedSaves' : 'projectHostedSyncs',
    row = [...f.tables[table].values()].find(r => r.operationId === operationId),
    progress = JSON.parse(
      await f.tx('progress', modules[kind === 'Save' ? 'projectHostedSaves' : 'projectHostedSync'].progress, {
        projectId: f.projectId,
        operationId,
      }),
    ),
    output = await f.c.compute(progress.input),
    job = await f.c.activate(row.jobId);
  await f.c.callback(job, { status: 'completed', output: output.output });
  const terminal = await f.tx('publish', modules[`projectHosted${kind}Jobs`].publish, {
    projectId: f.projectId,
    jobId: job.id,
    result: output.manifest,
  });
  for (const task of f.pending().filter(task => task.args[0]?.jobId === job.id))
    f.patch('_scheduled_functions', task._id, { state: { kind: 'success' } });
  return JSON.parse(terminal);
}
const chainTasks = f => f.pending().filter(task => task.name === 'projectHostedResolveChain:run');
/** projectHostedResolveChain:run with the fixture's R2: its prepare, its input write, its submit
 * (here the scheduled-dispatch submit, so the fixture's worker can complete the job). */
async function runChain(f, task) {
  f.patch('_scheduled_functions', task._id, { state: { kind: 'success' } });
  const prepared = await f.tx('chain:prepare', chainStore.prepare, task.args[0]);
  if (!prepared) return null;
  const { operationId, input } = JSON.parse(prepared);
  f.c.put(saveBytes(input));
  await f.tx('chain:submit', modules.projectHostedSyncJobs.submit, { projectId: f.projectId, operationId });
  return completeSource(f, 'Sync', operationId);
}
const clientCalls = (c, name) => c.s.calls.slice(c.mark).filter(call => call.name === name).length;
const newSyncs = c => c.f.tables.projectHostedSyncs.size - c.syncs;
async function saveSubmitted(c) {
  await until(() => [...c.f.tables.projectHostedSaves.values()].some(row => row.jobId) && c.live.size);
  const save = [...c.f.tables.projectHostedSaves.values()].at(-1);
  await completeSource(c.f, 'Save', save.operationId);
  return save;
}

test('a resolve gets its sync receipt from the save subscription: the server chains it, the CLI makes no sync call', async t => {
  const c = await conflicted(t);
  const waiting = c.transport().dispatch('resolve', { laneId: c.conflict.laneId });
  const save = await saveSubmitted(c);
  const [task] = chainTasks(c.f);
  assert.deepEqual(task.args[0], { projectId: c.f.projectId, actor: 'owner', operationId: save.operationId });
  // The save is done but its resolve is not: the CLI keeps its one subscription open.
  await c.pump();
  await tick();
  assert.equal(c.live.size, 1);
  assert.equal([...c.live][0].name, 'projectHostedSaves:progress');
  const chained = await runChain(c.f, task);
  assert.equal(chained.outcome.result.status, 'resolved');
  await c.pump();
  const result = await waiting;
  assert.equal(result.result.source.outcome.result.status, 'resolved');
  assert.deepEqual(result.result.source, chained);
  for (const name of [
    'projectHostedSync:prepare',
    'projectHostedSyncJobs:submit',
    'projectHostedSync:progress',
  ])
    assert.equal(clientCalls(c, name), 0, name);
  // A retry of the same resolve returns the same receipt and starts nothing new.
  const again = await c.transport().dispatch('resolve', { laneId: c.conflict.laneId });
  assert.deepEqual(again.result.source, chained);
  assert.equal(newSyncs(c), 1);
  assert.equal(chainTasks(c.f).length, 0);
});

test('a chain that never runs (crash between save and sync): the CLI resolves itself after the stall bound', async t => {
  const c = await conflicted(t);
  const waiting = c.transport().dispatch('resolve', { laneId: c.conflict.laneId });
  await saveSubmitted(c);
  const [task] = chainTasks(c.f);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await c.pump();
  c.s.eagerSource(true);
  t.mock.timers.tick(chainStallMs);
  t.mock.timers.reset();
  const result = await waiting;
  assert.equal(result.result.source.outcome.result.status, 'resolved');
  assert.equal(clientCalls(c, 'projectHostedSync:prepare'), 1);
  // The late chain finds the identical request already finished and does nothing.
  assert.equal(await runChain(c.f, task), null);
  assert.equal(newSyncs(c), 1);
});

test('a chain that stops before its submit records it, and the CLI resolves itself at once', async t => {
  const c = await conflicted(t);
  const waiting = c.transport().dispatch('resolve', { laneId: c.conflict.laneId });
  const save = await saveSubmitted(c);
  const [task] = chainTasks(c.f);
  ranTask(c.f, task);
  // The chain prepared (so the sync exists, ready), then its R2 write failed.
  assert(await c.f.tx('chain:prepare', chainStore.prepare, task.args[0]));
  await c.f.tx('chain:failed', chainStore.failed, { ...task.args[0], code: 'R2_UPLOAD_FAILED' });
  c.s.eagerSource(true);
  await c.pump();
  const result = await waiting;
  assert.equal(result.result.source.outcome.result.status, 'resolved');
  // The CLI's prepare replayed the chain's identical request: one sync, no request conflict.
  assert.equal(clientCalls(c, 'projectHostedSync:prepare'), 1);
  assert.equal(newSyncs(c), 1);
  const state = JSON.parse(
    [...c.f.tables.projectHostedSaves.values()].find(r => r.operationId === save.operationId).value,
  );
  assert.equal(state.chainFailure, 'R2_UPLOAD_FAILED');
});
function ranTask(f, task) {
  f.patch('_scheduled_functions', task._id, { state: { kind: 'success' } });
}

test('the chain submit records its own input write and dispatches the sync inline for its action', async t => {
  const c = await conflicted(t);
  const marker = readHostedLaneCheckout(c.conflict.root);
  const then = {
    kind: 'resolve',
    operationId: randomUUID(),
    authorityEpoch: 1,
    lifecycleVersion: marker.selection.lifecycleVersion,
    message: 'resolve',
  };
  const command = { operationId: randomUUID(), message: 'resolve' };
  const submitted = await saveHostedLane(c.conflict.root, command, c.s.exchange, {
    overlapEvidence: false,
    submitPage: false,
    then,
  });
  assert.equal(submitted.status, 'submitted');
  await completeSource(c.f, 'Save', command.operationId);
  const [task] = chainTasks(c.f);
  ranTask(c.f, task);
  const { operationId, input } = JSON.parse(await c.f.tx('chain:prepare', chainStore.prepare, task.args[0]));
  assert.equal(operationId, then.operationId);
  const pin = savePin(input);
  const result = JSON.parse(
    await c.f.tx('chain:submit', chainStore.submit, { ...task.args[0], operationId, input: pin }),
  );
  const sync = [...c.f.tables.projectHostedSyncs.values()].find(r => r.operationId === operationId);
  assert.equal(result.run, sync.jobId);
  const object = [...c.f.tables.projectObjects.values()].find(r => r.digest === pin.sha256);
  assert.equal(object.r2Committed, true);
  assert.equal(object.size, pin.size);
  const step = [...c.f.tables.projectSourceSteps.values()].find(r => r.jobId === sync.jobId);
  assert.equal(step.inlineFallback, true);
  // Nothing was dispatched on the scheduler: only the delayed fallback step waits there.
  const queued = c.f
    .pending()
    .filter(task => task.args[0]?.jobId === sync.jobId)
    .map(task => task.name);
  assert.deepEqual(queued, ['projectConvexSource:step']);
  // A replayed prepare (the CLI's, or a duplicate chain) does nothing more.
  assert.equal(await c.f.tx('chain:prepare', chainStore.prepare, task.args[0]), null);
});
