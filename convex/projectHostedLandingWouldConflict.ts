// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { internalMutation, type MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { hostedRecordBody, recordHead } from './projectHostedRecords';
import { hostedRecordSchema } from '../src/hosted-records';
import { canonicalPayload } from '../src/hosted-source-operation';

/** Queued rows scanned and Candidates read per land. Queues at dogfood scale hold a few tens of
 * entries, most already checked or batched; the rest stay unmarked. */
export const WOULD_CONFLICT_SCAN = 20;
export const WOULD_CONFLICT_READS = 10;
export const wouldConflictSchema = z
  .object({
    paths: z.array(z.string()).max(10),
    more: z.number().int().nonnegative(),
    landedSubmissionId: z.string(),
    at: z.iso.datetime(),
    next: z.string(),
  })
  .strict();
export type WouldConflict = z.infer<typeof wouldConflictSchema>;

const next = (paths: string[], more: number) =>
  `Main changed ${paths.length + more} file(s) this queued Candidate also changes (${paths.join(', ')}${more ? ', …' : ''}). ` +
  'Sync and land this Lane again: the new land syncs main in and replaces this entry in place.';

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

/** Queued entries that were not checked yet and change a file the landing changed are marked.
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
    if (
      row.submissionId === input.landedSubmissionId ||
      row.wouldConflict ||
      row.runId !== null ||
      !row.candidateId ||
      (JSON.parse(row.value) as { batchId?: string }).batchId
    )
      continue;
    if (++reads > WOULD_CONFLICT_READS) break;
    const head = await recordHead(ctx, input.projectId, 'candidate', row.candidateId);
    const record = head ? await ctx.db.get(head.recordId) : null;
    if (!record) continue;
    const candidate = hostedRecordSchema.parse(JSON.parse(await hostedRecordBody(ctx, record)));
    if (candidate.kind !== 'candidate') continue;
    const shared = (candidate.governance?.paths ?? []).filter(path => landed.has(path)).sort();
    if (!shared.length) continue;
    const paths = shared.slice(0, 10),
      more = shared.length - paths.length;
    await ctx.db.patch(row._id, {
      wouldConflict: canonicalPayload(
        wouldConflictSchema.parse({
          paths,
          more,
          landedSubmissionId: input.landedSubmissionId,
          at: new Date(now).toISOString(),
          next: next(paths, more),
        }),
      ),
    });
    marked++;
  }
  return marked;
}

export const readWouldConflict = (row: { wouldConflict?: string } | null | undefined) =>
  row?.wouldConflict ? wouldConflictSchema.parse(JSON.parse(row.wouldConflict)) : undefined;
