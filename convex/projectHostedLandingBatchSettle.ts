// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { internalAction, internalMutation, internalQuery, type MutationCtx, type QueryCtx } from './server';
import type { Id } from './_generated/dataModel';
import type { ActionCtx } from './_generated/server';
import type { HostedLandingState } from '../src/hosted-landing';
import { HOSTED_BATCH_MEMBERS } from '../src/hosted-landing-batch';
import { canonicalPayload } from '../src/hosted-source-operation';
import {
  batchRow,
  batchSchema,
  type BatchIdentity,
  type LandingBatch,
} from './projectHostedLandingBatchState';
import { writeBatch } from './projectHostedLandingBatchStore';
import { invalidatePipeline } from './projectHostedLandingPipeline';

/** Batch phases that still wait on a member's later step. */
const OPEN = new Set<LandingBatch['phase']>(['composing', 'checking', 'fallback']);
type Ctx = QueryCtx | MutationCtx;

/** Item ab5c0017: the open batch when every member is landed or terminal-failed, else null. That is
 * the rule the existing "no live member" exits use (retryLandingBatch, advanceBatchFallback,
 * settleBatchConflicts): any member not yet terminal keeps the batch open, whichever batch pointer
 * it holds. At most HOSTED_BATCH_MEMBERS indexed ticket reads, stopping at the first live member;
 * only the ticket's `phase` column decides. `ended` is a member the caller has just written
 * terminal, so it is not read again. `failed` lists the members that ended terminal-failed. */
export async function settledBatch(
  ctx: Ctx,
  input: BatchIdentity,
  ended?: { id: string; phase: HostedLandingState['phase'] },
) {
  const row = await batchRow(ctx, input);
  if (!row) return null;
  const batch = batchSchema.parse(JSON.parse(row.value));
  if (!OPEN.has(batch.phase)) return null;
  const failed: { submissionId: string }[] = [];
  for (const member of batch.members.slice(0, HOSTED_BATCH_MEMBERS)) {
    let phase: string | undefined = ended?.phase;
    if (member.submissionId !== ended?.id)
      phase = (
        await ctx.db
          .query('projectHostedLandingRequests')
          .withIndex('by_project_and_submission', q =>
            q.eq('projectId', input.projectId).eq('submissionId', member.submissionId),
          )
          .unique()
      )?.phase;
    if (phase === 'terminal-failed') failed.push({ submissionId: member.submissionId });
    else if (phase !== 'landed') return null;
  }
  return { row, batch, failed };
}

/** The terminal hook (writeLanding, non-terminal -> landed/terminal-failed). Every way a member
 * ends (cancel, supersede, failFinish from any caller, a stall drop, a solo landing of a member the
 * cohort released) passes here, so a batch can no longer outlive its members: it settles through
 * writeBatch, which releases capsule waits. The shared publish is skipped (a landing that still holds
 * batchId without batchSolo): it writes its batch landed in the same transaction, so a healthy
 * cohort landing pays nothing. Late compose or check IO for a settled batch finds a terminal phase
 * and does nothing. */
export async function settleEndedBatch(ctx: MutationCtx, state: HostedLandingState) {
  const batchId = state.batchId ?? state.batchOriginId;
  if (!batchId || (state.phase === 'landed' && state.batchId && !state.batchSolo)) return;
  const input = { projectId: state.projectId as Id<'hostedProjects'>, batchId };
  const settled = await settledBatch(ctx, input, state);
  if (settled) await settleBatch(ctx, input, settled);
}
/** A composing or checking cohort still pins its pipelined successors: retire those stacked on a
 * member that ended failed, as retryLandingBatch does on its own no-live-member exit (review
 * 000e2d4f). A successor stacked on a member that landed keeps its check (review 2a9d4b2e): its
 * publish still compares the pinned head. A fallback batch already invalidated its pipeline when it
 * entered fallback. */
async function settleBatch(
  ctx: MutationCtx,
  input: BatchIdentity,
  { batch, failed }: { batch: LandingBatch; failed: { submissionId: string }[] },
) {
  if (batch.phase !== 'fallback' && failed.length) await invalidatePipeline(ctx, input, { members: failed });
  await writeBatch(ctx, input, { ...batch, phase: 'landed' });
}

/*
 * One-time pass (ab5c0017) for batches that leaked before the hook: their members are already
 * terminal, so no later write reaches the hook. An operator runs `dryRun` (reads only), then `run`,
 * per project, on dev. Never a cron and never idle work. Delete this pass and its functions once dev
 * and bench are settled.
 */
const PAGE_ROWS = 32;
const PAGE_BYTES = 1024 * 1024;
const DAY_MS = 86_400_000;
type Page = {
  scanned: number;
  open: number;
  leaked: string[];
  leakedOver24h: number;
  capsuleWaits: number;
  cursor: string | null;
  done: boolean;
};

/** One bounded page of a project's batch rows: 32 rows and at most 8 ticket reads per open batch. */
export const leakedPage = internalQuery({
  args: { projectId: v.id('hostedProjects'), cursor: v.union(v.string(), v.null()) },
  returns: v.string(),
  handler: async (ctx, input) => {
    const page = await ctx.db
      .query('projectHostedLandingBatches')
      .withIndex('by_project_and_batch', q => q.eq('projectId', input.projectId))
      .paginate({
        cursor: input.cursor,
        numItems: PAGE_ROWS,
        maximumRowsRead: PAGE_ROWS,
        maximumBytesRead: PAGE_BYTES,
      });
    const out: Page = {
      scanned: 0,
      open: 0,
      leaked: [],
      leakedOver24h: 0,
      capsuleWaits: 0,
      cursor: page.isDone ? null : page.continueCursor,
      done: page.isDone,
    };
    const now = Date.now();
    for (const row of page.page) {
      out.scanned++;
      const batch = batchSchema.parse(JSON.parse(row.value));
      if (!OPEN.has(batch.phase)) continue;
      out.open++;
      if (!(await settledBatch(ctx, { projectId: input.projectId, batchId: row.batchId }))) continue;
      out.leaked.push(row.batchId);
      out.capsuleWaits += row.capsuleWaits?.length ?? 0;
      if (now - Date.parse(batch.drive?.at ?? batch.at) > DAY_MS) out.leakedOver24h++;
    }
    return canonicalPayload(out);
  },
});

/** Settles the named batches that still match the rule; any other is left as it is. */
export const settle = internalMutation({
  args: { projectId: v.id('hostedProjects'), batchIds: v.array(v.string()) },
  returns: v.string(),
  handler: async (ctx, input) => {
    let settled = 0,
      released = 0;
    for (const batchId of input.batchIds.slice(0, PAGE_ROWS)) {
      const key = { projectId: input.projectId, batchId };
      const found = await settledBatch(ctx, key);
      if (!found) continue;
      released += found.row.capsuleWaits?.length ?? 0;
      await settleBatch(ctx, key, found);
      settled++;
    }
    return canonicalPayload({
      settled,
      skipped: Math.min(input.batchIds.length, PAGE_ROWS) - settled,
      released,
    });
  },
});

async function pass(
  ctx: Pick<ActionCtx, 'runQuery' | 'runMutation'>,
  projectId: Id<'hostedProjects'>,
  apply: boolean,
) {
  const totals = { pages: 0, scanned: 0, open: 0, leaked: 0, leakedOver24h: 0, capsuleWaits: 0, settled: 0 };
  const ids: string[] = [];
  let cursor: string | null = null;
  for (;;) {
    const page = JSON.parse(
      await ctx.runQuery(makeFunctionReference<'query'>('projectHostedLandingBatchSettle:leakedPage'), {
        projectId,
        cursor,
      }),
    ) as Page;
    totals.pages++;
    totals.scanned += page.scanned;
    totals.open += page.open;
    totals.leaked += page.leaked.length;
    totals.leakedOver24h += page.leakedOver24h;
    totals.capsuleWaits += page.capsuleWaits;
    ids.push(...page.leaked);
    if (apply && page.leaked.length)
      totals.settled += JSON.parse(
        await ctx.runMutation(makeFunctionReference<'mutation'>('projectHostedLandingBatchSettle:settle'), {
          projectId,
          batchIds: page.leaked,
        }),
      ).settled;
    if (page.done || totals.pages >= 1_000) break;
    cursor = page.cursor;
  }
  return canonicalPayload({ ...totals, batchIds: ids.map(id => id.slice(0, 8)) });
}

/** Read-only: counts open batches and those whose members are all terminal. Writes nothing. */
export const dryRun = internalAction({
  args: { projectId: v.id('hostedProjects') },
  returns: v.string(),
  handler: (ctx, input) => pass(ctx, input.projectId, false),
});

/** Settles every leaked batch of one project through writeBatch, a page at a time. */
export const run = internalAction({
  args: { projectId: v.id('hostedProjects') },
  returns: v.string(),
  handler: (ctx, input) => pass(ctx, input.projectId, true),
});
