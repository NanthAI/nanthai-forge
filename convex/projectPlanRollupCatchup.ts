// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { v } from 'convex/values';
import { internalMutation, internalQuery } from './server';
import { recordPartition, selectedGeneration } from './projectWorkIndexStore';
import { generationHead } from './projectWorkHead';
import { planningWriteContext } from './projectWorkCommandContext';
import { planCounter, type PlanCounts } from './projectPlanCountsStore';
import { publishRollupBranches, readRollupBranch, readRollupScope } from './projectPlanRollupStore';
import { rollupChecklist, rollupWorkReader } from './projectPlanRollupFacts';
import { completionHeldByReopen } from './projectPlanRollupReopen';
import { writeRollupMove } from './projectPlanRollup';
import { splitRecordTable } from './projectWorkRecordTables';
import { rollupBranch, rollupDecision } from '../src/planning-rollup';
import { isShelved, type PlanningItem } from '../src/work-planning-types';
import { catchupRow, catchupWake, type CatchupProgress } from './projectPlanRollupCatchupStore';

const levels = 3;

export const status = internalQuery({
  args: { partition: v.id('projectWorkGenerations') },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, { partition }) => {
    const row = await catchupRow(ctx, partition);
    if (!row) return null;
    const { pending, ...progress } = JSON.parse(row.value) as CatchupProgress;
    return JSON.stringify({
      ...progress,
      ...(pending ? { state: 'partial', reason: 'approval-path-replaced' } : {}),
    });
  },
});

const level = (item: PlanningItem) => (item.kind === 'initiative' ? 2 : item.parentId ? 0 : 1);

/** The hierarchy guard makes a leaf-first pass possible without storing an inventory or walking ancestors.
 * Import-era deeper trees are reported partial, not interpreted using incomplete children. */
export const page = internalMutation({
  args: {
    projectId: v.id('hostedProjects'),
    partition: v.id('projectWorkGenerations'),
    operationId: v.string(),
    step: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { projectId, partition, operationId, step } = args;
    const row = await catchupRow(ctx, partition);
    if (!row) return null;
    const progress: CatchupProgress = JSON.parse(row.value);
    if (progress.operationId !== operationId || progress.step !== step || progress.state !== 'running')
      return null;
    const stop = async (reason: string) => {
      await ctx.db.patch(row._id, { value: JSON.stringify({ ...progress, state: 'partial', reason }) });
      return null;
    };
    const project = await ctx.db.get(projectId);
    if (!project || project.removal || project.autonomyPolicy?.rollUpPlanningStatus === false)
      return stop('disabled-or-removed');
    if (progress.pending) return stop('approval-path-replaced');
    const selected = await selectedGeneration(ctx, project);
    const generation = selected && (await generationHead(ctx, selected));
    if (!generation || recordPartition(generation) !== partition) return stop('plan-changed');
    const header = await planCounter(ctx.db, partition);
    const counts: PlanCounts | null = header ? JSON.parse(header.value) : null;
    if (counts?.scopeThrough !== null || counts.scopeBlocked) return stop('scope-tallies-unavailable');
    const source = await ctx.db
      .query(splitRecordTable('planningItems'))
      .withIndex('by_generation_and_collection_and_key', q =>
        q.eq('generationId', partition).eq('collection', 'planningItems').gt('key', progress.after),
      )
      .paginate({ cursor: null, numItems: 50, maximumRowsRead: 50, maximumBytesRead: 256 * 1024 });
    const last = source.page.at(-1)?.key;
    if (!source.isDone && (!last || last <= progress.after)) return stop('page-could-not-advance');
    const read = rollupWorkReader(ctx, project, generation, 150);
    const targets = [];
    for (const root of source.page) {
      const item: PlanningItem & { payload?: true; payloadKey?: string } = JSON.parse(root.value);
      if (isShelved(item.status) || item.purged || level(item) !== progress.pass) continue;
      if (
        item.id !== root.key ||
        item.payload ||
        item.payloadKey ||
        typeof item.body !== 'string' ||
        ('planningClose' in root && root.planningClose)
      )
        return stop('plan-row-incomplete');
      const branch = item.kind === 'issue' ? await readRollupBranch(ctx.db, partition, item.id) : null;
      if (progress.pass === 0 && branch?.counts.total) return stop('legacy-hierarchy');
      const scope =
        branch?.effective ??
        branch?.counts ??
        (await readRollupScope(ctx.db, partition, `initiative:${item.id}`, true, true))!;
      const facts = await read.read(item);
      const { work } = facts;
      if (work === 'unknown') return stop('work-incomplete');
      const move = rollupDecision(
        {
          ...item,
          ...rollupChecklist(item.body),
          work,
          ...((await completionHeldByReopen(ctx, projectId, partition, item, facts))
            ? { completionHeld: true as const }
            : {}),
        },
        scope,
        true,
      );
      targets.push({ item, move, branch, forwarded: rollupBranch(scope, work) });
    }
    // A page has no edges between its targets; validate its evidence before any status write.
    const planning = targets.some(target => target.move)
      ? await planningWriteContext(ctx, project)
      : undefined;
    const branches = targets.flatMap(({ item, branch, forwarded }) =>
      branch && (item.parentId || item.initiativeId) ? [{ item, previous: branch, next: forwarded }] : [],
    );
    if ((await publishRollupBranches(ctx.db, { projectId, partition }, branches)) === null) {
      if (header)
        await ctx.db.patch(header._id, { value: JSON.stringify({ ...counts, scopeBlocked: true }) });
      return stop('scope-tally-changed');
    }
    for (const { item, move } of targets) {
      if (move) {
        await writeRollupMove(ctx, project, generation, item, move, operationId, planning);
        progress.moved++;
      }
    }
    progress.pass += Number(source.isDone);
    progress.after = source.isDone ? '' : last!;
    progress.step++;
    if (progress.pass === levels) progress.state = 'complete';
    await ctx.db.patch(row._id, { value: JSON.stringify(progress) });
    if (progress.state === 'running')
      await ctx.scheduler.runAfter(0, catchupWake, { ...args, step: progress.step });
    return null;
  },
});
