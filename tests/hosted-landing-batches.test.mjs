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

test('a failed batch splits into exact serial single checks; a culprit retains its own named test', async t => {
  const f = await batchesFixture(t);
  await f.drain();
  await f.fail(f.runs()[0].id, 'tests/combined.test.mjs');
  await f.drain();
  for (let i = 0; i < 4; i++) {
    const [run] = f.runs().filter(r => r.status === 'queued');
    assert(run, `member ${i} has one exact check`);
    if (i === 1) await f.fail(run.id);
    else await f.rawChecks.pass(await f.rawChecks.activate(run.id));
    await f.drain();
  }
  assert.equal(f.runs().length, 5, 'one batch plus one check per member');
  assert.equal(states(f).filter(s => s.phase === 'landed').length, 3);
  const failed = states(f).find(s => s.phase === 'terminal-failed');
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
  assert.match(failed.error.message, /retained conflict root [0-9a-f]{64}/);
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

test('a main receipt race never transfers shared evidence to a new stack', async t => {
  const f = await batchesFixture(t);
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
  assert.equal(f.runs().length, 5);
  assert(JSON.parse(f.c.objects.get(f.currentMain().head)).files.some(f => f.path === 'accepted.txt'));
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
  const leader = [...f.tables.projectHostedLandingBatches.values()][0].batchId;
  const task = f
    .pending()
    .find(task => task.name === 'projectHostedFinishDriver:drive' && task.args[0].submissionId === leader);
  await assert.rejects(f.execute(task, 'before-resume'));
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
              name === 'by_project_and_channel_and_batchable_and_phase_and_sequence'
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

test('new queued finishes can join an already-checking eligible solo without replacing its original run', async t => {
  const f = await batchesFixture(t, { count: 1 });
  await f.drain();
  const originalRun = f.runs()[0];
  assert.equal(states(f)[0].phase, 'checking');
  for (let i = 1; i < 4; i++) {
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
  const batch = JSON.parse([...f.tables.projectHostedLandingBatches.values()][0].value);
  assert.equal(batch.members.length, 4);
  assert.equal(
    f.runs().length,
    2,
    'the pre-existing solo run is retained; exactly one new shared run is reserved',
  );
  assert.equal(
    f.runs().find(r => r.id === originalRun.id).request.expectedHead,
    originalRun.request.expectedHead,
  );
  await f.passChecks();
  await f.drain();
  assert(states(f).every(s => s.phase === 'landed'));
  const runs = [...f.tables.projectHostedAcceptances.values()].map(r => JSON.parse(r.value).check.runId);
  assert.equal(new Set(runs).size, 1);
  assert.notEqual(runs[0], originalRun.id);
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
    task = f.pending().find(task => task.name === 'projectHostedComposeJobs:complete');
    if (task) break;
    await f.execute(f.pending()[0]);
  }
  assert(task, 'source completion is event driven');
  const { jobApi } = await import('./hosted-compose-fixture.mjs');
  const grant = await f.transaction('batch-result-download', jobApi.resultDownload, task.args[0]);
  assert(grant.size > 4096 && grant.size <= 512 * 1024);
  await f.drain();
  await f.passChecks();
  await f.drain();
  assert(states(f).every(s => s.phase === 'landed'));
  assert.equal(f.runs().length, 1);
});
