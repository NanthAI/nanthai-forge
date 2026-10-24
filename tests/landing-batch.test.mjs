import { trainAccounting } from '../dist/train-accounting.js';
import { readMakingOf } from '../dist/making-of-read.js';
// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { withQueueSlot } from '../dist/landing-queue.js';
import { batchDirectory } from '../dist/landing-batch-store.js';
import { WorkService } from '../dist/work.js';
import { cancelLandingEntry } from '../dist/landing-batch-cancel.js';
import { orderLandingEntries } from '../dist/landing-batch-order.js';
import { materializeWork } from '../dist/work-hosted-index.js';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { checkEnvironment } from '../dist/work-run.js';
import { enqueueLanding, batchEdit, composeBatch, selectBatch } from '../dist/landing-batch-store.js';
import { drainLandingBatches, passingPrefix } from '../dist/landing-batch.js';
import { drainPostAccept } from '../dist/post-accept-main.js';
import { migrateIntentWork } from '../dist/work-intent-migration.js';
import { unifiedWorkSchema } from '../dist/work-unified-types.js';
import { hostedPushWork } from '../dist/work-intent-local.js';
import { assertWorkFormat, latestWorkFormat } from '../dist/work-format.js';
import { workSchema } from '../dist/work-types.js';
import { ForgeError } from '../dist/errors.js';
import { NativeSource } from '../dist/native-source.js';
import { fixture as batchFixture } from './landing-batch-fixture.mjs';

async function fixture(t, options) {
  const f = await batchFixture(t, { delay: 0, ...options });
  // These cases enqueue the entire batch before draining it. Arrival-window
  // timing is covered separately; use the existing policy to avoid real waits.
  await f.agent.dispatch({
    action: 'set-policy',
    operationId: randomUUID(),
    acceptance: { batchWindowMs: 0 },
  });
  return f;
}

test('four ready entries land with one exact combined check and one Channel move', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 4; i++) await f.candidate(`${i}.txt`);
  await drainLandingBatches(f.work, 'main');
  const data = f.store.load();
  assert.equal(data.schema, 17);
  assert.equal(data.landingBatches.length, 1);
  assert.equal(data.runs.filter(run => !run.mainCheck).length, 1);
  assert.equal(data.channelMoves.length, 1);
  assert.equal(data.views.find(view => view.id === f.main().viewId).inputs.length, 4);
  assert.ok(data.landingEntries.every(entry => entry.status === 'accepted'));
  assert.ok(
    data.landingEntries.every(
      entry =>
        Date.parse(entry.firstSelectedAt) >= Date.parse(entry.arrivedAt) && entry.terminalAt === f.main().at,
    ),
  );
  const accounting = trainAccounting(data.runs, {
    entries: data.landingEntries,
    batches: data.landingBatches,
    moves: data.channelMoves,
  });
  assert.equal(accounting.latency.endToEnd.observed, 4);
  assert.ok(accounting.submissions.every(row => row.queueBasis === 'submission-state'));
  const first = data.lanes[0];
  const makingOf = readMakingOf(f.store, first.intentId).result.accounting;
  assert.equal(makingOf.submissions.length, 1);
  assert.equal(makingOf.submissions[0].costs.shared, true);
  assert.equal(makingOf.submissions[0].costs.categories.landing.executions, 1);
  assert.equal(f.main().postAccept.reason, 'batch');
  for (let i = 0; i < 4; i++) assert.equal(f.content(`${i}.txt`), `${i}.txt\n`);
  await drainPostAccept(f.store);
  assert.ok(f.store.load().runs.some(run => run.mainCheck && run.status === 'passed'));
});

test('compose conflict ejects only its entry and retains the conflict View', async t => {
  const f = await fixture(t);
  await f.candidate('same.txt', 'first\n');
  const conflict = await f.candidate('same.txt', 'second\n');
  await f.candidate('later.txt');
  await drainLandingBatches(f.work, 'main');
  const entry = f.store.select('landingEntries', conflict.command.operationId);
  assert.equal(entry.status, 'conflict');
  assert.ok(Number.isFinite(Date.parse(entry.terminalAt)));
  assert.equal(f.store.select('views', entry.conflictViewId).status, 'conflict');
  assert.equal(f.content('same.txt'), 'first\n');
  assert.equal(f.content('later.txt'), 'later.txt\n');
  assert.equal(f.store.load().runs.filter(run => !run.mainCheck).length, 1);
});

for (const remote of [true, false])
  test(`${remote ? 'Modal parallel' : 'local halving'} failure lands checked prefix, records failing combination, preserves later age`, async t => {
    const f = await fixture(t, { remote });
    const entries = [];
    for (const path of ['good.txt', 'bad.txt', 'third.txt', 'fourth.txt'])
      entries.push(await f.candidate(path));
    const ages = f.store.load().landingEntries.map(entry => entry.arrivedAt);
    await drainLandingBatches(f.work, 'main');
    const data = f.store.load(),
      batch = data.landingBatches[0];
    assert.equal(batch.mode, remote ? 'parallel' : 'halving');
    assert.equal(batch.culpritId, entries[1].command.operationId);
    const culprit = data.landingEntries[1];
    assert.equal(culprit.status, 'failed');
    const failed = data.runs.find(run => run.id === culprit.runId);
    assert.equal(failed.status, 'failed');
    assert.equal(batch.prefixes.find(prefix => prefix.runId === failed.id).entryIds.length, 2);
    const firstMove = data.channelMoves[0];
    const checked = data.runs.find(run => run.viewId === firstMove.viewId && run.status === 'passed');
    assert.equal(checked.head, firstMove.head);
    assert.equal(checked.inputs.length, 1);
    assert.deepEqual(
      data.landingEntries.map(entry => entry.arrivedAt),
      ages,
    );
    assert.deepEqual(
      data.landingEntries.map(entry => entry.status),
      ['accepted', 'failed', 'accepted', 'accepted'],
      JSON.stringify(
        data.runs
          .filter(run => !run.mainCheck)
          .map(({ id, status, exitCode, signal, details, error, inputs, head, failureSummary }) => ({
            id,
            status,
            exitCode,
            signal,
            details,
            error,
            inputs,
            head,
            failureSummary,
            sourcePaths: new NativeSource(f.root).state(head).files.map(file => file.path),
          })),
      ),
    );
    assert.equal(f.content('bad.txt'), undefined);
    assert.equal(f.content('fourth.txt'), 'fourth.txt\n');
  });

test('restarted driver adopts the persisted batch and acceptance after a lost reply', async t => {
  const f = await fixture(t);
  for (const path of ['first.txt', 'second.txt']) await f.candidate(path);
  const batch = await batchEdit(f.work, 'select', data => selectBatch(f.work, data, 'main'));
  await composeBatch(f.work, batch);
  const dispatch = f.work.dispatch.bind(f.work);
  let lost = false;
  f.work.dispatch = async (...args) => {
    const result = await dispatch(...args);
    if (!lost && args[0].action === 'accept-channel') {
      lost = true;
      throw new ForgeError('SOURCE_CHANGED', 'Synthetic lost acceptance reply');
    }
    return result;
  };
  await assert.rejects(drainLandingBatches(f.work, 'main'), { code: 'SOURCE_CHANGED' });
  assert.equal(f.store.load().landingBatches[0].status, 'checking');
  await drainLandingBatches(new AgentWorkflow(f.root).work, 'main');
  const data = f.store.load();
  assert.equal(data.channelMoves.length, 1);
  assert.equal(data.landingBatches.length, 1);
  assert.equal(data.runs.filter(run => !run.mainCheck).length, 1);
  assert.ok(data.landingEntries.every(entry => entry.status === 'accepted'));
});

test('a lone finish runs immediately and terminal replay does not rerun it', async t => {
  const f = await fixture(t);
  const { lane } = await f.candidate('lone.txt', 'lone\n', false);
  const command = {
    action: 'finish',
    operationId: randomUUID(),
    laneId: lane.laneId,
    message: 'Lone',
    accept: true,
  };
  const first = (await f.agent.dispatch(command)).result;
  assert.equal(first.status, 'accepted');
  assert.equal(first.complete, true);
  assert.equal(f.store.load().landingBatches[0].entryIds.length, 1);
  // Replay the filled pins returned by the workflow.
  const replay = (await f.agent.dispatch({ ...command, ...first.resolved })).result;
  assert.equal(replay.acceptance.acceptanceId, first.acceptance.acceptanceId);
  assert.equal(f.store.load().runs.filter(run => !run.mainCheck).length, 1);
});

test('parallel failure checks all proper prefixes concurrently, and keeps a nonmonotonic longest pass', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const prefixes = Array.from({ length: 4 }, (_, i) => ({
    entryIds: Array(i + 1).fill('entry'),
    viewId: `${i}`,
    head: `${i}`,
    runId: `${i}`,
  }));
  let active = 0,
    peak = 0;
  const pending = passingPrefix(prefixes, 'parallel', async prefix => {
    active++;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 10));
    active--;
    return ['passed', 'failed', 'passed', 'failed'][Number(prefix.viewId)];
  });
  t.mock.timers.tick(10); // Full check fails first, then the three probes start together.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(active, 3);
  t.mock.timers.tick(10);
  const result = await pending;
  assert.equal(active, 0);
  assert.equal(peak, 3);
  assert.equal(result.passing, prefixes[2]);
  assert.equal(result.culprit, prefixes[3]);
});

test('Work17 requires its version, survives portable serialization and rejects future formats', async t => {
  const f = await fixture(t);
  await f.candidate('portable.txt');
  const data = f.store.load();
  assert.deepEqual(workSchema.parse(JSON.parse(JSON.stringify(data))).landingEntries, data.landingEntries);
  assert.equal(workSchema.safeParse({ ...data, schema: 15 }).success, false);
  const indexed = materializeWork(
    data,
    {
      kind: 'forge-native-work-backup',
      schema: 1,
      head: data.nativeHead,
      revision: data.revision,
      files: [],
      unavailable: [],
      coverage: 'Synthetic',
    },
    [],
    'objects',
  );
  assert.deepEqual(
    indexed.entries
      .filter(entry => entry.collection === 'landingEntries')
      .map(entry => JSON.parse(entry.value)),
    data.landingEntries,
  );
  assert.throws(() => assertWorkFormat({ schema: latestWorkFormat + 1 }), { code: 'WORK_UPGRADE_REQUIRED' });
  assertWorkFormat({ schema: 16 });
  assertWorkFormat({ schema: 18 });
  assertWorkFormat({ schema: 17 });
  await drainLandingBatches(f.work, 'main');
});

test('queued cancellation retains and checks the prefix before that entry', async t => {
  const f = await fixture(t);
  for (const path of ['before.txt', 'cancel.txt', 'after.txt']) await f.candidate(path);
  const dispatch = f.work.dispatch.bind(f.work);
  let cancelled = false;
  f.work.dispatch = async (...args) => {
    const result = await dispatch(...args);
    if (!cancelled && args[0].action === 'run-check') {
      cancelled = true;
      await cancelLandingEntry(f.work, f.pending[1]);
    }
    return result;
  };
  await drainLandingBatches(f.work, 'main');
  const data = f.store.load();
  assert.deepEqual(
    data.landingEntries.map(entry => entry.status),
    ['accepted', 'cancelled', 'accepted'],
  );
  const cancelledAt = data.landingEntries[1].terminalAt;
  assert.ok(Number.isFinite(Date.parse(cancelledAt)));
  await cancelLandingEntry(f.work, f.pending[1]);
  assert.equal(f.store.select('landingEntries', f.pending[1]).terminalAt, cancelledAt);
  assert.equal(f.content('cancel.txt'), undefined);
  const first = data.channelMoves[0];
  assert.ok(
    data.runs.some(
      run =>
        run.viewId === first.viewId &&
        run.head === first.head &&
        run.status === 'passed' &&
        run.inputs.length === 1,
    ),
  );
});

test('main can overtake a checking batch with manifest-disjoint evidence', async t => {
  const f = await fixture(t);
  await f.agent.dispatch({
    action: 'set-policy',
    operationId: randomUUID(),
    acceptance: { disjointFastPath: true },
  });
  await f.candidate('batch.txt');
  const rival = await f.candidate('rival.txt', 'rival\n', false);
  const dispatch = f.work.dispatch.bind(f.work);
  let moved = false;
  f.work.dispatch = async (...args) => {
    if (!moved && args[0].action === 'accept-channel') {
      moved = true;
      const person = new WorkService(f.root);
      await person.dispatch(
        {
          action: 'accept-channel',
          operationId: randomUUID(),
          channel: 'main',
          viewId: rival.view.id,
          expectedHead: rival.view.head,
          expectedPrevious: null,
        },
        person.store.revision(),
        { keepOpen: true },
      );
    }
    return dispatch(...args);
  };
  await drainLandingBatches(f.work, 'main');
  assert.equal(f.content('batch.txt'), 'batch.txt\n');
  assert.equal(f.content('rival.txt'), 'rival\n');
  assert.equal(f.main().fastPath.kind, 'disjoint-fast-path');
  assert.equal(f.store.load().runs.filter(run => !run.mainCheck).length, 1);
});

test('priority and submitter fairness only change ordering and keep original age', () => {
  const entries = ['a', 'a', 'a', 'a', 'b', 'c'].map((submitter, index) => ({
    id: index,
    submitter,
    priority: 'normal',
    arrivedAt: String(index),
  }));
  const before = JSON.stringify(entries);
  assert.deepEqual(
    orderLandingEntries(entries).map(entry => entry.id),
    [0, 1, 4, 2, 5, 3],
  );
  const urgent = { id: 6, submitter: 'd', priority: 'urgent', arrivedAt: '9' };
  assert.equal(orderLandingEntries([...entries, urgent])[0], urgent);
  assert.equal(JSON.stringify(entries), before);
});

test('synthetic four-entry wall time uses the same runner and harness for serial versus batch', async t => {
  const measure = async size => {
    const f = await fixture(t, { delay: 80 });
    for (let i = 0; i < 4; i++) await f.candidate(`perf-${i}.txt`, `${i}\n`, false);
    // Prepare identical pinned candidates; vary only how many are admitted per drain.
    const views = f.store.load().views.filter(view => view.inputs.length === 1);
    const started = performance.now();
    for (let offset = 0; offset < views.length; offset += size) {
      for (const view of views.slice(offset, offset + size)) {
        const definition = f.store.load().checks[0];
        await enqueueLanding(
          f.work,
          {
            action: 'finish',
            operationId: randomUUID(),
            laneId: view.inputs[0].laneId,
            checkId: definition.id,
            expectedDefinition: definition.definition,
            expectedEnvironment: checkEnvironment().fingerprint,
            accept: { channel: 'main', expectedPrevious: null },
            keepOpen: false,
          },
          view,
        );
      }
      await drainLandingBatches(f.work, 'main');
    }
    const ms = performance.now() - started;
    assert.equal(f.store.load().landingEntries.length, 4);
    return { ms: Math.round(ms), runs: f.store.load().runs.filter(run => !run.mainCheck).length };
  };
  const before = await measure(1),
    after = await measure(4);
  assert.equal(before.runs, 4);
  assert.equal(after.runs, 1);
  t.diagnostic(
    `SYNTHETIC serial=${before.ms}ms (${before.runs} runs), batch=${after.ms}ms (${after.runs} run); mock Modal 80ms/check; no real Modal`,
  );
});

test('policy changes before acceptance return checked batch evidence for person review', async t => {
  const f = await fixture(t);
  const { lane } = await f.candidate('review.txt', 'review\n', false);
  const dispatch = f.work.dispatch.bind(f.work);
  let changed = false;
  f.work.dispatch = async (...args) => {
    if (!changed && args[0].action === 'accept-channel') {
      changed = true;
      const person = new WorkService(f.root);
      await person.dispatch(
        { action: 'set-policy', operationId: randomUUID(), preset: 'supervised' },
        person.store.revision(),
      );
    }
    return dispatch(...args);
  };
  const result = (
    await f.agent.dispatch({
      action: 'finish',
      laneId: lane.laneId,
      message: 'Review current policy',
      accept: true,
    })
  ).result;
  assert.equal(result.status, 'awaiting-review');
  assert.equal(result.readyToReview, true);
  assert.equal(result.run.status, 'passed');
  assert.equal(f.main(), undefined);
  assert.equal(f.store.load().landingEntries[0].status, 'awaiting-review');
});

test('an overlapping main move supersedes the checked attempt without changing arrival age', async t => {
  const f = await fixture(t);
  await f.agent.dispatch({
    action: 'set-policy',
    operationId: randomUUID(),
    acceptance: { disjointFastPath: true },
  });
  await f.candidate('same.txt', 'batch version\n');
  const age = f.store.load().landingEntries[0].arrivedAt;
  const rival = await f.candidate('same.txt', 'main version\n', false);
  const dispatch = f.work.dispatch.bind(f.work);
  let moved = false;
  f.work.dispatch = async (...args) => {
    if (!moved && args[0].action === 'accept-channel') {
      moved = true;
      const person = new WorkService(f.root);
      await person.dispatch(
        {
          action: 'accept-channel',
          operationId: randomUUID(),
          channel: 'main',
          viewId: rival.view.id,
          expectedHead: rival.view.head,
          expectedPrevious: null,
        },
        person.store.revision(),
        { keepOpen: true },
      );
    }
    return dispatch(...args);
  };
  await drainLandingBatches(f.work, 'main');
  let data = f.store.load();
  assert.equal(data.landingBatches[0].status, 'superseded');
  assert.equal(data.landingEntries[0].status, 'queued');
  assert.equal(data.landingEntries[0].arrivedAt, age);
  await drainLandingBatches(f.work, 'main');
  data = f.store.load();
  assert.equal(data.landingEntries[0].status, 'conflict');
  assert.equal(data.channelMoves.length, 1);
  assert.equal(f.content('same.txt'), 'main version\n');
});

test('two finish processes with different PATH share the owner execution environment', async t => {
  const f = await fixture(t);
  const a = await f.candidate('path-a.txt', 'a\n', false);
  const b = await f.candidate('path-b.txt', 'b\n', false);
  const script = `import { AgentWorkflow } from ${JSON.stringify(new URL('../dist/agent-workflow.js', import.meta.url).href)};
const result = await new AgentWorkflow(process.argv[1]).dispatch({action:'finish',laneId:process.argv[2],message:'Synthetic process finish',accept:true,waitMs:1});
console.log(JSON.stringify(result.result));`;
  await withQueueSlot(batchDirectory(f.work, 'main'), async () => {
    for (const [candidate, path] of [
      [a, process.env.PATH],
      [b, `/synthetic-bin:${process.env.PATH}`],
    ]) {
      const result = await promisify(execFile)(
        process.execPath,
        ['--input-type=module', '-e', script, f.root, candidate.lane.laneId],
        { env: { ...process.env, PATH: path } },
      );
      assert.equal(JSON.parse(result.stdout).status, 'waiting to land');
    }
  });
  await drainLandingBatches(f.work, 'main');
  const data = f.store.load();
  assert.deepEqual(
    data.landingEntries.map(entry => entry.status),
    ['accepted', 'accepted'],
  );
  assert.equal(f.content('path-a.txt'), 'a\n');
  assert.equal(f.content('path-b.txt'), 'b\n');
  assert.equal(data.runs.filter(run => !run.mainCheck).length, 1);
  assert.equal(data.runs.find(run => !run.mainCheck).status, 'passed');
  assert.equal(
    data.landingBatches[0].environment.fingerprint,
    data.runs.find(run => !run.mainCheck).environment.fingerprint,
  );
});

test('a retained batch executes and accepts with its recorded runtime after driver PATH changes', async t => {
  const f = await fixture(t, { remote: false });
  await f.candidate('resume-runtime.txt');
  const batch = await batchEdit(f.work, 'select-runtime', data => selectBatch(f.work, data, 'main'));
  const path = process.env.PATH;
  try {
    process.env.PATH = `/different-driver:${path}`;
    await drainLandingBatches(f.work, 'main');
  } finally {
    process.env.PATH = path;
  }
  const data = f.store.load();
  const run = data.runs.find(run => !run.mainCheck);
  assert.equal(run.status, 'passed');
  assert.deepEqual(run.environment, batch.environment);
  assert.equal(data.landingEntries[0].status, 'accepted');
});

test('incompatible queued runtime diagnostics name Node and check settings without values', async t => {
  const f = await fixture(t);
  await f.candidate('changed-runtime.txt');
  await batchEdit(f.work, 'synthetic-runtime', data => {
    const entry = data.landingEntries[0];
    entry.environmentSnapshot.node = 'synthetic-node-secret';
    entry.environmentSnapshot.env.FORGE_CHECK_SCOPED = 'synthetic-value-secret';
    entry.runtimeSnapshot.nodeExecutable = 'synthetic-executable-secret';
    entry.runtimeSnapshot.cli = 'synthetic-cli-secret';
  });
  await drainLandingBatches(f.work, 'main');
  const entry = f.store.load().landingEntries[0];
  assert.equal(entry.status, 'interrupted');
  assert.match(entry.reason, /node/);
  assert.match(entry.reason, /FORGE_CHECK_SCOPED/);
  assert.match(entry.reason, /nodeExecutable/);
  assert.doesNotMatch(entry.reason, /cli/);
  assert.match(entry.reason, /owner service.*submitter/);
  assert.match(entry.reason, /new finish\/land operation/);
  assert.doesNotMatch(entry.reason, /secret/);
  assert.equal(f.store.load().runs.length, 0);
});

test('finish of an already accepted Lane completes without another check or audit', async t => {
  const f = await fixture(t);
  await f.agent.dispatch({
    action: 'set-policy',
    operationId: randomUUID(),
    acceptance: { disjointFastPath: true },
  });
  const { lane } = await f.candidate('already.txt', 'accepted\n', false);
  const first = (
    await f.agent.dispatch({
      action: 'finish',
      laneId: lane.laneId,
      message: 'Land',
      accept: true,
      keepOpen: true,
    })
  ).result;
  assert.equal(first.status, 'accepted');
  await drainPostAccept(f.store);
  const before = f.store.load();
  const result = (
    await f.agent.dispatch({
      action: 'finish',
      laneId: lane.laneId,
      message: 'Complete landed Lane',
      accept: true,
    })
  ).result;
  assert.equal(result.status, 'already-accepted');
  assert.equal(result.complete, true);
  assert.equal(f.store.select('lanes', lane.laneId).state, 'completed');
  assert.equal(f.store.load().runs.length, before.runs.length);
  assert.equal(f.store.load().channelMoves.length, before.channelMoves.length);
});

test('ordinary run admission reproduces the cross-process PATH evidence mismatch', async t => {
  const f = await fixture(t);
  const candidate = await f.candidate('admission.txt', 'synthetic\n', false);
  const path = process.env.PATH;
  try {
    process.env.PATH = `/other-process:${path}`;
    await assert.rejects(
      f.work.dispatch(
        {
          action: 'run-check',
          operationId: randomUUID(),
          viewId: candidate.view.id,
          expectedHead: candidate.view.head,
          checkId: candidate.command.checkId,
          expectedDefinition: candidate.command.expectedDefinition,
          expectedEnvironment: candidate.command.expectedEnvironment,
        },
        f.store.revision(),
      ),
      {
        code: 'EVIDENCE_CHANGED',
        message: 'Check definition or runtime settings changed. Inspect them before starting.',
      },
    );
  } finally {
    process.env.PATH = path;
  }
  assert.equal(f.store.load().runs.length, 0);
});

for (const checked of [false, true])
  test(`legacy batch runtime ${checked ? 'recovers recorded run' : 're-admits unchecked entries'}`, async t => {
    const f = await fixture(t);
    const candidate = await f.candidate('legacy-runtime.txt');
    const batch = await batchEdit(f.work, 'legacy-select', data => selectBatch(f.work, data, 'main'));
    const composed = await composeBatch(f.work, batch);
    if (checked) {
      const prefix = composed.prefixes.at(-1);
      await f.work.dispatch(
        {
          action: 'run-check',
          operationId: prefix.runId,
          viewId: prefix.viewId,
          expectedHead: prefix.head,
          checkId: candidate.command.checkId,
          expectedDefinition: candidate.command.expectedDefinition,
          expectedEnvironment: batch.environment.fingerprint,
        },
        f.store.revision(),
      );
      await f.agent.dispatch({ action: 'observe', operationId: prefix.runId, waitMs: 10000 });
    }
    await batchEdit(f.work, 'legacy-snapshot', data => {
      delete data.landingBatches[0].environment;
      delete data.landingEntries[0].environmentSnapshot;
    });
    const path = process.env.PATH;
    try {
      if (checked) process.env.PATH = `/legacy-adopter:${path}`;
      await drainLandingBatches(f.work, 'main');
    } finally {
      process.env.PATH = path;
    }
    const data = f.store.load();
    assert.equal(data.landingEntries[0].status, 'accepted');
    assert.equal(data.landingBatches[0].status, checked ? 'completed' : 'superseded');
    assert.equal(data.runs.filter(run => !run.mainCheck).length, 1);
  });

test('format17 batches migrate to unified format18 and keep working without downgrade', async t => {
  const f = await fixture(t);
  await f.candidate('before-migration.txt');
  const before = f.store.load();
  assert.equal(before.schema, 17);
  const receipt = migrateIntentWork(f.store);
  let data = f.store.load();
  assert.equal(data.schema, 18);
  assert.equal(receipt.receipt.fromSchema, 17);
  assert.equal(receipt.receipt.toSchema, 18);
  assert.deepEqual(data.landingEntries, before.landingEntries);
  assert.equal(unifiedWorkSchema.safeParse(hostedPushWork(data)).success, true);
  assert.equal(hostedPushWork(data).schema, 18);
  await f.candidate('after-migration.txt');
  await drainLandingBatches(f.work, 'main');
  data = f.store.load();
  assert.equal(data.schema, 18);
  assert.ok(data.landingEntries.every(entry => entry.status === 'accepted'));
  assert.ok(data.intents.every(intent => typeof intent.title === 'string'));
  assert.equal(f.content('before-migration.txt'), 'before-migration.txt\n');
  assert.equal(f.content('after-migration.txt'), 'after-migration.txt\n');
});

for (const unifiedFirst of [false, true])
  test(`eight-entry remote batch promotes ${unifiedFirst ? 'unified format18 to 20' : 'legacy format17 to 19'} and survives migration/restart`, async t => {
    const f = await fixture(t);
    for (let i = 0; i < 8; i++) await f.candidate(`eight-${i}.txt`);
    if (unifiedFirst) migrateIntentWork(f.store);
    assert.equal(f.store.load().schema, unifiedFirst ? 18 : 17);
    const batch = await batchEdit(f.work, 'select-eight', data => selectBatch(f.work, data, 'main'));
    assert.equal(batch.entryIds.length, 8);
    const selected = f.store.load();
    assert.equal(selected.schema, unifiedFirst ? 20 : 19);
    assert.equal(hostedPushWork(selected).schema, selected.schema);
    const receipt = migrateIntentWork(f.store);
    if (!unifiedFirst) {
      assert.equal(receipt.receipt.fromSchema, 19);
      assert.equal(receipt.receipt.toSchema, 20);
    }
    const migrated = f.store.load();
    assert.equal(migrated.schema, 20);
    assert.deepEqual(migrated.landingBatches, selected.landingBatches);
    assert.deepEqual(migrated.landingEntries, selected.landingEntries);
    assert.equal(unifiedWorkSchema.safeParse(hostedPushWork(migrated)).success, true);
    assert.equal(migrateIntentWork(f.store).migrated, false);
    assert.deepEqual(f.store.load(), migrated);
    await drainLandingBatches(new AgentWorkflow(f.root).work, 'main');
    const data = f.store.load();
    assert.equal(data.schema, 20);
    assert.equal(data.landingBatches.length, 1);
    assert.equal(data.landingBatches[0].entryIds.length, 8);
    assert.equal(data.landingBatches[0].status, 'completed');
    assert.equal(data.runs.filter(run => !run.mainCheck).length, 1);
    assert.ok(data.landingEntries.every(entry => entry.status === 'accepted'));
    assert.equal(data.channelMoves.length, 1);
    for (let i = 0; i < 8; i++) assert.equal(f.content(`eight-${i}.txt`), `eight-${i}.txt\n`);
    // Candidate preparation pins Work's revision; finish the concurrent audit first.
    await drainPostAccept(f.store);
    await f.candidate('later-small.txt');
    await drainLandingBatches(f.work, 'main');
    assert.equal(f.store.load().schema, 20);
  });

for (const snapshot of [false, true])
  test(`legacy queued entry ${snapshot ? 'with' : 'without'} environment snapshot stays readable`, async t => {
    const f = await fixture(t, { remote: false });
    await f.candidate('legacy-entry.txt');
    await batchEdit(f.work, 'legacy-entry', data => {
      delete data.landingEntries[0].runtimeSnapshot;
      if (!snapshot) delete data.landingEntries[0].environmentSnapshot;
    });
    const path = process.env.PATH;
    try {
      process.env.PATH = `/legacy-shell:${path}`;
      await drainLandingBatches(f.work, 'main');
    } finally {
      process.env.PATH = path;
    }
    const entry = f.store.load().landingEntries[0];
    assert.equal(entry.status, snapshot ? 'accepted' : 'interrupted');
    if (!snapshot) {
      assert.match(entry.reason, /legacy entry/);
      assert.equal(f.store.load().runs.length, 0);
    }
  });

test('a changed check definition still interrupts before dispatch', async t => {
  const f = await fixture(t, { remote: false });
  await f.candidate('definition.txt');
  await f.agent.dispatch({
    action: 'define-check',
    checkId: f.check.checkId,
    name: 'verify',
    executable: process.execPath,
    args: ['-e', 'process.exit(0)'],
  });
  await drainLandingBatches(f.work, 'main');
  const entry = f.store.load().landingEntries[0];
  assert.equal(entry.status, 'interrupted');
  assert.match(entry.reason, /check definition/);
  assert.equal(f.store.load().runs.length, 0);
});

test('a replacement CLI preserves an unstarted retained batch', async t => {
  const f = await fixture(t, { remote: false });
  await f.candidate('unstarted.txt');
  await batchEdit(f.work, 'selected', data => selectBatch(f.work, data, 'main'));
  await batchEdit(f.work, 'different-cli', data => {
    data.landingEntries[0].runtimeSnapshot.cli = 'synthetic-other-build';
  });
  await drainLandingBatches(f.work, 'main');
  const data = f.store.load();
  assert.equal(data.landingBatches[0].status, 'completed');
  assert.equal(data.landingEntries[0].status, 'accepted');
  assert.equal(data.runs.filter(run => !run.mainCheck).length, 1);
});

test('explicit PATH passthrough remains a check-relevant submission pin', async t => {
  const f = await fixture(t, { remote: false });
  await f.agent.dispatch({
    action: 'define-check',
    checkId: f.check.checkId,
    name: 'verify',
    executable: process.execPath,
    args: ['-e', 'process.exit(0)'],
    env: ['PATH'],
  });
  await f.candidate('declared-path.txt');
  const path = process.env.PATH;
  try {
    process.env.PATH = `/declared-other-shell:${path}`;
    await drainLandingBatches(f.work, 'main');
  } finally {
    process.env.PATH = path;
  }
  const data = f.store.load();
  assert.equal(data.landingEntries[0].status, 'interrupted');
  assert.match(data.landingEntries[0].reason, /PATH/);
  assert.equal(data.runs.length, 0);
});

test('pending infra keeps the original batch and submission resumable without attributing source failure', async t => {
  const f = await fixture(t);
  const candidate = await f.candidate('pending.txt');
  const batch = await batchEdit(f.work, 'select', data => selectBatch(f.work, data, 'main'));
  await composeBatch(f.work, batch);
  const saved = f.store.select('landingBatches', batch.id),
    prefix = saved.prefixes.at(-1);
  const view = f.store.select('views', prefix.viewId);
  const run = {
    id: prefix.runId,
    viewId: view.id,
    head: view.head,
    base: view.base,
    inputs: view.inputs,
    dependencies: view.dependencies,
    check: f.store.load().checks[0],
    environment: checkEnvironment(),
    status: 'interrupted',
    startedAt: new Date().toISOString(),
    runner: { pid: process.pid, host: 'synthetic' },
    details: 'pending-infra: retained ambiguous dispatch',
    error: { code: 'GITHUB_ACTIONS_PENDING_INFRA', message: 'retained original execution' },
    backend: { requested: 'github-actions', actual: 'github-actions' },
  };
  f.store.locked(() => {
    const tx = f.store.records();
    tx.append('runs', run);
    f.store.commitRecords(tx);
  });
  t.mock.method(f.work, 'dispatch', async command => {
    assert.equal(command.action, 'run-check');
    assert.equal(command.operationId, prefix.runId);
    return { result: run };
  });
  const { evaluateBatch } = await import('../dist/landing-batch-check.js');
  assert.equal(await evaluateBatch(f.work, saved, { beforePublish: () => {} }, 0), false);
  const retained = f.store.select('landingBatches', batch.id);
  assert.equal(retained.status, 'checking');
  assert.equal(retained.settlement, undefined);
  assert.deepEqual(retained.prefixes, saved.prefixes);
  assert.equal(f.store.load().channelMoves.length, 0);
  const { queuedOutcome, landingSubmission } = await import('../dist/landing-submission.js');
  const entry = f.store.load().landingEntries[0];
  assert.equal(entry.status, 'checking');
  const submission = landingSubmission(
    f.store,
    entry.id,
    view.inputs[0],
    queuedOutcome(f.store, entry),
    'same-attempt',
  );
  assert.equal(submission.pendingReason, 'pending-infra');
  assert.equal(submission.terminal, false);
  const { finishQueuedBatch } = await import('../dist/agent-finish-batch.js');
  const attempt = { view: { viewId: candidate.view.id }, operations: {} };
  const receipt = await finishQueuedBatch(f.work, candidate.command, attempt);
  assert.equal(receipt.status, 'pending-infra');
  assert.equal(receipt.terminal, false);
  assert.equal(receipt.complete, false);
  assert.equal(receipt.code, 'GITHUB_ACTIONS_PENDING_INFRA');
  assert.equal(attempt.run.runId, prefix.runId);
});

test('canonical enqueue refuses a second operation for an in-progress Lane/head and allows one after it failed', async t => {
  const f = await fixture(t, { remote: false });
  const input = await f.candidate('bad.txt');
  await assert.rejects(enqueueLanding(f.work, { ...input.command, operationId: randomUUID() }, input.view), {
    code: 'LANDING_ALREADY_SUBMITTED',
  });
  assert.equal(f.store.load().landingEntries.length, 1);
  await drainLandingBatches(f.work, 'main');
  assert.equal(f.store.load().runs.filter(r => !r.mainCheck).length, 1);
  assert.equal(f.store.load().landingEntries[0].status, 'failed');
  // A finished (failed) entry no longer owns the Lane/head: a flaky check can be retried.
  await enqueueLanding(f.work, { ...input.command, operationId: randomUUID() }, input.view);
  assert.equal(f.store.load().landingEntries.length, 2);
});
