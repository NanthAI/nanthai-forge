// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { setup } from './hosted-planning-fixture.mjs';
import { indexedRecord } from '../dist/work-hosted-index.js';
import { moduleUrl } from './convex-module.mjs';
export const planRowKeys = new Set([
  'id',
  'kind',
  'title',
  'status',
  'position',
  'version',
  'initiativeId',
  'parentId',
  'order',
  'type',
  'owner',
  'relations',
  'hidden',
  'inLane',
  'doneWhen',
]);
const { workRecordWriter, finishWorkRecordWrites, preparePlanRowsWrites } = await import(
  moduleUrl('../convex/projectWorkRecordWriter.ts')
);
const { finishReadWriter } = await import(moduleUrl('../convex/projectFinishReadWriter.ts'));
const { planCounter } = await import(moduleUrl('../convex/projectPlanCountsStore.ts'));
export async function planFixture(t, scale = 1, sparse = false) {
  const s = await setup(t);
  const generationId = s.tables.hostedProjects.get(s.projectId).work.generationId;
  // The fixture loads historical search roots directly and prepares only the compact rows.
  await s.ctx.db.delete((await planCounter(s.ctx.db, generationId))._id);
  await finishReadWriter(s.ctx).db.patch(generationId, { planRowsVersion: undefined });
  const initiatives = Array.from({ length: 22 * scale }, () => randomUUID());
  const topics = [
    'the source reader',
    'parallel planning',
    'the project list',
    'the saved snapshot',
    'the check evidence',
    'the owned Lane',
    'the access record',
    'the compact projection',
    'the export archive',
    'the session history',
    'the change summary',
  ];
  const roots = [];
  // Many settled Items belong to older Initiatives and are absent from a Plan
  // read. Its selected creation positions therefore have gaps and mixed states.
  const positions = Array.from({ length: 324 * scale }, (_, i) => ({
    i,
    position: sparse ? (i * 137) % (1009 * scale) : i,
  })).sort((a, b) => a.position - b.position);
  for (const { i, position } of positions) {
    const initiative = i < 22 * scale,
      settled = i >= 293 * scale;
    const item = {
      id: initiative ? initiatives[i] : randomUUID(),
      kind: initiative ? 'initiative' : 'issue',
      status: initiative
        ? i < 4 * scale
          ? 'open'
          : 'closed'
        : settled
          ? i % 5 === 0
            ? 'abandoned'
            : 'closed'
          : i % 3 === 0
            ? 'in-progress'
            : i % 7 === 0
              ? 'proposed'
              : 'open',
      title: `Preserve ${topics[i % topics.length]} when ${topics[(i + 3) % topics.length]} changes during a concurrent update ${randomUUID()}`,
      version: 3,
      previousVersion: 2,
      operationId: randomUUID(),
      request: 'a'.repeat(64),
      at: '2026-11-17T00:00:00.000Z',
      provenance: 'user-declared-local',
      intentIds: [],
      body:
        `Distinct Item ${randomUUID()} — ${topics[i % topics.length]}\n` +
        'Done when:\n- [x] Preserve the original source and identity\n- [ ] Keep concurrent writes in the same transaction\n' +
        Array.from(
          { length: i % 9 },
          (_, line) => `- [ ] Keep ${randomUUID()} exact in section ${line}\n`,
        ).join('') +
        `\nPrivate fixture detail ${randomUUID()} `.repeat(i % 7),
      author: `user_synthetic${i}`,
      ...(!initiative
        ? {
            initiativeId: initiatives[i % (4 * scale)],
            ...(i % 4 === 0 ? { owner: '@sample' } : {}),
            ...(i % 3 === 0 ? { type: 'task' } : {}),
            ...(i % 10 === 0 ? { relations: [{ kind: 'depends-on', id: initiatives[0] }] } : {}),
            ...(i % 13 === 0 ? { hidden: true } : {}),
          }
        : {}),
    };
    for (const entry of indexedRecord('planningItems', item.id, '', position, item)) {
      const id = await s.ctx.db.insert('projectPlanningRecords', {
        ...entry,
        projectId: s.projectId,
        generationId,
      });
      if (entry.collection === 'planningSearch') roots[i] = id;
    }
  }
  if (sparse) {
    const { _id, _creationTime, ...generation } = s.tables.projectWorkGenerations.get(generationId);
    const alias = await finishReadWriter(s.ctx).db.insert('projectWorkGenerations', {
      ...generation,
      recordsGenerationId: generationId,
    });
    const project = s.tables.hostedProjects.get(s.projectId);
    await finishReadWriter(s.ctx).db.patch(s.projectId, {
      work: { ...project.work, generationId: alias },
      needsFix: Object.fromEntries(
        Array.from({ length: 6 }, () => [
          randomUUID(),
          JSON.stringify({
            at: '2026-11-17T00:00:00.000Z',
            auditRunId: randomUUID(),
            head: 'a'.repeat(64),
            intentId: randomUUID(),
            receiptId: randomUUID(),
            state: 'needs-fix',
            summary: 'Synthetic diagnostic history is irrelevant to a Plan read. '.repeat(4),
          }),
        ]),
      ),
    });
    for (const id of [generationId, alias]) {
      const current = s.tables.projectWorkGenerations.get(id);
      await finishReadWriter(s.ctx).db.patch(id, {
        metadata: JSON.stringify({
          ...JSON.parse(current.metadata),
          fixtureNotes: 'Unused index metadata. '.repeat(100),
        }),
      });
    }
  }
  return {
    ...s,
    generationId,
    roots,
    initiatives,
    async project() {
      const writer = workRecordWriter(finishReadWriter(s.ctx));
      preparePlanRowsWrites(writer);
      for (const id of roots)
        await writer.db.patch(id, { value: s.tables.projectPlanningRecords.get(id).value });
      await finishWorkRecordWrites(writer);
      await finishReadWriter(s.ctx).db.patch(generationId, { planRowsVersion: 1 });
    },
    async patch(id, fields, compact = true) {
      const writer = compact ? workRecordWriter(finishReadWriter(s.ctx)) : s.ctx;
      const root = s.tables.projectPlanningRecords.get(id);
      const value = { ...JSON.parse(root.value), ...fields };
      await writer.db.patch(id, {
        value: JSON.stringify(value),
        planning: {
          ...root.planning,
          status: value.status,
          initiativeId: value.initiativeId ?? '',
          open: ['proposed', 'open', 'in-progress'].includes(value.status),
        },
      });
      if (compact) await finishWorkRecordWrites(writer);
    },
  };
}
