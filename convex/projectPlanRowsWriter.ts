// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import type { PlanRow } from '../src/planning-model';
import {
  PLAN_ROWS,
  PLAN_PAGE_SIZE,
  planParent,
  planPageKey,
  planViewRow,
  encodePlanPage,
  decodePlanPage,
} from './projectPlanRows';

type Root = Pick<
  Doc<'projectPlanningRecords'>,
  'collection' | 'projectId' | 'generationId' | 'value' | 'position'
>;
type Page = {
  old: Doc<'projectWorkDataRecords'> | null;
  fields: Pick<
    Doc<'projectWorkDataRecords'>,
    'projectId' | 'generationId' | 'collection' | 'key' | 'parent' | 'position'
  >;
  rows: Map<number, PlanRow>;
};
/** One read and one final write per touched page in this transaction, including bulk writes and rebuild batches. */
export function planRowsWriter(db: MutationCtx['db']) {
  const pages = new Map<string, Promise<Page>>();
  const legacy = new Set<string>();
  const page = (root: Root, row: PlanRow) => {
    const parent = planParent(row.kind, row.status, row.initiativeId ?? '');
    const key = planPageKey(parent, row.position);
    const cacheKey = `${root.generationId}/${key}`;
    let pending = pages.get(cacheKey);
    if (!pending) {
      pending = (async () => {
        const old = await db
          .query('projectWorkDataRecords')
          .withIndex('by_generation_and_collection_and_key', q =>
            q.eq('generationId', root.generationId).eq('collection', PLAN_ROWS).eq('key', key),
          )
          .unique();
        return {
          old,
          fields: {
            projectId: root.projectId,
            generationId: root.generationId,
            collection: PLAN_ROWS,
            key,
            parent,
            position: Math.floor(row.position / PLAN_PAGE_SIZE),
          },
          rows: new Map((old ? decodePlanPage(old.value, parent) : []).map(item => [item.position, item])),
        };
      })();
      pages.set(cacheKey, pending);
    }
    return pending;
  };
  const row = (root: Root | null) =>
    root?.collection === 'planningSearch' ? planViewRow(JSON.parse(root.value), root.position) : null;
  return {
    async change(before: Root | null, after: Root | null) {
      const previous = row(before),
        next = row(after);
      if (previous) (await page(before!, previous)).rows.delete(previous.position);
      if (next) (await page(after!, next)).rows.set(next.position, next);
    },
    async flush() {
      for (const pending of pages.values()) {
        const { old, fields, rows } = await pending;
        if (!rows.size) {
          if (old) await db.delete(old._id);
          continue;
        }
        const ordered = [...rows.values()].sort((a, b) => a.position - b.position);
        // Derived metadata must not make an otherwise valid Item write exceed the
        // database document/memory envelope. Retain exact legacy reads for this
        // partition instead of truncating fields or rejecting its planning write.
        let rawBytes = 2;
        for (const row of ordered) {
          rawBytes += new TextEncoder().encode(JSON.stringify(row)).byteLength + 1;
          if (rawBytes > 256000) break;
        }
        if (rawBytes > 256000) {
          if (!legacy.has(fields.generationId)) {
            legacy.add(fields.generationId);
            await db.patch(fields.generationId, { planRowsVersion: undefined, planRowsOversized: true });
            const project = await db.get(fields.projectId);
            const selected = project?.work?.generationId;
            const alias = selected && selected !== fields.generationId ? await db.get(selected) : null;
            if (alias?.recordsGenerationId === fields.generationId)
              await db.patch(alias._id, { planRowsVersion: undefined });
          }
          continue;
        }
        const value = encodePlanPage(ordered);
        if (old?.value === value) continue;
        if (old) await db.patch(old._id, { value });
        else await db.insert('projectWorkDataRecords', { ...fields, value });
      }
      pages.clear();
      return !legacy.size;
    },
  };
}
