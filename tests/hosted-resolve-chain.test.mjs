// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getFunctionName, makeFunctionReference } from 'convex/server';
import { resolutionFixture } from './hosted-agent-resolution-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { HostedAgentTransport } from '../dist/hosted-agent-transport.js';
import { saveHostedLane } from '../dist/hosted-save-client.js';
import { readHostedLaneCheckout } from '../dist/hosted-lane-checkout-marker.js';
import { saveBytes, savePin } from '../dist/hosted-save.js';
import { chainSettle, chainStallMs, resolveSyncRequest } from '../dist/hosted-resolve-chain.js';
import { canonicalPayload } from '../dist/hosted-source-operation.js';
import { hostedAgentDirectory } from '../dist/hosted-agent-journal.js';
import { clientCacheRoot } from '../dist/root-paths.js';
import speedBudgets from '../src/speed-budgets.json' with { type: 'json' };
import { fakeSourceR2 } from './convex-source-r2-fixture.mjs';

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

/** A conflicted Lane with its chosen bytes written, and a transport whose source subscription the
 * test pushes by hand (`pump`). */
async function conflicted(t) {
  const s = await resolutionFixture(t, { overlap: true, sourceChain: true }),
    f = s.f;
  f.moveMain({ overlap: true });
  const conflict = (await s.transport().dispatch('finish', { laneId: f.lane.laneId })).result.recovery
    .conflict;
  writeFileSync(join(conflict.root, 'a.txt'), 'chosen\nb\nc\n');
  s.eagerSource(false);
  const live = new Set();
  const subscriptions = new EventEmitter();
  const read = entry => {
    const [module, member] = entry.name.split(':');
    return f.tx(`subscription:${entry.name}`, modules[module][member], entry.args);
  };
  const subscribe = () => ({
    onUpdate(ref, args, update, error) {
      const entry = { name: getFunctionName(ref), args, update };
      live.add(entry);
      entry.initial = read(entry).then(
        value => live.has(entry) && update(value),
        reason => live.has(entry) && error(reason),
      );
      subscriptions.emit(entry.name, entry);
      return () => live.delete(entry);
    },
    close: async () => {},
  });
  const subscribed = async (operation, kind = 'Saves') => {
    const name = `projectHosted${kind}:progress`;
    const attached = [...live].find(entry => entry.name === name);
    if (attached) return attached;
    const controller = new AbortController();
    try {
      const [entry] = await Promise.race([
        once(subscriptions, name, { signal: controller.signal }),
        operation.then(() => assert.fail(`Resolve finished before subscribing to ${name}`)),
      ]);
      return entry;
    } finally {
      controller.abort();
    }
  };
  const pump = async () => {
    for (const entry of [...live]) {
      await entry.initial;
      if (!live.has(entry)) continue;
      const value = await read(entry);
      if (live.has(entry)) entry.update(value);
    }
  };
  const transport = () => new HostedAgentTransport(conflict.root, s.address, s.exchange, subscribe);
  // Calls and syncs from here on are the resolve's (the finish above made its own conflict sync).
  return {
    s,
    f,
    conflict,
    live,
    subscribed,
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
async function saveSubmitted(c, operation, inline = false) {
  const { args } = await c.subscribed(operation);
  const save = [...c.f.tables.projectHostedSaves.values()].find(row => row.operationId === args.operationId);
  assert(save?.jobId, 'the subscribed save has a source job');
  if (inline) await publishInline(c.f, save.operationId);
  else await completeSource(c.f, 'Save', save.operationId);
  return save;
}

test('a resolve gets its sync receipt from the save subscription: the server chains it, the CLI makes no sync call', async t => {
  const c = await conflicted(t);
  const waiting = c.transport().dispatch('resolve', { laneId: c.conflict.laneId });
  const save = await saveSubmitted(c, waiting);
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
  assert.equal(
    result.result.applied.downloadedBytes,
    speedBudgets.budgets.find(value => value.id === 'resolve-state-download-bytes').max,
    'the resolved header rebuilds from the exact saved State without a manifest download',
  );
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
  await saveSubmitted(c, waiting);
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

test('retrying a completed save observes its scheduled resolve without preparing, uploading or submitting it', async t => {
  const c = await conflicted(t);
  const controller = new AbortController();
  const command = { laneId: c.conflict.laneId, operationId: randomUUID() };
  const original = c.transport().dispatch('resolve', command, controller.signal);
  await saveSubmitted(c, original, true);
  controller.abort();
  assert.equal((await original).result.phase, 'save');
  const [task] = chainTasks(c.f);
  const upload = t.mock.method(c.s.exchange, 'upload');
  c.s.eagerSource(true);
  const retry = c.transport().dispatch('resolve', command);
  await c.subscribed(retry);
  await c.pump();
  const chained = await runChain(c.f, task);
  await c.pump();
  const result = await retry;
  assert.equal(result.result.source.outcome.result.status, 'resolved');
  assert.equal(clientCalls(c, 'projectHostedSync:prepare'), 0);
  assert.equal(clientCalls(c, 'projectHostedSyncJobs:submit'), 0);
  assert.equal(upload.mock.callCount(), 0);
  assert.deepEqual(result.result.source, chained);
  assert.equal(newSyncs(c), 1);
  assert.equal(c.live.size, 0);
});

for (const delayed of [false, true])
  test(`a submitted chain past the stall bound keeps one execution (delayed update=${delayed})`, async t => {
    const c = await conflicted(t);
    const waiting = c.transport().dispatch('resolve', { laneId: c.conflict.laneId });
    await saveSubmitted(c, waiting);
    const [task] = chainTasks(c.f);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    await c.pump(); // Observe the completed save before the chain has submitted.
    ranTask(c.f, task);
    const { operationId, input } = JSON.parse(
      await c.f.tx('chain:prepare', chainStore.prepare, task.args[0]),
    );
    c.f.c.put(saveBytes(input));
    await c.f.tx('chain:submit', modules.projectHostedSyncJobs.submit, {
      projectId: c.f.projectId,
      operationId,
    });
    if (!delayed) await c.pump();
    const upload = t.mock.method(c.s.exchange, 'upload');
    const saveReads = clientCalls(c, 'projectHostedSaves:progress');
    c.s.eagerSource(true);
    t.mock.timers.tick(chainStallMs);
    await c.subscribed(waiting, 'Sync');
    t.mock.timers.reset();
    await completeSource(c.f, 'Sync', operationId);
    await c.pump();
    const result = await waiting;
    assert.equal(result.result.source.outcome.result.status, 'resolved');
    assert.equal(clientCalls(c, 'projectHostedSync:prepare'), 0);
    assert.equal(clientCalls(c, 'projectHostedSyncJobs:submit'), 0);
    assert.equal(clientCalls(c, 'projectHostedSaves:progress') - saveReads, delayed ? 1 : 0);
    assert.equal(upload.mock.callCount(), 0);
    assert.equal(newSyncs(c), 1);
    assert.equal(c.live.size, 0);
  });

test('a chain that stops before its submit records it, and the CLI resolves itself at once', async t => {
  const c = await conflicted(t);
  const waiting = c.transport().dispatch('resolve', { laneId: c.conflict.laneId });
  const save = await saveSubmitted(c, waiting);
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

async function settleScheduledChain(c, operation, fail = false) {
  // Eager save publication queues the chain before the CLI receives the save reply.
  await c.subscribed(operation);
  const [task] = chainTasks(c.f);
  assert(task, 'the completed save queued its resolve');
  if (fail) {
    ranTask(c.f, task);
    await c.f.tx('chain:failed', chainStore.failed, { ...task.args[0], code: 'R2_UPLOAD_FAILED' });
  } else {
    await runChain(c.f, task);
  }
  await c.pump();
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

const savePublish = await import(moduleUrl('../convex/projectHostedSavePublish.ts'));
/** The save's job completes and its step's own commit publishes it with the chain run inline
 * (`publishSaveJob(..., true)`): the action then runs the chain itself; the scheduler keeps only a
 * delayed fallback. */
async function publishInline(f, operationId) {
  const row = [...f.tables.projectHostedSaves.values()].find(r => r.operationId === operationId),
    progress = JSON.parse(
      await f.tx('progress', modules.projectHostedSaves.progress, { projectId: f.projectId, operationId }),
    ),
    output = await f.c.compute(progress.input),
    job = await f.c.activate(row.jobId);
  await f.c.callback(job, { status: 'completed', output: output.output });
  const terminal = await f.tx(
    'publish-inline',
    { _handler: (ctx, args) => savePublish.publishSaveJob(ctx, args, true) },
    { projectId: f.projectId, jobId: job.id, result: output.manifest },
  );
  for (const task of f.pending().filter(task => task.args[0]?.jobId === job.id))
    f.patch('_scheduled_functions', task._id, { state: { kind: 'success' } });
  return JSON.parse(terminal);
}
async function savedWithThen(c) {
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
  const terminal = await publishInline(c.f, command.operationId);
  assert.equal(terminal.outcome.status, 'completed');
  return { then, command };
}

async function chainCoordinator(t, c) {
  const r2 = fakeSourceR2(t);
  r2.hooks.echo = true;
  const { runPreparedResolveChain } = await import(moduleUrl('../convex/projectHostedResolveChainRun.ts'));
  const transactions = [];
  const runMutation = (ref, args) => {
    const name = getFunctionName(ref).split(':')[1];
    transactions.push(name);
    return c.f.tx(`chain:${name}`, chainStore[name], args);
  };
  return {
    r2,
    transactions,
    runMutation,
    run: (args, step) => runPreparedResolveChain({ runMutation }, args, step),
  };
}

test('a fresh chain prepares and submits once with a single checksum-echo PUT', async t => {
  const c = await conflicted(t);
  await savedWithThen(c);
  const [task] = chainTasks(c.f);
  const chain = await chainCoordinator(t, c);
  const result = await chain.run(task.args[0], async ({ jobId }, preloaded) => {
    assert([...c.f.tables.projectHostedSyncs.values()].some(row => row.jobId === jobId));
    assert.deepEqual(savePin(JSON.parse(preloaded.text)), { sha256: preloaded.sha256, size: preloaded.size });
    return 'dispatched';
  });
  assert.equal(result, 'dispatched');
  assert.deepEqual(chain.transactions, ['prepare', 'submit']);
  assert.deepEqual(chain.r2.requests, ['PUT']);
});

test('the scheduled fallback confirms an input uploaded before the inline chain stopped', async t => {
  const c = await conflicted(t);
  const { then } = await savedWithThen(c);
  const [task] = chainTasks(c.f);
  const chain = await chainCoordinator(t, c);
  const prepared = JSON.parse(
    await chain.runMutation(makeFunctionReference('projectHostedResolveChainStore:prepare'), task.args[0]),
  );
  assert.equal(prepared.operationId, then.operationId);
  const { storeSourceBytes } = await import(moduleUrl('../convex/projectSourceBytes.ts'));
  const pin = savePin(prepared.input);
  await storeSourceBytes({}, c.f.projectId, saveBytes(prepared.input), pin);
  assert.deepEqual(chain.r2.requests, ['PUT'], 'the original fresh input takes one request');
  const [fallback] = chainTasks(c.f);
  assert.equal(fallback?._id, task._id, 'a crash before submit leaves the scheduled recovery available');
  ranTask(c.f, fallback);
  const result = await chain.run(fallback.args[0], async (_job, preloaded) => {
    assert.deepEqual(savePin(JSON.parse(preloaded.text)), pin);
    return 'dispatched';
  });
  assert.equal(result, 'dispatched');
  assert.deepEqual(chain.transactions, ['prepare', 'prepare', 'submit']);
  assert.deepEqual(chain.r2.requests, ['PUT', 'HEAD']);
});

test('an inline chain keeps its delayed fallback until the sync submission commits (1eef1b43 item 3)', async t => {
  const c = await conflicted(t);
  const { then, command } = await savedWithThen(c);
  const [task] = chainTasks(c.f);
  // Delayed, not immediate: the publishing action runs the chain itself first.
  // The fixture's scheduler stamps every task at one clock: an immediate task sits at the base.
  const base = Math.min(...[...c.f.tables._scheduled_functions.values()].map(row => row.scheduledTime));
  assert.equal(task.scheduledTime - base, savePublish.chainFallbackMs);
  const state = JSON.parse(
    [...c.f.tables.projectHostedSaves.values()].find(r => r.operationId === command.operationId).value,
  );
  assert.equal(state.chainFallbackId, task._id);
  // Preparing alone leaves no durable sync job, so the fallback still owns crash recovery.
  const prepared = JSON.parse(
    await c.f.tx('chain:prepare', chainStore.prepare, {
      projectId: c.f.projectId,
      actor: 'owner',
      operationId: command.operationId,
    }),
  );
  assert.equal(prepared.operationId, then.operationId);
  assert.equal(chainTasks(c.f).length, 1);
  await c.f.tx('chain:submit', chainStore.submit, {
    ...task.args[0],
    operationId: prepared.operationId,
    input: savePin(prepared.input),
    fallbackId: prepared.fallbackId,
  });
  assert.equal(chainTasks(c.f).length, 0);
  assert.equal(c.f.tables._scheduled_functions.get(task._id).state.kind, 'canceled');
});

test('a save published inside its call whose action died before the chain: the delayed fallback still resolves', async t => {
  const c = await conflicted(t);
  const { then } = await savedWithThen(c);
  const [task] = chainTasks(c.f);
  // The action never ran its chain; the fallback fires and runs the identical resolve.
  const chained = await runChain(c.f, task);
  assert.equal(chained.outcome.result.status, 'resolved');
  const sync = [...c.f.tables.projectHostedSyncs.values()].find(r => r.operationId === then.operationId);
  assert(sync, 'the resolve sync ran from the fallback');
  assert.equal(chainTasks(c.f).length, 0);
});

/** Every retained save request under this checkout's client cache. */
function savedRequests(root) {
  const found = [];
  const walk = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name === 'request.json') found.push(JSON.parse(readFileSync(path, 'utf8')));
    }
  };
  walk(clientCacheRoot(root));
  return found;
}
test('a resolve retains its then before the save, and the save request carries exactly that value (review 0f10873e R3)', async t => {
  const c = await conflicted(t);
  c.s.lose('projectHostedSaves:prepare');
  await assert.rejects(c.transport().dispatch('resolve', { laneId: c.conflict.laneId }));
  const journals = readdirSync(hostedAgentDirectory(c.conflict.root))
    .filter(name => name.endsWith('.json'))
    .map(name => JSON.parse(readFileSync(join(hostedAgentDirectory(c.conflict.root), name), 'utf8')))
    .filter(journal => journal.values?.['resolve-then']);
  assert.equal(journals.length, 1, 'the resolve journal retained its then before the save');
  const retained = journals[0].values['resolve-then'];
  const [request] = savedRequests(c.conflict.root);
  assert.deepEqual(request.then, retained, 'the save request carries exactly the retained then');
  // The resolve request is built from this same retained value (hosted-agent-resolution), never
  // from a fresh epoch or lifecycle read, so it equals what the server's chain builds.
});

test('the submit action reply with its chained resolve settles the save wait at once (source-run-publish)', async () => {
  const { publishedReply } = await import(moduleUrl('../convex/projectSourceRun.ts'));
  const save = { terminal: { outcome: { status: 'completed', result: {} } }, state: { submittedAt: 1 } },
    sync = { terminal: { outcome: { status: 'completed', result: { status: 'resolved' } } }, state: {} };
  const chainRun = { projectId: 'p', actor: 'owner', operationId: 'op' };
  const done = JSON.parse(publishedReply({ ...save, chainRun }, JSON.stringify(sync), true));
  assert.equal(done.chainRun, undefined, 'the chain identity never reaches the client');
  assert.deepEqual(chainSettle(done), {
    value: {
      save: save.terminal,
      chained: { terminal: sync.terminal, state: sync.state },
    },
  });
  // The chained step did not finish: the CLI waits on the save subscription for its receipt.
  const running = JSON.parse(publishedReply({ ...save, chainRun }, null, true));
  assert.deepEqual(chainSettle(running), { waitMs: chainStallMs });
  const failed = { outcome: { status: 'failed', error: { code: 'SOURCE_WORKER_FAILED' } } };
  const failedReply = JSON.parse(
    publishedReply({ ...save, chainRun }, JSON.stringify({ ...sync, terminal: failed }), true),
  );
  assert.deepEqual(chainSettle(failedReply), {
    value: { save: save.terminal, chained: { terminal: failed, state: sync.state } },
  });
  // An older CLI asked for the bare receipt.
  assert.deepEqual(JSON.parse(publishedReply({ ...save, chainRun }, null, false)), save.terminal);
  assert.deepEqual(JSON.parse(publishedReply(save, null, true)), save);
});

test('a sync prepare asked for targets returns its input upload target, and a replay returns the same one (prepare-upload-targets)', async t => {
  const c = await conflicted(t);
  const { then, command } = await savedWithThen(c);
  const saved = JSON.parse(
    await c.f.tx('progress', modules.projectHostedSaves.progress, {
      projectId: c.f.projectId,
      operationId: command.operationId,
    }),
  ).terminal.outcome.result;
  const request = canonicalPayload(resolveSyncRequest(then, c.conflict.laneId, saved));
  const first = JSON.parse(
    await c.f.tx('sync:prepare', modules.projectHostedSync.prepare, {
      projectId: c.f.projectId,
      request,
      targets: true,
    }),
  );
  const pin = savePin(first.input);
  assert.equal(first.targets.length, 1);
  const [target] = first.targets;
  const row = c.f.tables.projectObjects.get(target.id);
  assert.equal(row.digest, pin.sha256);
  assert.equal(row.size, pin.size);
  assert.equal(target.stored, false);
  assert(target.target, 'a PUT target for the input');
  const replay = JSON.parse(
    await c.f.tx('sync:prepare', modules.projectHostedSync.prepare, {
      projectId: c.f.projectId,
      request,
      targets: true,
    }),
  );
  assert.equal(replay.targets[0].id, target.id);
  // Without the flag the reply is unchanged for older CLIs.
  const plain = JSON.parse(
    await c.f.tx('sync:prepare', modules.projectHostedSync.prepare, { projectId: c.f.projectId, request }),
  );
  assert.equal(plain.targets, undefined);
});

/** A source cutover: the project and its main move to the next authority epoch. */
function nextEpoch(f) {
  const project = f.tables.hostedProjects.get(f.projectId);
  project.sourceAuthority = { ...project.sourceAuthority, epoch: project.sourceAuthority.epoch + 1 };
  const main = JSON.parse(f.tables.projectHostedChannels.get(f.mainId).selection);
  f.patch('projectHostedChannels', f.mainId, {
    selection: JSON.stringify({ ...main, authority: { ...main.authority, epoch: main.authority.epoch + 1 } }),
  });
  return project.sourceAuthority.epoch;
}
/** The client loses its connection on the first call to `name`, before the server runs it. */
function dropFirst(c, name) {
  const client = c.s.exchange.client,
    mutation = client.mutation;
  client.mutation = async (ref, args) => {
    if (getFunctionName(ref) !== name) return mutation(ref, args);
    client.mutation = mutation;
    throw new TypeError('fetch failed');
  };
}
test('a resolve whose save never began re-journals its then after an epoch change; the replay resolves (review b1448b61 N3)', async t => {
  const c = await conflicted(t);
  c.s.eagerSource(true);
  dropFirst(c, 'projectHostedSaves:prepare');
  const operationId = randomUUID(),
    resolve = () => c.transport().dispatch('resolve', { laneId: c.conflict.laneId, operationId });
  await assert.rejects(resolve(), { code: 'HOSTED_ACTION_FAILED' });
  const epoch = nextEpoch(c.f);
  // Before the fix every replay of this operation was refused SOURCE_AUTHORITY_CHANGED: the retained
  // save request and its then kept the old epoch, and nothing began to reconcile with.
  const retry = resolve();
  await settleScheduledChain(c, retry);
  const result = await retry;
  assert.equal(result.result.source.outcome.result.status, 'resolved');
  const save = [...c.f.tables.projectHostedSaves.values()].map(row => JSON.parse(row.value).request);
  assert.equal(save.length, 1, 'one save began, at the current epoch');
  assert.equal(save[0].authorityEpoch, epoch);
  assert.equal(save[0].then.authorityEpoch, epoch);
  assert.equal(newSyncs(c), 1, 'one resolve sync');
});

test('a resolve whose save completed but whose sync never began rebuilds the sync at the new epoch (review b1448b61 N3)', async t => {
  const c = await conflicted(t);
  c.s.eagerSource(true);
  const submit = c.s.exchange.client.mutation;
  t.mock.method(c.s.exchange.client, 'mutation', async (ref, args) => {
    if (getFunctionName(ref) === 'projectHostedSaveJobs:submit') {
      // Keep the save in flight past the old fixture's 5,000-turn readiness limit.
      for (let turn = 0; turn < 5_001; turn++) await tick();
    }
    return submit(ref, args);
  });
  dropFirst(c, 'projectHostedSync:prepare');
  const operationId = randomUUID(),
    resolve = () => c.transport().dispatch('resolve', { laneId: c.conflict.laneId, operationId });
  const first = assert.rejects(resolve());
  await settleScheduledChain(c, first, true);
  await first;
  assert.equal(newSyncs(c), 0, 'the resolve sync never began');
  const epoch = nextEpoch(c.f);
  const result = await resolve();
  assert.equal(result.result.source.outcome.result.status, 'resolved');
  assert.equal(newSyncs(c), 1);
  const sync = [...c.f.tables.projectHostedSyncs.values()].at(-1);
  assert.equal(JSON.parse(sync.value).request.authorityEpoch, epoch);
  // A further replay answers from the receipt: the rebuilt request is the retained one now.
  const again = await resolve();
  assert.equal(again.result.source.outcome.result.status, 'resolved');
  assert.equal(newSyncs(c), 1);
});

test('a plain save refused for an older authority epoch drops its request and rebuilds it at the current one (review b1448b61 N3)', async t => {
  const c = await conflicted(t);
  c.s.eagerSource(true);
  dropFirst(c, 'projectHostedSaves:prepare');
  const command = { message: 'Chosen side', operationId: randomUUID() },
    save = () => c.transport().dispatch('save', command);
  await assert.rejects(save(), { code: 'HOSTED_ACTION_FAILED' });
  const epoch = nextEpoch(c.f);
  const result = await save();
  assert.equal(result.result.outcome?.status ?? result.result.terminal?.outcome?.status, 'completed');
  const [request] = [...c.f.tables.projectHostedSaves.values()].map(row => JSON.parse(row.value).request);
  assert.equal(request.authorityEpoch, epoch);
});

test('a resolve whose save began at an older epoch is refused with the one next command, and that command resolves (review b1448b61 N3)', async t => {
  const c = await conflicted(t);
  c.s.eagerSource(true);
  dropFirst(c, 'projectHostedSaveJobs:submit');
  const operationId = randomUUID(),
    resolve = () => c.transport().dispatch('resolve', { laneId: c.conflict.laneId, operationId });
  await assert.rejects(resolve());
  assert.equal(c.f.tables.projectHostedSaves.size, 1, 'the save began at the old epoch');
  nextEpoch(c.f);
  const refused = await resolve().catch(error => error);
  assert.match(refused.code, /^SOURCE_AUTHORITY_/);
  const { next } = refused.recovery;
  assert.equal(next.action, 'resolve');
  assert.notEqual(next.operationId, operationId, 'a new operation, not a replay of this one');
  const { action, ...parameters } = next;
  const resumed = c.transport().dispatch(action, parameters);
  await settleScheduledChain(c, resumed);
  const result = await resumed;
  assert.equal(result.result.source.outcome.result.status, 'resolved');
});

test('a resolve whose sync began at an older epoch is refused with the one next command, and that command resolves (review b1448b61 N3)', async t => {
  const c = await conflicted(t);
  c.s.eagerSource(true);
  dropFirst(c, 'projectHostedSyncJobs:submit');
  const operationId = randomUUID(),
    resolve = () => c.transport().dispatch('resolve', { laneId: c.conflict.laneId, operationId });
  const first = assert.rejects(resolve());
  await settleScheduledChain(c, first, true);
  await first;
  assert.equal(newSyncs(c), 1, 'the resolve sync began at the old epoch');
  nextEpoch(c.f);
  const refused = await resolve().catch(error => error);
  assert.match(refused.code, /^SOURCE_AUTHORITY_/);
  const { action, ...parameters } = refused.recovery.next;
  assert.equal(action, 'resolve');
  assert.notEqual(parameters.operationId, operationId);
  const resumed = c.transport().dispatch(action, parameters);
  await settleScheduledChain(c, resumed);
  const result = await resumed;
  assert.equal(result.result.source.outcome.result.status, 'resolved');
});
