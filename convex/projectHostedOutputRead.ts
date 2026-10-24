// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { query, mutation, type QueryCtx, type MutationCtx } from './cliServer';
import type { Id } from './_generated/dataModel';
import { accessibleProject } from './projectAuthority';
import { loadHostedCheck } from './projectHostedCheckStore';
import { outputHead, outputChunk, rootForOutput, type OutputIdentity } from './projectHostedOutputStore';
import { outputKey, outputChunkSchema, outputRootObject } from '../src/hosted-check-output';
import { canonicalPayload } from '../src/hosted-source-operation';
import { presignGet, r2Config } from './r2';
import { invariant } from '../src/errors';
import { report } from './errors';

const identity = { projectId: v.id('hostedProjects'), runId: v.string() };
export async function outputReader(ctx: QueryCtx | MutationCtx, projectId: Id<'hostedProjects'>) {
  const user = await ctx.auth.getUserIdentity();
  if (user) return accessibleProject(ctx, projectId, user.subject);
  const project = await ctx.db.get(projectId);
  invariant(
    project?.visibility === 'public' && !project.removal,
    'PROJECT_UNAVAILABLE',
    'This Forge project is unavailable with the current account.',
  );
  return project;
}
/** Constant-size status subscription. Reading never schedules work or signs a
 * URL. H20a gates subscriptions/downloads through its existing idle boundary. */
export const manifest = query({
  args: identity,
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      await outputReader(ctx, input.projectId);
      const { run } = await loadHostedCheck(ctx, input);
      const head = await outputHead(ctx, input);
      return canonicalPayload({
        status: run.status,
        executionId: run.executionId,
        complete: head?.final !== null && head?.final !== undefined,
        sealed: head?.sealed ?? 0,
        root: run.executionId ? rootForOutput(input, run.executionId, head) : null,
      });
    } catch (error) {
      return report(error);
    }
  },
});
const paging = { ...identity, cursor: v.union(v.string(), v.null()) };
export const streams = query({
  args: paging,
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      await outputReader(ctx, input.projectId);
      await loadHostedCheck(ctx, input);
      const page = await ctx.db
        .query('projectHostedOutputStreams')
        .withIndex('by_project_and_run', q => q.eq('projectId', input.projectId).eq('runId', input.runId))
        .paginate({ cursor: input.cursor, numItems: 50, maximumRowsRead: 50, maximumBytesRead: 128 * 1024 });
      return canonicalPayload({
        ...page,
        page: page.page.map(row => ({
          streamId: row.streamId,
          stream: JSON.parse(row.descriptor),
          chunks: row.chunks,
          bytes: row.bytes,
          maxSequence: row.maxSequence,
          seal: row.seal ? JSON.parse(row.seal) : null,
        })),
      });
    } catch (error) {
      return report(error);
    }
  },
});
/** Numeric revision cursor follows COMMIT order, distinct from stream sequence.
 * Out-of-order arrivals are retained; consumers recover gaps by exact sequence.
 * Resume the returned after revision when new committed metadata is observed. */
export const chunks = query({
  args: { ...identity, after: v.number() },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      await outputReader(ctx, input.projectId);
      await loadHostedCheck(ctx, input);
      invariant(
        Number.isSafeInteger(input.after) && input.after >= 0,
        'BAD_ARGUMENT',
        'Resume an exact committed revision.',
      );
      const rows = await ctx.db
        .query('projectHostedOutputChunks')
        .withIndex('by_project_and_run_and_revision', q =>
          q.eq('projectId', input.projectId).eq('runId', input.runId).gt('revision', input.after),
        )
        .paginate({ cursor: null, numItems: 50, maximumRowsRead: 50, maximumBytesRead: 128 * 1024 });
      const page = rows.page;
      return canonicalPayload({
        page: page.map(row => ({
          revision: row.revision,
          streamId: row.streamId,
          chunk: JSON.parse(row.value),
        })),
        after: page.at(-1)?.revision ?? input.after,
        more: !rows.isDone,
      });
    } catch (error) {
      return report(error);
    }
  },
});
/** Freshly authorized, read-only signing; metadata pages never fetch bytes. */
export const download = mutation({
  args: { ...identity, streamId: v.union(v.string(), v.null()), sequence: v.number() },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      await outputReader(ctx, input.projectId);
      await loadHostedCheck(ctx, input);
      const object = await downloadableOutput(ctx, input);
      return canonicalPayload({
        object,
        url: await presignGet(r2Config(), outputKey(input.projectId, input.runId, object)),
      });
    } catch (error) {
      return report(error);
    }
  },
});
export async function downloadableOutput(
  ctx: QueryCtx | MutationCtx,
  input: OutputIdentity & { streamId: string | null; sequence: number },
) {
  if (input.streamId === null) {
    const head = await outputHead(ctx, input);
    invariant(head?.final, 'NOT_FOUND', 'Final output manifest is not complete.');
    return outputRootObject(JSON.parse(head.final));
  }
  invariant(
    Number.isSafeInteger(input.sequence) && input.sequence >= 0,
    'BAD_ARGUMENT',
    'Read an exact output sequence.',
  );
  const row = await outputChunk(ctx, input, input.streamId, input.sequence);
  invariant(row, 'NOT_FOUND', 'Output chunk is missing; recover it from the original collector.');
  return outputChunkSchema.parse(JSON.parse(row.value)).object;
}
/** H14 may inspect completeness separately from H10's passing-run evidence.
 * This helper neither changes landing policy nor makes log reads a new step. */
export async function completeOutputManifest(ctx: QueryCtx | MutationCtx, input: OutputIdentity) {
  const head = await outputHead(ctx, input);
  invariant(
    head?.final && head.streams === head.sealed,
    'EVIDENCE_CHANGED',
    'Hosted output is not completely retained.',
  );
  return { root: JSON.parse(head.final), object: outputRootObject(JSON.parse(head.final)) };
}
