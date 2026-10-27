// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { internalQuery, internalMutation } from './_generated/server';
import { activeOwnedProject } from './projectAuthority';
import { outputStream } from './projectHostedOutputStore';
import { invariant } from '../src/errors';
const identity = {
  projectId: v.id('hostedProjects'),
  actor: v.string(),
  runId: v.string(),
  streamId: v.string(),
};
export const page = internalQuery({
  args: {
    ...identity,
    cursor: v.union(v.string(), v.null()),
    one: v.optional(v.boolean()),
    expected: v.optional(v.string()),
  },
  returns: v.string(),
  handler: async (ctx, input) => {
    await activeOwnedProject(ctx, input.projectId, input.actor);
    const stream = await outputStream(ctx, input, input.streamId);
    invariant(stream, 'NOT_FOUND', 'Original output stream is unavailable.');
    requireOriginal(stream, input.expected);
    const page = await ctx.db
      .query('projectHostedOutputChunks')
      .withIndex('by_project_and_run_and_stream_and_sequence', q =>
        q.eq('projectId', input.projectId).eq('runId', input.runId).eq('streamId', input.streamId),
      )
      .paginate({ cursor: input.cursor, numItems: input.one ? 1 : 50 });
    return JSON.stringify({ ...page, retired: stream.retired ?? false });
  },
});
/** Output objects are addressed by run and hash, so artifact/summary streams
 * can share a raw log chunk. Keep those keys while any live stream needs them. */
export const retained = internalQuery({
  args: { ...identity, cursor: v.union(v.string(), v.null()) },
  returns: v.string(),
  handler: async (ctx, input) => {
    await activeOwnedProject(ctx, input.projectId, input.actor);
    const page = await ctx.db
      .query('projectHostedOutputChunks')
      .withIndex('by_project_and_run', q => q.eq('projectId', input.projectId).eq('runId', input.runId))
      .paginate({ cursor: input.cursor, numItems: 50 });
    const pins: string[] = [];
    for (const row of page.page) {
      if (row.streamId === input.streamId) continue;
      const stream = await outputStream(ctx, input, row.streamId);
      invariant(
        stream,
        'SOURCE_UNAVAILABLE',
        'Retained output chunk has no stream; its bytes were preserved.',
      );
      if (!stream.retired || JSON.parse(stream.descriptor).stream === 'artifact')
        pins.push(JSON.parse(row.value).object.sha256);
    }
    return JSON.stringify({ pins, isDone: page.isDone, continueCursor: page.continueCursor });
  },
});
export const summary = internalMutation({
  args: {
    ...identity,
    position: v.number(),
    text: v.string(),
    final: v.boolean(),
    excerpt: v.string(),
    expected: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, input) => {
    await activeOwnedProject(ctx, input.projectId, input.actor);
    const stream = await outputStream(ctx, input, input.streamId);
    invariant(stream, 'NOT_FOUND', 'Original output stream is unavailable.');
    requireOriginal(stream, input.expected);
    if (stream.retired) return null;
    const existing = await ctx.db
      .query('projectHostedOutputSummaries')
      .withIndex('by_project_and_run_and_stream_and_position', q =>
        q
          .eq('projectId', input.projectId)
          .eq('runId', input.runId)
          .eq('streamId', input.streamId)
          .eq('position', input.position),
      )
      .unique();
    if (existing)
      invariant(
        existing.text === input.text,
        'EVIDENCE_CHANGED',
        'Retain the same compact output summary on retry.',
      );
    else
      await ctx.db.insert('projectHostedOutputSummaries', {
        projectId: input.projectId,
        runId: input.runId,
        streamId: input.streamId,
        position: input.position,
        text: input.text,
      });
    if (input.final) await ctx.db.patch(stream._id, { retired: true, failureExcerpt: input.excerpt });
    return null;
  },
});

function requireOriginal(
  stream: { bytes: number; chunks: number; maxSequence: number; seal: string | null; descriptor: string },
  expected?: string,
) {
  if (!expected) return;
  invariant(
    JSON.stringify({
      bytes: stream.bytes,
      chunks: stream.chunks,
      maxSequence: stream.maxSequence,
      seal: stream.seal,
      descriptor: stream.descriptor,
    }) === expected,
    'EVIDENCE_CHANGED',
    'Hosted output changed after cleanup planning; its bytes were preserved.',
  );
}
