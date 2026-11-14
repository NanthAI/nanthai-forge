// SPDX-License-Identifier: Apache-2.0
import { makeFunctionReference } from 'convex/server';
import { v } from 'convex/values';
import { internalMutation } from './server';
import { loadLanding, loadLandingAttempt } from './projectHostedLandingStore';
import type { MutationCtx } from './_generated/server';
import type { LandingRow } from './projectHostedLandingStore';
import type { HostedLandingState, HostedLandingAttempt } from '../src/hosted-landing';
import { invalidatePipeline } from './projectHostedLandingPipeline';
import { readHostedRecord, writeHostedRecord } from './projectHostedRecords';
import { hostedRecordSchema } from '../src/hosted-records';
import { predecessorPinSchema } from '../src/early-resolution';
import { stageEarlyResolutionSample } from './projectHostedEarlyResolutionSamples';
import { postSystemLaneNote } from './projectBoardSystem';
import { STACK_NOTICE_FANOUT } from '../src/hosted-stack-notice';

/** Only watched predecessors enter here. Reset speculative Lanes to their retained author head:
 * every speculative save remains immutable, but rejected prefix bytes cannot be submitted again.
 * Existing pipeline invalidation independently retires running checks and fences callbacks. */
export async function recoverEarlyResolutions(
  ctx: MutationCtx,
  row: LandingRow,
  before: HostedLandingState,
  state: HostedLandingState,
  attempt: HostedLandingAttempt,
  cursor: string | null = null,
  continuation = false,
) {
  if (
    !row.earlyResolveWatch ||
    (!continuation &&
      before.attemptId === state.attemptId &&
      state.phase !== 'terminal-failed' &&
      state.phase !== 'landed' &&
      state.observation.pendingReason !== 'waiting-for-review')
  )
    return;
  const page = row.earlyResolveDependents
    ? await ctx.db
        .query('projectHostedStackDependents')
        .withIndex('by_project_and_predecessor', q =>
          q.eq('projectId', row.projectId).eq('predecessorId', state.id),
        )
        .paginate({ cursor, numItems: STACK_NOTICE_FANOUT })
    : { page: [], isDone: true, continueCursor: '' };
  const dependents = page.page;
  const project = dependents.length ? await ctx.db.get(row.projectId) : null;
  const invalidated = dependents.some(
    dependent =>
      state.phase === 'terminal-failed' ||
      state.observation.pendingReason === 'waiting-for-review' ||
      dependent.parentHead !== attempt.candidate.head ||
      dependent.resolutionReceipt !== attempt.operations.accept,
  );
  if (invalidated)
    await invalidatePipeline(
      ctx,
      { projectId: row.projectId, batchId: state.id },
      { members: [{ submissionId: state.id }] },
    );
  const costs: [number | null, number | null][] = [];
  for (const dependent of dependents) {
    const same =
      dependent.parentHead === attempt.candidate.head &&
      dependent.resolutionReceipt === attempt.operations.accept;
    const accepted =
      state.phase === 'landed' &&
      state.acceptance?.head === dependent.parentHead &&
      state.acceptance.receiptId === dependent.resolutionReceipt;
    if (
      same &&
      state.phase !== 'terminal-failed' &&
      state.observation.pendingReason !== 'waiting-for-review' &&
      !accepted
    )
      continue;
    const started = Date.parse(dependent.resolutionStartedAt ?? ''),
      ended = Date.parse(dependent.resolutionEndedAt ?? '');
    costs.push([
      Number.isFinite(ended - started) ? Math.max(0, ended - started) : null,
      Number.isFinite(started) ? Math.max(0, Date.now() - started) : null,
    ]);
    if (accepted) {
      await ctx.db.patch(dependent._id, { predecessorId: undefined });
      continue;
    }
    const record = await readHostedRecord(ctx, {
      projectId: row.projectId,
      actor: project?.owner ?? row.actor,
      kind: 'lane',
      key: dependent.laneId,
    });
    if (!record) continue;
    const lane = hostedRecordSchema.options[1].parse(JSON.parse(record.value));
    if (!lane.earlyResolution || lane.stack?.detached || lane.state !== 'active') continue;
    const retained = lane.head;
    const { earlyResolution, resolution: _resolution, restoreBase: _restore, ...rest } = lane;
    void [_resolution, _restore];
    await writeHostedRecord(ctx, {
      projectId: row.projectId,
      // System bookkeeping uses current project authority even if the child author
      // was revoked. It restores existing source and preserves the original author
      // and provenance; it never grants the revoked actor access or acceptance.
      actor: project?.owner ?? lane.actor,
      authorityEpoch: project?.sourceAuthority?.epoch ?? lane.authorityEpoch,
      expectedVersion: lane.version,
      ownerOnly: record.ownerOnly,
      record: {
        ...rest,
        head: earlyResolution.originalHead,
        version: lane.version + 1,
        sourceVersion: lane.sourceVersion + 1,
        at: new Date(Date.now()).toISOString(),
        ...(lane.stack ? { stack: { ...lane.stack, detached: true } } : {}),
      },
    });
    await postSystemLaneNote(ctx, {
      projectId: row.projectId,
      id: `early-resolution:${dependent.laneId}:${dependent.resolutionReceipt}`,
      author: lane.actor,
      fromLaneId: earlyResolution.laneId,
      toLaneId: lane.id,
      text: `The exact predecessor ${state.id} changed or did not land. Forge removed its speculative content by restoring your original saved State ${earlyResolution.originalHead}. The prior resolution State ${retained} remains retained; open this Lane to install the restored head, then sync onto main and resolve again. To inspect or recover the prior resolution use show {"state":"${retained}","path":"FILE"}. Its old stacked check cannot accept.`,
    });
  }
  if (!page.isDone)
    await ctx.scheduler.runAfter(
      0,
      makeFunctionReference<'mutation'>('projectHostedEarlyResolutionRecovery:advance'),
      { projectId: row.projectId, submissionId: state.id, cursor: page.continueCursor },
    );
  // Observe every exact conflicting predecessor, including while Automatic waits or is off.
  // Otherwise a high failure window would stop sampling and could never recover.
  const watch = predecessorPinSchema.parse(JSON.parse(row.earlyResolveWatch!));
  const accepted =
    state.phase === 'landed' &&
    state.acceptance?.head === watch.head &&
    state.acceptance.receiptId === watch.receiptId;
  const retired =
    state.phase === 'terminal-failed' ||
    state.observation.pendingReason === 'waiting-for-review' ||
    attempt.candidate.head !== watch.head ||
    attempt.operations.accept !== watch.receiptId;
  if (!cursor && row.earlyResolveObserved !== watch.receiptId && (accepted || retired)) {
    const known = costs.filter((cost): cost is [number, number] => cost[0] !== null && cost[1] !== null);
    const mean = (index: 0 | 1) =>
      known.length ? known.reduce((n, cost) => n + cost[index], 0) / known.length : null;
    stageEarlyResolutionSample(ctx, row.projectId, [watch.receiptId, Boolean(accepted), mean(0), mean(1)]);
  }
}

/** One event-owned continuation per dependent page. No timer remains after it drains. */
export const advance = internalMutation({
  args: {
    projectId: v.id('hostedProjects'),
    submissionId: v.string(),
    cursor: v.union(v.string(), v.null()),
  },
  returns: v.null(),
  handler: async (ctx, input) => {
    const { row, state } = await loadLanding(ctx, input);
    const attempt = await loadLandingAttempt(ctx, { projectId: input.projectId, attemptId: state.attemptId });
    await recoverEarlyResolutions(ctx, row, state, state, attempt, input.cursor, true);
    return null;
  },
});
