// SPDX-License-Identifier: Apache-2.0
import type { Doc } from './_generated/dataModel';
import type { MutationCtx } from './server';
import { record, recordPartition } from './projectWorkIndexStore';
import { commandPayloadRows, commandValues } from './projectWorkCommandRows';
import { decodePlanPage, PLAN_PAGE_SIZE, PLAN_ROWS, planParent, planViewRow } from './projectPlanRows';
import { isLive, type PlanRow } from '../src/planning-model';

/** Older generations may lack search roots. Their current Item headers are complete.
 * A fragmented live Item's header may omit its parent, so read its retained payload. */
async function legacyChildren(
  ctx: MutationCtx,
  generationId: Doc<'projectWorkGenerations'>['_id'],
  parents: ReadonlySet<string>,
) {
  const result: PlanRow[] = [];
  let after = -1;
  while (true) {
    const page = await ctx.db
      .query('projectPlanningRecords')
      .withIndex('by_generation_and_collection_and_position', q =>
        q.eq('generationId', generationId).eq('collection', 'planningItems').gt('position', after),
      )
      .take(32);
    const live = page.filter(entry => {
      const row = planViewRow(JSON.parse(entry.value), entry.position);
      return row?.kind === 'issue' && isLive(row);
    });
    await commandPayloadRows(live, keys =>
      Promise.all(keys.map(key => record(ctx, generationId, key.collection, key.key))),
    );
    for (const item of commandValues(live, 'planningItems')) {
      if (!item.parentId || !parents.has(item.parentId)) continue;
      const row = planViewRow(item, 0);
      if (row) result.push(row);
    }
    if (page.length < 32) return result;
    after = page.at(-1)!.position;
  }
}

/** Read the full live range in indexed pages in the close transaction. The browser's Plan
 * window and filters can omit children. A range read also covers a concurrent insertion. */
export async function liveCloseChildren(
  ctx: MutationCtx,
  generation: Doc<'projectWorkGenerations'>,
  parents: ReadonlySet<string>,
) {
  if (!parents.size) return [];
  const generationId = recordPartition(generation);
  const partition = generationId === generation._id ? generation : await ctx.db.get(generationId);
  if (partition?.planningSearchVersion !== 2 || generation.planningSearchVersion !== 2)
    return legacyChildren(ctx, generationId, parents);
  const result: PlanRow[] = [];
  const include = (row: PlanRow | null) => {
    if (row?.parentId && parents.has(row.parentId)) result.push(row);
  };
  for (const status of ['proposed', 'open', 'in-progress']) {
    let after = -1;
    while (true) {
      const parent = planParent('issue', status);
      const page =
        partition?.planRowsVersion === 1
          ? await ctx.db
              .query('projectWorkDataRecords')
              .withIndex('by_generation_and_collection_and_parent_and_position', q =>
                q
                  .eq('generationId', generationId)
                  .eq('collection', PLAN_ROWS)
                  .eq('parent', parent)
                  .gt('position', after),
              )
              .take(PLAN_PAGE_SIZE)
          : await ctx.db
              .query('projectPlanningRecords')
              .withIndex('by_planning_kind_and_status', q =>
                q
                  .eq('generationId', generationId)
                  .eq('collection', 'planningSearch')
                  .eq('planning.kind', 'issue')
                  .eq('planning.status', status)
                  .gt('position', after),
              )
              .take(PLAN_PAGE_SIZE);
      for (const row of page) {
        if (row.collection === PLAN_ROWS) decodePlanPage(row.value, row.parent).forEach(include);
        else include(planViewRow(JSON.parse(row.value), row.position));
      }
      if (page.length < PLAN_PAGE_SIZE) break;
      after = page.at(-1)!.position;
    }
  }
  return result;
}
