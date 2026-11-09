// SPDX-License-Identifier: Apache-2.0
import { syncRequiredAdvice, syncRequiredNext, wouldConflictSchema } from '../src/hosted-would-conflict';
export { wouldConflictSchema, type WouldConflict } from '../src/hosted-would-conflict';
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { internalMutation, type MutationCtx } from './server';
import type { Id } from './_generated/dataModel';
import { hostedRecordBody, recordHead } from './projectHostedRecords';
import { hostedRecordSchema } from '../src/hosted-records';
import { canonicalPayload } from '../src/hosted-source-operation';
import { markdownDoc } from '../src/docs-resolution';

/** Queued rows scanned and Candidates read per land. Queues at dogfood scale hold a few tens of
 * entries, most already checked or batched; the rest stay unmarked. */
export const WOULD_CONFLICT_SCAN = 20;
export const WOULD_CONFLICT_READS = 10;

/** Event-driven on each land (no polling): the publication schedules one bounded pass, only when
 * the landing changed known paths, so publication itself stays constant-size. */
export async function scheduleWouldConflict(
  ctx: MutationCtx,
  input: { projectId: Id<'hostedProjects'>; paths: string[] | null; landedSubmissionId: string },
) {
  if (!input.paths?.length) return;
  await ctx.scheduler.runAfter(
    0,
    makeFunctionReference<'mutation'>('projectHostedLandingWouldConflict:mark'),
    {
      projectId: input.projectId,
      paths: input.paths.slice(0, 2000),
      landedSubmissionId: input.landedSubmissionId,
    },
  );
}

export const mark = internalMutation({
  args: { projectId: v.id('hostedProjects'), paths: v.array(v.string()), landedSubmissionId: v.string() },
  returns: v.number(),
  handler: (ctx, input) => markWouldConflict(ctx, input),
});

/** Queued entries that were not checked yet and change a file the landing changed are marked
 * (Markdown docs excepted).
 * Path advice, not a proven text conflict. Cost: one bounded queue read plus at most
 * WOULD_CONFLICT_READS Candidate reads (record head + record). */
export async function markWouldConflict(
  ctx: MutationCtx,
  input: { projectId: Id<'hostedProjects'>; paths: string[]; landedSubmissionId: string },
  now = Date.now(),
) {
  if (!input.paths.length) return 0;
  const landed = new Set(input.paths);
  const queued = await ctx.db
    .query('projectHostedLandingRequests')
    .withIndex('by_project_and_channel_and_phase_and_priority_and_sequence', q =>
      q.eq('projectId', input.projectId).eq('channel', 'main').eq('phase', 'queued'),
    )
    .take(WOULD_CONFLICT_SCAN);
  let marked = 0,
    reads = 0;
  for (const row of queued) {
    const value = JSON.parse(row.value) as {
      batchId?: string;
      actor: string;
      request: { finish?: { composeOperationId?: string } };
    };
    if (
      row.submissionId === input.landedSubmissionId ||
      row.wouldConflict ||
      row.runId !== null ||
      !row.candidateId ||
      value.batchId
    )
      continue;
    if (++reads > WOULD_CONFLICT_READS) break;
    const head = await recordHead(ctx, input.projectId, 'candidate', row.candidateId);
    const record = head ? await ctx.db.get(head.recordId) : null;
    if (!record) continue;
    const candidate = hostedRecordSchema.parse(JSON.parse(await hostedRecordBody(ctx, record)));
    if (candidate.kind !== 'candidate') continue;
    // Shared Markdown docs need no sync: the queue's recompose merges them with the docs rule,
    // and a conflict it cannot merge surfaces as an actual compose conflict (Issue 561996ac).
    const shared = (candidate.governance?.paths ?? [])
      .filter(path => landed.has(path) && !markdownDoc(path))
      .sort();
    if (!shared.length) continue;
    const paths = shared.slice(0, 10),
      more = shared.length - paths.length;
    // The Lane this entry composed (as the queue view finds it): one indexed read per marked entry, so
    // every reader can name the one recovery command without a read of its own.
    const composeOperationId = value.request.finish?.composeOperationId;
    const composed = composeOperationId
      ? await ctx.db
          .query('projectHostedComposeSelections')
          .withIndex('by_project_and_actor_and_operation_and_kind_and_key', q =>
            q
              .eq('projectId', input.projectId)
              .eq('actor', value.actor)
              .eq('operationId', composeOperationId)
              .eq('kind', 'inputs'),
          )
          .take(2)
      : [];
    const laneId =
      composed.length === 1 && /^[0-9a-f-]{36}$/i.test(composed[0]!.key) ? composed[0]!.key : undefined;
    await ctx.db.patch(row._id, {
      wouldConflict: canonicalPayload(
        wouldConflictSchema.parse({
          paths,
          more,
          landedSubmissionId: input.landedSubmissionId,
          ...(laneId ? { laneId } : {}),
          at: new Date(now).toISOString(),
          next: syncRequiredNext({ paths, more, laneId }),
        }),
      ),
    });
    marked++;
  }
  return marked;
}

/** Stored advice as readers see it. Accepted-main advice always carries the current SYNC_REQUIRED
 * guidance, so marks written before it say the same as new ones. */
export function readWouldConflict(row: { wouldConflict?: string } | null | undefined) {
  if (!row?.wouldConflict) return undefined;
  const advice = wouldConflictSchema.parse(JSON.parse(row.wouldConflict));
  return 'landedSubmissionId' in advice ? { ...advice, next: syncRequiredNext(advice) } : advice;
}

/** A queue status for an entry that needs a sync: it will not move by waiting, so it carries no ETA
 * and says so (f7539ebb). Derived from facts the read already holds; no extra read. */
export function syncRequiredQueue<T extends { message?: string; eta?: unknown } | null>(
  queue: T,
  advice: unknown,
): T | (Omit<NonNullable<T>, 'eta'> & { phase: 'needs-sync'; message: string }) {
  const sync = syncRequiredAdvice(advice);
  if (!queue || !sync) return queue;
  const { eta, ...rest } = queue;
  void eta;
  return { ...rest, phase: 'needs-sync', message: syncRequiredNext(sync) } as never;
}
