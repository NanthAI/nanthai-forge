// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
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
import { accessibleProject, coordinationAccess } from './projectAuthority';
import { hasWriteRole } from './projectRole';
import { githubMirrorStatus } from './projectGithubMirrorStatus.idle';
import { deployStatusForViewer } from './projectDeployStatus';
import { effectivePolicy } from '../src/autonomy-policy';
import { mirrorSummary } from '../src/github-mirror-sentence';
import { needsFix } from '../src/culprit-bisect';
import { takenOutOf, type TakenOut } from '../src/hosted-revert-notice';
import { lineOwner } from './projectLiveLineOwners';
import { landingRow } from './projectHostedLandingStore';
import { finishRow } from './projectHostedFinishWake';
import { openApprovalRequests } from './projectHostedApprovals';
import { messagesTo } from './projectNeedsFyi';
import { openLandingReviews, reviewCheckEvidence, reviewSubmitter } from './projectHostedReviewInbox';
import { approvalLinks, type ApprovalLink } from './projectHostedApprovalStore';
import { storedLandingStateSchema } from '../src/hosted-landing';
import { landingStateOf, type LandingStateName } from '../src/landing-state';
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
/** The most revert / fix-needed notices one read lists (Item 12fde646): they sit on the project row this read already
 * holds, so listing them adds no read; the rest are counted by `noticesMore`. */
const NEEDS_ME_NOTICE_LIMIT = 20;

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
  /** Held, and Forge has no landing outcome on record for it (the bound landing is gone): said as exactly that, with
   * the next step, never guessed (Item 9b9057a9). */
  v.literal('unknown'),
);
const takenOutShape = {
  laneId: v.string(),
  title: v.union(v.string(), v.null()),
  by: v.string(),
  agent: v.union(v.string(), v.null()),
  at: v.number(),
};
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
      reviewCheck: v.optional(v.union(v.literal('ran'), v.literal('pending'), v.literal('none'))),
      /** A review of several Lanes (one submission): every Lane of it, so each shows as waiting on the reader. */
      laneIds: v.optional(v.array(v.string())),
      /** The owner's page for this decision: the Lane page (Item 0a99ab23), when the deployment has a web address. */
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
  /** Shared-state decisions a person settles (Item 12fde646): work reverted from main (or still needing a fix) and a
   * GitHub mirror that stopped. Team members only; the mirror one is the owner's. Each stays until the state changes. */
  notices: v.optional(
    v.array(
      v.object({
        kind: v.union(v.literal('reverted'), v.literal('needs-fix'), v.literal('mirror')),
        /** The reverted Intent's id, `mirror`, or `deploy:<target>`. */
        id: v.string(),
        summary: v.string(),
        next: v.union(v.string(), v.null()),
        /** A revert somebody ran, offered to the Lane's owner (J08): the card says who took which Lane out and when. */
        taken: v.optional(v.object(takenOutShape)),
      }),
    ),
  ),
  deployStatus: v.optional(
    v.object({
      mainSequence: v.number(),
      targets: v.array(
        v.object({
          target: v.string(),
          label: v.string(),
          environment: v.string(),
          liveSequence: v.union(v.number(), v.null()),
          failure: v.optional(
            v.object({
              key: v.string(),
              since: v.string(),
              sinceSequence: v.number(),
              runUrl: v.optional(v.string()),
              work: v.optional(
                v.object({
                  kind: v.union(v.literal('lane'), v.literal('item')),
                  id: v.string(),
                  who: v.string(),
                }),
              ),
              attentionAt: v.optional(v.number()),
              attentionMinutes: v.number(),
            }),
          ),
        }),
      ),
    }),
  ),
  noticesMore: v.optional(v.literal(true)),
  /** What waits on a person in the project's sealed secrets (Item 41a0df87): removed people still listed, names to
   * rotate and waiting proposals, from the counter on the project row. Write members only; absent when zero. */
  secrets: v.optional(v.number()),
  /** Reverts the reader ran themselves: FYI, never counted, with the Lane they can bring back (J08). */
  tookOut: v.optional(v.array(v.object({ id: v.string(), ...takenOutShape }))),
  /** Questions with choices addressed to the viewer, unanswered, on an open Lane (Items 12fde646, 48049998). */
  asksMore: v.optional(v.literal(true)),
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
        planningItemId: v.optional(v.string()),
        ahead: v.optional(v.literal(true)),
        handBack: v.optional(v.object({ head: v.string(), left: v.string(), to: v.string() })),
        recipientSession: v.optional(v.string()),
        to: v.optional(v.string()),
        recipientEnded: v.optional(v.literal(true)),
      }),
    ),
  ),
});

type Held = Doc<'projectLiveLineLanes'>;

/** The hold a failed end names by its error code when it recorded no `cause` (older or other write paths): the one
 * reading every screen and agent reply shares (src/landing-state.ts), so Forge never says "why not reported" for an
 * end it made itself. Nothing named: null. */
function endedWhy(state: ReturnType<typeof storedLandingStateSchema.parse> | null) {
  if (!state || state.observation?.state !== 'terminal-failed') return null;
  const named: Partial<
    Record<LandingStateName, 'conflict' | 'check-failed' | 'infra' | 'stale-head' | 'rejected'>
  > = {
    conflict: 'conflict',
    'check-failed': 'check-failed',
    'not-run': 'infra',
    'stale-head': 'stale-head',
    rejected: 'rejected',
  };
  return named[landingStateOf(state).state] ?? null;
}

/** Why one held Lane is held: the landing its mark is bound to, read once. Its recorded cause wins over an overlap mark. */
async function reason(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  mark: Held,
  reviewIds: ReadonlySet<string>,
  link: ApprovalLink,
) {
  const owner = await lineOwner(ctx.db, mark.laneId);
  // Binding stamps the submission on the owner row. A new save clears it in
  // the same transaction that detaches the page.
  const submissionId = owner?.projectId === projectId ? owner.submissionId : undefined;
  if (submissionId && reviewIds.has(submissionId))
    return { sibling: submissionId as string, why: undefined } as const;
  const row = submissionId ? await landingRow(ctx, { projectId, submissionId }) : null;
  const parsed = row ? storedLandingStateSchema.safeParse(JSON.parse(row.value)) : null;
  const state = parsed?.success ? parsed.data : null;
  const observed = state?.observation;
  // A recorded landing hold or failure wins over an incidental overlap mark.
  const why =
    state?.error?.code === 'LANDING_CANCELLED'
      ? 'withdrawn'
      : observed?.pendingReason === 'waiting-for-review'
        ? 'review'
        : (observed?.cause ??
          endedWhy(state) ??
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
    ...(why === 'review' && state && row
      ? {
          attemptId: state.attemptId,
          ...reviewCheckEvidence(row, state),
          url: await link(mark.laneId, state.id),
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
  const parsed = row ? storedLandingStateSchema.safeParse(JSON.parse(row.value)) : null;
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

type Notice = {
  kind: 'reverted' | 'needs-fix' | 'mirror';
  id: string;
  summary: string;
  next: string | null;
  taken?: TakenOut;
};

/** The GitHub mirror, only when it stopped on a conflict a person settles (GitHub's main moved, GitHub refused the push,
 * or the push failed): the same words as Settings → GitHub mirror. A mirror that is level, behind or retrying asks
 * nobody. One status read of three rows, so nothing here for a project with no mirror. */
async function stoppedMirror(ctx: QueryCtx, project: Doc<'hostedProjects'>): Promise<Notice | null> {
  const policy = effectivePolicy(project).githubMirror;
  if (!policy?.autoPush) return null;
  const summary = mirrorSummary(
    { ...policy, paused: project.githubMirrorPausedInbound !== undefined },
    await githubMirrorStatus(ctx, project),
  );
  if (!['moved', 'refused', 'stopped'].includes(summary.state)) return null;
  return { kind: 'mirror', id: 'mirror', summary: summary.sentence, next: summary.next };
}

export const read = query({
  args: { projectId: v.id('hostedProjects') },
  returns: needsMeResult,
  handler: async (ctx, { projectId }) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read what needs you.');
      const project = await accessibleProject(ctx, projectId, user.subject);
      // The owner's handle (one indexed read) is read only when a row below needs an approval link.
      const link = approvalLinks(ctx, project);
      const [marks, approvals, asks, parks, { reviews }] = await Promise.all([
        ctx.db
          .query('projectLiveLineLanes')
          .withIndex('by_project_and_held', q => q.eq('projectId', projectId).eq('held', true))
          .take(NEEDS_ME_HELD_LIMIT + 1),
        openApprovalRequests(ctx, projectId, link),
        messagesTo(ctx, project, user.subject, true),
        ctx.db
          .query('projectHostedParks')
          .withIndex('by_project_and_parked_for', q =>
            q.eq('projectId', projectId).eq('parkedFor', user.subject),
          )
          .take(NEEDS_ME_PARKED_LIMIT + 1),
        openLandingReviews(ctx, projectId, link),
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
      // The Lanes whose marks are bound to each review submission: one decision, but every Lane of it waits on the
      // reader (Item 9b9057a9). Taken from the marks this read already walks, so no read is added.
      const reviewLanes = new Map<string, string[]>();
      const marked = await Promise.all(
        shown.map(async mark => {
          const recorded = await reason(ctx, projectId, mark, reviewIds, link);
          // One decision for all the Lane marks on this exact submission.
          // A different submission on the same Lane can still have its own hold.
          if (recorded.why === undefined) {
            reviewLanes.set(recorded.sibling, [...(reviewLanes.get(recorded.sibling) ?? []), mark.laneId]);
            return null;
          }
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
          const laneIds = [
            ...new Set([review.laneId, ...(reviewLanes.get(review.submissionId) ?? [])]),
          ].filter(id => id !== null);
          return {
            ...review,
            ...(laneIds.length > 1 ? { laneIds } : {}),
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
      // Shared-state decisions (Item 12fde646): the notices sit on the project row already read; the mirror reads its
      // three status rows only for the owner of a project with a mirror, as the Mirror screen does.
      const fixes = needsFix(project);
      const owner = project.owner === user.subject;
      // The team check reads a role only for a project with notices to show or for its owner's mirror.
      const team = fixes.length > 0 || owner ? await coordinationAccess(ctx, project, user.subject) : false;
      // The sealed-secrets counter sits on the project row already read; a role check runs only when it is not zero.
      const secrets =
        project.secretsNeeds && (await hasWriteRole(ctx, project, user.subject)) ? project.secretsNeeds : 0;
      const notices: Notice[] = [];
      const tookOut: (TakenOut & { id: string })[] = [];
      let noticesMore = false;
      if (team) {
        noticesMore = fixes.length > NEEDS_ME_NOTICE_LIMIT;
        for (const fix of fixes.slice(0, NEEDS_ME_NOTICE_LIMIT)) {
          // A revert somebody ran (J08): FYI for whoever ran it, an offer for the Lane's owner when that is someone
          // else, nothing for the rest; once brought back or left out it is gone. Entries without these fields (a main
          // audit's, an older revert) keep the shared-state notice below.
          const summary = String(fix.summary ?? '')
            .replace(/\s+/g, ' ')
            .slice(0, NOTE_CHARS);
          const taken = fix.state === 'reverted' ? takenOutOf(fix) : null;
          if (taken) {
            const { owner: laneOwner, left, back, ...shown } = taken;
            if (back || left.includes(user.subject)) continue;
            if (taken.by === user.subject) tookOut.push({ id: fix.intentId, ...shown });
            else if (laneOwner === user.subject)
              notices.push({ kind: 'reverted', id: fix.intentId, summary, next: null, taken: shown });
            continue;
          }
          notices.push({
            kind: fix.state === 'reverted' ? 'reverted' : 'needs-fix',
            id: fix.intentId,
            summary,
            next: typeof fix.undo === 'string' ? fix.undo.slice(0, NOTE_CHARS) : null,
          });
        }
      }
      const mirror = team && owner ? await stoppedMirror(ctx, project) : null;
      if (mirror) notices.push(mirror);
      const deployStatus = await deployStatusForViewer(ctx, project, user.subject);
      return {
        held,
        parked,
        ...(notices.length ? { notices } : {}),
        ...(deployStatus ? { deployStatus } : {}),
        ...(tookOut.length ? { tookOut } : {}),
        ...(noticesMore ? { noticesMore: true as const } : {}),
        ...(secrets ? { secrets } : {}),
        parkedMore: parks.length > NEEDS_ME_PARKED_LIMIT,
        more: Math.max(0, marks.length - NEEDS_ME_HELD_LIMIT),
        moreIsLowerBound: marks.length > NEEDS_ME_HELD_LIMIT,
        approvals,
        canDecide: project.owner === user.subject,
        asks: asks.rows,
        ...(asks.more ? { asksMore: true as const } : {}),
      };
    } catch (error) {
      return report(error);
    }
  },
});
