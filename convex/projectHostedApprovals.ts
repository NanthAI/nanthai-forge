// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { mutation, query } from './cliServer';
import { acceptanceActor } from './projectAutonomy';
import { accessibleProject, activeOwnedProject, activeProject } from './projectAuthority';
import { requireMemberAuthorityById } from './projectLaneAuthority';
import { saveLane } from './projectHostedSaveStore';
import { liveLaneFinish } from './projectHostedLaneFinish';
import { approveHeldLanding } from './projectHostedAcceptance';
import { declineHeldLanding, held } from './projectHostedOwnerReview';
import { postSystemLaneNote } from './projectBoardSystem';
import {
  APPROVAL_LIVE_LIMIT,
  approvalRow,
  approvalView,
  fitNote,
  noteDecision,
  openForkRequest,
  writeApproval,
} from './projectHostedApprovalStore';
import { notifyPullApproval } from './projectGithubPullQueue';
import { isAgentSlug } from '../src/agent-slug';
import { canonicalPayload } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';
import { report } from './errors';

/** Issue fe5bea80: a builder asks the project owner for a go on one saved Lane; the owner grants or
 * declines in one step; a waiting builder's subscription (`observe`) returns on that write. */
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REASON_LIMIT = 500;

export function laneApproveUrl(projectId: string, laneId: string) {
  const web = process.env.FORGE_WEB_URL;
  if (!web) return null;
  const url = new URL('/approve', web);
  url.searchParams.set('project', projectId);
  url.searchParams.set('lane', laneId);
  return url.href;
}
const text = (value: string | undefined) => value?.replace(/\s+/g, ' ').trim().slice(0, REASON_LIMIT);

/** Request (or re-request) approval on a saved Lane: its author or the project owner, agent or person.
 * One indexed read and one write, plus one project board note. A replay returns the same row. */
export const request = mutation({
  args: {
    projectId: v.id('hostedProjects'),
    operationId: v.string(),
    laneId: v.string(),
    reason: v.string(),
    agent: v.optional(v.string()),
  },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      invariant(uuid.test(input.operationId), 'BAD_ARGUMENT', 'operationId must be a lowercase UUID.');
      const reason = text(input.reason);
      invariant(reason, 'BAD_ARGUMENT', 'request-approval needs a reason the owner can read.');
      const actor = await acceptanceActor(ctx, true);
      await activeProject(ctx, input.projectId, actor.id);
      const old = await approvalRow(ctx, input.projectId, input.laneId);
      if (old?.operationId === input.operationId) return canonicalPayload(requestReply(old, input));
      const lane = await saveLane(ctx, { projectId: input.projectId, actor: actor.id, laneId: input.laneId });
      await requireMemberAuthorityById(ctx, input.projectId, lane.actor, actor.id, 'Lane');
      invariant(
        lane.state === 'active',
        'WORK_STALE',
        `Lane ${lane.id} is ${lane.state}; nothing to approve.`,
      );
      const now = Date.now();
      const fields = {
        operationId: input.operationId,
        requester: actor.id,
        reason,
        head: lane.head,
        at: now,
        status: 'requested' as const,
        live: true,
        decision: undefined,
        ended: undefined,
      };
      const agent = isAgentSlug(input.agent) ? input.agent : undefined;
      if (old) await writeApproval(ctx, old, { ...fields, agent });
      else
        await ctx.db.insert('projectHostedApprovals', {
          projectId: input.projectId,
          laneId: lane.id,
          ...fields,
          ...(agent ? { agent } : {}),
          version: 1,
        });
      const url = laneApproveUrl(input.projectId, lane.id);
      await postSystemLaneNote(ctx, {
        projectId: input.projectId,
        id: input.operationId,
        toLaneId: 'project',
        fromLaneId: lane.id,
        author: actor.id,
        ...(agent ? { agent } : {}),
        text: fitNote(
          `Approval requested on Lane ${lane.id.slice(0, 8)}: `,
          reason,
          url ? ` Owner: ${url}` : '',
        ),
        now,
      });
      return canonicalPayload(requestReply((await approvalRow(ctx, input.projectId, lane.id))!, input));
    } catch (error) {
      return report(error);
    }
  },
});
function requestReply(
  row: NonNullable<Awaited<ReturnType<typeof approvalRow>>>,
  input: { projectId: string; laneId: string },
) {
  const url = laneApproveUrl(input.projectId, row.laneId);
  return {
    ...approvalView(row, row.laneId),
    url,
    next: `${url ? 'Hand this link to the project owner; they open it signed in and grant or decline. ' : ''}Landing this Lane holds for the owner until they grant it. Wait for the decision: nforge agent ROOT wait '{"approval":"${row.laneId}"}'.`,
  };
}

/** The owner person's decision on a Lane's request, in one step. A grant covers exactly the Lane head
 * the owner saw; if that Lane's landing is already held for review, the grant is its exact approval
 * (it lands) and a decline ends it REVIEW_DECLINED. Agents and device sign-ins are refused. */
export const decide = mutation({
  args: {
    projectId: v.id('hostedProjects'),
    operationId: v.string(),
    laneId: v.string(),
    decision: v.union(v.literal('grant'), v.literal('decline')),
    head: v.string(),
    reason: v.optional(v.string()),
  },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      invariant(uuid.test(input.operationId), 'BAD_ARGUMENT', 'operationId must be a lowercase UUID.');
      const actor = await acceptanceActor(ctx);
      await activeOwnedProject(ctx, input.projectId, actor.id);
      invariant(
        actor.kind === 'person',
        'PROJECT_UNAVAILABLE',
        'Only the project owner, signed in as a person, can grant or decline approval.',
      );
      const row = await approvalRow(ctx, input.projectId, input.laneId);
      const fork = openForkRequest(row);
      invariant(row && (row.live || fork), 'NOT_FOUND', `Lane ${input.laneId} has no open approval request.`);
      if (row.decision?.operationId === input.operationId)
        return canonicalPayload({ approval: approvalView(row, row.laneId), landing: null });
      // A fork PR run is decided once: a grant starts the run, a decline settles the PR head.
      invariant(
        !fork || row.status === 'requested',
        'WORK_STALE',
        `This fork PR run was already ${row.status}; a new push asks again.`,
      );
      const lane = await saveLane(ctx, { projectId: input.projectId, actor: actor.id, laneId: input.laneId });
      invariant(
        lane.head === input.head,
        'WORK_STALE',
        'The Lane changed since you opened it; reload to review its current work.',
      );
      const status = input.decision === 'grant' ? ('granted' as const) : ('declined' as const);
      const reason = text(input.reason) || undefined;
      await writeApproval(ctx, row, {
        status,
        decision: {
          operationId: input.operationId,
          by: actor.id,
          at: Date.now(),
          head: lane.head,
          via: 'lane',
          ...(reason ? { reason } : {}),
        },
      });
      // A fork PR's Lane has no builder to tell; its PR head's forge/verify carries the decision.
      if (fork) await notifyPullApproval(ctx, row, status);
      else await noteDecision(ctx, row, status, actor.id, input.operationId, reason);
      // A held landing of this Lane takes the same decision now: one click, not two.
      const live = await liveLaneFinish(ctx, {
        projectId: input.projectId,
        laneId: lane.id,
        headWrittenAt: '',
      });
      let landing: unknown = null;
      if (live && held(live.state)) {
        const selection = {
          projectId: input.projectId,
          submissionId: live.state.id,
          attemptId: live.state.attemptId,
        };
        landing =
          status === 'granted'
            ? await approveHeldLanding(ctx, actor, selection)
            : await declineHeldLanding(ctx, actor.id, {
                ...selection,
                operationId: input.operationId,
                ...(reason ? { reason } : {}),
              });
      }
      const after = await approvalRow(ctx, input.projectId, lane.id);
      return canonicalPayload({ approval: approvalView(after, lane.id), landing });
    } catch (error) {
      return report(error);
    }
  },
});

/** The requester withdraws their own request (or the owner drops it): it stops holding landings. */
export const withdraw = mutation({
  args: { projectId: v.id('hostedProjects'), laneId: v.string() },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const actor = await acceptanceActor(ctx, true);
      await activeProject(ctx, input.projectId, actor.id);
      const row = await approvalRow(ctx, input.projectId, input.laneId);
      invariant(row, 'NOT_FOUND', `Lane ${input.laneId} has no approval request.`);
      await requireMemberAuthorityById(ctx, input.projectId, row.requester, actor.id, 'Lane');
      const fork = openForkRequest(row);
      if (row.live || fork)
        await writeApproval(ctx, row, { live: false, ended: { kind: 'withdrawn', at: Date.now() } });
      if (fork) await notifyPullApproval(ctx, row, 'withdrawn');
      return canonicalPayload(
        approvalView(await approvalRow(ctx, input.projectId, input.laneId), input.laneId),
      );
    } catch (error) {
      return report(error);
    }
  },
});

/** One indexed row, for `wait {approval}` (a live subscription re-runs only when this row changes).
 * `detail` (the owner's page only) adds the Lane's current head and its held landing. Any project
 * reader; idle costs nothing. */
export const observe = query({
  args: { projectId: v.id('hostedProjects'), laneId: v.string(), detail: v.optional(v.literal(1)) },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read approval requests.');
      await accessibleProject(ctx, input.projectId, user.subject);
      const row = await approvalRow(ctx, input.projectId, input.laneId);
      const view = approvalView(row, input.laneId);
      // Held for the landing: the Lane's live landing, when one waits for review, for the owner page.
      const detail = Boolean((row?.live || openForkRequest(row)) && input.detail);
      const live = detail
        ? await liveLaneFinish(ctx, { projectId: input.projectId, laneId: input.laneId, headWrittenAt: '' })
        : null;
      const landing =
        live && held(live.state)
          ? { submissionId: live.state.id, operationId: live.state.operationId, held: true }
          : null;
      const lane = detail
        ? await saveLane(ctx, { projectId: input.projectId, actor: user.subject, laneId: input.laneId })
        : null;
      return canonicalPayload({
        ...view,
        ...(lane ? { currentHead: lane.head, intentId: lane.intentId } : {}),
        landing,
        url: row ? laneApproveUrl(input.projectId, input.laneId) : null,
      });
    } catch (error) {
      return report(error);
    }
  },
});

/** The owner's list: live requests in this project (one per protected Lane), newest first. */
export const list = query({
  args: { projectId: v.id('hostedProjects') },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read approval requests.');
      await accessibleProject(ctx, input.projectId, user.subject);
      const rows = await ctx.db
        .query('projectHostedApprovals')
        .withIndex('by_project_and_live', q => q.eq('projectId', input.projectId).eq('live', true))
        .order('desc')
        .take(APPROVAL_LIVE_LIMIT);
      return canonicalPayload({
        requests: rows.map(row => ({
          ...approvalView(row, row.laneId),
          url: laneApproveUrl(input.projectId, row.laneId),
        })),
      });
    } catch (error) {
      return report(error);
    }
  },
});
