// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { MutationCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { PLAN_ROWS } from './projectPlanRows';
import { finishWorkRecordWrites, preparePlanRowsWrites } from './projectWorkRecordWriter';
import { savePlanPreparation, type PlanPreparation } from './projectPlanPreparationStore';

/** Replacement has two finite phases. No roots are reapplied until all old
 * pages have gone, including old statuses, Initiatives and deleted Items. */
export async function advancePlanPreparation(
  ctx: MutationCtx,
  generation: Doc<'projectWorkGenerations'>,
  state: PlanPreparation,
) {
  preparePlanRowsWrites(ctx);
  let cleared = 0;
  if (state.phase === 'clear') {
    const page = await ctx.db
      .query('projectWorkDataRecords')
      .withIndex('by_generation_and_collection_and_key', q =>
        q.eq('generationId', generation._id).eq('collection', PLAN_ROWS),
      )
      .paginate({ cursor: null, numItems: 32, maximumRowsRead: 32, maximumBytesRead: 1000000 });
    for (const row of page.page) await ctx.db.delete(row._id);
    cleared = page.page.length;
    if (page.isDone) {
      state = { ...state, phase: 'rows', after: null };
      await ctx.db.patch(generation._id, { planRowsPreparation: state, planRowsOversized: undefined });
    }
    if (cleared || !page.isDone) {
      state = await savePlanPreparation(ctx, generation, {
        ...state,
        step: crypto.randomUUID(),
        task: undefined,
      });
      return { state, processed: 0, cleared, isDone: false, compactReady: state.compactReady };
    }
  }
  const page = await ctx.db
    .query('projectPlanningRecords')
    .withIndex('by_generation_and_collection_and_key', q => {
      const range = q.eq('generationId', generation._id).eq('collection', 'planningSearch');
      return state.after === null ? range : range.gt('key', state.after);
    })
    .paginate({ cursor: null, numItems: 100, maximumRowsRead: 100, maximumBytesRead: 1000000 });
  for (const root of page.page) await ctx.db.patch(root._id, { value: root.value });
  const flushed = await finishWorkRecordWrites(ctx);
  let compactReady = state.compactReady && flushed !== false;
  if (page.isDone) compactReady &&= !(await ctx.db.get(generation._id))?.planRowsOversized;
  state = {
    ...state,
    compactReady,
    after: page.page.at(-1)?.key ?? state.after,
    step: crypto.randomUUID(),
    task: undefined,
  };
  if (page.isDone && compactReady) {
    await ctx.db.patch(generation._id, {
      planRowsVersion: 1,
      planRowsOversized: undefined,
      planRowsPreparation: undefined,
    });
    const project = await ctx.db.get(generation.projectId);
    const selected = project?.work?.generationId;
    if (selected && selected !== generation._id) {
      const alias = await ctx.db.get(selected);
      if (alias?.recordsGenerationId === generation._id) await ctx.db.patch(selected, { planRowsVersion: 1 });
    }
    return { state: null, processed: page.page.length, cleared, isDone: true, compactReady };
  }
  if (page.isDone) {
    state =
      state.automatic && state.restart
        ? { ...state, phase: 'clear', after: null, compactReady: true, restart: undefined }
        : { ...state, phase: 'blocked' };
  }
  state = await savePlanPreparation(ctx, generation, state);
  return { state, processed: page.page.length, cleared, isDone: state.phase === 'blocked', compactReady };
}
