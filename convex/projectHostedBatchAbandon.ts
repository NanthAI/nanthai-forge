// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { internalMutation, type MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { readHostedRecord } from './projectHostedRecords';
import { cancelHostedLanding } from './projectHostedLandingCancel';
import { hostedLandingStateSchema } from '../src/hosted-landing';

const fields = {
  projectId: v.id('hostedProjects'),
  actor: v.string(),
  operationId: v.string(),
  kind: v.union(v.literal('lane'), v.literal('intent')),
  key: v.string(),
  version: v.number(),
  cursor: v.union(v.string(), v.null()),
  candidateId: v.optional(v.string()),
};
type Selection = {
  projectId: Id<'hostedProjects'>;
  actor: string;
  operationId: string;
  kind: 'lane' | 'intent';
  key: string;
  version: number;
  cursor: string | null;
  candidateId?: string;
};
const schedule = (ctx: MutationCtx, input: Selection) =>
  ctx.scheduler.runAfter(0, makeFunctionReference<'mutation'>('projectHostedBatchAbandon:reselect'), input);

/** A finite continuation of the user's lifecycle operation, never a history scan
 * or idle watcher. Original compose selections supply the existing reverse map. */
export async function scheduleAbandonedBatchReselection(
  ctx: MutationCtx,
  input: Omit<Selection, 'cursor' | 'candidateId'>,
) {
  const selected =
    input.kind === 'lane'
      ? await ctx.db
          .query('projectHostedComposeSelections')
          .withIndex('by_project_and_kind_and_key', q =>
            q.eq('projectId', input.projectId).eq('kind', 'inputs').eq('key', input.key),
          )
          .take(1)
      : await ctx.db
          .query('projectHostedRecordHeads')
          .withIndex('by_project_and_kind_and_parent', q =>
            q.eq('projectId', input.projectId).eq('kind', 'candidate').eq('parent', input.key),
          )
          .take(1);
  if (selected.length) await schedule(ctx, { ...input, cursor: null });
}
async function cancelCandidateMembers(
  ctx: MutationCtx,
  input: Selection,
  candidateId: string,
  cursor: string | null,
) {
  const page = await ctx.db
    .query('projectHostedLandingRequests')
    .withIndex('by_project_and_candidate_and_sequence', q =>
      q.eq('projectId', input.projectId).eq('candidateId', candidateId),
    )
    .paginate({ cursor, numItems: 10, maximumRowsRead: 10, maximumBytesRead: 128 * 1024 });
  for (const row of page.page) {
    const state = hostedLandingStateSchema.parse(JSON.parse(row.value));
    if (['landed', 'terminal-failed'].includes(state.phase) || !(state.batchId ?? state.batchOriginId))
      continue;
    await cancelHostedLanding(ctx, {
      projectId: input.projectId,
      actor: state.actor,
      request: {
        operationId: crypto.randomUUID(),
        authorityEpoch: state.request.authorityEpoch,
        submissionId: state.id,
      },
      reason: `Saved ${input.kind} ${input.key} was abandoned by lifecycle ${input.operationId}; its pending batch landing was cancelled and peers requeued. Reopen the saved work and finish again to propose it.`,
    });
  }
  if (!page.isDone) await schedule(ctx, { ...input, candidateId, cursor: page.continueCursor });
}
export const reselect = internalMutation({
  args: fields,
  returns: v.null(),
  handler: async (ctx, input) => {
    const target = await readHostedRecord(ctx, {
      projectId: input.projectId,
      actor: input.actor,
      kind: input.kind,
      key: input.key,
    });
    if (!target) return null;
    const record = JSON.parse(target.value);
    // A reopen or later save never inherits an earlier abandonment's effect.
    if (record.version !== input.version || (record.state ?? record.status) !== 'abandoned') return null;
    if (input.candidateId) {
      await cancelCandidateMembers(ctx, input, input.candidateId, input.cursor);
      return null;
    }
    const candidates = new Set<string>();
    let next: string | null, done: boolean;
    if (input.kind === 'lane') {
      const page = await ctx.db
        .query('projectHostedComposeSelections')
        .withIndex('by_project_and_kind_and_key', q =>
          q.eq('projectId', input.projectId).eq('kind', 'inputs').eq('key', input.key),
        )
        .paginate({ cursor: input.cursor, numItems: 5, maximumRowsRead: 5, maximumBytesRead: 8 * 1024 });
      for (const selected of page.page) {
        const compose = await ctx.db
          .query('projectHostedComposes')
          .withIndex('by_project_and_actor_and_operation', q =>
            q
              .eq('projectId', input.projectId)
              .eq('actor', selected.actor)
              .eq('operationId', selected.operationId),
          )
          .unique();
        if (compose) candidates.add(JSON.parse(compose.value).candidateId);
      }
      next = page.continueCursor;
      done = page.isDone;
    } else {
      const page = await ctx.db
        .query('projectHostedRecordHeads')
        .withIndex('by_project_and_kind_and_parent', q =>
          q.eq('projectId', input.projectId).eq('kind', 'candidate').eq('parent', input.key),
        )
        .paginate({ cursor: input.cursor, numItems: 5, maximumRowsRead: 5, maximumBytesRead: 8 * 1024 });
      for (const candidate of page.page) candidates.add(candidate.key);
      next = page.continueCursor;
      done = page.isDone;
    }
    for (const candidate of candidates) await cancelCandidateMembers(ctx, input, candidate, null);
    if (!done) await schedule(ctx, { ...input, cursor: next });
    return null;
  },
});
