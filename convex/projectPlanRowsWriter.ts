// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { MutationCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import type { PlanRow } from '../src/planning-model';
import {
  PLAN_ROWS,
  PLAN_PAGE_SIZE,
  PLAN_PAGE_PREFIX,
  PLAN_OVERSIZED_PREFIX,
  planParent,
  planPageKey,
  planViewRow,
  planPagePayload,
  encodePlanPage,
  decodePlanPage,
} from './projectPlanRows';

type Root = Pick<
  Doc<'projectPlanningRecords'>,
  'collection' | 'projectId' | 'generationId' | 'value' | 'position'
>;
type Fields = Pick<
  Doc<'projectWorkDataRecords'>,
  'projectId' | 'generationId' | 'collection' | 'key' | 'parent' | 'position'
>;
type Page = {
  old: Doc<'projectWorkDataRecords'> | null;
  fields: Fields;
  end: number;
  rows: Map<number, PlanRow>;
};
const PAGE_VALUE_BYTES = 11000;

/** Sparse positions share a bounded interval until occupancy/bytes require a split.
 * The predecessor index selects exactly one leaf, without routers or per-Item records. */
export function planRowsWriter(
  db: MutationCtx['db'],
  knownLayout: (id: Id<'projectWorkGenerations'>) => boolean | undefined,
  repair: (id: Id<'projectWorkGenerations'>) => void,
) {
  const pages: Page[] = [];
  const layouts = new Map<string, boolean>();
  const oversized = new Set<string>();
  const layout = async (id: Id<'projectWorkGenerations'>) => {
    const known = knownLayout(id);
    if (known !== undefined) return known;
    if (!layouts.has(id)) {
      // Legacy keys start with issue:/initiative:. Current leaf keys use 2/x,
      // so an empty indexed legacy range proves no old layout needs replacing.
      const legacy = await db
        .query('projectWorkDataRecords')
        .withIndex('by_generation_and_collection_and_key', q =>
          q.eq('generationId', id).eq('collection', PLAN_ROWS).gte('key', 'i').lt('key', 'j'),
        )
        .take(1);
      layouts.set(id, legacy.length === 0);
    }
    return layouts.get(id)!;
  };
  const page = async (root: Root, row: PlanRow) => {
    const parent = planParent(row.kind, row.status, row.initiativeId ?? '');
    const cached = pages.find(
      p =>
        p.fields.generationId === root.generationId &&
        p.fields.parent === parent &&
        p.fields.position <= row.position &&
        row.position < p.end,
    );
    if (cached) return cached;
    // A caller's generation read avoids even opening an old wide page during upgrade.
    if (knownLayout(root.generationId) === false) {
      repair(root.generationId);
      return null;
    }
    let old: Page['old'] =
      (
        await db
          .query('projectWorkDataRecords')
          .withIndex('by_generation_and_collection_and_parent_and_position', q =>
            q
              .eq('generationId', root.generationId)
              .eq('collection', PLAN_ROWS)
              .eq('parent', parent)
              .lte('position', row.position),
          )
          .order('desc')
          .take(1)
      )[0] ?? null;
    if (
      (old && ![PLAN_PAGE_PREFIX, PLAN_OVERSIZED_PREFIX].includes(old.key[0]!)) ||
      (!old && !(await layout(root.generationId)))
    ) {
      repair(root.generationId);
      return null;
    }
    let lower = old?.position ?? 0;
    const suffix = old?.key.split(':').at(-1);
    let end = suffix && suffix !== '~' ? parseInt(suffix, 36) : Number.MAX_SAFE_INTEGER;
    if (old && (!Number.isFinite(end) || end <= lower)) {
      repair(root.generationId);
      return null;
    }
    if (!old || row.position >= end) {
      lower = old ? end : 0;
      old = null;
      const next = (
        await db
          .query('projectWorkDataRecords')
          .withIndex('by_generation_and_collection_and_parent_and_position', q =>
            q
              .eq('generationId', root.generationId)
              .eq('collection', PLAN_ROWS)
              .eq('parent', parent)
              .gt('position', row.position),
          )
          .order('asc')
          .take(1)
      )[0];
      end = next?.position ?? Number.MAX_SAFE_INTEGER;
    }
    const fields = {
      projectId: root.projectId,
      generationId: root.generationId,
      collection: PLAN_ROWS,
      parent,
      position: lower,
      key: planPageKey(parent, lower, end),
    };
    const selected: Page = {
      old,
      fields,
      end,
      rows: new Map((old ? decodePlanPage(old.value, parent) : []).map(item => [item.position, item])),
    };
    pages.push(selected);
    return selected;
  };
  const row = (root: Root | null) =>
    root?.collection === 'planningSearch' ? planViewRow(JSON.parse(root.value), root.position) : null;
  const write = async (
    old: Page['old'],
    fields: Fields,
    end: number,
    rows: PlanRow[],
    blocked = false,
  ): Promise<void> => {
    if (!rows.length) {
      if (old) await db.delete(old._id);
      return;
    }
    const rawBytes = new TextEncoder().encode(JSON.stringify(planPagePayload(rows))).byteLength;
    const value = rawBytes <= 256000 ? encodePlanPage(rows) : '';
    if (
      rows.length > 1 &&
      (rows.length > PLAN_PAGE_SIZE || rawBytes > 256000 || value.length > PAGE_VALUE_BYTES)
    ) {
      const middle = Math.floor(rows.length / 2),
        pivot = rows[middle]!.position;
      await write(
        old,
        { ...fields, key: planPageKey(fields.parent, fields.position, pivot) },
        pivot,
        rows.slice(0, middle),
        blocked,
      );
      await write(
        null,
        { ...fields, position: pivot, key: planPageKey(fields.parent, pivot, end) },
        end,
        rows.slice(middle),
        blocked,
      );
      return;
    }
    const tooLarge = rawBytes > 256000 || value.length > PAGE_VALUE_BYTES;
    if (tooLarge) {
      if (!oversized.has(fields.generationId)) {
        oversized.add(fields.generationId);
        await db.patch(fields.generationId, { planRowsVersion: undefined, planRowsOversized: true });
      }
      repair(fields.generationId);
    }
    const key = tooLarge || blocked ? PLAN_OVERSIZED_PREFIX + fields.key.slice(1) : fields.key;
    const next = { ...fields, key, value: tooLarge ? encodePlanPage([]) : value };
    if (old?.value === next.value && old.key === next.key) return;
    if (old) await db.patch(old._id, next);
    else await db.insert('projectWorkDataRecords', next);
  };
  return {
    async change(before: Root | null, after: Root | null) {
      const previous = row(before),
        next = row(after);
      if (previous) (await page(before!, previous))?.rows.delete(previous.position);
      if (next) (await page(after!, next))?.rows.set(next.position, next);
    },
    async flush() {
      for (const { old, fields, end, rows } of pages) {
        const blocked = old?.key.startsWith(PLAN_OVERSIZED_PREFIX);
        if (blocked) repair(fields.generationId);
        await write(
          old,
          fields,
          end,
          [...rows.values()].sort((a, b) => a.position - b.position),
          blocked,
        );
      }
      pages.length = 0;
      return !oversized.size;
    },
  };
}
