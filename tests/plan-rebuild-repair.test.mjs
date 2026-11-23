// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { planFixture } from './plan-read-fixture.mjs';
import { setup } from './hosted-planning-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { meterWorkIO } from './hosted-read-set.mjs';
const prepare = await import(moduleUrl('../convex/projectHostedPlanningPrepare.ts'));
const { planView } = await import(moduleUrl('../convex/projectPlanView.ts'));
const { PLAN_ROWS, PLAN_PAGE_SIZE, PLAN_PAGE_PREFIX, encodePlanPage, decodePlanPage } = await import(
  moduleUrl('../convex/projectPlanRows.ts')
);
const { finishReadWriter } = await import(moduleUrl('../convex/projectFinishReadWriter.ts'));
const { requestPlanRepair } = await import(moduleUrl('../convex/projectPlanPreparationStore.ts'));
const { workRecordWriter } = await import(moduleUrl('../convex/projectWorkRecordWriter.ts'));
const shape = r => ({ ...r, rows: JSON.parse(r.rows) });
const pages = s =>
  [...s.tables.projectWorkDataRecords.values()].filter(
    row => row.collection === PLAN_ROWS && row.generationId === s.generationId,
  );
const repairs = s =>
  s.scheduled.filter(task => getFunctionName(task.fn) === 'projectHostedPlanningPrepare:repair');
async function drain(s, from = 0) {
  let index = from;
  const io = meterWorkIO(s.ctx, s.tables),
    costs = [];
  while (index < repairs(s).length) {
    assert(index - from < 40, 'one exceptional repair is finite and never polls');
    const task = repairs(s)[index++];
    const state = s.tables.projectWorkGenerations.get(s.generationId).planRowsPreparation;
    assert(Buffer.byteLength(JSON.stringify(state)) <= 512, 'one bounded control object, never source bytes');
    costs.push(await io.cost(() => prepare.repair._handler(s.ctx, task.args)));
  }
  io.restore();
  return { index, costs };
}

test('replacement rebuild clears old status/Initiative and deleted-Item ghosts in bounded batches before reapplying roots', async t => {
  const s = await planFixture(t, 1, true);
  await s.project();
  const alias = s.tables.hostedProjects.get(s.projectId).work.generationId;
  const sentinels = await s.ctx.db.insert('projectWorkDataRecords', {
    projectId: s.projectId,
    generationId: s.generationId,
    collection: '_workStoreOther',
    key: 'untouched',
    parent: '',
    position: 0,
    value: 'retained unrelated metadata',
  });
  const ghosts = [];
  for (let i = 0; i < 40; i++) {
    const parent = i % 2 ? `issue:closed:${s.initiatives[0]}` : 'issue:open';
    const original = i < 2 ? s.tables.projectPlanningRecords.get(s.roots[23 + i]) : null;
    const row = {
      id: original ? JSON.parse(original.value).id : randomUUID(),
      kind: 'issue',
      status: i % 2 ? 'closed' : 'open',
      title: 'Deleted or moved Item ghost',
      position: original?.position ?? 20000 + i,
      initiativeId: s.initiatives[0],
    };
    if (!original) ghosts.push(row.id);
    await s.ctx.db.insert('projectWorkDataRecords', {
      projectId: s.projectId,
      generationId: s.generationId,
      collection: PLAN_ROWS,
      key: `zz-stale-${i}`,
      parent,
      position: i,
      value: encodePlanPage([row]),
    });
  }
  await finishReadWriter(s.ctx).db.patch(s.generationId, { planRowsVersion: undefined });
  const expectedBefore = shape(await planView(s.ctx, s.projectId));
  await finishReadWriter(s.ctx).db.patch(s.generationId, { planRowsVersion: 1 });
  assert.notDeepEqual(
    shape(await planView(s.ctx, s.projectId)),
    expectedBefore,
    'the planted drift changes real rows/counts',
  );
  const input = {
    projectId: s.projectId,
    owner: 'owner',
    generationId: alias,
    operationId: randomUUID(),
    cursor: null,
    planRowsOnly: true,
  };
  const first = await prepare.page._handler(s.ctx, input);
  let result = JSON.parse(first);
  assert.equal(result.cleared, 32);
  assert.equal(result.processed, 0, 'no roots are applied before old pages are cleared');
  assert.equal(await prepare.page._handler(s.ctx, input), first, 'a lost clear reply does not clear twice');
  await s.patch(s.roots[23], { status: 'closed', initiativeId: s.initiatives[1] });
  let calls = 1;
  while (!result.isDone) {
    assert(++calls < 20);
    result = JSON.parse(
      await prepare.page._handler(s.ctx, { ...input, operationId: randomUUID(), cursor: result.nextCursor }),
    );
    assert(result.cleared <= 32);
    if (result.cleared) assert.equal(result.processed, 0);
    assert(result.processed <= 100);
  }
  assert.equal(result.compactReady, true);
  const compact = shape(await planView(s.ctx, s.projectId));
  await finishReadWriter(s.ctx).db.patch(s.generationId, { planRowsVersion: undefined });
  assert.deepEqual(compact, shape(await planView(s.ctx, s.projectId)));
  assert(compact.rows.every(row => !ghosts.includes(row.id)));
  assert(!compact.rows.some(row => row.title === 'Deleted or moved Item ghost'));
  assert.equal(s.tables.projectWorkDataRecords.get(sentinels).value, 'retained unrelated metadata');
  t.diagnostic(JSON.stringify({ calls, pages: pages(s).length }));
});

test('an old page layout repairs itself after a planning write and scheduled steps are idempotent', async t => {
  const s = await planFixture(t);
  await finishReadWriter(s.ctx).db.patch(s.generationId, { planRowsVersion: 1 });
  const root = s.tables.projectPlanningRecords.get(s.roots[23]);
  const item = JSON.parse(root.value);
  await s.ctx.db.insert('projectWorkDataRecords', {
    projectId: s.projectId,
    generationId: s.generationId,
    collection: PLAN_ROWS,
    key: 'issue:open:0',
    parent: 'issue:open',
    position: 0,
    value: encodePlanPage([
      { id: item.id, kind: 'issue', status: 'open', title: 'Old title', position: root.position },
    ]),
  });
  await s.patch(root._id, { title: 'Current title survives automatic repair' });
  assert.equal(s.tables.projectWorkGenerations.get(s.generationId).planRowsVersion, undefined);
  assert.equal(repairs(s).length, 1);
  const expected = shape(await planView(s.ctx, s.projectId));
  const { costs } = await drain(s);
  assert.deepEqual(shape(await planView(s.ctx, s.projectId)), expected);
  assert.equal(s.tables.projectWorkGenerations.get(s.generationId).planRowsVersion, 1);
  assert.equal(s.tables.projectWorkGenerations.get(s.generationId).planRowsPreparation, undefined);
  assert(
    pages(s).every(
      page =>
        page.key.startsWith(PLAN_PAGE_PREFIX) &&
        decodePlanPage(page.value, page.parent).length <= PLAN_PAGE_SIZE,
    ),
  );
  const before = JSON.stringify(pages(s)),
    count = repairs(s).length;
  await prepare.repair._handler(s.ctx, repairs(s)[0].args);
  assert.equal(JSON.stringify(pages(s)), before);
  assert.equal(repairs(s).length, count, 'retrying a finished step never advances another step');
  t.diagnostic(
    JSON.stringify({
      steps: count,
      maxReadBytes: Math.max(...costs.map(x => x.readBytes)),
      maxWriteBytes: Math.max(...costs.map(x => x.writeBytes)),
    }),
  );
});

test('oversized legacy metadata gets one bounded repair, stays idle when blocked, and recovers automatically after an edit', async t => {
  const s = await planFixture(t, 1, true);
  await s.project();
  const id = s.roots[23],
    title = 'Large exact legacy title '.repeat(16000);
  await s.patch(id, { title });
  assert.equal(s.tables.projectWorkGenerations.get(s.generationId).planRowsOversized, true);
  assert.equal(repairs(s).length, 1);
  const first = await drain(s);
  assert.equal(s.tables.projectWorkGenerations.get(s.generationId).planRowsPreparation.phase, 'blocked');
  assert(shape(await planView(s.ctx, s.projectId)).rows.some(row => row.title === title));
  const count = repairs(s).length;
  const io = meterWorkIO(s.ctx, s.tables);
  const idleRead = await io.cost(() => planView(s.ctx, s.projectId));
  assert.equal(idleRead.writeDocuments, 0);
  assert.equal(repairs(s).length, count, 'queries never restart blocked work');
  io.restore();
  await s.patch(id, { title: 'Metadata fits again without operator preparation' });
  assert.equal(repairs(s).length, count + 1);
  const expected = shape(await planView(s.ctx, s.projectId));
  const second = await drain(s, first.index);
  assert.equal(s.tables.projectWorkGenerations.get(s.generationId).planRowsVersion, 1);
  assert.equal(s.tables.projectWorkGenerations.get(s.generationId).planRowsOversized, undefined);
  assert.equal(s.tables.projectWorkGenerations.get(s.generationId).planRowsPreparation, undefined);
  assert.deepEqual(shape(await planView(s.ctx, s.projectId)), expected);
  t.diagnostic(JSON.stringify({ blockedSteps: first.index, recoverySteps: second.index - first.index }));
});

test('a fitting edit during an oversized repair requests one replacement pass and needs no further write', async t => {
  const s = await planFixture(t);
  await s.project();
  const id = s.roots
    .filter(id => {
      const row = JSON.parse(s.tables.projectPlanningRecords.get(id).value);
      return row.kind === 'issue' && ['open', 'in-progress', 'proposed'].includes(row.status);
    })
    .sort((a, b) =>
      s.tables.projectPlanningRecords.get(a).key.localeCompare(s.tables.projectPlanningRecords.get(b).key),
    )[0];
  await s.patch(id, { title: 'Oversized legacy metadata '.repeat(16000) });
  await prepare.repair._handler(s.ctx, repairs(s)[0].args);
  await prepare.repair._handler(s.ctx, repairs(s)[1].args);
  assert.equal(s.tables.projectWorkGenerations.get(s.generationId).planRowsPreparation.compactReady, false);
  await s.patch(id, { title: 'The edit arrived while repair was running' });
  const expected = shape(await planView(s.ctx, s.projectId));
  const result = await drain(s, 2);
  assert.equal(s.tables.projectWorkGenerations.get(s.generationId).planRowsVersion, 1);
  assert.equal(s.tables.projectWorkGenerations.get(s.generationId).planRowsPreparation, undefined);
  assert.deepEqual(shape(await planView(s.ctx, s.projectId)), expected);
  assert(result.index <= 12, 'one source change requires at most one additional replacement pass');
});

test('a repair callback cannot act for another project or recreate metadata of a removed project', async t => {
  const s = await planFixture(t);
  await requestPlanRepair(s.ctx, s.generationId);
  const task = repairs(s)[0],
    before = JSON.stringify(pages(s));
  await prepare.repair._handler(s.ctx, { ...task.args, projectId: 'another-project' });
  assert.equal(JSON.stringify(pages(s)), before);
  await s.ctx.db.patch(s.projectId, { removal: 'deleted' });
  await prepare.repair._handler(s.ctx, task.args);
  assert.equal(JSON.stringify(pages(s)), before);
  assert.equal(repairs(s).length, 1);
});

test('settled-page sizing uses only stored positions and never falls back for an unused title', async t => {
  const s = await planFixture(t);
  await s.project();
  const before = shape(await planView(s.ctx, s.projectId));
  await s.patch(s.roots[293], { title: 'Large settled title '.repeat(16000) });
  assert.equal(s.tables.projectWorkGenerations.get(s.generationId).planRowsVersion, 1);
  assert.equal(s.tables.projectWorkGenerations.get(s.generationId).planRowsOversized, undefined);
  assert.equal(repairs(s).length, 0);
  assert.deepEqual(shape(await planView(s.ctx, s.projectId)), before);
});

test('overlapping operator rebuilds share current progress without an extra restart step', async t => {
  const s = await planFixture(t);
  const input = {
    projectId: s.projectId,
    owner: 'owner',
    generationId: s.generationId,
    operationId: randomUUID(),
    cursor: null,
    planRowsOnly: true,
  };
  const first = JSON.parse(await prepare.page._handler(s.ctx, input));
  const second = JSON.parse(await prepare.page._handler(s.ctx, { ...input, operationId: randomUUID() }));
  let result = JSON.parse(
    await prepare.page._handler(s.ctx, { ...input, operationId: randomUUID(), cursor: first.nextCursor }),
  );
  if (!result.isDone)
    assert.equal(JSON.parse(result.nextCursor).preparationId, JSON.parse(second.nextCursor).preparationId);
  while (!result.isDone)
    result = JSON.parse(
      await prepare.page._handler(s.ctx, { ...input, operationId: randomUUID(), cursor: result.nextCursor }),
    );
  assert.equal(result.compactReady, true);
  const compact = shape(await planView(s.ctx, s.projectId));
  await finishReadWriter(s.ctx).db.patch(s.generationId, { planRowsVersion: undefined });
  assert.deepEqual(compact, shape(await planView(s.ctx, s.projectId)));
});

test('an alias shares partition repair without copying its control or scheduled task', async t => {
  const s = await planFixture(t);
  await requestPlanRepair(s.ctx, s.generationId);
  const { _id, _creationTime, ...generation } = s.tables.projectWorkGenerations.get(s.generationId);
  const writer = workRecordWriter(s.ctx);
  const alias = await writer.db.insert('projectWorkGenerations', {
    ...generation,
    recordsGenerationId: s.generationId,
  });
  assert.equal(s.tables.projectWorkGenerations.get(alias).planRowsPreparation, undefined);
  await requestPlanRepair(s.ctx, alias);
  assert.equal(repairs(s).length, 1);
  const project = s.tables.hostedProjects.get(s.projectId);
  await finishReadWriter(s.ctx).db.patch(s.projectId, { work: { ...project.work, generationId: alias } });
  const expected = shape(await planView(s.ctx, s.projectId));
  await drain(s);
  assert.equal(s.tables.projectWorkGenerations.get(s.generationId).planRowsPreparation, undefined);
  assert.equal(s.tables.projectWorkGenerations.get(alias).planRowsVersion, 1);
  assert.deepEqual(shape(await planView(s.ctx, s.projectId)), expected);
});

test('an inconsistent alias cannot request repair in another project', async t => {
  const s = await planFixture(t);
  const { _id, _creationTime, ...generation } = s.tables.projectWorkGenerations.get(s.generationId);
  const foreign = await s.ctx.db.insert('projectWorkGenerations', {
    ...generation,
    projectId: 'another-project',
  });
  const writer = workRecordWriter(s.ctx);
  const alias = await writer.db.insert('projectWorkGenerations', {
    ...generation,
    recordsGenerationId: foreign,
  });
  await requestPlanRepair(s.ctx, alias);
  assert.equal(repairs(s).length, 0);
  assert.equal(s.tables.projectWorkGenerations.get(foreign).planRowsPreparation, undefined);
});

test('legacy alias search completion marks its partition complete and wakes finite Plan repair', async t => {
  const s = await setup(t),
    project = s.tables.hostedProjects.get(s.projectId),
    generationId = project.work.generationId;
  await s.ctx.db.patch(generationId, { planningSearchVersion: 1, planRowsVersion: undefined });
  const { _id, _creationTime, ...generation } = s.tables.projectWorkGenerations.get(generationId);
  const alias = await s.ctx.db.insert('projectWorkGenerations', {
    ...generation,
    recordsGenerationId: generationId,
  });
  await s.ctx.db.patch(s.projectId, { work: { ...project.work, generationId: alias } });
  const result = JSON.parse(
    await prepare.page._handler(s.ctx, {
      projectId: s.projectId,
      owner: 'owner',
      generationId: alias,
      operationId: randomUUID(),
      cursor: null,
    }),
  );
  assert(result.isDone);
  assert.equal(s.tables.projectWorkGenerations.get(alias).planningSearchVersion, 2);
  assert.equal(s.tables.projectWorkGenerations.get(generationId).planningSearchVersion, 2);
  assert.equal(repairs(s).length, 1, 'complete search wakes exactly one bounded repair');
  await drain({ ...s, generationId });
  assert.equal(s.tables.projectWorkGenerations.get(generationId).planRowsVersion, 1);
  assert.equal(s.tables.projectWorkGenerations.get(generationId).planRowsPreparation, undefined);
});

test('oversized metadata repairs through a historically complete alias with an older partition search marker', async t => {
  const s = await planFixture(t, 1, true);
  await s.project();
  const alias = s.tables.hostedProjects.get(s.projectId).work.generationId;
  await s.ctx.db.patch(s.generationId, { planningSearchVersion: 1 });
  assert.equal(s.tables.projectWorkGenerations.get(alias).planningSearchVersion, 2);
  const id = s.roots.find(id => {
    const row = JSON.parse(s.tables.projectPlanningRecords.get(id).value);
    return row.kind === 'issue' && row.status === 'open';
  });
  await s.patch(id, { title: 'Legacy alias metadata '.repeat(16000) });
  assert.equal(repairs(s).length, 1, 'a complete selected alias proves coverage for its exact partition');
  const first = await drain(s);
  assert.equal(s.tables.projectWorkGenerations.get(s.generationId).planRowsPreparation.phase, 'blocked');
  await s.patch(id, { title: 'Fits again through the existing complete alias' });
  assert.equal(repairs(s).length, first.index + 1);
  const expected = shape(await planView(s.ctx, s.projectId));
  await drain(s, first.index);
  assert.equal(s.tables.projectWorkGenerations.get(s.generationId).planRowsVersion, 1);
  assert.deepEqual(shape(await planView(s.ctx, s.projectId)), expected);
});
