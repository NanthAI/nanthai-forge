// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { itemWorkFixture } from './item-work-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';

const { workRecordWriter, finishWorkRecordWrites } = await import(
  moduleUrl('../convex/projectWorkRecordWriter.ts')
);
const commit = 'b'.repeat(64);
const at = '2026-01-01T00:00:00.000Z';
const root = { sha256: commit, size: 0 };

async function addLanding(s, sequence, paths, itemIds = [s.itemId]) {
  const receiptId = randomUUID();
  const candidateId = randomUUID();
  for (const intentId of itemIds) await s.addLandingNote(sequence, { receiptId, intentId });
  await s.put({
    kind: 'candidate',
    id: candidateId,
    version: 0,
    at,
    intentId: s.itemId,
    base: { head: commit, receiptId: randomUUID() },
    inputs: root,
    dependencies: root,
    algorithm: 'fixture',
    result: { status: 'clean', head: commit },
    governance: { version: 1, paths, ownerInputs: true },
  });
  await s.ctx.db.insert('projectHostedAcceptances', {
    projectId: s.auth.projectId,
    receiptId,
    submissionId: randomUUID(),
    attemptId: randomUUID(),
    sequence,
    value: JSON.stringify({
      at,
      snapshot: { revision: sequence },
      candidate: { id: randomUUID(), head: commit },
      memberCandidate: { id: candidateId, head: commit },
    }),
  });
  return { receiptId, commit, itemIds };
}

async function emptyInitiative() {
  const s = await itemWorkFixture({ details: true });
  const [note] = s.tables.projectIntentLandingNotes.values();
  await s.ctx.db.delete(note._id);
  const stamp = [...s.tables.projectHostedOverlapLanes.values()].find(row => row.laneId === s.stamped.id);
  await s.ctx.db.patch(stamp._id, { landed: undefined });
  return s;
}

const view = async (s, args) => JSON.parse(await s.readInitiativeRaw(args));

test('the Initiative reads exact counts in one bounded query at 80 and at 10,000 retained landing notes', async t => {
  const s = await emptyInitiative();
  for (let i = 0; i < 80; i++)
    await addLanding(
      s,
      i + 43,
      Array.from({ length: i < 12 ? 8 : 9 }, (_, j) => `src/fixture-${i}-${j}.ts`),
    );
  await s.rebuildInitiative();
  const totals = { role: true, openLanes: 1, openAtLeast: false, landings: 80, files: 708, missingFiles: 0 };
  const measure = async size => {
    const started = performance.now();
    const result = await view(s);
    const io = s.counts.at(-1);
    t.diagnostic(
      JSON.stringify({
        notes: size,
        ...io,
        milliseconds: +(performance.now() - started).toFixed(2),
        peakKiB: process.resourceUsage().maxRSS,
      }),
    );
    assert.equal(io.writes, 0);
    assert(io.documents <= 10);
    return { result, io };
  };
  const small = await measure(80);
  assert.deepEqual(small.result, totals);
  // Many notes for an already-counted receipt increase history without changing its work totals.
  const [{ receiptId }] = s.tables.projectIntentLandingNotes.values();
  for (let i = 80; i < 10_000; i++) await s.addLandingNote(i + 43, { receiptId });
  const large = await measure(10_000);
  assert.deepEqual(large.result, totals);
  assert.deepEqual(large.io, small.io);
});

test('one receipt on two Items counts once, and replay adds no writes', async t => {
  const s = await emptyInitiative();
  const head = [...s.tables.projectHostedRecordHeads.values()].find(row => row.key === s.itemId);
  assert.equal(head.planningItemId, undefined);
  await s.rebuildInitiative();
  assert.equal((await s.ctx.db.get(head._id)).planningItemId, s.itemId);
  const second = randomUUID();
  await s.planning(second, { title: 'Second item', initiativeId: s.initiativeId });
  const paths = Array.from({ length: 9 }, (_, i) => `src/${i}.ts`);
  const landing = await addLanding(s, 43, paths, [s.itemId, second]);
  await s.foldInitiative(landing);
  const first = s.counts.at(-1);
  t.diagnostic(JSON.stringify({ firstFold: first }));
  assert.equal(first.writes, 11, 'one receipt marker, nine path members, one summary');
  assert(first.documents <= 10 + paths.length);
  assert(first.readBytes + first.writeBytes < 10_000);
  await s.foldInitiative(landing);
  assert.equal(s.counts.at(-1).writes, 0);
  assert.equal(s.workTasks.length, 0);
  assert.equal((await view(s)).landings, 1);
  assert.equal((await view(s)).files, 9);
  await s.foldInitiative(await addLanding(s, 44, paths));
  const subsequent = s.counts.at(-1);
  t.diagnostic(JSON.stringify({ sharedPathsFold: subsequent }));
  assert.equal(subsequent.writes, 2);
  assert.equal((await view(s)).landings, 2);
  assert.equal((await view(s)).files, 9);
});

test('rebuilding Initiative work includes the receipts of archived Item landing notes', async () => {
  const s = await emptyInitiative();
  const landing = await addLanding(s, 43, ['src/archive.ts']);
  const { retainLandingNoteReference } = await import(
    moduleUrl('../convex/projectIntentLandingNoteArchive.ts')
  );
  const note = [...s.tables.projectIntentLandingNotes.values()].find(
    row => row.receiptId === landing.receiptId,
  );
  const receipt = [...s.tables.projectHostedAcceptances.values()].find(
    row => row.receiptId === landing.receiptId,
  );
  await retainLandingNoteReference(s.ctx, receipt.submissionId, note);
  await s.rebuildInitiative();
  const result = await view(s);
  assert.equal(result.landings, 1);
  assert.equal(result.files, 1);
  assert.equal(result.missingFiles, 0);
});

test('a long Candidate is folded in 500-path pages and unfinished file coverage is explicit', async () => {
  const s = await emptyInitiative();
  await s.rebuildInitiative();
  const paths = Array.from({ length: 501 }, (_, i) => `src/${i}.ts`);
  const landing = await addLanding(s, 43, paths);
  await s.foldInitiative(landing);
  assert.equal(s.workTasks.length, 1);
  assert.deepEqual(await view(s), {
    role: true,
    openLanes: 1,
    openAtLeast: false,
    landings: 1,
    files: 500,
    missingFiles: 1,
  });
  await s.drainWork();
  await s.foldInitiative(landing);
  assert.equal(s.counts.at(-1).writes, 0);
  assert.deepEqual(await view(s), {
    role: true,
    openLanes: 1,
    openAtLeast: false,
    landings: 1,
    files: 501,
    missingFiles: 0,
  });
});

test('the planning writer rebuilds both Initiatives on a move and removes archived work', async () => {
  const s = await itemWorkFixture({ details: true });
  const old = s.initiativeId;
  const destination = randomUUID();
  await s.planning(destination, { kind: 'initiative', title: 'Moved work' });
  await s.rebuildInitiative(old);
  await s.rebuildInitiative(destination);
  const move = async fields => {
    await s.run('changeItem', async () => {
      const ctx = workRecordWriter(s.ctx);
      const row = await ctx.db
        .query('projectPlanningRecords')
        .withIndex('by_generation_and_collection_and_key', q =>
          q
            .eq('generationId', [...s.tables.projectWorkGenerations.keys()][0])
            .eq('collection', 'planningSearch')
            .eq('key', s.itemId),
        )
        .unique();
      const value = { ...JSON.parse(row.value), ...fields };
      await ctx.db.patch(row._id, {
        value: JSON.stringify(value),
        planning: { ...row.planning, status: value.status, initiativeId: value.initiativeId },
      });
      await finishWorkRecordWrites(ctx);
    });
  };
  await move({ initiativeId: destination });
  assert.equal(s.workTasks.length, 2);
  assert.equal((await view(s)).landings, null);
  assert.equal((await view(s, { initiativeId: destination })).landings, null);
  await s.drainWork();
  assert.deepEqual(await view(s), {
    role: true,
    openLanes: 0,
    openAtLeast: false,
    landings: 0,
    files: 0,
    missingFiles: 0,
  });
  assert.deepEqual(await view(s, { initiativeId: destination }), {
    role: true,
    openLanes: 1,
    openAtLeast: false,
    landings: 2,
    files: 2,
    missingFiles: 1,
  });
  await move({ status: 'archived' });
  await s.drainWork();
  assert.deepEqual(await view(s, { initiativeId: destination }), {
    role: true,
    openLanes: 0,
    openAtLeast: false,
    landings: 0,
    files: 0,
    missingFiles: 0,
  });
});

test('Initiative rollups are private and report a lower bound above 200 active project Lanes', async () => {
  const s = await itemWorkFixture({ details: true });
  await s.rebuildInitiative();
  await s.addUnrelatedLanes(205);
  const summary = await view(s);
  assert.equal(summary.openLanes, 1);
  assert.equal(summary.openAtLeast, true);
  assert(s.counts.at(-1).documents <= 610);
  s.as(null);
  assert.deepEqual(await view(s), { role: false });
});

test('oversized legacy Item roots leave a truthful bounded count of open Lanes', async () => {
  const s = await itemWorkFixture({ details: true });
  const text = 'legacy '.repeat(120_000);
  for (let index = 0; index < 14; index++) {
    const id = randomUUID();
    await s.planning(id, { title: 'Large legacy Item', initiativeId: s.initiativeId }, text);
    await s.put({
      kind: 'intent',
      id,
      version: 0,
      at,
      outcome: 'Legacy Import',
      constraints: '',
      creatorAccountId: 'owner',
      assigneeAccountIds: [],
      base: { head: commit, receiptId: randomUUID() },
      status: 'active',
    });
    await s.put({ ...s.open, id: randomUUID(), intentId: id });
  }
  const result = await view(s);
  assert(result.openLanes > 1 && result.openLanes < 15);
  assert.equal(result.openAtLeast, true);
  assert(s.counts.at(-1).readBytes < 14 * 1024 * 1024);
});

test('publishing a replacement Work partition recovers a fold from the gap and rebuilds moved Item totals', async () => {
  const s = await emptyInitiative();
  const target = randomUUID();
  const projectId = s.auth.projectId;
  await s.planning(target, { kind: 'initiative', title: 'Destination' });
  await s.rebuildInitiative();
  await s.rebuildInitiative(target);
  const first = await addLanding(s, 43, ['src/first.ts']);
  await s.foldInitiative(first);
  assert.equal((await view(s)).landings, 1);
  const project = await s.ctx.db.get(projectId);
  const oldPartition = project.work.generationId;
  const { _id, _creationTime, ...generation } = await s.ctx.db.get(oldPartition);
  await s.ctx.db.patch(projectId, { work: { ...project.work, generationId: undefined } });
  await s.foldInitiative(await addLanding(s, 44, ['src/second.ts']));
  const newPartition = await s.ctx.db.insert('projectWorkGenerations', {
    ...generation,
    revision: project.work.revision,
    status: 'building',
  });
  for (const row of [...s.tables.projectPlanningRecords.values()]) {
    const { _id, _creationTime, ...record } = row;
    if (record.generationId !== oldPartition) continue;
    const value = JSON.parse(record.value);
    if (record.key === s.itemId) {
      value.initiativeId = target;
      if (record.planning) record.planning.initiativeId = target;
    }
    await s.ctx.db.insert('projectPlanningRecords', {
      ...record,
      generationId: newPartition,
      value: JSON.stringify(value),
    });
  }
  assert(await s.publishWork(newPartition));
  assert.equal((await view(s)).landings, null);
  assert.equal((await view(s, { initiativeId: target })).landings, null);
  await s.drainWork();
  assert.equal((await view(s)).landings, 0);
  assert.deepEqual(await view(s, { initiativeId: target }), {
    role: true,
    openLanes: 1,
    openAtLeast: false,
    landings: 2,
    files: 2,
    missingFiles: 0,
  });
});

test('an applied abandonment cascade closes a Lane in the Work view before head materialization', async () => {
  const s = await itemWorkFixture({ details: true });
  const { projectId } = s.auth;
  const head = [...s.tables.projectHostedRecordHeads.values()].find(row => row.key === s.open.id);
  const planId = await s.ctx.db.insert('projectHostedLifecyclePlans', {
    projectId,
    actor: 'owner',
    operationId: randomUUID(),
    receiptId: randomUUID(),
    intentId: s.itemId,
    authorityEpoch: 1,
    request: '{}',
    at,
    revision: 0,
    status: 'pending',
    cursor: null,
    staged: 1,
    ready: true,
    saveOperationId: null,
    savedExpected: null,
    materialized: false,
    appliedThrough: 0,
    materializeCursor: null,
  });
  const { _id, _creationTime, ...base } = await s.ctx.db.get(head.recordId);
  const recordId = await s.ctx.db.insert('projectHostedRecords', {
    ...base,
    status: 'abandoned',
    version: 1,
    lifecyclePlanId: planId,
  });
  await s.ctx.db.insert('projectHostedLifecyclePointers', {
    projectId,
    laneId: s.open.id,
    planId,
    baseRecordId: head.recordId,
    recordId,
  });
  assert.equal((await view(s)).openLanes, 1);
  await s.ctx.db.patch(planId, { status: 'applied' });
  assert.equal((await view(s)).openLanes, 0);
});
