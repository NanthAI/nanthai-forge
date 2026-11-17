// SPDX-License-Identifier: Apache-2.0
// Needs me (Items 9e748e41, 12fde646): what holds work until a person decides, in one bounded subscription.
// It starts from the live line's held marks (the same set the top bar counts as "Needs you"), so the count
// beside Needs you, the screen's count and its rows always agree. For each held Lane it adds the Lane's title
// and holder (its slim presence row) and why Forge holds it (the bound landing's recorded observation), and
// it adds the open approval requests. No paths, source, activity or check output; idle costs nothing.
import { v } from 'convex/values';
import { query } from './cliServer';
import type { QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { accessibleProject } from './projectAuthority';
import { lineOwner, type LineOwnerValue } from './projectLiveLineOwners';
import { landingRow } from './projectHostedLandingStore';
import { openApprovalRequests } from './projectHostedApprovals';
import { hostedLandingStateSchema } from '../src/hosted-landing';
import { report } from './errors';
import { invariant } from '../src/errors';

/** The most held Lanes one read describes; the rest are counted, as the line does. */
export const NEEDS_ME_HELD_LIMIT = 30;
const NOTE_CHARS = 240;

export const needsMeWhy = v.union(
  v.literal('conflict'),
  v.literal('check-failed'),
  v.literal('infra'),
  v.literal('stale-head'),
  v.literal('rejected'),
  v.literal('review'),
  v.literal('dependency'),
  /** Held, but the bound landing is gone or names no reason: shown as not reported, never guessed. */
  v.literal('unknown'),
);
export const needsMeResult = v.object({
  held: v.array(
    v.object({
      laneId: v.string(),
      title: v.union(v.string(), v.null()),
      actor: v.union(v.string(), v.null()),
      agent: v.union(v.string(), v.null()),
      why: needsMeWhy,
      /** Forge's own words for the hold (the landing's recorded error), when it has them. */
      note: v.union(v.string(), v.null()),
      /** The held landing, for the failed-check screen (2c420916 owns its cause). */
      submissionId: v.union(v.string(), v.null()),
      /** When the hold began, as far as the records say (ms). */
      since: v.number(),
    }),
  ),
  /** Held Lanes past the limit. With `moreIsLowerBound`, at least this many. */
  more: v.number(),
  moreIsLowerBound: v.boolean(),
  /** Open approval requests (projectHostedApprovals:list), as its canonical payload. */
  approvals: v.string(),
  /** Whether the viewer can grant or decline (the project owner). */
  canDecide: v.boolean(),
});

type Held = Doc<'projectLiveLineLanes'>;

/** Why one held Lane is held: the landing its mark is bound to, read once. A conflict mark wins. */
async function reason(ctx: QueryCtx, projectId: Id<'hostedProjects'>, mark: Held) {
  const owner = await lineOwner(ctx.db, mark.laneId);
  const pageId = owner ? (JSON.parse(owner.value) as LineOwnerValue).pageId : undefined;
  const submissionId = pageId ? (await ctx.db.get(pageId))?.submissionId : undefined;
  const row = submissionId ? await landingRow(ctx, { projectId, submissionId }) : null;
  const parsed = row ? hostedLandingStateSchema.safeParse(JSON.parse(row.value)) : null;
  const state = parsed?.success ? parsed.data : null;
  const observed = state?.observation;
  const why =
    mark.overlap || observed?.cause === 'conflict'
      ? 'conflict'
      : observed?.cause
        ? observed.cause
        : observed?.pendingReason === 'waiting-for-review'
          ? 'review'
          : observed?.pendingReason === 'waiting-for-dependency'
            ? 'dependency'
            : 'unknown';
  const ended = state?.timing?.ciEndedAt ?? state?.timing?.settledAt;
  return {
    why,
    note: state?.error?.message ? state.error.message.replace(/\s+/g, ' ').slice(0, NOTE_CHARS) : null,
    submissionId: state?.id ?? null,
    since: ended ? Date.parse(ended) : mark.changedAt,
  } as const;
}

export const read = query({
  args: { projectId: v.id('hostedProjects') },
  returns: needsMeResult,
  handler: async (ctx, { projectId }) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read what needs you.');
      const project = await accessibleProject(ctx, projectId, user.subject);
      const [marks, approvals] = await Promise.all([
        ctx.db
          .query('projectLiveLineLanes')
          .withIndex('by_project_and_held', q => q.eq('projectId', projectId).eq('held', true))
          .take(NEEDS_ME_HELD_LIMIT + 1),
        openApprovalRequests(ctx, projectId),
      ]);
      const shown = marks.slice(0, NEEDS_ME_HELD_LIMIT);
      const held = await Promise.all(
        shown.map(async mark => {
          const [presence, why] = await Promise.all([
            ctx.db
              .query('projectHostedPresence')
              .withIndex('by_project_and_lane', q => q.eq('projectId', projectId).eq('laneId', mark.laneId))
              .unique(),
            reason(ctx, projectId, mark),
          ]);
          return {
            laneId: mark.laneId,
            title: presence?.goal ?? null,
            actor: presence?.actor ?? null,
            agent: presence?.agent ?? null,
            ...why,
          };
        }),
      );
      return {
        held,
        more: Math.max(0, marks.length - NEEDS_ME_HELD_LIMIT),
        moreIsLowerBound: marks.length > NEEDS_ME_HELD_LIMIT,
        approvals,
        canDecide: project.owner === user.subject,
      };
    } catch (error) {
      return report(error);
    }
  },
});
