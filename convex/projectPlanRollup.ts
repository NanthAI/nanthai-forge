// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { v } from 'convex/values';
import { internalMutation, type MutationCtx } from './server';
import type { Doc } from './_generated/dataModel';
import type { PlanningWriteContext } from './projectWorkCommandContext';
import { recordPartition, selectedGeneration } from './projectWorkIndexStore';
import { workRecordLookup } from './projectWorkRecordTables';
import { planCounter, type PlanCounts } from './projectPlanCountsStore';
import { publishRollupBranches, readRollupBranch, readRollupScope } from './projectPlanRollupStore';
import { rollupChecklist, rollupWorkReader } from './projectPlanRollupFacts';
import { executeCommand } from './projectWorkCommand';
import { rollupBranch, rollupDecision } from '../src/planning-rollup';
import { emptyRollupCounts } from '../src/planning-rollup-membership';
import { isShelved, type PlanningItem } from '../src/work-planning-types';
import { digest } from '../src/state/hash';
import { recordHead } from './projectHostedRecords';

import { rollupWake } from './projectPlanRollupWake';
const result = v.union(
  v.literal('unchanged'),
  v.literal('moved'),
  v.literal('blocked'),
  v.literal('repeated'),
);
const source = v.union(
  v.literal('landing'),
  v.literal('plan'),
  v.literal('start'),
  v.literal('lifecycle'),
  v.literal('import'),
);

function operationFor(cause: string, item: PlanningItem, rule: string) {
  const h = digest(JSON.stringify(['plan-rollup-v1', cause, item.id, item.version, rule]));
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export async function writeRollupMove(
  ctx: MutationCtx,
  project: Doc<'hostedProjects'>,
  generation: Doc<'projectWorkGenerations'>,
  item: PlanningItem,
  move: NonNullable<ReturnType<typeof rollupDecision>>,
  cause: string,
  planning?: PlanningWriteContext,
) {
  const operationId = operationFor(cause, item, move.rule);
  await executeCommand(
    ctx,
    {
      projectId: project._id,
      operationId,
      command: JSON.stringify({
        action: 'put-planning-item',
        itemId: item.id,
        operationId,
        expectedVersion: item.version,
        status: move.status,
        reason: move.reason,
      }),
    },
    project.owner,
    { server: true, startGeneration: generation, fromRollup: true, planning },
  );
}

/** One scope per write. No sibling scan or source mutation: status versions and any next wake commit together. */
export const advance = internalMutation({
  args: {
    projectId: v.id('hostedProjects'),
    partition: v.optional(v.id('projectWorkGenerations')),
    itemId: v.string(),
    cause: v.string(),
    source,
    path: v.optional(v.array(v.string())),
    remaining: v.optional(v.number()),
    affected: v.optional(v.array(v.string())),
    reopenedLaneId: v.optional(v.string()),
  },
  returns: result,
  handler: async (ctx, args) => {
    const path = args.path ?? [];
    if (path.includes(args.itemId) || args.remaining === 0) return 'repeated' as const;
    const project = await ctx.db.get(args.projectId);
    const generation = project && !project.removal && (await selectedGeneration(ctx, project));
    if (!project || !generation) return 'blocked' as const;
    const partition = recordPartition(generation);
    if (
      args.partition ? partition !== args.partition : args.source !== 'start' && args.source !== 'lifecycle'
    )
      return 'blocked' as const;
    const enabled = project.autonomyPolicy?.rollUpPlanningStatus !== false;
    if (args.source === 'import') {
      // The import writer already published membership. Check its coverage once without inferring any status from imported history.
      if (!enabled) return 'unchanged' as const;
      const header = await planCounter(ctx.db, partition);
      const counts: PlanCounts | null = header ? JSON.parse(header.value) : null;
      return counts?.scopeThrough === null && !counts.scopeBlocked
        ? ('unchanged' as const)
        : ('blocked' as const);
    }
    const schedule = async (targets: Iterable<string>, remaining?: number) => {
      if (!enabled) return;
      for (const itemId of new Set(targets)) {
        if (itemId === args.itemId || path.includes(itemId)) continue;
        await ctx.scheduler.runAfter(0, rollupWake, {
          projectId: args.projectId,
          partition,
          cause: args.cause,
          itemId,
          source: 'plan',
          path: [...path, args.itemId],
          ...(remaining === undefined ? {} : { remaining }),
        });
      }
    };
    const row = await workRecordLookup(ctx, partition, 'planningItems', args.itemId);
    if (!row) return 'unchanged' as const;
    const item: PlanningItem & { payload?: true; payloadKey?: string } = JSON.parse(row.value);
    if (item.id !== args.itemId || isShelved(item.status) || item.purged) {
      await schedule(args.affected ?? []);
      return 'unchanged' as const;
    }
    if (item.payload || item.payloadKey || typeof item.body !== 'string') return 'blocked' as const;
    if ('planningClose' in row && row.planningClose) return 'blocked' as const;
    if (!enabled && (path.length || item.kind === 'initiative')) return 'unchanged' as const;
    const facts = await rollupWorkReader(ctx, args.projectId, 32).read(item);
    if (facts.work === 'unknown') return 'blocked' as const;
    // A Lane reopen does not rewrite its Intent. Honor the reopened Lane only while its exact current head is active.
    const reopened = args.reopenedLaneId
      ? await recordHead(ctx, args.projectId, 'lane', args.reopenedLaneId)
      : null;
    const work = reopened?.status === 'active' && reopened.planningItemId === item.id ? 'active' : facts.work;
    if (args.source === 'landing' && work !== 'completed') return 'unchanged' as const;
    const header = enabled ? await planCounter(ctx.db, partition) : null;
    const counts: PlanCounts | null = header ? JSON.parse(header.value) : null;
    if (enabled && (!counts || counts.scopeThrough !== null || counts.scopeBlocked))
      return 'blocked' as const;
    const branch =
      enabled && item.kind === 'issue' ? await readRollupBranch(ctx.db, partition, item.id) : null;
    const scope =
      branch?.effective ??
      branch?.counts ??
      (enabled && item.kind === 'initiative'
        ? (await readRollupScope(ctx.db, partition, `initiative:${item.id}`, true, true))!
        : emptyRollupCounts());
    const move = rollupDecision({ ...item, ...rollupChecklist(item.body), work }, scope, enabled);
    let forwarded = false;
    if (
      branch &&
      (item.parentId || item.initiativeId) &&
      (!item.parentId || (!path.includes(item.parentId) && item.parentId !== item.id))
    ) {
      // A pinned or Proposed Item passes started evidence through without moving its own displayed status.
      const changed = await publishRollupBranches(ctx.db, { projectId: args.projectId, partition }, [
        { item, previous: branch, next: rollupBranch(scope, work) },
      ]);
      if (changed === null) {
        if (header && counts)
          await ctx.db.patch(header._id, { value: JSON.stringify({ ...counts, scopeBlocked: true }) });
        return 'blocked' as const;
      }
      forwarded = changed;
    }
    if (move) await writeRollupMove(ctx, project, generation, item, move, args.cause);
    if (enabled && counts && item.kind === 'issue') {
      const remaining = args.remaining ?? Object.values(counts.issue).reduce((n, tally) => n + tally, 0);
      await schedule(
        [
          ...(args.affected ?? []),
          ...((move || forwarded) && item.parentId && remaining > 1 ? [item.parentId] : []),
          ...((move || forwarded) && item.initiativeId ? [item.initiativeId] : []),
        ],
        Math.max(1, remaining - 1),
      );
    }
    return move ? ('moved' as const) : ('unchanged' as const);
  },
});
