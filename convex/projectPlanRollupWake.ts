// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { makeFunctionReference } from 'convex/server';
import type { Id } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';
import { rollupChecklist } from './projectPlanRollupFacts';
import type { PlanningItem } from '../src/work-planning-types';

export const rollupWake = makeFunctionReference<'mutation'>('projectPlanRollup:advance');

/** Acceptance keeps its own batched fold; an explicit lifecycle operation checks just its linked Item. */
export async function wakePlanLifecycle(
  ctx: MutationCtx,
  input: {
    projectId: Id<'hostedProjects'>;
    cause: string;
    itemId?: string;
    branchOnly?: true;
    reopen?: { kind: 'lane' | 'intent'; id: string; version: number; at: string };
  },
) {
  if (!input.itemId) return;
  await ctx.scheduler.runAfter(0, rollupWake, { ...input, source: 'lifecycle' });
}

/** One wake for an applied version; operation replay returns before reaching here. The wake re-reads the latest
 * version. It must still consider the old membership even if a different write moved the Item again meanwhile. */
export async function wakePlanWrite(
  ctx: MutationCtx,
  input: { projectId: Id<'hostedProjects'>; partition: Id<'projectWorkGenerations'>; cause: string },
  before: PlanningItem | undefined,
  after: PlanningItem,
) {
  const membership =
    before?.status !== after.status ||
    before?.parentId !== after.parentId ||
    before?.initiativeId !== after.initiativeId;
  const checklist =
    before?.body !== after.body &&
    JSON.stringify(rollupChecklist(before?.body ?? '')) !== JSON.stringify(rollupChecklist(after.body));
  if (
    !membership &&
    !checklist &&
    Boolean(before?.statusPin) === Boolean(after.statusPin) &&
    JSON.stringify(before?.intentIds ?? []) === JSON.stringify(after.intentIds ?? [])
  )
    return;
  const affected = membership
    ? [
        ...new Set(
          [before?.parentId, before?.initiativeId, after.parentId, after.initiativeId].filter(
            (id): id is string => Boolean(id),
          ),
        ),
      ]
    : [];
  await ctx.scheduler.runAfter(0, rollupWake, { ...input, itemId: after.id, source: 'plan', affected });
}
