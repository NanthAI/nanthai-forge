// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setup } from './hosted-planning-fixture.mjs';
import { indexedRecord } from '../dist/work-hosted-index.js';
import { meterWorkIO } from './hosted-read-set.mjs';
import { moduleUrl } from './convex-module.mjs';
const { workRecordWriter, finishWorkRecordWrites } = await import(
  moduleUrl('../convex/projectWorkRecordWriter.ts')
);
const { planView } = await import(moduleUrl('../convex/projectPlanView.ts'));
const { PLAN_PAGE_SIZE, PLAN_ROWS, decodePlanPage } = await import(moduleUrl('../convex/projectPlanRows.ts'));

for (const [relations, titleLength] of [
  [0, 0],
  [0, 200],
  [0, 400],
  [20, 400],
])
  test(`128 occupied rows with ${titleLength || 'short'}-character titles and ${relations} relations keep edits within 16KB and the full view within 40KB`, async t => {
    const s = await setup(t),
      generationId = s.tables.hostedProjects.get(s.projectId).work.generationId,
      ids = Array.from({ length: 128 }, () => randomUUID()),
      words =
        'source reader planning project saved snapshot check evidence owned Lane access record compact projection export archive session history change summary concurrent update preserve exact identity'.split(
          ' ',
        ),
      writer = workRecordWriter(s.ctx),
      roots = [];
    for (let i = 0; i < ids.length; i++) {
      const title = !titleLength
        ? `Preserve Item ${i} ${randomUUID()}`
        : Array.from({ length: 65 }, (_, j) => words[(i * 7 + j * ((i % 5) + 1)) % words.length])
            .join(' ')
            .slice(0, titleLength - 37) + ` ${randomUUID()}`;
      const item = {
        id: ids[i],
        kind: 'issue',
        status: 'open',
        version: 1,
        title,
        body: `Distinct source detail ${randomUUID()}\n- [ ] Preserve Item ${i}`,
        intentIds: [],
        operationId: randomUUID(),
        request: 'a'.repeat(64),
        at: '2026-11-17T00:00:00.000Z',
        provenance: 'user-declared-local',
        relations: Array.from({ length: relations }, (_, j) => ({
          kind: 'depends-on',
          id: ids[(i + j + 1) % ids.length],
        })),
      };
      for (const entry of indexedRecord('planningItems', item.id, '', i, item)) {
        const id = await writer.db.insert('projectPlanningRecords', {
          ...entry,
          projectId: s.projectId,
          generationId,
        });
        if (entry.collection === 'planningSearch') roots.push(id);
      }
    }
    await finishWorkRecordWrites(writer);
    const io = meterWorkIO(s.ctx, s.tables);
    const read = await io.cost(() => planView(s.ctx, s.projectId));
    const edit = workRecordWriter(s.ctx);
    const update = await io.cost(async () => {
      const root = await edit.db.get(roots[64]);
      const value = {
        ...JSON.parse(root.value),
        version: 2,
        title: `Updated ${randomUUID()} ${JSON.parse(root.value).title}`.slice(0, 400),
      };
      await edit.db.patch(root._id, { value: JSON.stringify(value) });
      await finishWorkRecordWrites(edit);
    });
    const pages = [...s.tables.projectWorkDataRecords.values()].filter(row => row.collection === PLAN_ROWS);
    assert.equal(PLAN_PAGE_SIZE, 128);
    const occupancy = pages.map(page => decodePlanPage(page.value, page.parent).length);
    assert.equal(
      occupancy.reduce((a, b) => a + b, 0),
      128,
    );
    assert(occupancy.every(rows => rows <= 128));
    if (titleLength <= 200)
      assert(occupancy.includes(128), 'the fixture fills one physical page when its metadata fits');
    if (relations)
      assert(pages.length > 1, 'relation-heavy full occupancy splits by bytes before breaching edit I/O');
    assert.equal(JSON.parse((await planView(s.ctx, s.projectId)).rows).length, 128);
    assert(read.readBytes <= 40000, JSON.stringify(read));
    assert(update.readBytes <= 16000, JSON.stringify(update));
    assert(update.writeBytes <= 16000, JSON.stringify(update));
    t.diagnostic(JSON.stringify({ relations, titleLength, occupancy, read, update }));
  });
