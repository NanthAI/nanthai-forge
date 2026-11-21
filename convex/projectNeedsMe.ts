// SPDX-License-Identifier: Apache-2.0
// Needs me (Items 9e748e41, 12fde646): what holds work until a person decides, in one bounded subscription.
// Review decisions come from the queue's submissions. Other holds start from the live line's held marks.
// The screen and top bar share this read. For each held Lane it adds the Lane's title and holder
// (its slim presence row) and why Forge holds it (the bound landing's recorded observation), and
// it adds the open approval requests, and the Lanes parked for the reader (Item e1633718: one index range on the parked
// Lanes' routing rows, plus each one's slim presence row). No paths, source, activity or check output; idle costs nothing.
import { v } from 'convex/values';
import { query } from './cliServer';
import type { QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { accessibleProject } from './projectAuthority';
import { lineOwner } from './projectLiveLineOwners';
import { landingRow } from './projectHostedLandingStore';
import { finishRow } from './projectHostedFinishWake';
import { openApprovalRequests } from './projectHostedApprovals';
import { messagesTo } from './projectNeedsFyi';
import { openLandingReviews, reviewSubmitter } from './projectHostedReviewInbox';
import { approvePath, approveUrl } from './projectHostedOwnerReview';
import { hostedLandingStateSchema } from '../src/hosted-landing';
import { report } from './errors';
import { invariant } from '../src/errors';
import { record, recordPartition, selectedGeneration } from './projectWorkIndexStore';

const RAW_ID = /^\s*[0-9a-f]{8}(?:-[0-9a-f]{1,12})*(?:-?(?:…|\.{3}))?(?:\s*[:–—-]\s*|\s*$)/i;
/** A Lane goal without a leading raw Item or Lane id ("875a4b60-3aad-…: site function" → "site function"). */
export const withoutRawId = (goal: string) => goal.replace(RAW_ID, '').replace(/\s+/g, ' ').trim();

/** The most held Lanes one read describes; the rest are counted, as the line does. */
export const NEEDS_ME_HELD_LIMIT = 30;
/** The most parked Lanes one read lists for the reader (Item e1633718); one index range of at most this plus one. */
const NEEDS_ME_PARKED_LIMIT = 30;
const NOTE_CHARS = 240;

export const needsMeWhy = v.union(
  v.literal('conflict'),
  v.literal('check-failed'),
  v.literal('infra'),
  v.literal('stale-head'),
  v.literal('rejected'),
  v.literal('review'),
  v.literal('dependency'),
  /** Its own agent (or a person) withdrew the landing: nothing to decide, shown under FYI (Item 0cb9b064). */
  v.literal('withdrawn'),
  /** Held, but the bound landing is gone or names no reason: shown as not reported, never guessed. */
  v.literal('unknown'),
);
export const needsMeResult = v.object({
  held: v.array(
    v.object({
      laneId: v.union(v.string(), v.null()),
      /** The Lane's Intent, so several held Lanes of one Item can be told apart and grouped. */
      intentId: v.union(v.string(), v.null()),
      title: v.union(v.string(), v.null()),
      actor: v.union(v.string(), v.null()),
      agent: v.union(v.string(), v.null()),
      agentClient: v.optional(v.string()),
      agentAuthored: v.optional(v.literal(true)),
      why: needsMeWhy,
      /** Forge's own words for the hold (the landing's recorded error), when it has them. */
      note: v.union(v.string(), v.null()),
      /** The held landing, for the failed-check screen (2c420916 owns its cause). */
      submissionId: v.union(v.string(), v.null()),
      /** For a landing held for review: its held attempt, so the owner can approve or decline that exact attempt
       * here with the calls the /approve page makes (projectHostedAcceptance:approve, projectHostedOwnerReview:decline).
       * A landing-policy hold (protected paths, supervised) has no Lane approval request to decide instead. */
      attemptId: v.optional(v.string()),
      /** The owner's review page for this submission, when the deployment has a web address. */
      url: v.optional(v.union(v.string(), v.null())),
      /** When the hold began, as far as the records say (ms). */
      since: v.number(),
      /** A Lane held for a dependency: the Lane it lands after, and its title, when the records name it (Item
       * 9e748e41). Only such a row carries it, read from its finish row and the parent's landing. */
      dependsOn: v.optional(v.object({ laneId: v.string(), title: v.union(v.string(), v.null()) })),
    }),
  ),
  /** Held Lanes past the limit. With `moreIsLowerBound`, at least this many. */
  more: v.number(),
  moreIsLowerBound: v.boolean(),
  /** Open approval requests (projectHostedApprovals:list), as its canonical payload. */
  approvals: v.string(),
  /** Whether the viewer can approve or decline (the project owner). */
  canDecide: v.boolean(),
  /** Open Lanes parked for the reader (Item e1633718): named to the reader, or parked by the reader's own Lane with
   * no one named. The page shows an unnamed one only once `at` (its last activity) is 4 h old, by its own clock
   * when it draws (count.ts `parkShown`), so no timer and no clock argument: idle costs nothing. */
  parked: v.optional(
    v.array(
      v.object({
        laneId: v.string(),
        intentId: v.string(),
        title: v.union(v.string(), v.null()),
        actor: v.string(),
        agent: v.union(v.string(), v.null()),
        /** `named` stays true when the reader may not see the holder's handle, so a hidden name never reads as none. */
        park: v.object({
          to: v.optional(v.string()),
          named: v.boolean(),
          reason: v.string(),
          at: v.number(),
          by: v.string(),
        }),
        /** The Lane's last activity (ms): its presence row's record time. */
        at: v.number(),
      }),
    ),
  ),
  parkedMore: v.optional(v.boolean()),
  /** Questions with choices addressed to the viewer, unanswered, on an open Lane (Items 12fde646, 48049998). */
  asks: v.optional(
    v.array(
      v.object({
        id: v.string(),
        at: v.number(),
        actor: v.string(),
        agent: v.union(v.string(), v.null()),
        text: v.string(),
        choices: v.array(v.string()),
        laneId: v.union(v.string(), v.null()),
      }),
    ),
  ),
});

type Held = Doc<'projectLiveLineLanes'>;

/** Why one held Lane is held: the landing its mark is bound to, read once. Its recorded cause wins over an overlap mark. */
async function reason(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  mark: Held,
  reviewIds: ReadonlySet<string>,
) {
  const owner = await lineOwner(ctx.db, mark.laneId);
  // Binding stamps the submission on the owner row. A new save clears it in
  // the same transaction that detaches the page.
  const submissionId = owner?.projectId === projectId ? owner.submissionId : undefined;
  if (submissionId && reviewIds.has(submissionId)) return null;
  const row = submissionId ? await landingRow(ctx, { projectId, submissionId }) : null;
  const parsed = row ? hostedLandingStateSchema.safeParse(JSON.parse(row.value)) : null;
  const state = parsed?.success ? parsed.data : null;
  const observed = state?.observation;
  // A recorded landing hold or failure wins over an incidental overlap mark.
  const why =
    state?.error?.code === 'LANDING_CANCELLED'
      ? 'withdrawn'
      : observed?.pendingReason === 'waiting-for-review'
        ? 'review'
        : (observed?.cause ??
          (mark.overlap
            ? 'conflict'
            : observed?.pendingReason === 'waiting-for-dependency'
              ? 'dependency'
              : 'unknown'));
  const ended = state?.timing?.ciEndedAt ?? state?.timing?.settledAt;
  const parentLaneId = why === 'dependency' && state ? await dependencyLane(ctx, projectId, state.id) : null;
  return {
    why,
    note: state?.error?.message ? state.error.message.replace(/\s+/g, ' ').slice(0, NOTE_CHARS) : null,
    submissionId: state?.id ?? null,
    ...(why === 'review' && state
      ? {
          attemptId: state.attemptId,
          url: approveUrl(projectId, state.id) ?? approvePath(projectId, state.id),
        }
      : {}),
    since: ended ? Date.parse(ended) : mark.changedAt,
    parentLaneId,
    submitter: row && state ? reviewSubmitter(row, state) : null,
  } as const;
}

/** The Lane a dependency-held landing lands after: its finish row names the parent landing, whose compose selection
 * names its Lane (as projectHostedQueueView does). Three point reads, only for a Lane held for a dependency. */
async function dependencyLane(ctx: QueryCtx, projectId: Id<'hostedProjects'>, submissionId: string) {
  const parentId = (await finishRow(ctx, { projectId, submissionId }))?.parentSubmissionId;
  const row = parentId ? await landingRow(ctx, { projectId, submissionId: parentId }) : null;
  const parsed = row ? hostedLandingStateSchema.safeParse(JSON.parse(row.value)) : null;
  const parent = parsed?.success ? parsed.data : null;
  const operationId = parent?.request.finish?.composeOperationId;
  if (!parent || !operationId) return null;
  const composed = await ctx.db
    .query('projectHostedComposeSelections')
    .withIndex('by_project_and_actor_and_operation_and_kind_and_key', q =>
      q
        .eq('projectId', projectId)
        .eq('actor', parent.actor)
        .eq('operationId', operationId)
        .eq('kind', 'inputs'),
    )
    .take(2);
  return composed.length === 1 ? composed[0]!.key : null;
}

export const read = query({
  args: { projectId: v.id('hostedProjects') },
  returns: needsMeResult,
  handler: async (ctx, { projectId }) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read what needs you.');
      const project = await accessibleProject(ctx, projectId, user.subject);
      const [marks, approvals, asks, parks, { reviews }] = await Promise.all([
        ctx.db
          .query('projectLiveLineLanes')
          .withIndex('by_project_and_held', q => q.eq('projectId', projectId).eq('held', true))
          .take(NEEDS_ME_HELD_LIMIT + 1),
        openApprovalRequests(ctx, projectId),
        messagesTo(ctx, projectId, user.subject, true),
        ctx.db
          .query('projectHostedParks')
          .withIndex('by_project_and_parked_for', q =>
            q.eq('projectId', projectId).eq('parkedFor', user.subject),
          )
          .take(NEEDS_ME_PARKED_LIMIT + 1),
        openLandingReviews(ctx, projectId),
      ]);
      const reviewIds = new Set(reviews.map(review => review.submissionId));
      const shown = marks.slice(0, NEEDS_ME_HELD_LIMIT);
      // A goal that is only a raw id names its Item instead (the Lane's Intent is the Item it started from): one
      // point read, only for such a row.
      let partition: Id<'projectWorkGenerations'> | null | undefined;
      const titleOf = async (presence: { goal: string; intentId: string } | null) => {
        if (!presence) return null;
        const words = withoutRawId(presence.goal);
        if (words) return words;
        if (partition === undefined) {
          const generation = await selectedGeneration(ctx, project);
          partition = generation ? recordPartition(generation) : null;
        }
        const root = partition ? await record(ctx, partition, 'planningSearch', presence.intentId) : null;
        const title = root ? (JSON.parse(root.value) as { title?: unknown }).title : null;
        return typeof title === 'string' && title.trim() ? title.replace(/\s+/g, ' ').trim() : null;
      };
      const presenceOf = (laneId: string) =>
        ctx.db
          .query('projectHostedPresence')
          .withIndex('by_project_and_lane', q => q.eq('projectId', projectId).eq('laneId', laneId))
          .unique();
      const marked = await Promise.all(
        shown.map(async mark => {
          const recorded = await reason(ctx, projectId, mark, reviewIds);
          // One decision for all the Lane marks on this exact submission.
          // A different submission on the same Lane can still have its own hold.
          if (!recorded) return null;
          const { parentLaneId, submitter, ...why } = recorded;
          const presence = await presenceOf(mark.laneId);
          // A review is for the submitted landing; for other holds the byline names who
          // acts next. Select only one account so privacy mapping reads no second person.
          const by = why.why === 'review' ? (submitter ?? presence) : presence;
          const stamp =
            by && by.actor === submitter?.actor && by.agent === submitter.agent ? submitter : null;
          return {
            laneId: mark.laneId,
            intentId: presence?.intentId ?? null,
            title: await titleOf(presence),
            actor: by?.actor ?? null,
            agent: by?.agent ?? null,
            ...(stamp?.agentClient ? { agentClient: stamp.agentClient } : {}),
            ...(stamp?.agentAuthored ? { agentAuthored: stamp.agentAuthored } : {}),
            ...why,
            ...(parentLaneId
              ? { dependsOn: { laneId: parentLaneId, title: await titleOf(await presenceOf(parentLaneId)) } }
              : {}),
          };
        }),
      );
      const reviewRows = await Promise.all(
        reviews.map(async review => {
          const presence = review.laneId ? await presenceOf(review.laneId) : null;
          return {
            ...review,
            intentId: review.intentId ?? presence?.intentId ?? null,
            title: await titleOf(presence),
            why: 'review' as const,
            note: review.note?.replace(/\s+/g, ' ').slice(0, NOTE_CHARS) ?? null,
          };
        }),
      );
      const held = [...marked.filter(mark => mark !== null), ...reviewRows];
      // parkedFor is the named holder's account, or the starter's when no one is named (projectHostedPresence.ts
      // routeLanePark); the Lane's slim presence row holds its title, people, park and last activity.
      const parked = [];
      for (const route of parks.slice(0, NEEDS_ME_PARKED_LIMIT)) {
        const row = await ctx.db
          .query('projectHostedPresence')
          .withIndex('by_project_and_lane', q => q.eq('projectId', projectId).eq('laneId', route.laneId))
          .unique();
        if (!row?.park) continue;
        parked.push({
          laneId: row.laneId,
          intentId: row.intentId,
          title: await titleOf(row),
          actor: row.actor,
          agent: row.agent ?? null,
          park: { ...row.park, named: Boolean(row.park.to) },
          at: row.at,
        });
      }
      return {
        held,
        parked,
        parkedMore: parks.length > NEEDS_ME_PARKED_LIMIT,
        more: Math.max(0, marks.length - NEEDS_ME_HELD_LIMIT),
        moreIsLowerBound: marks.length > NEEDS_ME_HELD_LIMIT,
        approvals,
        canDecide: project.owner === user.subject,
        asks: asks.rows,
      };
    } catch (error) {
      return report(error);
    }
  },
});
