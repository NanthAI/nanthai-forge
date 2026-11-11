// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { internalMutation } from './server';
import { composeStateSchema } from './projectHostedComposeStore';
import { canonicalPayload } from '../src/hosted-source-operation';

export const capsuleIndexKind = 'projectLandingCapsuleIndex';
/** One bounded bootstrap per project. New composes write this identity in their existing transaction.
 * The retained cursor resumes the original pass; it is never a per-landing history scan. */
export const page = internalMutation({
  args: { projectId: v.id('hostedProjects') },
  returns: v.boolean(),
  handler: async (ctx, { projectId }) => {
    const old = await ctx.db
      .query('projectFinishReadRows')
      .withIndex('by_kind_and_source', q => q.eq('kind', capsuleIndexKind).eq('sourceId', projectId))
      .unique();
    const state = old
      ? (JSON.parse(old.value) as { done: boolean; cursor: string | null; phase?: 'composes' | 'attempts' })
      : { done: false, cursor: null, phase: 'composes' as const };
    if (state.done) return true;
    const phase = state.phase ?? 'composes';
    let done = false,
      cursor: string | null,
      nextPhase = phase;
    if (phase === 'composes') {
      const rows = await ctx.db
        .query('projectHostedComposes')
        .withIndex('by_project_and_job', q => q.eq('projectId', projectId))
        .paginate({ cursor: state.cursor, numItems: 8, maximumRowsRead: 8, maximumBytesRead: 128 * 1024 });
      for (const row of rows.page) {
        if (!row.candidateId)
          await ctx.db.patch(row._id, {
            candidateId: composeStateSchema.parse(JSON.parse(row.value)).candidateId,
          });
      }
      cursor = rows.isDone ? null : rows.continueCursor;
      if (rows.isDone) nextPhase = 'attempts';
    } else {
      const rows = await ctx.db
        .query('projectHostedLandingAttempts')
        .withIndex('by_project', q => q.eq('projectId', projectId))
        .paginate({ cursor: state.cursor, numItems: 4, maximumRowsRead: 4, maximumBytesRead: 128 * 1024 });
      for (const row of rows.page)
        await ctx.db.patch(row._id, { sourceCreatedAt: row._creationTime, value: row.value });
      done = rows.isDone;
      cursor = done ? null : rows.continueCursor;
    }
    const value = canonicalPayload({ done, cursor, phase: nextPhase });
    if (old) await ctx.db.patch(old._id, { value });
    else
      await ctx.db.insert('projectFinishReadRows', {
        kind: capsuleIndexKind,
        sourceId: projectId,
        projectId,
        value,
      });
    return done;
  },
});
