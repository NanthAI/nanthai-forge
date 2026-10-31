// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { acceptanceFixture, api, store, records, control, maxima } from './hosted-acceptance-fixture.mjs';
import { code } from './hosted-landing-fixture.mjs';
import { canonicalPayload } from '../dist/hosted-source-operation.js';
import { policyPreset } from '../dist/autonomy-policy.js';
import { hostedAcceptanceSchema } from '../dist/hosted-acceptance.js';
const keyId = process.env.FORGE_HOSTED_CHECK_KEY_ID;
test.before(() => {
  process.env.FORGE_HOSTED_CHECK_KEY_ID = 'SYNTHETIC';
});
test.after(() => {
  if (keyId === undefined) delete process.env.FORGE_HOSTED_CHECK_KEY_ID;
  else process.env.FORGE_HOSTED_CHECK_KEY_ID = keyId;
  console.log('H14 synthetic per-invocation maxima', JSON.stringify(maxima));
});
async function checked(f, item = null, policy = policyPreset('trusted')) {
  f.patch('hostedProjects', f.projectId, { autonomyPolicy: policy });
  item ??= await f.makeCandidate([], [], {
    governance: { version: 1, paths: ['src/leaf.ts'], ownerInputs: false },
  });
  const run = await f.rawChecks.enqueue(
    f.rawChecks.selection({ candidateId: item.candidate.id, expectedHead: item.candidate.result.head }),
  );
  await f.rawChecks.pass(await f.rawChecks.activate(run.id));
  return f.ready(item, { agent: true, check: { kind: 'run', runId: run.id } });
}

test('clean unchecked person acceptance publishes receipt, snapshot, event and original operation exactly once', async () => {
  const f = await acceptanceFixture();
  const { state, request } = await f.ready();
  const result = await f.accept(state),
    receipt = hostedAcceptanceSchema.parse(result.receipt);
  assert.equal(result.status, 'landed');
  assert.equal(receipt.check, null);
  assert.equal(receipt.actor.kind, 'person');
  assert.equal(f.currentMain().receipt.id, receipt.id);
  assert.equal(f.currentMain().sourceRevision, 1);
  assert.equal(f.currentMain().snapshotId, receipt.snapshot.id);
  assert.deepEqual(receipt.previous, request.expectedMain);
  assert.equal(f.tables.projectHostedAcceptances.size, 1);
  assert.equal(f.tables.projectHostedAcceptanceSnapshots.size, 1);
  assert.equal(f.tables.projectHostedAcceptanceEvents.size, 1);
  assert.equal((await f.status(state.id)).request.observation.state, 'landed');
  const op = [...f.tables.projectHostedOperations.values()]
    .map(r => JSON.parse(r.value))
    .find(r => r.operationId === request.operationId);
  assert.equal(op.terminal.outcome.status, 'completed');
  assert.equal(op.terminal.outcome.result.observation.state, 'landed');
  assert.deepEqual(op.terminal.outcome.result.acceptance, {
    receiptId: receipt.id,
    head: receipt.candidate.head,
  });
  assert.equal(f.queue().lease, null);
  assert.equal(f.queue().wake, null);
  const main = f.currentMain();
  f.patch('hostedProjects', f.projectId, {
    sourceAuthority: { mode: 'server', epoch: 2 },
    autonomyPolicy: policyPreset('supervised'),
  });
  assert.deepEqual(await f.accept(state), result);
  assert.equal((await f.enqueue(request)).phase, 'landed');
  assert.deepEqual(f.currentMain(), main);
  assert.equal(f.tables.projectHostedAcceptances.size, 1);
});

test('agent publication retains exact complete-run evidence and current policy', async () => {
  const f = await acceptanceFixture(),
    { state } = await checked(f);
  const result = await f.accept(state);
  assert.equal(result.status, 'landed');
  assert(result.receipt.check.terminalDigest);
  assert(result.receipt.check.planDigest);
  assert(result.receipt.check.executionId);
  assert.equal(result.receipt.automatic, true);
  assert.deepEqual(result.receipt.undo, { kind: 'revert', receiptId: result.receipt.id });
  assert.equal(f.tables.projectHostedCheckRuns.size, 1);
});

test('agent unchecked acceptance fails without changing main or consuming the prepared request', async () => {
  const f = await acceptanceFixture(),
    { state } = await f.ready(null, { agent: true });
  const main = f.currentMain();
  await assert.rejects(f.accept(state), code('CHECK_NOT_PASSED'));
  assert.deepEqual(f.currentMain(), main);
  assert.equal(f.tables.projectHostedAcceptances.size, 0);
  assert.equal((await f.status(state.id)).request.phase, 'ready');
});

test('simultaneous publication retries and a lost reply produce one immutable acceptance', async () => {
  const f = await acceptanceFixture(),
    { state } = await f.ready();
  const results = await Promise.all([f.accept(state), f.accept(state), f.accept(state)]);
  assert(results.every(r => canonicalPayload(r) === canonicalPayload(results[0])));
  assert.equal(f.tables.projectHostedAcceptances.size, 1);
  assert.equal(f.tables.projectHostedAcceptanceEvents.size, 1);
  assert.equal(f.currentMain().sourceRevision, 1);
  assert.equal(f.pendingTasks().filter(t => t.name.endsWith(':complete')).length, 1);
});

for (const kind of ['head', 'receipt'])
  test(`final CAS rejects changed main ${kind}, including same-source receipt ABA`, async () => {
    const f = await acceptanceFixture(),
      { state } = await f.ready(),
      claim = await f.claimAcceptance(state);
    const before = f.currentMain();
    const changed =
      kind === 'head'
        ? { ...before, head: 'e'.repeat(64) }
        : { ...before, receipt: { ...before.receipt, id: randomUUID() } };
    f.patch('projectHostedChannels', f.mainId, { selection: canonicalPayload(changed) });
    await assert.rejects(f.commit(claim), code('CHANNEL_CHANGED'));
    assert.deepEqual(f.currentMain(), changed);
    assert.equal(f.tables.projectHostedAcceptances.size, 0);
  });

for (const kind of ['epoch', 'shadow', 'native-owner', 'channel-epoch'])
  test(`publication fences ${kind} authority changes`, async () => {
    const f = await acceptanceFixture(),
      { state } = await f.ready(),
      claim = await f.claimAcceptance(state);
    if (kind === 'channel-epoch')
      f.patch('projectHostedChannels', f.mainId, {
        selection: canonicalPayload({ ...f.currentMain(), authority: { mode: 'server', epoch: 2 } }),
      });
    else
      f.patch('hostedProjects', f.projectId, {
        sourceAuthority: {
          mode: kind === 'epoch' ? 'server' : kind === 'shadow' ? 'server-shadow' : kind,
          epoch: kind === 'epoch' ? 2 : 1,
        },
      });
    await assert.rejects(f.commit(claim), code('SOURCE_AUTHORITY_CHANGED'));
    assert.equal(f.tables.projectHostedAcceptances.size, 0);
  });

test('a policy change between ready/claim and publication is rejected at final use', async () => {
  const f = await acceptanceFixture(),
    { state } = await checked(f),
    claim = await f.claimAcceptance(state);
  f.patch('hostedProjects', f.projectId, { autonomyPolicy: policyPreset('supervised') });
  await assert.rejects(f.commit(claim), code('POLICY_CHANGED'));
  assert.equal(f.tables.projectHostedAcceptances.size, 0);
});

for (const kind of [
  'definition',
  'configuration',
  'environment',
  'run-head',
  'run-candidate',
  'run-digest',
  'incomplete-shards',
  'failed',
  'cancelled',
  'unknown',
])
  test(`final exact-run evidence rejects ${kind} changes after queue preparation`, async () => {
    const f = await acceptanceFixture(),
      { state } = await checked(f),
      claim = await f.claimAcceptance(state);
    if (kind === 'definition' || kind === 'configuration') {
      const table = 'projectHostedCheckSettings';
      const row = [...f.tables[table].values()].find(
        r => r.kind === (kind === 'definition' ? 'definition' : 'runner'),
      );
      f.patch(table, row._id, { digest: 'f'.repeat(64) });
    } else {
      const row = [...f.tables.projectHostedCheckRuns.values()][0],
        run = JSON.parse(row.value);
      if (kind === 'environment') run.request.expectedEnvironment = 'f'.repeat(64);
      if (kind === 'run-head') run.request.expectedHead = 'f'.repeat(64);
      if (kind === 'run-candidate') run.request.candidateId = randomUUID();
      if (kind === 'run-digest') run.candidate.digest = 'f'.repeat(64);
      if (kind === 'incomplete-shards') run.counts.passed--;
      if (['failed', 'cancelled', 'unknown'].includes(kind)) {
        run.status = kind;
        f.patch('projectHostedCheckRuns', row._id, { status: kind });
      }
      f.patch('projectHostedCheckRuns', row._id, { value: canonicalPayload(run) });
    }
    await assert.rejects(f.commit(claim), code('EVIDENCE_CHANGED'));
    assert.equal(f.tables.projectHostedAcceptances.size, 0);
  });

test('supervised, actor selection and protected-path policies preserve review behavior', async () => {
  for (const policy of [
    policyPreset('supervised'),
    {
      ...policyPreset('trusted'),
      acceptance: { ...policyPreset('trusted').acceptance, autoActors: ['another-agent'] },
    },
    {
      ...policyPreset('trusted'),
      acceptance: { ...policyPreset('trusted').acceptance, protectedPaths: ['src/**'] },
    },
  ]) {
    const f = await acceptanceFixture(),
      { state } = await checked(f, null, policy);
    const result = await f.accept(state);
    assert.equal(result.status, 'pending');
    assert.equal(result.request.observation.pendingReason, 'waiting-for-review');
    assert.equal(f.tables.projectHostedAcceptances.size, 0);
    assert.equal(f.queue().lease, null);
  }
});

test('only landed exact saved heads complete; newer saves, lifecycle changes, sibling Lanes and Intent remain open', async () => {
  const f = await acceptanceFixture();
  const intentId = randomUUID();
  const intent = {
    kind: 'intent',
    id: intentId,
    version: 0,
    at: '2026-01-01T00:00:00.000Z',
    outcome: 'Keep sibling work open',
    constraints: '',
    creatorAccountId: 'owner',
    assigneeAccountIds: [],
    base: { head: f.main.head, receiptId: f.main.receipt.id },
    status: 'active',
  };
  await f.runAcceptance('acceptanceSeed', records.writeHostedRecord, {
    ...f.auth,
    expectedVersion: null,
    record: intent,
  });
  const lanes = await Promise.all(Array.from({ length: 5 }, () => f.lane({ intentId })));
  const item = await f.makeCandidate(lanes.slice(0, 4), [], {
    governance: { version: 1, paths: ['src/leaf.ts'], ownerInputs: false },
  });
  const { state } = await checked(f, item);
  const changedBefore = await f.changeLane(lanes[1].laneId, { sourceVersion: 1 });
  const reopenedBefore = await f.changeLane(lanes[2].laneId, { lifecycleVersion: 1 });
  const { receipt } = await f.accept(state);
  assert.equal(
    (await f.readLane(lanes[0].laneId)).state,
    'active',
    'completion materialization is separate from the accepted marker',
  );
  const changedAfter = await f.changeLane(lanes[3].laneId, { sourceVersion: 1 });
  assert.deepEqual(await f.materialize(receipt.id), { complete: true });
  assert.equal((await f.readLane(lanes[0].laneId)).state, 'completed');
  assert.deepEqual(await f.readLane(lanes[1].laneId), changedBefore);
  assert.deepEqual(await f.readLane(lanes[2].laneId), reopenedBefore);
  assert.deepEqual(await f.readLane(lanes[3].laneId), changedAfter);
  assert.equal((await f.readLane(lanes[4].laneId)).state, 'active');
  const parent = await f.runAcceptance('acceptanceIntentRead', records.readHostedRecord, {
    ...f.auth,
    kind: 'intent',
    key: intentId,
  });
  assert.equal(JSON.parse(parent.value).status, 'active');
  const versions = f.tables.projectHostedRecords.size;
  await f.materialize(receipt.id);
  assert.equal(f.tables.projectHostedRecords.size, versions);
  assert.equal(
    f.counts
      .filter(c => c.name === 'acceptanceComplete')
      .some(c => c.written.includes('projectHostedChannels')),
    false,
  );
});

test('completeOnAccept skips a pinned Lane and still completes its unpinned sibling', async () => {
  const f = await acceptanceFixture(),
    plain = await f.lane(),
    // Seeded pinned, so the Candidate records its exact current pins and only the pin can skip it.
    pinned = await f.lane({ pinned: true });
  const item = await f.makeCandidate([plain, pinned], [], {
    governance: { version: 1, paths: ['src/leaf.ts'], ownerInputs: false },
  });
  const { state } = await checked(f, item);
  const { receipt } = await f.accept(state);
  assert.equal(receipt.completion.enabled, true);
  await f.materialize(receipt.id);
  assert.equal((await f.readLane(plain.laneId)).state, 'completed');
  assert.equal((await f.readLane(pinned.laneId)).state, 'active', 'a pinned Lane is never completed');
});

test('disabled completion policy preserves all Lane state and never completes an Intent', async () => {
  const f = await acceptanceFixture(),
    lane = await f.lane(),
    item = await f.makeCandidate([lane]);
  const policy = policyPreset('supervised');
  f.patch('hostedProjects', f.projectId, {
    autonomyPolicy: { ...policy, lifecycle: { ...policy.lifecycle, completeOnAccept: false } },
  });
  const { state } = await f.ready(item);
  const { receipt } = await f.accept(state);
  assert.equal(receipt.completion.enabled, false);
  await f.materialize(receipt.id);
  assert.equal((await f.readLane(lane.laneId)).state, 'active');
});

test('final scheduler failure rolls back main, all receipts, operation and queue atomically', async () => {
  const f = await acceptanceFixture(),
    { state } = await checked(f),
    claim = await f.claimAcceptance(state);
  const before = f.currentMain();
  f.schedulerFailure(true);
  await assert.rejects(f.commit(claim), /synthetic scheduler unavailable/);
  assert.deepEqual(f.currentMain(), before);
  assert.equal(f.tables.projectHostedAcceptances.size, 0);
  assert.equal(f.tables.projectHostedAcceptanceSnapshots.size, 0);
  assert.equal(f.tables.projectHostedAcceptanceEvents.size, 0);
  assert.equal((await f.status(state.id)).request.phase, 'ready');
  assert.equal(f.queue().lease.token, claim.token);
  f.schedulerFailure(false);
  assert.equal((await f.commit(claim)).status, 'landed');
});

test('current access and actor kind precede receipt replay; a device cannot accept a person request', async () => {
  const f = await acceptanceFixture(),
    { state } = await f.ready();
  f.insert('cliCredentials', {
    name: 'Synthetic',
    tokenHash: 'synthetic',
    issuedAt: Date.now(),
    credentialId: 'synthetic-device',
    owner: 'owner',
    scope: 'cli',
    revoked: false,
    expiresAt: Date.now() + 60000,
  });
  await assert.rejects(
    f.accept(state, { subject: 'owner', forgeCredential: 'synthetic-device' }),
    code('PROJECT_UNAVAILABLE'),
  );
  await assert.rejects(f.accept(state, null), code('PROJECT_UNAVAILABLE'));
  await f.accept(state);
  await assert.rejects(f.accept(state, 'stranger'), code('PROJECT_UNAVAILABLE'));
  await assert.rejects(
    f.transaction(
      'acceptanceReceipt',
      api.receipt,
      { projectId: f.projectId, receiptId: f.currentMain().receipt.id },
      'stranger',
    ),
    code('PROJECT_UNAVAILABLE'),
  );
});

test('incomplete, reordered or replaced inclusion plans cannot authorize publication', async () => {
  const f = await acceptanceFixture(),
    item = await f.makeCandidate([await f.lane()]);
  const s = await f.enqueue(
    f.request({ candidateId: item.candidate.id, expectedHead: item.candidate.result.head, agent: false }),
  );
  await f.drain();
  await f.runAcceptance('acceptancePrepare', store.prepareAcceptance, f.select(s));
  await assert.rejects(f.accept(s), code('WORK_STALE'));
  const input = { ...f.select(s), kind: 'dependencies', index: 0, page: item.pages.dependencies[0].value };
  await assert.rejects(
    f.runAcceptance('acceptanceStage', store.stageAcceptance, input),
    code('WORK_OPERATION_CHANGED'),
  );
  await f.stageAcceptance(s, item.pages);
  await assert.rejects(
    f.runAcceptance('acceptanceStage', store.stageAcceptance, {
      ...input,
      kind: 'inputs',
      page: { ...item.pages.inputs[0].value, entries: [] },
    }),
    code('WORK_OPERATION_CHANGED'),
  );
  assert.equal((await f.accept(s)).status, 'landed');
});

test('expired publication lease is fenced and a recovered original attempt can land once', async () => {
  const f = await acceptanceFixture(),
    { state } = await f.ready(),
    claim = await f.claimAcceptance(state);
  f.patch('projectHostedLandingQueues', f.queue()._id, {
    lease: { ...f.queue().lease, until: Date.now() - 1 },
  });
  await assert.rejects(f.commit(claim), code('WORK_STALE'));
  const next = await f.claimAcceptance(state);
  assert(next.token > claim.token);
  await assert.rejects(f.commit(claim), code('WORK_STALE'));
  assert.equal((await f.commit(next)).status, 'landed');
  assert.equal(f.tables.projectHostedAcceptances.size, 1);
});

test('revoked contributor authority is checked again at final publication and completed replay', async () => {
  const f = await acceptanceFixture(),
    item = await f.makeCandidate();
  const contributor = f.insert('projectContributors', { projectId: f.projectId, contributor: 'contributor' });
  const request = f.request({
    agent: false,
    candidateId: item.candidate.id,
    expectedHead: item.candidate.result.head,
  });
  const s = await f.enqueue(request, 'contributor');
  await f.drain();
  for (const kind of ['inputs', 'dependencies'])
    for (const [index, page] of item.pages[kind].entries())
      await f.transaction(
        'acceptanceStage',
        api.stage,
        { ...f.select(s), kind, index, page: JSON.stringify(page.value) },
        'contributor',
      );
  const claim = await f.claimAcceptance(s);
  f.tables.projectContributors.delete(contributor);
  await assert.rejects(f.commit(claim), code('PROJECT_UNAVAILABLE'));
  assert.equal(f.tables.projectHostedAcceptances.size, 0);
  f.insert('projectContributors', { projectId: f.projectId, contributor: 'contributor' });
  const result = await f.commit(claim);
  assert.equal(result.status, 'landed');
  for (const [id, row] of f.tables.projectContributors)
    if (row.contributor === 'contributor') f.tables.projectContributors.delete(id);
  await assert.rejects(f.commit(claim), code('PROJECT_UNAVAILABLE'));
  assert.equal(f.tables.projectHostedAcceptances.size, 1);
});

test('registered source or canonical Candidate changes cannot publish from a ready lease', async () => {
  for (const kind of ['source', 'candidate']) {
    const f = await acceptanceFixture(),
      { state } = await f.ready(),
      claim = await f.claimAcceptance(state);
    if (kind === 'source') f.tables.projectHostedStates.clear();
    else {
      const row = [...f.tables.projectHostedRecords.values()].find(
        r => r.kind === 'candidate' && r.key === state.request.candidateId,
      );
      f.patch('projectHostedRecords', row._id, { digest: 'e'.repeat(64) });
    }
    await assert.rejects(f.commit(claim), code('SOURCE_UNAVAILABLE'));
    assert.equal(f.tables.projectHostedAcceptances.size, 0);
  }
});

test('completion materialization rolls back a failed page and resumes without rewriting accepted source', async () => {
  const f = await acceptanceFixture();
  f.patch('hostedProjects', f.projectId, { autonomyPolicy: policyPreset('trusted') });
  const lanes = [];
  for (let i = 0; i < 21; i++) lanes.push(await f.lane());
  const item = await f.makeCandidate(lanes),
    { state } = await f.ready(item);
  const { receipt } = await f.accept(state),
    main = f.currentMain();
  f.schedulerFailure(true);
  await assert.rejects(f.materialize(receipt.id), /synthetic scheduler unavailable/);
  assert.equal((await f.readLane(lanes[0].laneId)).state, 'active');
  assert.equal([...f.tables.projectHostedAcceptancePlans.values()][0].appliedEntry, 0);
  f.schedulerFailure(false);
  assert.deepEqual(await f.materialize(receipt.id), { complete: false });
  await f.changeLane(lanes[20].laneId, { sourceVersion: 1 });
  assert.deepEqual(await f.materialize(receipt.id), { complete: true });
  assert.equal((await f.readLane(lanes[0].laneId)).state, 'completed');
  assert.equal((await f.readLane(lanes[20].laneId)).state, 'active');
  assert.deepEqual(f.currentMain(), main);
  assert.equal(f.tables.projectHostedAcceptances.size, 1);
});
