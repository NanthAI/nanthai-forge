// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { planFixture } from './plan-read-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const { workRecordWriter, finishWorkRecordWrites } = await import(
  moduleUrl('../convex/projectWorkRecordWriter.ts')
);
const { finishReadWriter } = await import(moduleUrl('../convex/projectFinishReadWriter.ts'));
const { PLAN_ROWS, decodePlanPage } = await import(moduleUrl('../convex/projectPlanRows.ts'));
const { planView } = await import(moduleUrl('../convex/projectPlanView.ts'));
const shape = x => ({ ...x, rows: JSON.parse(x.rows) });

for (const removedIndex of [0, 1])
  test(`reusing the gap of deleted leaf ${removedIndex} cannot absorb or duplicate its neighboring leaf`, async t => {
    const s = await planFixture(t, 2);
    await s.project();
    const leaves = [...s.tables.projectWorkDataRecords.values()]
      .filter(row => row.collection === PLAN_ROWS && row.parent === 'issue:open')
      .sort((a, b) => a.position - b.position);
    assert(leaves.length >= 3);
    const removed = decodePlanPage(leaves[removedIndex].value, 'issue:open');
    const neighbor = decodePlanPage(leaves[removedIndex + 1].value, 'issue:open')[0];
    const positions = new Set(removed.map(row => row.position));
    const writer = workRecordWriter(s.ctx);
    for (const id of s.roots) {
      const root = s.tables.projectPlanningRecords.get(id);
      if (positions.has(root.position) && JSON.parse(root.value).status === 'open')
        await writer.db.delete(id);
    }
    await finishWorkRecordWrites(writer);
    const next = workRecordWriter(s.ctx),
      id = randomUUID();
    await next.db.insert('projectPlanningRecords', {
      projectId: s.projectId,
      generationId: s.generationId,
      collection: 'planningSearch',
      key: id,
      parent: '',
      position: removed[0].position,
      value: JSON.stringify({ id, kind: 'issue', status: 'open', title: 'An Item in the vacant interval' }),
      planning: {
        text: 'An Item in the vacant interval',
        kind: 'issue',
        status: 'open',
        initiativeId: '',
        open: true,
      },
    });
    const adjacentId = s.roots.find(
      id => s.tables.projectPlanningRecords.get(id)?.position === neighbor.position,
    );
    const adjacent = await next.db.get(adjacentId);
    await next.db.patch(adjacentId, {
      value: JSON.stringify({
        ...JSON.parse(adjacent.value),
        title: 'The neighboring Item remains separate',
      }),
    });
    await finishWorkRecordWrites(next);
    const compact = shape(await planView(s.ctx, s.projectId));
    await finishReadWriter(s.ctx).db.patch(s.generationId, { planRowsVersion: undefined });
    assert.deepEqual(compact, shape(await planView(s.ctx, s.projectId)));
    assert.equal(new Set(compact.rows.map(row => row.id)).size, compact.rows.length);
  });
