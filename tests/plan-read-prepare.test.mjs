// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { planFixture } from './plan-read-fixture.mjs';
import { setup } from './hosted-planning-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const prepare = await import(moduleUrl('../convex/projectHostedPlanningPrepare.ts'));
const { planView } = await import(moduleUrl('../convex/projectPlanView.ts'));
const { PLAN_ROWS } = await import(moduleUrl('../convex/projectPlanRows.ts'));
const { finishReadWriter } = await import(moduleUrl('../convex/projectFinishReadWriter.ts'));
const reply = r => ({ ...r, rows: JSON.parse(r.rows) });
test('large exact titles keep legacy reads through aliases and partial preparation, then compact again after repair', async t => {
  const s = await planFixture(t, 1, true);
  const aliasId = s.tables.hostedProjects.get(s.projectId).work.generationId;
  const input = {
    projectId: s.projectId,
    owner: 'owner',
    generationId: aliasId,
    operationId: randomUUID(),
    cursor: null,
    planRowsOnly: true,
  };
  let result = JSON.parse(await prepare.page._handler(s.ctx, input));
  const after = JSON.parse(result.nextCursor).after;
  const id = s.roots.find(id => {
    const root = s.tables.projectPlanningRecords.get(id),
      row = JSON.parse(root.value);
    return (
      root.key <= after &&
      (row.kind === 'initiative' || ['open', 'proposed', 'in-progress'].includes(row.status))
    );
  });
  const hugeTitle = 'Exact large title '.repeat(16000);
  await s.patch(id, { title: hugeTitle });
  assert.equal(s.tables.projectWorkGenerations.get(s.generationId).planRowsVersion, undefined);
  assert.equal(s.tables.projectWorkGenerations.get(s.generationId).planRowsOversized, true);
  // A retained alias must not override its partition's current coverage.
  await finishReadWriter(s.ctx).db.patch(aliasId, { planRowsVersion: 1 });
  assert(JSON.parse((await planView(s.ctx, s.projectId)).rows).some(row => row.title === hugeTitle));
  while (!result.isDone)
    result = JSON.parse(
      await prepare.page._handler(s.ctx, { ...input, operationId: randomUUID(), cursor: result.nextCursor }),
    );
  assert.equal(
    result.compactReady,
    false,
    'a large write to an earlier page cannot publish partial coverage',
  );
  assert.equal(s.tables.projectWorkGenerations.get(s.generationId).planRowsVersion, undefined);
  await s.patch(id, { title: 'The repaired title remains exact' });
  const before = reply(await planView(s.ctx, s.projectId));
  result = { isDone: false, nextCursor: null };
  while (!result.isDone)
    result = JSON.parse(
      await prepare.page._handler(s.ctx, { ...input, operationId: randomUUID(), cursor: result.nextCursor }),
    );
  assert.equal(result.compactReady, true);
  assert.equal(s.tables.projectWorkGenerations.get(s.generationId).planRowsVersion, 1);
  assert.deepEqual(reply(await planView(s.ctx, s.projectId)), before);
});
test('bounded Plan preparation preserves canonical bytes, retries exactly and covers writes between pages', async t => {
  const s = await planFixture(t);
  const canonical = new Map([...s.tables.projectPlanningRecords].map(([id, row]) => [id, row.value]));
  const input = {
    projectId: s.projectId,
    owner: 'owner',
    generationId: s.generationId,
    operationId: randomUUID(),
    cursor: null,
    planRowsOnly: true,
  };
  await assert.rejects(
    () =>
      prepare.page._handler(s.ctx, {
        ...input,
        operationId: randomUUID(),
        cursor: JSON.stringify({ after: 'zzzz', operationId: randomUUID() }),
      }),
    { code: 'WORK_STALE' },
  );
  assert.equal(s.tables.projectWorkGenerations.get(s.generationId).planRowsVersion, undefined);
  await assert.rejects(
    () => prepare.page._handler(s.ctx, { ...input, operationId: randomUUID(), cursor: 'null' }),
    { code: 'BAD_ARGUMENT' },
  );
  const first = await prepare.page._handler(s.ctx, input);
  assert.equal(
    s.tables.projectWorkGenerations.get(s.generationId).planRowsVersion,
    undefined,
    'partial coverage keeps the legacy reader',
  );
  assert.equal(
    await prepare.page._handler(s.ctx, input),
    first,
    'lost replies replay the same page without duplicating positions',
  );
  await assert.rejects(() => prepare.page._handler(s.ctx, { ...input, cursor: 'changed' }), {
    code: 'WORK_OPERATION_CHANGED',
  });
  await assert.rejects(
    () => prepare.page._handler(s.ctx, { ...input, owner: 'another-owner', operationId: randomUUID() }),
    { code: 'PROJECT_UNAVAILABLE' },
  );
  assert([...s.tables.projectWorkDataRecords.values()].some(row => row.collection === PLAN_ROWS));
  const id = s.roots[23];
  await s.patch(id, { status: 'closed', initiativeId: s.initiatives[1] });
  canonical.set(id, s.tables.projectPlanningRecords.get(id).value);
  let next = JSON.parse(first);
  let pages = 1;
  while (!next.isDone) {
    next = JSON.parse(
      await prepare.page._handler(s.ctx, { ...input, operationId: randomUUID(), cursor: next.nextCursor }),
    );
    pages++;
  }
  assert.equal(pages, 4, '324 roots use four bounded pages, not one call per Item');
  assert.equal(s.tables.projectWorkGenerations.get(s.generationId).planRowsVersion, 1);
  const compact = await planView(s.ctx, s.projectId);
  await finishReadWriter(s.ctx).db.patch(s.generationId, { planRowsVersion: undefined });
  assert.deepEqual(reply(compact), reply(await planView(s.ctx, s.projectId)));
  for (const [id, value] of canonical)
    assert.equal(
      s.tables.projectPlanningRecords.get(id).value,
      value,
      'preparation never changes Item or search-root bytes',
    );
});
test('fresh planning writes publish compact rows in the same mutation while Item bodies remain exact', async t => {
  const s = await setup(t);
  const generationId = s.tables.hostedProjects.get(s.projectId).work.generationId;
  assert.equal(s.tables.projectWorkGenerations.get(generationId).planRowsVersion, 1);
  const body =
    'Done when:\n- [x] Preserve the original prose\n- [ ] Keep the compact row current\n' +
    'Retained Item detail. '.repeat(1000);
  const item = s.item({ title: 'Keep detailed planning readable', body });
  await s.send(item);
  const row = JSON.parse((await planView(s.ctx, s.projectId)).rows).find(row => row.id === item.itemId);
  assert.equal(row.title, item.title);
  assert.deepEqual(row.doneWhen, [1, 2]);
  assert(!('body' in row));
  assert.equal(
    (await s.read()).data.planningItems.find(row => row.id === item.itemId).body,
    body,
    'the exact Work detail read keeps the full original body',
  );
  const saved = [...s.tables.projectWorkDataRecords.values()]
    .filter(row => row.collection === PLAN_ROWS)
    .map(row => row.value);
  await s.send({
    action: 'comment-planning-item',
    operationId: randomUUID(),
    itemId: item.itemId,
    text: 'Keep the original comment exact.',
  });
  assert.deepEqual(
    [...s.tables.projectWorkDataRecords.values()]
      .filter(row => row.collection === PLAN_ROWS)
      .map(row => row.value),
    saved,
    'ordinary comments do not rewrite Plan pages',
  );
  assert.equal((await s.read()).data.planningComments.at(-1).text, 'Keep the original comment exact.');
});
