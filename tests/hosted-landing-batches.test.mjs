// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { batchesFixture, states, synthetic } from './hosted-landing-batches-fixture.mjs';
import { policyPreset } from '../dist/autonomy-policy.js';
import { batchEligible } from '../dist/hosted-landing-batch.js';
import { landingApi, compose } from './hosted-finish-fixture.mjs';
const prior = Object.fromEntries(Object.keys(synthetic).map(k => [k, process.env[k]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [k, v] of Object.entries(prior)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

test('incident replay: four finishes in one minute share one full check and one atomic main publication', async t => {
  const f = await batchesFixture(t);
  const arrivals = states(f).map(s => Date.parse(s.at));
  assert(Math.max(...arrivals) - Math.min(...arrivals) < 60_000);
  assert.equal(f.runs().length, 0, 'eligible finishes defer check reservation to selection');
  await f.drain();
  assert.equal(f.runs().length, 1);
  const run = f.runs()[0];
  assert.equal(run.gate.mode, 'full');
  assert.equal(new Set(states(f).map(s => s.batchId)).size, 1);
  assert(states(f).every(s => s.phase === 'checking'));
  const oldMain = f.currentMain();
  await f.passChecks();
  await f.drain();
  assert(states(f).every(s => s.phase === 'landed'));
  assert.equal(f.tables.projectHostedAcceptances.size, 4);
  const receipts = [...f.tables.projectHostedAcceptances.values()].map(r => JSON.parse(r.value));
  assert(receipts.every(r => r.check.runId === run.id && r.candidate.head === run.request.expectedHead));
  assert(receipts.every(r => r.previous.head === oldMain.head));
  assert.deepEqual(
    receipts.map(r => r.submissionId),
    f.entries.map(e => e.state.id),
  );
  assert.equal(f.currentMain().head, run.request.expectedHead);
  assert.deepEqual(
    f.publications,
    [{ receipts: 4, mainMoves: 1, landed: 4 }],
    'all receipts and the main CAS commit in one transaction',
  );
  const finalFiles = JSON.parse(f.c.objects.get(f.currentMain().head)).files.map(f => f.path);
  for (let i = 0; i < 4; i++) assert(finalFiles.includes(`member-${i}`));
  for (const entry of f.entries) assert.equal((await f.readLane(entry.lane.laneId)).state, 'completed');
  for (const entry of f.entries) assert.equal((await f.enqueue(entry.request)).phase, 'landed');
  assert.equal(f.runs().length, 1, 'original-operation replay starts no checks');
  assert.equal(f.pending().length, 0);
});

test('a failed batch checks both halves at once; a culprit retains its own named test', async t => {
  const f = await batchesFixture(t);
  const runOf = i =>
    [...f.tables.projectHostedLandingRequests.values()].find(r => r.submissionId === f.entries[i].state.id)
      .runId;
  const settle = async () => {
    for (const run of f.runs().filter(r => r.status === 'queued')) {
      if (run.id === runOf(1)) await f.fail(run.id);
      else await f.rawChecks.pass(await f.rawChecks.activate(run.id));
    }
    await f.drain();
  };
  await f.drain();
  await f.fail(f.runs()[0].id, 'tests/combined.test.mjs');
  await f.drain();
  const halves = f.runs().filter(r => r.status === 'queued');
  assert.equal(halves.length, 2, 'both halves compose and check in parallel');
  assert(
    states(f).every(s => !s.batchSolo),
    'halves are cohorts, not serial singles',
  );
  await settle();
  assert.equal(states(f).filter(s => s.phase === 'landed').length, 2, 'the good half lands');
  for (let i = 0; i < 4 && states(f).some(s => s.phase === 'checking'); i++) await settle();
  assert.equal(states(f).filter(s => s.phase === 'checking').length, 0);
  // One batch, two halves, two singles of the failed half; the passing single
  // checked on the old main rechecks once on main including the good half.
  assert.equal(f.runs().length, 6);
  const receipts = [...f.tables.projectHostedAcceptances.values()].map(r => JSON.parse(r.value));
  const single = receipts.find(r => r.submissionId === f.entries[0].state.id);
  assert.equal(
    single.previous.head,
    receipts.find(r => r.submissionId === f.entries[2].state.id).candidate.head,
  );
  assert.equal(states(f).filter(s => s.phase === 'landed').length, 3);
  const failed = states(f).find(s => s.phase === 'terminal-failed');
  assert.equal(failed.id, f.entries[1].state.id);
  assert.match(failed.error.message, /tests\/member-1.test.mjs/);
  assert(!JSON.parse(f.c.objects.get(f.currentMain().head)).files.some(f => f.path === 'member-1'));
  assert.equal(f.pending().length, 0);
});

test('one member compose conflict is retained without blocking the rest or adding checks', async t => {
  const f = await batchesFixture(t, { conflict: true });
  await f.drain();
  const batch = JSON.parse([...f.tables.projectHostedLandingBatches.values()][0].value);
  const selected = await f.c.progress({ request: { operationId: batch.composeOperationId } });
  const fixed = await f.c.compute(selected.input);
  assert.equal(
    fixed.head,
    f.runs()[0].request.expectedHead,
    'fixed and stepped workers stack identical source',
  );
  assert.deepEqual(JSON.parse(fixed.manifest).dropped, selected.state.dropped);
  assert.equal(f.runs().length, 1);
  await f.passChecks();
  await f.drain();
  assert.equal(states(f).filter(s => s.phase === 'landed').length, 3);
  const failed = states(f).find(s => s.phase === 'terminal-failed');
  assert.equal(failed.error.code, 'COMPOSITION_CONFLICT');
  const pins = JSON.parse(
    [...f.tables.projectHostedLandingAttempts.values()].find(r => r.attemptId === failed.attemptId).value,
  );
  assert.equal(pins.candidate.head, null, 'member has its own resolvable conflict Candidate');
  assert.match(failed.error.message, /conflict/i);
  assert.equal(f.runs().length, 1);
});

test('governance eligibility preserves supervised, contributor and protected-path review', () => {
  const candidate = {
    kind: 'candidate',
    result: { status: 'clean' },
    governance: { paths: ['src/a.ts'], ownerInputs: true },
  };
  const project = { owner: 'owner', visibility: 'public' },
    actor = { id: 'owner', kind: 'agent' };
  assert(batchEligible(project, policyPreset('trusted'), actor, candidate));
  assert(!batchEligible(project, policyPreset('supervised'), actor, candidate));
  assert(!batchEligible(project, policyPreset('trusted'), { ...actor, id: 'contributor' }, candidate));
  assert(!batchEligible(project, policyPreset('trusted'), actor, { ...candidate, governance: undefined }));
  assert(
    !batchEligible(project, policyPreset('trusted'), actor, {
      ...candidate,
      governance: { paths: ['.github/workflows/a.yml'], ownerInputs: false },
    }),
  );
  assert(!batchEligible(project, policyPreset('trusted'), { ...actor, kind: 'person' }, candidate));
});

test('cancellation during the shared check cannot publish the cancelled member', async t => {
  const f = await batchesFixture(t);
  await f.drain();
  await f.transaction('batch-cancel', landingApi.cancel, {
    projectId: f.projectId,
    request: JSON.stringify({
      operationId: randomUUID(),
      authorityEpoch: 1,
      submissionId: f.entries[1].state.id,
    }),
  });
  await f.passChecks();
  await f.drain();
  assert.equal(
    states(f).filter(s => s.phase === 'landed').length,
    0,
    'checked stack containing a cancelled member is never published',
  );
  for (let i = 0; i < 3; i++) {
    await f.passChecks();
    await f.drain();
  }
  assert.equal(states(f).filter(s => s.phase === 'landed').length, 3);
  assert.equal(states(f).find(s => s.id === f.entries[1].state.id).error.code, 'LANDING_CANCELLED');
  assert(!JSON.parse(f.c.objects.get(f.currentMain().head)).files.some(f => f.path === 'member-1'));
});

test('a main receipt race recomposes the whole cohort without transferring evidence or splitting checks', async t => {
  const f = await batchesFixture(t, { count: 8 });
  await f.drain();
  const checkedHead = f.runs()[0].request.expectedHead;
  const moved = f.moveMain();
  await f.passChecks();
  await f.drain();
  assert.equal(f.tables.projectHostedAcceptances.size, 0);
  assert.equal(f.currentMain().head, moved.head);
  assert.notEqual(f.runs().find(r => r.status === 'queued').request.expectedHead, checkedHead);
  for (let i = 0; i < 4; i++) {
    await f.passChecks();
    await f.drain();
  }
  assert(states(f).every(s => s.phase === 'landed'));
  assert.equal(f.runs().length, 2);
  assert(states(f).every(s => !s.batchSolo));
  const receipts = [...f.tables.projectHostedAcceptances.values()].map(r => JSON.parse(r.value));
  assert(receipts.every(r => r.check.runId !== f.runs()[0].id));
  assert.equal(new Set(receipts.map(r => r.check.runId)).size, 1);
  assert(JSON.parse(f.c.objects.get(f.currentMain().head)).files.some(f => f.path === 'accepted.txt'));
});

test('a replaced check attempt starts with empty progress, not the previous attempt test counts (9f94c28a)', async t => {
  const f = await batchesFixture(t, { count: 4 });
  await f.drain();
  const first = f.runs()[0];
  const before = states(f).map(s => s.attemptId);
  f.moveMain();
  const active = await f.rawChecks.activate(first.id);
  for (let i = 0; i < active.plan.shardCount; i++) await f.rawChecks.callback(f.rawChecks.shard(active, i));
  await f.rawChecks.callback(
    f.rawChecks.complete(active, 'passed', {
      contractReports: {
        'tests/a.test.mjs': { failed: false, durationMs: 1 },
        'tests/b.test.mjs': { failed: false, durationMs: 1 },
      },
    }),
  );
  // Step the queue: the old attempt reports its counts, then main replaces it.
  let counted = false;
  for (let steps = 0; f.pending().length; steps++) {
    assert(steps < 100, 'bounded');
    await f.execute(f.pending()[0]);
    const now = states(f);
    if (now.every((s, i) => s.attemptId === before[i])) counted ||= now.some(s => s.testFiles);
  }
  assert(counted, 'the replaced attempt reported test counts to its members');
  const now = states(f);
  assert(
    now.every((s, i) => s.attemptId !== before[i]),
    'main moved: every member got a new attempt',
  );
  for (const state of now) {
    assert.equal(state.testFiles, undefined, 'a new attempt carries no counts from the replaced one');
    assert.equal(state.checkProgress, undefined, 'a new attempt carries no progress digest');
  }
});

test('a changed supervised policy returns every passing member to individual review', async t => {
  const f = await batchesFixture(t);
  await f.drain();
  f.patch('hostedProjects', f.projectId, { autonomyPolicy: policyPreset('supervised') });
  await f.passChecks();
  await f.drain();
  await f.passChecks();
  await f.drain();
  assert.equal(f.tables.projectHostedAcceptances.size, 0);
  assert(states(f).some(s => s.observation.pendingReason === 'waiting-for-review'));
  assert.equal(f.pending().length, 0);
});

test('lost batch upload replies replay the same generation without duplicate source jobs or checks', async t => {
  const f = await batchesFixture(t);
  // Select the batch, then crash after its first metadata upload. The durable
  // ordinary finish watchdog retries that same object and IO generation.
  while (!f.tables.projectHostedLandingBatches.size) await f.execute(f.pending()[0]);
  const retainedBatch = JSON.parse([...f.tables.projectHostedLandingBatches.values()][0].value);
  const leader = retainedBatch.leaderId ?? retainedBatch.id;
  let lostReply = false;
  for (let step = 0; step < 12 && !lostReply; step++) {
    const task = f
      .pending()
      .find(task => task.name === 'projectHostedFinishDriver:drive' && task.args[0].submissionId === leader);
    assert(task, 'batch metadata step remains resumable');
    try {
      await f.execute(task, 'before-resume');
    } catch (error) {
      assert.match(error.message, /synthetic crash after upload/);
      lostReply = true;
    }
  }
  assert(lostReply, 'crash after a missing metadata page upload, beyond reused pages');
  await f.drain();
  await f.passChecks();
  await f.drain();
  assert(states(f).every(s => s.phase === 'landed'));
  assert.equal(f.runs().length, 1);
});

test('changed exact run pins cannot authorize any shared publication', async t => {
  const f = await batchesFixture(t);
  await f.drain();
  await f.passChecks();
  const row = [...f.tables.projectHostedCheckRuns.values()][0],
    run = JSON.parse(row.value);
  run.request.expectedHead = 'e'.repeat(64);
  f.patch('projectHostedCheckRuns', row._id, { value: JSON.stringify(run) });
  await f.drain();
  assert.equal(f.tables.projectHostedAcceptances.size, 0);
  assert(
    f.runs().some(r => r.status === 'queued'),
    'members retain an exact single fallback',
  );
  const transition = JSON.parse([...f.tables.projectHostedLandingBatches.values()][0].value).transition;
  assert(transition?.code && transition.message, 'retain the structured failure that caused fallback');
  assert(
    states(f).every(
      state =>
        state.batchDiagnostic?.message.includes(transition.code) &&
        state.batchDiagnostic.message.includes(transition.message),
    ),
    'report the retained internal cause through the released diagnostic message',
  );
  for (let i = 0; i < 4; i++) {
    await f.passChecks();
    await f.drain();
  }
  assert(states(f).every(s => s.phase === 'landed'));
});

test('formation reads two indexed windows, takes eight members and leaves overflow runnable', async t => {
  const f = await batchesFixture(t, { count: 9 });
  const { batchStore } = await import('./hosted-landing-batches-fixture.mjs');
  const { store } = await import('./hosted-landing-fixture.mjs');
  let windows = 0;
  await f.transaction(
    'batch-formation-budget',
    {
      _handler: async ctx => {
        const input = { projectId: f.projectId, submissionId: f.entries[0].state.id };
        const selected = await store.loadLanding(ctx, input),
          query = ctx.db.query.bind(ctx.db);
        ctx.db.query = table => {
          const value = query(table),
            withIndex = value.withIndex.bind(value);
          value.withIndex = (name, builder) => {
            if (
              table === 'projectHostedLandingRequests' &&
              name === 'by_project_channel_runnable_batchable_priority_sequence'
            )
              windows++;
            return withIndex(name, builder);
          };
          return value;
        };
        assert(await batchStore.formLandingBatch(ctx, input, selected));
      },
    },
    {},
  );
  assert.equal(windows, 2);
  const batch = JSON.parse([...f.tables.projectHostedLandingBatches.values()][0].value);
  assert.equal(batch.members.length, 8);
  const overflow = [...f.tables.projectHostedLandingRequests.values()].find(
    r => r.submissionId === f.entries[8].state.id,
  );
  assert.equal(overflow.runnable, true);
  assert.equal(JSON.parse(overflow.value).batchId, undefined);
});

test('seven arrivals pipeline on a checking solo without replacing its proof or rechecking', async t => {
  const f = await batchesFixture(t, { count: 1 });
  await f.drain();
  const originalRun = f.runs()[0];
  assert.equal(states(f)[0].phase, 'checking');
  for (let i = 1; i < 8; i++) {
    const base = JSON.parse(f.c.objects.get(f.c.baseline.sha256));
    const head = f.c.state([...base.files, f.c.file(`member-${i}`, `member ${i}`)], [f.c.baseline.sha256]);
    const lane = await f.c.lane(head),
      selection = f.c.selection([lane]);
    for (const table of ['projectHostedRecords', 'projectHostedRecordHeads'])
      for (const row of f.tables[table].values())
        if (row.kind === 'lane' && row.key === lane.laneId) f.patch(table, row._id, { ownerOnly: true });
    const candidate = await compose(f.c, selection);
    await f.enqueue(
      f.request({
        governanceVersion: 1,
        candidateId: candidate.id,
        expectedHead: candidate.result.head,
        finish: { composeOperationId: selection.request.operationId, after: null },
      }),
    );
  }
  await f.drain();
  assert.equal(f.tables.projectHostedLandingBatches.size, 1, 'successor composes while the solo checks');
  assert.equal(f.runs().length, 2, 'successor checks on the predicted predecessor');
  await f.rawChecks.pass(await f.rawChecks.activate(originalRun.id));
  await f.drain();
  const batch = JSON.parse([...f.tables.projectHostedLandingBatches.values()][0].value);
  assert.equal(batch.members.length, 7);
  assert.equal(f.runs().length, 2);
  assert.equal(f.runs()[0].id, originalRun.id);
  const originalMain = f.currentMain().head;
  const shared = f.runs().find(run => run.id !== originalRun.id);
  assert.equal(shared.candidate.base.head, originalMain, 'next cohort checks on its accepted predecessor');
  await f.passChecks();
  await f.drain();
  assert(states(f).every(s => s.phase === 'landed'));
  const receipts = [...f.tables.projectHostedAcceptances.values()].map(r => JSON.parse(r.value));
  assert.equal(receipts.filter(r => r.check.runId === originalRun.id).length, 1);
  assert.equal(receipts.filter(r => r.check.runId === shared.id).length, 7);
  assert.equal(f.runs().length, 2, 'eight landings need two full checks total');
  assert.equal(f.pending().length, 0);
});

test('server-verified governance batches legacy clients without a new protocol step', async t => {
  const f = await batchesFixture(t, { count: 2, governanceVersion: null });
  assert(states(f).every(s => s.request.governanceVersion === undefined));
  await f.drain();
  assert.equal(f.runs().length, 1);
  await f.passChecks();
  await f.drain();
  assert(states(f).every(s => s.phase === 'landed'));
});

test('a stacked changed-path manifest larger than 4 KiB passes the real source finalizer grant', async t => {
  const f = await batchesFixture(t, { count: 4, fileCount: 500 });
  let task;
  for (let i = 0; i < 100; i++) {
    task = f.pending().find(task => /^projectHostedComposeJobs:(complete|publish)$/.test(task.name));
    if (task) break;
    await f.execute(f.pending()[0]);
  }
  assert(task, 'source completion is event driven');
  if (task.name.endsWith(':publish')) {
    // Up to 64 KiB, the step's own result text goes straight to publication.
    const size = Buffer.byteLength(task.args[0].result);
    assert(size > 4096 && size <= 64 * 1024);
  } else {
    const { jobApi } = await import('./hosted-compose-fixture.mjs');
    const grant = await f.transaction('batch-result-download', jobApi.resultDownload, task.args[0]);
    assert(grant.size > 4096 && grant.size <= 512 * 1024);
  }
  await f.drain();
  await f.passChecks();
  await f.drain();
  assert(states(f).every(s => s.phase === 'landed'));
  assert.equal(f.runs().length, 1);
});

test('incident storage replay: eight eligible landings reuse a Convex-stored empty page and share one check', async t => {
  const f = await batchesFixture(t, { count: 8 });
  const { buildComposePages } = await import('../dist/hosted-compose.js');
  const { saveBytes } = await import('../dist/hosted-save.js');
  const page = buildComposePages([]).pages[0];
  const pin = f.c.put(saveBytes(page.value));
  const object = [...f.tables.projectObjects.values()].find(row => row.digest === pin.sha256);
  await f.transaction(
    'seed-convex-metadata',
    {
      _handler: async ctx => {
        const storageId = await ctx.storage.store(
          new Blob([saveBytes(page.value)], { type: 'application/json' }),
        );
        await ctx.db.patch(object._id, {
          storageId,
          location: undefined,
          r2Key: undefined,
          r2Committed: undefined,
        });
      },
    },
    {},
  );
  await f.drain();
  assert.equal(f.runs().length, 1);
  assert(states(f).every(s => !s.batchSolo && s.phase === 'checking'));
  assert.equal(
    [...f.tables.projectObjects.values()].find(row => row.digest === pin.sha256).location,
    undefined,
    'valid stored bytes keep their existing location',
  );
  await f.passChecks();
  await f.drain();
  assert(states(f).every(s => s.phase === 'landed'));
  assert.equal(f.runs().length, 1);
  assert.equal(f.pending().length, 0);
});

test('overflow pipelines a one-member group on the checking eight-member cohort', async t => {
  const f = await batchesFixture(t, { count: 9 });
  await f.drain();
  assert.equal(f.runs().length, 2);
  const [first, next] = f.runs();
  assert.equal(next.candidate.base.head, first.request.expectedHead);
  await f.rawChecks.pass(await f.rawChecks.activate(first.id));
  await f.drain();
  assert.equal(states(f).filter(s => s.phase === 'landed').length, 8);
  assert.equal(next.candidate.base.head, f.currentMain().head);
  await f.passChecks();
  await f.drain();
  assert(states(f).every(s => s.phase === 'landed'));
  assert.equal(f.runs().length, 2);
  assert.equal(f.pending().length, 0);
});

test('a main advance during shared composition recomposes before reserving a full check', async t => {
  const f = await batchesFixture(t, { count: 8 });
  while (![...f.tables.projectHostedComposes.values()].some(row => JSON.parse(row.value).batch))
    await f.execute(f.pending()[0]);
  const moved = f.moveMain();
  await f.drain();
  assert.equal(f.runs().length, 1);
  assert.equal(f.runs()[0].candidate.base.head, moved.head);
  await f.passChecks();
  await f.drain();
  assert(states(f).every(s => s.phase === 'landed'));
  assert.equal(f.runs().length, 1, 'an obsolete source plan does not consume a check');
});

test('a terminal finish error releases its active cohort through an event without waiting for an alarm', async t => {
  const f = await batchesFixture(t, { count: 9 });
  await f.drain();
  const { moduleUrl } = await import('./convex-module.mjs');
  const finish = await import(moduleUrl('../convex/projectHostedFinishStore.ts'));
  // Simulate a terminal source/controller error, outside normal check settlement.
  for (const member of f.entries.slice(0, 8))
    await f.transaction(
      'terminal-cohort-error',
      {
        _handler: ctx =>
          finish.failFinish(
            ctx,
            { projectId: f.projectId, submissionId: member.state.id },
            'SOURCE_UNAVAILABLE',
            'synthetic terminal source error',
          ),
      },
      {},
    );
  for (const task of f.pending())
    if (task.name === 'projectHostedLandingStall:alarm')
      f.patch('_scheduled_functions', task._id, { state: { kind: 'canceled' } });
  await f.drain();
  assert.equal(
    f.runs().length,
    3,
    'the speculative overflow is discarded and checks surviving main after its predecessor fails',
  );
  assert.equal(f.runs().at(-1).candidate.base.head, f.currentMain().head);
  await f.passChecks();
  await f.drain();
  assert.equal(states(f).find(s => s.id === f.entries[8].state.id).phase, 'landed');
  assert.equal(f.pending().length, 0);
});

for (const legacy of [false, true])
  test(`non-batchable owner work can settle while an eligible cohort checks (${legacy ? 'legacy' : 'current'} projection)`, async t => {
    const f = await batchesFixture(t, { count: 8 });
    await f.drain();
    const shared = f.runs()[0];
    const base = JSON.parse(f.c.objects.get(f.c.baseline.sha256));
    const head = f.c.state([...base.files, f.c.file('owner-work', 'owner change')], [f.c.baseline.sha256]);
    const lane = await f.c.lane(head),
      selection = f.c.selection([lane]);
    const candidate = await compose(f.c, selection);
    const state = await f.enqueue(
      f.request({
        agent: false,
        candidateId: candidate.id,
        expectedHead: candidate.result.head,
        finish: { composeOperationId: selection.request.operationId, after: null },
      }),
    );
    if (legacy) {
      const row = [...f.tables.projectHostedLandingRequests.values()].find(r => r.submissionId === state.id);
      f.patch('projectHostedLandingRequests', row._id, { batchable: undefined });
    }
    const own = f.runs().find(r => r.id !== shared.id);
    assert(own, 'ordinary non-batchable work keeps its existing check reservation');
    await f.rawChecks.pass(await f.rawChecks.activate(own.id));
    await f.drain();
    assert.equal(
      states(f).find(s => s.id === state.id).phase,
      'landed',
      'an eligible checking cohort never holds ordinary non-batchable publication',
    );
    assert.equal(
      f.runs().find(r => r.id === shared.id).status,
      'queued',
      'the cohort check did not need to finish first',
    );
    await f.passChecks();
    await f.drain();
    await f.passChecks();
    await f.drain();
    assert(states(f).every(s => s.phase === 'landed'));
    assert.equal(f.runs().length, 3, 'one external main advance requires one shared cohort recheck');
    assert.equal(f.pending().length, 0);
  });

test('urgent non-batchable owner work bypasses older normal work while a cohort checks', async t => {
  const f = await batchesFixture(t, { count: 8 });
  await f.drain();
  const shared = f.runs()[0],
    entries = [];
  for (const priority of ['normal', 'urgent']) {
    const base = JSON.parse(f.c.objects.get(f.c.baseline.sha256));
    const head = f.c.state([...base.files, f.c.file(`outside-${priority}`, priority)], [f.c.baseline.sha256]);
    const lane = await f.c.lane(head),
      selection = f.c.selection([lane]);
    const candidate = await compose(f.c, selection);
    const state = await f.enqueue(
      f.request({
        agent: false,
        priority,
        candidateId: candidate.id,
        expectedHead: candidate.result.head,
        finish: { composeOperationId: selection.request.operationId, after: null },
      }),
    );
    entries.push({ state, candidate });
  }
  const urgent = f.runs().find(run => run.request.candidateId === entries[1].candidate.id);
  await f.rawChecks.pass(await f.rawChecks.activate(urgent.id));
  await f.drain();
  assert.equal(states(f).find(s => s.id === entries[1].state.id).phase, 'landed');
  assert.notEqual(states(f).find(s => s.id === entries[0].state.id).phase, 'landed');
  assert.equal(f.runs().find(run => run.id === shared.id).status, 'queued');
});

test('priority bypass reads bounded heads with 1150 earlier non-batchable normal arrivals', async t => {
  const f = await batchesFixture(t, { count: 8 });
  await f.drain();
  const template = [...f.tables.projectHostedLandingRequests.values()][0];
  for (let i = 0; i < 1150; i++)
    f.insert('projectHostedLandingRequests', {
      ...template,
      _id: undefined,
      _creationTime: undefined,
      submissionId: randomUUID(),
      sequence: i + 20,
      batchable: false,
      priority: 'normal',
      runnable: true,
      value: '{"unrelated":"normal bodies must not be hydrated"}',
    });
  const urgent = randomUUID();
  f.insert('projectHostedLandingRequests', {
    ...template,
    _id: undefined,
    _creationTime: undefined,
    submissionId: urgent,
    sequence: 2000,
    batchable: undefined,
    priority: 'urgent',
    runnable: true,
    value: '{"unrelated":"only the exact selected head is needed"}',
  });
  const { moduleUrl } = await import('./convex-module.mjs');
  const wake = await import(moduleUrl('../convex/projectHostedLandingWake.ts'));
  const { store } = await import('./hosted-landing-fixture.mjs');
  const before = f.counts.length;
  await f.transaction(
    'priority-bypass-budget',
    {
      _handler: async ctx => {
        const queue = await store.landingQueue(ctx, { projectId: f.projectId, channel: 'main' });
        const row = await wake.nextTrainLandingRow(ctx, queue);
        assert.equal(row.submissionId, urgent);
      },
    },
    {},
  );
  assert.equal(f.counts.length - before, 1);
  const count = f.counts.at(-1);
  assert(count.documents <= 16 && count.ranges <= 16, JSON.stringify(count));
  t.diagnostic(
    JSON.stringify({
      normalBacklog: 1150,
      calls: 1,
      documents: count.documents,
      ranges: count.ranges,
      readBytes: count.readBytes,
    }),
  );
});

test('an exhausted shared source job fails its original cohort without allocating fallback compositions', async t => {
  const { moduleUrl } = await import('./convex-module.mjs');
  const { exhaustSourceExecution } = await import(moduleUrl('../convex/projectConvexSourceFailure.ts'));
  const f = await batchesFixture(t);
  for (let i = 0; !f.tables.projectSourceSteps.size; i++) {
    assert(i < 40);
    await f.execute(f.pending()[0]);
  }
  const step = [...f.tables.projectSourceSteps.values()][0];
  const jobs = f.tables.projectSourceSteps.size,
    composes = f.tables.projectHostedComposes.size;
  await f.tx(
    'exhaustSharedSource',
    {
      _handler: ctx =>
        exhaustSourceExecution(ctx, step, {
          stage: 'source-headers',
          exception: 'TimeoutError',
          code: null,
          elapsedMs: 15000,
          httpStatus: null,
        }),
    },
    {},
  );
  await f.drain();
  assert(
    states(f).every(
      state => state.phase === 'terminal-failed' && state.error.code === 'SOURCE_RETRY_EXHAUSTED',
    ),
  );
  assert.equal(f.tables.projectSourceSteps.size, jobs);
  assert.equal(f.tables.projectHostedComposes.size, composes);
  assert.equal(f.runs().length, 0);
  assert.equal(f.pending().length, 0);
});
