// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { MutationCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { internal } from './_generated/api';

export type PlanPreparation = NonNullable<Doc<'projectWorkGenerations'>['planRowsPreparation']>;

export async function startPlanPreparation(
  ctx: MutationCtx,
  generationId: Id<'projectWorkGenerations'>,
  id: string,
  automatic = false,
) {
  const state: PlanPreparation = {
    id,
    step: crypto.randomUUID(),
    phase: 'clear',
    after: null,
    compactReady: true,
    automatic,
  };
  await ctx.db.patch(generationId, { planRowsVersion: undefined, planRowsPreparation: state });
  return state;
}

export async function savePlanPreparation(
  ctx: MutationCtx,
  generation: Pick<Doc<'projectWorkGenerations'>, '_id' | 'projectId'>,
  state: PlanPreparation,
) {
  if (state.automatic && state.phase !== 'blocked' && !state.task)
    state = {
      ...state,
      task: await ctx.scheduler.runAfter(0, internal.projectHostedPlanningPrepare.repair, {
        projectId: generation.projectId,
        generationId: generation._id,
        preparationId: state.id,
        step: state.step,
      }),
    };
  await ctx.db.patch(generation._id, { planRowsPreparation: state });
  return state;
}

/** Coalesce exceptional layout/size repairs. Ordinary prepared-page edits never call this. */
export async function requestPlanRepair(
  ctx: MutationCtx,
  generationId: Id<'projectWorkGenerations'>,
): Promise<void> {
  let generation = await ctx.db.get(generationId);
  if (!generation) return;
  if (generation.recordsGenerationId) {
    const partition = await ctx.db.get(generation.recordsGenerationId);
    if (!partition || partition.projectId !== generation.projectId || partition.recordsGenerationId) return;
    generation = partition;
    generationId = partition._id;
  }
  let state = generation.planRowsPreparation;
  if (
    state?.task &&
    state.automatic &&
    !(state.phase === 'rows' && generation.planRowsOversized && !state.restart)
  )
    return;
  if (!state || state.phase === 'blocked')
    state = await startPlanPreparation(ctx, generationId, crypto.randomUUID(), true);
  else
    state = {
      ...state,
      automatic: true,
      ...(state.phase === 'rows' && generation.planRowsOversized ? { restart: true } : {}),
    };
  // Older search preparation stamped only the selected alias. Its exact shared
  // partition is equally complete; do not leave a valid repair waiting forever.
  let complete = generation.planningSearchVersion === 2;
  if (!complete) {
    const project = await ctx.db.get(generation.projectId);
    const selected = project?.work?.generationId;
    const alias = selected && selected !== generationId ? await ctx.db.get(selected) : null;
    complete =
      alias?.projectId === generation.projectId &&
      alias.recordsGenerationId === generationId &&
      alias.planningSearchVersion === 2;
  }
  // Incomplete search owns its coverage; its completion wakes this finite repair.
  if (complete) await savePlanPreparation(ctx, generation, state);
}
