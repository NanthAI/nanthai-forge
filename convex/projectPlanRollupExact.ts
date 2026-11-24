// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { v, type Infer } from 'convex/values';
import type { Doc } from './_generated/dataModel';
import { internalMutation, internalQuery, type QueryCtx } from './server';
import { recordPartition, selectedGeneration } from './projectWorkIndexStore';
import { workRecordLookup } from './projectWorkRecordTables';
import { planCounter, type PlanCounts } from './projectPlanCountsStore';
import { readRollupScope, validCounts } from './projectPlanRollupStore';
import { rollupChecklist, rollupWorkReader } from './projectPlanRollupFacts';
import { completionHeldByReopen } from './projectPlanRollupReopen';
import { writeRollupMove } from './projectPlanRollup';
import { approvedDevRollup } from './projectPlanRollupPreview';
import { rollupDecision, rollupReasons } from '../src/planning-rollup';
import { isShelved, type PlanningItem } from '../src/work-planning-types';
import { digest } from '../src/state/hash';
import { invariant } from '../src/errors';

const movePin = v.object({
  id: v.string(),
  version: v.number(),
  from: v.string(),
  status: v.string(),
  rule: v.string(),
  workStamp: v.string(),
  counterStamp: v.string(),
});
const receipt = v.object({
  receiptId: v.string(),
  move: movePin,
  outcome: v.union(v.literal('applied'), v.literal('drift')),
  reason: v.optional(v.string()),
});

function requireDev() {
  invariant(
    process.env.CONVEX_CLOUD_URL === approvedDevRollup,
    'HOSTED_ACTION_UNSUPPORTED',
    'Exact Planning roll-up is not enabled on the selected dev deployment.',
  );
}

async function assess(
  ctx: QueryCtx,
  project: Doc<'hostedProjects'>,
  generation: Doc<'projectWorkGenerations'>,
  id: string,
) {
  const partition = recordPartition(generation);
  const [root, header] = await Promise.all([
    workRecordLookup(ctx, partition, 'planningItems', id),
    planCounter(ctx.db, partition),
  ]);
  const counts: PlanCounts | null = header ? JSON.parse(header.value) : null;
  if (counts?.scopeThrough !== null || counts.scopeBlocked) return { reason: 'scope-tallies-unavailable' };
  const item: (PlanningItem & { payload?: true; payloadKey?: string }) | null =
    root && JSON.parse(root.value);
  if (
    !root ||
    !item ||
    item.id !== id ||
    isShelved(item.status) ||
    item.purged ||
    item.payload ||
    item.payloadKey ||
    typeof item.body !== 'string' ||
    ('planningClose' in root && root.planningClose)
  )
    return { reason: 'target-unavailable' };
  const state = { version: item.version, from: item.status };
  if (item.statusPin || (item.status !== 'open' && item.status !== 'in-progress'))
    return { state, reason: 'no-longer-moves' };
  const [scope, facts] = await Promise.all([
    readRollupScope(
      ctx.db,
      partition,
      `${item.kind === 'issue' ? 'parent' : 'initiative'}:${id}`,
      true,
      true,
    ),
    rollupWorkReader(ctx, project, generation, 32).read(item),
  ]);
  if (!scope || !validCounts(scope)) return { state, reason: 'scope-tally-invalid' };
  if (facts.work === 'unknown') return { state, reason: 'work-incomplete' };
  const move = rollupDecision(
    {
      ...item,
      ...rollupChecklist(item.body),
      work: facts.work,
      ...((await completionHeldByReopen(ctx, project._id, partition, item, facts))
        ? { completionHeld: true as const }
        : {}),
    },
    scope,
    true,
  );
  if (!move) return { state, reason: 'no-longer-moves' };
  // Scope values, not the Plan revision or any global count, are decision inputs.
  const counterStamp = digest(
    JSON.stringify([scope.total, scope.unsettled, scope.progress, scope.started, scope.done, scope.running]),
  );
  return { item, move, state, workStamp: facts.workStamp, counterStamp };
}

/** Read only the named target and its rule inputs. Count non-null moves for the exact-set dry run. */
export const preview = internalQuery({
  args: { projectId: v.id('hostedProjects'), itemId: v.string() },
  returns: v.object({
    generation: v.id('projectWorkGenerations'),
    move: v.union(movePin, v.null()),
    reason: v.optional(v.string()),
  }),
  handler: async (ctx, { projectId, itemId }) => {
    requireDev();
    const project = await ctx.db.get(projectId);
    const generation = project && !project.removal && (await selectedGeneration(ctx, project));
    invariant(project && generation, 'PROJECT_WORK_INDEX_MISSING', 'Select a ready Plan before preview.');
    if (project.autonomyPolicy?.rollUpPlanningStatus === false)
      return { generation: generation._id, move: null, reason: 'disabled' };
    const current = await assess(ctx, project, generation, itemId);
    return current.move
      ? {
          generation: generation._id,
          move: {
            id: itemId,
            ...current.state,
            status: current.move.status,
            rule: current.move.rule,
            workStamp: current.workStamp,
            counterStamp: current.counterStamp,
          },
        }
      : { generation: generation._id, move: null, reason: current.reason };
  },
});

/** The operator sends one call per approved move with the same set UUID. Each move and its receipt
 * commit together. No full-Plan job, automatic continuation, or scheduling of unapproved moves. */
export const applyApproved = internalMutation({
  args: {
    projectId: v.id('hostedProjects'),
    generation: v.id('projectWorkGenerations'),
    operationId: v.string(),
    move: movePin,
  },
  returns: receipt,
  handler: async (ctx, { projectId, generation, operationId, move }) => {
    requireDev();
    const uuid = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
    invariant(
      uuid.test(operationId) && uuid.test(move.id),
      'BAD_ARGUMENT',
      'Use a set UUID and an Item UUID.',
    );
    const stamp = /^[a-f0-9]{64}$/;
    invariant(
      Number.isSafeInteger(move.version) &&
        move.version > 0 &&
        ['open', 'in-progress'].includes(move.from) &&
        ['in-progress', 'closed', 'abandoned'].includes(move.status) &&
        move.from !== move.status &&
        Object.hasOwn(rollupReasons, move.rule) &&
        move.rule !== 'workReopened' &&
        stamp.test(move.workStamp) &&
        stamp.test(move.counterStamp),
      'BAD_ARGUMENT',
      'Use the exact transition, version and evidence stamps from preview.',
    );
    const receiptId = `plan-rollup-exact:${operationId}:${move.id}`;
    const hash = digest(
      JSON.stringify([
        generation,
        move.version,
        move.from,
        move.status,
        move.rule,
        move.workStamp,
        move.counterStamp,
      ]),
    );
    const saved = await ctx.db
      .query('projectJournalReceipts')
      .withIndex('by_project_and_operation', q => q.eq('projectId', projectId).eq('operationId', receiptId))
      .unique();
    if (saved) {
      invariant(saved.hash === hash, 'WORK_OPERATION_CHANGED', 'Retry the originally approved move.');
      return JSON.parse(saved.envelope) as Infer<typeof receipt>;
    }
    const project = await ctx.db.get(projectId);
    invariant(project && !project.removal, 'PROJECT_UNAVAILABLE', 'Select a current project.');
    const selected = await selectedGeneration(ctx, project);
    let reason: string | undefined;
    if (!selected || selected._id !== generation) reason = 'generation-changed';
    else if (project.autonomyPolicy?.rollUpPlanningStatus === false) reason = 'disabled';
    else {
      const current = await assess(ctx, project, selected, move.id);
      if (current.state && (current.state.version !== move.version || current.state.from !== move.from))
        reason = 'item-changed';
      else if (!current.move) reason = current.reason;
      else if (current.workStamp !== move.workStamp) reason = 'work-changed';
      else if (current.counterStamp !== move.counterStamp) reason = 'counters-changed';
      else if (current.move.status !== move.status || current.move.rule !== move.rule)
        reason = 'decision-changed';
      else await writeRollupMove(ctx, project, selected, current.item, current.move, operationId);
    }
    const result: Infer<typeof receipt> = {
      receiptId,
      move,
      outcome: reason ? 'drift' : 'applied',
      ...(reason ? { reason } : {}),
    };
    await ctx.db.insert('projectJournalReceipts', {
      projectId,
      operationId: receiptId,
      hash,
      envelope: JSON.stringify(result),
    });
    return result;
  },
});
