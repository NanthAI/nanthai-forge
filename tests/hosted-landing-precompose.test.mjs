// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import { readLandingTransition } from '../dist/hosted-landing.js';
import assert from 'node:assert/strict';
import { batchesFixture, synthetic, states } from './hosted-landing-batches-fixture.mjs';
import { hostedLandingStateSchema } from '../dist/hosted-landing.js';
import { hostedRecordSchema } from '../dist/hosted-records.js';
import { hostedFinishSchema } from '../dist/hosted-finish.js';
import { moduleUrl } from './convex-module.mjs';
import { compose, records } from './hosted-finish-fixture.mjs';
const precompose = await import(moduleUrl('../convex/projectHostedLandingPrecompose.ts'));
const observe = await import(moduleUrl('../convex/projectHostedFinishObserve.ts'));
const conflictPeers = await import(moduleUrl('../convex/projectHostedLandingConflictPeers.ts'));
const prior = Object.fromEntries(Object.keys(synthetic).map(k => [k, process.env[k]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [k, v] of Object.entries(prior)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

for (const grouped of [false, true, 'pipeline']) {
  test(`t23938/t19456 replay: waiting conflicts surface on one compose after ${grouped === 'pipeline' ? 'pipelined grouped' : grouped ? 'grouped' : 'single'} main movement`, async t => {
    const f = await batchesFixture(t, {
      count: 10,
      batching: grouped,
      batchMaxSize: grouped ? 2 : 8,
      concurrency: grouped === true ? 1 : 6,
      memberPaths: [
        'client.test.ts',
        'ServerBrowser.test.ts',
        'other-2',
        'other-3',
        'other-4',
        'other-5',
        'other-6',
        'other-7',
        'client.test.ts',
        'ServerBrowser.test.ts',
      ],
    });
    // Drive only runnable work, not future stall deadlines. Keep waiting agents
    // alive and the first exact check pending until the fixture passes it.
    const readyTasks = () => f.pending().filter(task => task.scheduledTime <= Date.now() + 30000);
    const drainReady = async () => {
      let n = 0;
      while (readyTasks().length) {
        assert(++n < 1000);
        await f.execute(readyTasks()[0]);
      }
    };
    await drainReady();
    const measuredFrom = f.counts.length;
    const conflictIds = f.entries.slice(8).map(e => e.state.id);
    for (
      let moves = 0;
      conflictIds.some(id => states(f).find(s => s.id === id).phase !== 'terminal-failed');
      moves++
    ) {
      assert(moves < 3, 'both conflicts found after the corresponding first landings');
      const first = f.runs().find(run => run.status === 'queued');
      assert(first, 'the queue head owns an exact check');
      await f.rawChecks.pass(await f.rawChecks.activate(first.id));
      await drainReady();
      // Scheduled main-race backoff is pending work; execute only its short
      // driver delay, never a queue/stall timeout.
      for (const task of f
        .pending()
        .filter(
          task => task.name === 'projectHostedFinishDriver:drive' && task.scheduledTime - Date.now() < 30000,
        ))
        await f.execute(task);
      await drainReady();
    }
    for (let i = 8; i < 10; i++) {
      const status = await f.current(f.entries[i].state.id);
      assert.equal(status.submission.error.code, 'COMPOSITION_CONFLICT');
      const conflictPath = i === 8 ? 'client.test.ts' : 'ServerBrowser.test.ts';
      assert(status.submission.error.message.includes(conflictPath));
      assert(status.submission.error.message.includes(f.entries[i - 8].lane.laneId));
      hostedLandingStateSchema.parse(status.submission);
      const page = JSON.parse(
        await f.tx('observeConflict', observe.page, {
          projectId: f.projectId,
          operationId: f.entries[i].request.operationId,
          nextVersion: 0,
        }),
      );
      assert.equal(page.submission.error.code, 'COMPOSITION_CONFLICT');
      assert.equal(page.submission.error.message, status.submission.error.message);
      const releasedPending = hostedFinishSchema.shape.pending.unwrap().omit({ precompose: true }).nullable();
      for (const event of page.events) {
        hostedLandingStateSchema.parse(event.submission);
        releasedPending.parse(event.pendingAttempt);
      }
      releasedPending.parse(page.pendingAttempt);
      const source = [...f.tables.projectHostedFinishes.values()].find(
        row => row.submissionId === f.entries[i].state.id,
      );
      assert.equal(JSON.parse(source.value).pending, null);
      const composed = [...f.tables.projectHostedComposes.values()].map(row => JSON.parse(row.value));
      const conflictCandidateId = status.submission.error.message.match(/^Candidate ([0-9a-f-]+)/)[1];
      const terminalAttempt = JSON.parse(
        [...f.tables.projectHostedLandingAttempts.values()].find(
          row => row.attemptId === status.submission.attemptId,
        ).value,
      );
      assert.equal(terminalAttempt.candidate.id, conflictCandidateId);
      assert.equal(terminalAttempt.candidate.head, null);
      assert.equal(terminalAttempt.check, null, 'conflict delivery allocates no check');
      const conflictCompose =
        composed.find(value => value.candidateId === conflictCandidateId) ??
        composed.findLast(value => value.dropped?.some(d => d.candidateId === f.entries[i].candidate.id));
      assert(
        [...f.tables.projectHostedAcceptances.values()].some(
          row => row.receiptId === conflictCompose.request.expectedMain.receiptId,
        ),
        'each terminal conflict is composed against an actual accepted main transition',
      );
      const summary =
        conflictCompose.conflictSummary ??
        conflictCompose.dropped.find(d => d.candidateId === f.entries[i].candidate.id);
      assert.deepEqual(summary.paths, [conflictPath]);
      const conflictBody = [...f.tables.projectHostedRecords.values()].find(
        row =>
          row.kind === 'candidate' &&
          row.key === status.submission.error.message.match(/^Candidate ([0-9a-f-]+)/)[1],
      );
      const bytes = f.tables.projectHostedRecordBodies.get(conflictBody.bodyId).value;
      const releasedCandidate = hostedRecordSchema.options[3].parse(JSON.parse(bytes));
      assert.deepEqual(Object.keys(releasedCandidate.result).sort(), ['conflicts', 'status']);
      const jobs = [...f.tables.projectHostedComposes.values()]
        .map(row => JSON.parse(row.value))
        .filter(
          value =>
            value.request.expectedMain.receiptId === conflictCompose.request.expectedMain.receiptId &&
            (value.request.inputs.root.sha256 === f.entries[i].selection.request.inputs.root.sha256 ||
              value.dropped?.some(d => d.candidateId === f.entries[i].candidate.id)),
        );
      assert.equal(
        jobs.length,
        1,
        'one compose from the conflicting main transition to the waiting conflict',
      );
    }
    const landed = states(f).filter(s => s.phase === 'landed').length;
    assert(landed > 0, 'the replay includes actual accepted main movement');
    assert(landed < 8, 'conflicts arrive before queue head');
    assert.equal(f.metrics.convexStorageCalls, 0, 'source bytes stay in R2');
    t.diagnostic(
      JSON.stringify({
        grouped,
        landed: states(f).filter(s => s.phase === 'landed').length,
        sourceJobs: f.metrics.sourceJobs,
        controlCalls: f.counts.length - measuredFrom,
        documents: f.counts.slice(measuredFrom).reduce((n, c) => n + c.documents, 0),
        writes: f.counts.slice(measuredFrom).reduce((n, c) => n + c.writes, 0),
        maxDocumentsPerCall: Math.max(...f.counts.slice(measuredFrom).map(c => c.documents)),
        scans: f.counts
          .filter(c => c.name === 'precomposeStart')
          .map(({ documents, writes, readBytes }) => ({ documents, writes, readBytes })),
      }),
    );
  });
}

test('50 waiting entries: one bounded scan coalesces repeated main events; idle reads schedule no work', async t => {
  const f = await batchesFixture(t, { count: 50, batching: false });
  const main = f.moveMain();
  const args = { projectId: f.projectId, receiptIds: [main.receipt.id] };
  const before = f.counts.length;
  assert.equal(
    await f.transaction('precompose-budget', { _handler: precompose.precomposeWaiting }, args),
    10,
  );
  assert.equal(await f.transaction('precompose-replay', { _handler: precompose.precomposeWaiting }, args), 0);
  const cost = f.counts.slice(before).find(c => c.name === 'precompose-budget');
  assert(cost.documents < 1600 && cost.readBytes < 2 * 1024 * 1024);
  let pages = 1;
  for (const task of f.pending().filter(task => task.name === 'projectHostedLandingPrecompose:start')) {
    // Drain metadata continuations only; source jobs remain independently scheduled.
    await f.execute(task);
    pages++;
  }
  while (f.pending().some(task => task.name === 'projectHostedLandingPrecompose:start')) {
    await f.execute(f.pending().find(task => task.name === 'projectHostedLandingPrecompose:start'));
    pages++;
  }
  assert(pages <= 10, 'two replayed bounded scans, no per-item function loop');
  assert([...f.tables.projectHostedFinishes.values()].every(row => JSON.parse(row.value).pending));
  const tasks = f.pending().length;
  await f.current(f.entries.at(-1).state.id);
  assert.equal(f.pending().length, tasks, 'finite reads never schedule background work');
  const obsolete = await f.transaction(
    'precompose-obsolete',
    { _handler: precompose.precomposeWaiting },
    { ...args, receiptIds: [f.entries[0].request.expectedMain.receiptId] },
  );
  assert.equal(obsolete, 0);
  t.diagnostic(
    JSON.stringify({
      entries: 50,
      scanPages: pages,
      sourceReservations: 50,
      extraReplayReservations: 0,
      idleCalls: 0,
      documents: cost.documents,
      ranges: cost.ranges,
      writes: cost.writes,
      readBytes: cost.readBytes,
      writeBytes: cost.writeBytes,
      rssBytes: process.memoryUsage().rss,
    }),
  );
});

test('group conflict peers exclude earlier dropped members that never entered its composed prefix', async t => {
  const f = await batchesFixture(t, {
    count: 4,
    memberPaths: ['collision', 'collision', 'collision', 'other'],
  });
  let ticks = 0;
  while (f.pending().some(task => task.scheduledTime <= Date.now() + 30000)) {
    assert(++ticks < 300);
    await f.execute(f.pending().find(task => task.scheduledTime <= Date.now() + 30000));
  }
  const pending = await f.current(f.entries[2].state.id);
  assert.equal(pending.submission.phase, 'queued');
  assert.equal(pending.submission.error, null, 'an unaccepted prefix is advisory until its group settles');
  const row = [...f.tables.projectHostedLandingRequests.values()].find(
    row => row.submissionId === f.entries[2].state.id,
  );
  const advice = JSON.parse(row.wouldConflict);
  assert.equal(advice.predecessor.groupId, pending.submission.batchId);
  assert.deepEqual(advice.paths, ['collision']);
  const batch = JSON.parse([...f.tables.projectHostedLandingBatches.values()][0].value);
  const peers = await f.transaction(
    'retained-prefix-peers',
    {
      _handler: ctx =>
        conflictPeers.batchConflictPeers(ctx, f.projectId, batch, f.entries[2].candidate.id, [
          f.entries[1].candidate.id,
          f.entries[2].candidate.id,
        ]),
    },
    {},
  );
  assert(peers.includes(f.entries[0].lane.laneId));
  assert(!peers.includes(f.entries[1].lane.laneId), 'an earlier dropped member never entered this prefix');
  assert(!peers.includes(f.entries[3].lane.laneId), 'a later survivor is not part of this prefix');
  await f.passChecks();
  await f.drain();
  const status = await f.current(f.entries[2].state.id);
  assert.equal(status.submission.error?.code, 'COMPOSITION_CONFLICT');
  const attempt = [...f.tables.projectHostedLandingAttempts.values()]
    .map(row => JSON.parse(row.value))
    .find(attempt => attempt.id === status.submission.attemptId);
  const candidateRow = await f.c.run('read-settled-conflict', records.readHostedRecord, {
    ...f.c.auth,
    kind: 'candidate',
    key: attempt.candidate.id,
  });
  const candidate = JSON.parse(candidateRow.value);
  const conflicts = JSON.parse(f.c.objects.get(candidate.result.conflicts.sha256));
  assert.deepEqual(
    conflicts.paths.map(entry => entry.path),
    ['collision'],
  );
  assert.equal(conflicts.left, f.currentMain().head, 'the conflict root pins actual accepted main');
  assert.equal(attempt.main.head, f.currentMain().head, 'terminal evidence uses actual accepted main');
  assert.equal(attempt.main.receiptId, f.currentMain().receipt.id);
  assert.equal(states(f).find(state => state.id === f.entries[0].state.id).phase, 'landed');
});

test('a delayed main event preserves its conflict priority after a newer disjoint landing', async t => {
  const f = await batchesFixture(t, {
    count: 10,
    batching: false,
    memberPaths: [
      'client.test.ts',
      'newer-independent',
      'other-2',
      'other-3',
      'other-4',
      'other-5',
      'other-6',
      'other-7',
      'other-8',
      'client.test.ts',
    ],
  });
  let ticks = 0;
  const drainWithoutCompletions = async () => {
    const ready = () =>
      f
        .pending()
        .find(
          task =>
            task.name !== 'projectHostedAcceptance:complete' && task.scheduledTime <= Date.now() + 30000,
        );
    while (ready()) {
      assert(++ticks < 1000);
      await f.execute(ready());
    }
  };
  await drainWithoutCompletions();
  let run = f.runs().find(run => run.status === 'queued');
  await f.rawChecks.pass(await f.rawChecks.activate(run.id));
  await drainWithoutCompletions();
  const firstReceipt = f.currentMain().receipt.id;
  run = f.runs().find(run => run.status === 'queued');
  await f.rawChecks.pass(await f.rawChecks.activate(run.id));
  await drainWithoutCompletions();
  const main = f.currentMain();
  assert.notEqual(main.receipt.id, firstReceipt);
  assert.equal(states(f).filter(s => s.phase === 'landed').length, 2);
  const delayed = f
    .pending()
    .find(
      task => task.name === 'projectHostedAcceptance:complete' && task.args[0].receiptId === firstReceipt,
    );
  assert(delayed.args[0].precompose, 'the existing completion wake carries the main event');
  await f.execute(delayed);
  await drainWithoutCompletions();
  const status = await f.current(f.entries[9].state.id);
  assert.equal(status.submission.error?.code, 'COMPOSITION_CONFLICT');
  assert(status.submission.error.message.includes('client.test.ts'));
  assert(status.submission.error.message.includes(f.entries[0].lane.laneId));
  const jobs = [...f.tables.projectHostedComposes.values()]
    .map(row => JSON.parse(row.value))
    .filter(
      c =>
        c.request.inputs.root.sha256 === f.entries[9].selection.request.inputs.root.sha256 &&
        c.request.expectedMain.receiptId === main.receipt.id,
    );
  assert.equal(jobs.length, 1, 'one compose on actual main retains the earlier conflicting landing context');
});

test('clean waiting source is composed once, cached and checked before ordinary acceptance', async t => {
  const f = await batchesFixture(t, { count: 2, batching: false });
  const drain = async () => {
    let ticks = 0;
    while (f.pending().some(task => task.scheduledTime <= Date.now() + 30000)) {
      assert(++ticks < 300);
      await f.execute(f.pending().find(task => task.scheduledTime <= Date.now() + 30000));
    }
  };
  await drain();
  let run = f.runs().find(run => run.status === 'queued');
  await f.rawChecks.pass(await f.rawChecks.activate(run.id));
  await drain();
  assert.equal((await f.current(f.entries[0].state.id)).submission.phase, 'landed');
  assert.equal((await f.current(f.entries[1].state.id)).submission.phase, 'checking');
  assert.equal(f.metrics.sourceJobs, 1, 'the speculative result is not composed a second time at queue head');
  run = f.runs().find(run => run.status === 'queued');
  await f.rawChecks.pass(await f.rawChecks.activate(run.id));
  await drain();
  assert.equal((await f.current(f.entries[1].state.id)).submission.phase, 'landed');
  assert.equal(f.metrics.sourceJobs, 1);
  assert.equal(f.metrics.convexStorageCalls, 0);
});

test('a main move during an older probe is retained and composed before the waiting entry resumes', async t => {
  const f = await batchesFixture(t, { count: 1, batching: false });
  const first = f.moveMain();
  const args = { projectId: f.projectId, receiptIds: [first.receipt.id] };
  assert.equal(await f.transaction('first-probe', { _handler: precompose.precomposeWaiting }, args), 1);
  const firstPending = JSON.parse(f.row(f.entries[0].state.id).value).pending;
  const second = f.moveMain({ sameHead: true });
  const state = f.c.state(
    [...JSON.parse(f.c.objects.get(first.head)).files, f.c.file('member-0', 'accepted competing content')],
    [first.head],
  );
  f.c.register(state);
  f.patch('projectHostedChannels', f.mainId, {
    selection: JSON.stringify({ ...second, head: state.sha256 }),
  });
  const main = f.currentMain();
  const next = { ...args, receiptIds: [main.receipt.id], peerLanes: [f.entries[0].lane.laneId] };
  assert.equal(await f.transaction('next-probe', { _handler: precompose.precomposeWaiting }, next), 0);
  assert.equal(await f.transaction('next-replay', { _handler: precompose.precomposeWaiting }, next), 0);
  const retained = JSON.parse(f.row(f.entries[0].state.id).value).pending;
  assert.equal(retained.operations.compose, firstPending.operations.compose, 'do not cancel the running job');
  assert.deepEqual(retained.precompose.next.main, { head: main.head, receiptId: main.receipt.id });
  const unobserved = f.moveMain({ sameHead: true });
  let ticks = 0;
  // Isolate advisory event coalescing. A concurrent useful queue claim can now
  // take ownership; its supersession and exact reuse have dedicated replays.
  const advisory = task =>
    task.name !== 'projectHostedLandingDriver:drive' && task.scheduledTime <= Date.now() + 30000;
  while (f.pending().some(advisory)) {
    assert(++ticks < 300);
    await f.execute(f.pending().find(advisory));
  }
  const status = await f.current(f.entries[0].state.id);
  assert.equal(status.submission.error?.code, 'COMPOSITION_CONFLICT');
  assert(status.submission.error.message.includes('member-0'));
  assert(status.submission.error.message.includes(f.entries[0].lane.laneId));
  assert.equal(f.metrics.sourceJobs, 2, 'one old compose and one compose for the retained main move');
  const receipts = [...f.tables.projectHostedComposes.values()].map(
    row => JSON.parse(row.value).request.expectedMain.receiptId,
  );
  assert(receipts.includes(main.receipt.id));
  assert(!receipts.includes(unobserved.receipt.id), 'retain the exact notified revision and its peers');
  assert.equal(f.tables.projectHostedCheckRuns.size, 0, 'probe continuation never starts a check');
});

test('N=50: a potentially conflicting tail entry starts before known disjoint probes', async t => {
  const f = await batchesFixture(t, { count: 50, batching: false });
  const main = f.moveMain();
  const args = { projectId: f.projectId, receiptIds: [main.receipt.id], paths: ['member-49'] };
  assert.equal(
    await f.transaction('priority-probe-page', { _handler: precompose.precomposeWaiting }, args),
    0,
  );
  const seen = new Set(),
    order = [];
  let pages = 1;
  while (f.pending().some(task => task.name === 'projectHostedLandingPrecompose:start')) {
    assert(++pages <= 11);
    await f.execute(f.pending().find(task => task.name === 'projectHostedLandingPrecompose:start'));
    for (const row of f.tables.projectHostedFinishes.values())
      if (JSON.parse(row.value).pending && !seen.has(row.submissionId)) {
        seen.add(row.submissionId);
        order.push(row.submissionId);
      }
  }
  assert.equal(order[0], f.entries[49].state.id);
  assert.equal(order.length, 2, 'all possible conflicts and only the next known-disjoint source are warmed');
  assert.equal(new Set(order).size, 2, 'no duplicate source reservation across passes');
});

for (const notified of [false, true])
  test(`an obsolete accepted-head conflict cannot fail an entry after main fixes it (${notified ? 'notified' : 'unobserved'} newer move)`, async t => {
    const f = await batchesFixture(t, { count: 1, batching: false });
    const baseline = JSON.parse(f.c.objects.get(f.currentMain().head));
    const moving = f.moveMain();
    const conflict = f.c.state([...baseline.files, f.c.file('member-0', 'competing main')], [moving.head]);
    f.c.register(conflict);
    f.patch('projectHostedChannels', f.mainId, {
      selection: JSON.stringify({ ...moving, head: conflict.sha256 }),
    });
    await f.transaction(
      'old-conflict-probe',
      { _handler: precompose.precomposeWaiting },
      { projectId: f.projectId, receiptIds: [moving.receipt.id] },
    );
    await f.execute(f.pending().find(task => task.name === 'projectHostedFinishDriver:drive'));
    const isSource = task =>
      task.name.startsWith('projectConvexSource') ||
      /^projectHostedComposeJobs:(complete|publish)$/.test(task.name);
    let ticks = 0;
    while (f.pending().some(isSource)) {
      assert(++ticks < 100);
      await f.execute(f.pending().find(isSource));
    }
    assert(
      [...f.tables.projectHostedComposes.values()].some(row =>
        JSON.parse(row.value).conflictSummary?.paths.includes('member-0'),
      ),
      'the old job really found a conflict',
    );
    const newer = f.moveMain({ sameHead: true });
    const fixed = f.c.state([...baseline.files, f.c.file('member-0', 'member 0')], [conflict.sha256]);
    f.c.register(fixed);
    f.patch('projectHostedChannels', f.mainId, {
      selection: JSON.stringify({ ...newer, head: fixed.sha256 }),
    });
    if (notified)
      await f.transaction(
        'new-main-probe',
        { _handler: precompose.precomposeWaiting },
        { projectId: f.projectId, receiptIds: [newer.receipt.id] },
      );
    const drain = async () => {
      while (f.pending().some(task => task.scheduledTime <= Date.now() + 30000)) {
        assert(++ticks < 500);
        await f.execute(f.pending().find(task => task.scheduledTime <= Date.now() + 30000));
      }
    };
    await drain();
    assert.equal((await f.current(f.entries[0].state.id)).submission.error, null);
    assert(
      [...f.tables.projectHostedLandingObservations.values()].every(
        row =>
          readLandingTransition(
            row.value,
            JSON.parse(
              [...f.tables.projectHostedLandingRequests.values()].find(
                request => request.submissionId === row.submissionId,
              ).value,
            ),
          ).submission.error?.code !== 'COMPOSITION_CONFLICT',
      ),
    );
    await f.passChecks();
    await drain();
    assert.equal((await f.current(f.entries[0].state.id)).submission.phase, 'landed');
    assert.equal(f.metrics.sourceJobs, 2, 'one obsolete compose and one compose on the fixed accepted head');
  });

test('a failed speculative source job leaves the original entry queued for ordinary composition', async t => {
  const finishCompose = await import(moduleUrl('../convex/projectHostedFinishCompose.ts'));
  const finishStore = await import(moduleUrl('../convex/projectHostedFinishStore.ts'));
  const operations = await import(moduleUrl('../convex/projectHostedOperations.ts'));
  const f = await batchesFixture(t, { count: 1, batching: false });
  const main = f.moveMain(),
    id = f.entries[0].state.id;
  await f.transaction(
    'reserve-probe',
    { _handler: precompose.precomposeWaiting },
    { projectId: f.projectId, receiptIds: [main.receipt.id] },
  );
  const identity = { projectId: f.projectId, submissionId: id };
  await f.transaction(
    'failed-probe',
    {
      _handler: async ctx => {
        const { row, value } = await finishStore.loadFinish(ctx, identity);
        const source = await finishCompose.prepareFinishCompose(ctx, identity, value);
        await operations.finishHostedOperation(ctx, {
          projectId: f.projectId,
          actor: source.row.actor,
          operationId: value.pending.operations.compose,
          receipt: {
            attemptId: source.operation.firstAttempt.id,
            at: source.operation.firstAttempt.at,
            outcome: {
              status: 'failed',
              error: { code: 'SOURCE_WORKER_UNAVAILABLE', message: 'synthetic interrupted worker' },
            },
          },
        });
        await finishCompose.installFinishCompose(ctx, row, value);
      },
    },
    {},
  );
  const status = await f.current(id);
  assert.equal(status.submission.phase, 'queued');
  assert.equal(status.submission.error, null);
  assert.equal(status.submission.attemptId, f.entries[0].state.attemptId);
  assert.equal(JSON.parse(f.row(id).value).pending, null);
  assert.equal(f.tables.projectHostedCheckRuns.size, 0);
});

test('an idle queue schedules no background precomposition work', async t => {
  const f = await batchesFixture(t, { count: 0 });
  const before = f.pending().length;
  await f.transaction(
    'idle-main-event',
    {
      _handler: ctx =>
        precompose.scheduleLandingPrecompose(ctx, {
          projectId: f.projectId,
          receiptIds: [f.currentMain().receipt.id],
        }),
    },
    {},
  );
  assert.equal(f.pending().length, before);
  const cost = f.counts.find(c => c.name === 'idle-main-event');
  assert.equal(cost.writes, 0);
});

test('precomposition does not read a revoked submitter Candidate or block its metadata window', async t => {
  const f = await batchesFixture(t, { count: 2, batching: false });
  const main = f.moveMain();
  f.patch('hostedProjects', f.projectId, { owner: 'new-owner' });
  const started = await f.transaction(
    'revoked-probes',
    { _handler: precompose.precomposeWaiting },
    { projectId: f.projectId, receiptIds: [main.receipt.id], paths: ['member-0'] },
  );
  assert.equal(started, 0);
  assert([...f.tables.projectHostedFinishes.values()].every(row => JSON.parse(row.value).pending === null));
});

for (const failure of ['changed-digest', 'revoked-publisher'])
  test(`unavailable trigger coverage (${failure}) probes conservatively instead of skipping waiting entries`, async t => {
    const f = await batchesFixture(t, { count: 2, batching: false });
    const unchanged = await f.c.lane(f.c.baseline);
    const candidate = await compose(f.c, f.c.selection([unchanged]));
    assert.deepEqual(candidate.governance.paths, []);
    const row = await f.c.run('trigger-pin', records.readHostedRecord, {
      ...f.c.auth,
      kind: 'candidate',
      key: candidate.id,
    });
    const main = f.moveMain();
    const started = await f.transaction(
      'unknown-trigger-probes',
      { _handler: precompose.precomposeWaiting },
      {
        projectId: f.projectId,
        receiptIds: [main.receipt.id],
        candidate: {
          id: candidate.id,
          actor: failure === 'revoked-publisher' ? 'revoked-user' : f.c.auth.actor,
          digest: failure === 'changed-digest' ? '0'.repeat(64) : row.digest,
        },
      },
    );
    assert.equal(started, 2, 'untrusted disjoint coverage cannot suppress either source merge');
    assert(states(f).every(state => state.phase === 'queued' && state.error === null));
  });
