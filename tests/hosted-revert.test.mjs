// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { revertFixture, sync, syncJobs, synthetic, code, maxima } from './hosted-revert-fixture.mjs';
const prior = Object.fromEntries(Object.keys(synthetic).map(k => [k, process.env[k]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  console.log('Synthetic hosted revert transaction maxima', JSON.stringify(maxima));
});

test('receipt compensation preserves later disjoint work through normal checked finish and a main race', async t => {
  const f = await revertFixture(t),
    receipt = await f.landOriginal();
  f.move([f.c.file('later.txt', 'later work\n')]);
  const r = f.revertRequest({ kind: 'receipt', receiptId: receipt.id }),
    reverse = await f.reverse(r);
  assert.equal(f.currentMain().head === reverse.lane.head, false);
  assert.deepEqual(reverse.lane.revert, {
    receiptId: receipt.id,
    previous: receipt.previous.head,
    accepted: receipt.candidate.head,
  });
  assert.deepEqual(JSON.parse(f.c.objects.get(reverse.lane.head)).parents, [receipt.candidate.head]);
  assert.deepEqual(f.files(reverse.lane.head), f.files(receipt.previous.head));
  assert(!reverse.output.reads.some(p => p.sha256 === f.c.hidden.blob), 'unchanged blob never downloaded');
  const selection = f.selectRevert([reverse.entry], reverse.lane.intentId),
    candidate = await f.composeRevert(selection);
  const state = await f.finishRevert(candidate, selection);
  assert.equal((await f.current(state.id)).submission.phase, 'checking');
  f.move([f.c.file('racing.txt', 'racing work\n')]);
  assert.equal(
    (await f.settleRevert(state.id)).phase,
    'checking',
    'new Candidate gets a new real fake check',
  );
  const final = await f.settleRevert(state.id);
  assert.equal(final.phase, 'landed');
  assert.equal(f.text(final.acceptance.head, 'selected.txt'), null);
  assert.equal(f.text(final.acceptance.head, 'later.txt'), 'later work\n');
  assert.equal(f.text(final.acceptance.head, 'racing.txt'), 'racing work\n');
  assert.equal(f.tables.projectHostedCheckRuns.size, 3);
  assert.equal(f.tables.projectHostedAcceptances.size, 2);
});

test('overlapping later work yields an H09 conflict Candidate and leaves main unchanged', async t => {
  const f = await revertFixture(t, { overlap: true }),
    receipt = await f.landOriginal();
  const main = f.move([f.c.file('a.txt', 'later overlap\nb\nc\n')]);
  const reverse = await f.reverse(f.revertRequest({ kind: 'receipt', receiptId: receipt.id })),
    selection = f.selectRevert([reverse.entry], reverse.lane.intentId),
    candidate = await f.composeRevert(selection);
  assert.equal(candidate.result.status, 'conflict');
  const state = await f.finishRevert(candidate, selection);
  assert.equal((await f.current(state.id)).submission.observation.cause, 'conflict');
  assert.equal(f.currentMain().head, main.head);
  assert.equal(f.tables.projectHostedCheckRuns.size, 1, 'no passing evidence transferred to conflict');
  const resolution = {
    kind: 'resolution',
    operationId: randomUUID(),
    authorityEpoch: 1,
    candidateId: candidate.id,
    conflicts: candidate.result.conflicts,
    message: 'Resolve revert overlap',
  };
  const prepared = await f.revertCall('resolutionPrepare', sync.prepare, {
    request: JSON.stringify(resolution),
  });
  f.c.put(
    (await import('../dist/hosted-save.js')).saveBytes(
      (await f.revertCall('resolutionProgress', sync.progress, { operationId: resolution.operationId }))
        .input,
    ),
  );
  await f.revertCall('resolutionSubmit', syncJobs.submit, { operationId: resolution.operationId });
  const plan = (
    await f.revertCall('resolutionProgress', sync.progress, { operationId: resolution.operationId })
  ).input;
  const output = await f.c.compute(plan),
    row = [...f.tables.projectHostedSyncs.values()].find(x => x.operationId === resolution.operationId),
    job = await f.c.activate(row.jobId);
  await f.c.callback(job, { status: 'completed', output: output.output });
  const terminal = await f.revertCall('resolutionPublish', syncJobs.publish, {
    jobId: job.id,
    result: output.manifest,
  });
  assert.equal(terminal.outcome.result.resolution.status, 'pending');
  assert.equal(terminal.outcome.result.resolution.candidateId, candidate.id);
  assert.notEqual(prepared.state.resolutionLaneId, reverse.lane.id);
  assert.equal(f.currentMain().head, main.head);
});

test('batch/merge revert uses the actual accepted transition, including dependencies and both Lanes', async t => {
  const f = await revertFixture(t),
    c = f.c;
  // Main already contains unrelated work before the selected batch is composed.
  f.move([c.file('before-batch.txt', 'keep before batch\n')]);
  const other = await c.lane(
    c.state([c.baseFile, c.hidden, c.file('second.txt', 'second\n')], [c.baseline.sha256]),
  );
  const dependencyLane = await c.lane(
    c.state([c.baseFile, c.hidden, c.file('dependency.txt', 'dependency\n')], [c.baseline.sha256]),
  );
  const depSelection = f.selectRevert([dependencyLane]),
    dependency = await f.composeRevert(depSelection);
  const dep = {
    candidateId: dependency.id,
    head: dependency.result.head,
    state: {
      object: { sha256: dependency.result.head, size: c.objects.get(dependency.result.head).length },
      recipe: null,
    },
  };
  const batch = f.selectRevert([f.lane, other], c.intentId, [dep]),
    candidate = await f.composeRevert(batch),
    original = await f.finishRevert(candidate, batch),
    accepted = await f.settleRevert(original.id);
  assert.equal(accepted.phase, 'landed');
  const receipt = f.receipt(accepted.acceptance.receiptId);
  assert.equal(receipt.completion.lanes, 2);
  assert.notEqual(receipt.candidate.head, f.lane.head);
  const reverse = await f.reverse(f.revertRequest({ kind: 'receipt', receiptId: receipt.id })),
    selection = f.selectRevert([reverse.entry], reverse.lane.intentId),
    proposal = await f.composeRevert(selection),
    state = await f.finishRevert(proposal, selection),
    final = await f.settleRevert(state.id);
  assert.equal(final.phase, 'landed');
  assert.deepEqual(f.files(final.acceptance.head), f.files(receipt.previous.head));
  assert.equal(f.text(final.acceptance.head, 'before-batch.txt'), 'keep before batch\n');
});

test('reverting the revert restores the actual accepted files while newer disjoint work survives', async t => {
  const f = await revertFixture(t),
    original = await f.landOriginal();
  const first = await f.reverse(f.revertRequest({ kind: 'receipt', receiptId: original.id })),
    selected = f.selectRevert([first.entry], first.lane.intentId),
    candidate = await f.composeRevert(selected),
    state = await f.finishRevert(candidate, selected),
    undone = await f.settleRevert(state.id);
  assert.equal(undone.phase, 'landed');
  f.move([f.c.file('after-revert.txt', 'keep this\n')]);
  const second = await f.reverse(
      f.revertRequest({ kind: 'receipt', receiptId: undone.acceptance.receiptId }),
    ),
    next = f.selectRevert([second.entry], second.lane.intentId),
    restored = await f.composeRevert(next),
    request = await f.finishRevert(restored, next),
    final = await f.settleRevert(request.id);
  assert.equal(final.phase, 'landed');
  assert.equal(f.text(final.acceptance.head, 'selected.txt'), 'selected\n');
  assert.equal(f.text(final.acceptance.head, 'after-revert.txt'), 'keep this\n');
});

test('unknown original final reply resolves the exact submission receipt; absent acceptance never guesses from source', async t => {
  const f = await revertFixture(t),
    state = await f.enqueue(f.request());
  await f.drain();
  const r = f.revertRequest({ kind: 'submission', submissionId: state.id });
  await assert.rejects(f.prepareRevert(r), code('NOT_FOUND'));
  assert.equal(f.tables.projectHostedSyncs.size, 0);
  assert.equal(f.tables.projectHostedAcceptances.size, 0);
  // Commit the original acceptance, discard its final reply, and move main again.
  await f.passChecks();
  await f.drain();
  const receipt = JSON.parse([...f.tables.projectHostedAcceptances.values()][0].value);
  f.move([f.c.file('after-unknown.txt', 'retained\n')]);
  const reverse = await f.reverse(r);
  assert.equal(reverse.lane.revert.receiptId, receipt.id);
  assert.equal(reverse.lane.revert.accepted, receipt.candidate.head);
  assert.deepEqual(f.files(reverse.lane.head), f.files(receipt.previous.head));
});

test('same-operation prepare/submit/publish retries retain identities and never rewind a later save or main', async t => {
  const f = await revertFixture(t),
    receipt = await f.landOriginal(),
    r = f.revertRequest({ kind: 'receipt', receiptId: receipt.id });
  const [a, b] = await Promise.all([f.prepareRevert(r), f.prepareRevert(r)]);
  assert.deepEqual(a, b);
  const [x, y] = await Promise.all([f.submitRevert(r), f.submitRevert(r)]);
  assert.equal(x.jobId, y.jobId);
  const output = await f.workRevert(r),
    first = await f.publishRevert(output);
  const laneId = first.outcome.result.lane.laneId,
    old = await f.readLane(laneId),
    later = f.c.state([...f.files(old.head), f.c.file('later-save.txt', 'saved later\n')], [old.head]);
  f.c.register(later);
  await f.changeLane(laneId, { head: later.sha256, sourceVersion: old.sourceVersion + 1 });
  const main = f.move([f.c.file('new-main.txt', 'accepted later\n')]);
  assert.deepEqual(await f.publishRevert(output), first);
  assert.deepEqual((await f.prepareRevert(r)).terminal, first);
  assert.deepEqual(await f.submitRevert(r), first);
  assert.equal((await f.readLane(laneId)).head, later.sha256);
  assert.equal(f.currentMain().head, main.head);
  assert.equal(f.tables.projectHostedSyncs.size, 1);
  await assert.rejects(f.prepareRevert({ ...r, message: 'changed' }), code('WORK_OPERATION_CHANGED'));
});

test('current contributor authority, authority epoch and project-scoped receipts are enforced', async t => {
  const f = await revertFixture(t),
    receipt = await f.landOriginal(),
    r = f.revertRequest({ kind: 'receipt', receiptId: receipt.id });
  await assert.rejects(f.prepareRevert(r, null), code('PROJECT_UNAVAILABLE'));
  await assert.rejects(f.prepareRevert(r, 'outsider'), code('PROJECT_UNAVAILABLE'));
  await assert.rejects(f.prepareRevert({ ...r, authorityEpoch: 0 }), code('SOURCE_AUTHORITY_CHANGED'));
  await assert.rejects(
    f.prepareRevert(f.revertRequest({ kind: 'receipt', receiptId: randomUUID() })),
    code('NOT_FOUND'),
  );
  f.insert('projectContributors', { projectId: f.projectId, contributor: 'contributor' });
  const prepared = await f.prepareRevert(r, 'contributor');
  assert.equal(
    prepared.state.work.receiptId,
    receipt.id,
    'accept-capable contributor can prepare compensation',
  );
  assert.equal(f.currentMain().head, receipt.candidate.head);
  f.patch('projectContributors', [...f.tables.projectContributors.values()][0]._id, {
    contributor: 'removed',
  });
  await assert.rejects(f.prepareRevert(r, 'contributor'), code('PROJECT_UNAVAILABLE'));
});

test('10,050 unrelated receipts do not expand receipt lookup or hydrate selection/history', async t => {
  const f = await revertFixture(t),
    receipt = await f.landOriginal();
  for (let n = 0; n < 10050; n++)
    f.insert('projectHostedAcceptances', {
      projectId: f.projectId,
      receiptId: randomUUID(),
      submissionId: randomUUID(),
      attemptId: randomUUID(),
      sequence: n + 100,
      value: '{}',
    });
  const r = f.revertRequest({ kind: 'submission', submissionId: receipt.submissionId });
  await f.prepareRevert(r);
  const measured = f.counts.filter(x => x.name === 'revertPrepare').at(-1);
  assert.equal(measured.touched.filter(x => x === 'projectHostedAcceptances').length, 1);
  assert(!measured.touched.includes('projectHostedAcceptancePages'));
  assert(!measured.touched.includes('projectHostedAcceptanceEvents'));
  console.log('Synthetic revert lookup with 10050 unrelated receipts', JSON.stringify(measured));
});

test('publication rejects a result that differs from the signed original source output', async t => {
  const f = await revertFixture(t),
    receipt = await f.landOriginal(),
    r = f.revertRequest({ kind: 'receipt', receiptId: receipt.id });
  await f.prepareRevert(r);
  await f.submitRevert(r);
  const output = await f.workRevert(r),
    before = f.tables.projectHostedRecordHeads.size;
  await assert.rejects(
    f.publishRevert({ ...output, manifest: output.manifest + ' ' }),
    code('SOURCE_HASH_MISMATCH'),
  );
  assert.equal(f.tables.projectHostedRecordHeads.size, before);
  assert.equal((await f.progressRevert(r)).terminal, null);
  assert.equal(f.currentMain().head, receipt.candidate.head);
  assert.equal((await f.publishRevert(output)).outcome.status, 'completed');
});

test('another project receipt cannot be selected and pending reverts recheck authority before dispatch', async t => {
  const f = await revertFixture(t),
    receipt = await f.landOriginal(),
    foreign = randomUUID();
  f.insert('projectHostedAcceptances', {
    projectId: 'foreign-project',
    receiptId: foreign,
    submissionId: randomUUID(),
    attemptId: randomUUID(),
    sequence: 1,
    value: JSON.stringify({ ...receipt, id: foreign }),
  });
  await assert.rejects(
    f.prepareRevert(f.revertRequest({ kind: 'receipt', receiptId: foreign })),
    code('NOT_FOUND'),
  );
  const r = f.revertRequest({ kind: 'receipt', receiptId: receipt.id });
  await f.prepareRevert(r);
  f.patch('hostedProjects', f.projectId, { sourceAuthority: { mode: 'server', epoch: 2 } });
  await assert.rejects(f.submitRevert(r), code('SOURCE_AUTHORITY_CHANGED'));
  assert.equal((await f.progressRevert(r)).state.status, 'ready');
  assert.equal(f.currentMain().head, receipt.candidate.head);
});
