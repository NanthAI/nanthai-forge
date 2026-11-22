// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { acceptancePage, acceptancePlan } from './projectHostedAcceptanceStore';
import { composeLaneSchema, validateComposePage } from '../src/hosted-compose';
import { postSystemLaneNote } from './projectBoardSystem';
import { BOARD_TEXT_CHARS } from '../src/board-text';
import { approvalPath } from '../src/project-routes';
import { accountFor } from './urlIdentity';

/** Issue fe5bea80: builder approval requests on Lanes (table projectHostedApprovals). */
export type ApprovalRow = Doc<'projectHostedApprovals'>;
/** Live requests per project are one per protected Lane; this bounds the gate read. */
export const APPROVAL_LIVE_LIMIT = 100;
/** A landing's input pages read for the hold; a solo landing has one. */
const INPUT_PAGE_LIMIT = 8;

/** The owner's approval links for one project (Item 0a99ab23; src/project-routes.ts `approvalPath`). The owner's
 * handle is one indexed read, made by the first link asked for and shared by the rest, so a reply with no link reads
 * nothing. Null links without a configured web URL. */
export function approvalLinks(
  ctx: QueryCtx | MutationCtx,
  project: Pick<Doc<'hostedProjects'>, '_id' | 'owner' | 'slug'>,
) {
  const web = process.env.FORGE_WEB_URL;
  let handle: Promise<string | undefined> | undefined;
  return async (laneId: string | null, submissionId?: string): Promise<string | null> => {
    if (!web) return null;
    handle ??= project.slug
      ? accountFor(ctx, project.owner).then(account => account?.handle)
      : Promise.resolve(undefined);
    return approvalLinkFor(web, project, await handle)(laneId, submissionId);
  };
}
export type ApprovalLink = ReturnType<typeof approvalLinks>;
/** The same links when the caller already read the owner's handle. */
export function approvalLinkFor(
  web: string | undefined,
  project: Pick<Doc<'hostedProjects'>, '_id' | 'slug'>,
  handle: string | undefined,
) {
  const address = handle && project.slug ? { handle, slug: project.slug } : null;
  return (laneId: string | null, submissionId?: string): string | null =>
    web ? new URL(approvalPath(address, project._id, laneId, submissionId), web).href : null;
}
/** One request's link: the Lane page, or Needs me for a settings request. */
export const laneApproveUrl = (
  ctx: QueryCtx | MutationCtx,
  project: Pick<Doc<'hostedProjects'>, '_id' | 'owner' | 'slug'>,
  laneId: string,
) => approvalLinks(ctx, project)(laneId);
/** The /approve form, with no read: that page looks the project up and opens the Lane page or Needs me. For a link
 * shown where the project's address must not be (a GitHub status on a private project) and settings replies. */
export const opaqueApproveUrl = (projectId: string, laneId: string) => {
  const web = process.env.FORGE_WEB_URL;
  return web ? new URL(approvalPath(null, projectId, laneId), web).href : null;
};

export const approvalRow = (ctx: QueryCtx | MutationCtx, projectId: Id<'hostedProjects'>, laneId: string) =>
  ctx.db
    .query('projectHostedApprovals')
    .withIndex('by_project_and_lane', q => q.eq('projectId', projectId).eq('laneId', laneId))
    .unique();

/** A held settings change as the agent sent it, for the owner's page only. */
export function settingChange(row: ApprovalRow): unknown {
  if (!row.setting) return undefined;
  try {
    return JSON.parse(row.setting.request);
  } catch {
    return row.setting.request;
  }
}
/** Issue 470ef29b: a held settings request that is still open (never `live`; open until it ends). */
export const openSettingRequest = (row: ApprovalRow | null) => Boolean(row?.setting && !row.ended);
/** A fork PR run request that is still open: it is never `live` (it holds no landing). */
export const openForkRequest = (row: ApprovalRow | null) => row?.pullRequest !== undefined && !row.ended;
/** What every reader sees (the requester and deciding person map to handles). `live` reads as
 * "open": a fork PR run request or a settings request is open until it ends. */
export function approvalView(row: ApprovalRow | null, laneId: string) {
  if (!row) return { laneId, status: 'none' as const, live: false, version: 0 };
  return {
    laneId: row.laneId,
    status: row.status,
    live: row.live || openForkRequest(row) || openSettingRequest(row),
    ...(row.pullRequest !== undefined ? { pullRequest: row.pullRequest } : {}),
    reason: row.reason,
    requester: row.requester,
    ...(row.agent ? { agent: row.agent } : {}),
    head: row.head,
    at: new Date(row.at).toISOString(),
    ...(row.decision
      ? {
          decision: {
            by: row.decision.by,
            at: new Date(row.decision.at).toISOString(),
            head: row.decision.head,
            via: row.decision.via,
            ...(row.decision.reason ? { reason: row.decision.reason } : {}),
          },
        }
      : {}),
    ...(row.ended ? { ended: { kind: row.ended.kind, at: new Date(row.ended.at).toISOString() } } : {}),
    // Issue 470ef29b: a held settings change; its content is for the owner (settingChange).
    ...(row.setting?.origin === 'membership'
      ? { membership: true }
      : row.setting
        ? { setting: { origin: row.setting.origin } }
        : {}),
    version: row.version,
  };
}

/** The Lanes (and pinned heads) one prepared attempt lands, from its staged input pages. Only read
 * when the project has a live request, so landings in projects without one pay nothing more. */
async function attemptLanes(ctx: QueryCtx | MutationCtx, projectId: Id<'hostedProjects'>, receiptId: string) {
  const identity = { projectId, receiptId };
  const plan = await acceptancePlan(ctx, identity);
  const lanes = new Map<string, string>();
  for (let index = 0; index < Math.min(plan?.inputPages ?? 0, INPUT_PAGE_LIMIT); index++) {
    const page = await acceptancePage(ctx, { ...identity, kind: 'inputs', index });
    if (!page) break;
    for (const entry of validateComposePage(JSON.parse(page.value)).entries) {
      const pin = composeLaneSchema.safeParse(entry);
      if (pin.success) lanes.set(pin.data.laneId, pin.data.head);
    }
  }
  return lanes;
}

/** The live requests on the Lanes this attempt lands, each with the head it pins. One indexed read
 * (normally empty); input pages only when that read found a row. */
export const liveApprovals = (ctx: QueryCtx | MutationCtx, projectId: Id<'hostedProjects'>) =>
  ctx.db
    .query('projectHostedApprovals')
    .withIndex('by_project_and_live', q => q.eq('projectId', projectId).eq('live', true))
    .take(APPROVAL_LIVE_LIMIT);
export async function attemptApprovals(
  ctx: QueryCtx | MutationCtx,
  projectId: Id<'hostedProjects'>,
  receiptId: string,
  /** Already read in this transaction (a batch reads it once for all members). */
  preloaded?: ApprovalRow[],
) {
  const live = preloaded ?? (await liveApprovals(ctx, projectId));
  if (!live.length) return [];
  const lanes = await attemptLanes(ctx, projectId, receiptId);
  return live.flatMap(row => {
    const head = lanes.get(row.laneId);
    return head === undefined ? [] : [{ row, head }];
  });
}

/** Why these requests still hold the landing, or null when every one is granted for the exact Lane
 * head it lands. Declined requests say so; the owner can still accept the held landing. */
export function approvalHoldReason(matched: { row: ApprovalRow; head: string }[]) {
  const open = matched.filter(({ row, head }) => !(row.status === 'granted' && row.decision?.head === head));
  if (!open.length) return null;
  return open
    .map(({ row }) =>
      row.status === 'declined'
        ? `approval declined on Lane ${row.laneId.slice(0, 8)}${row.decision?.reason ? `: ${row.decision.reason}` : ''} (address it, then request-approval again)`
        : `approval requested on Lane ${row.laneId.slice(0, 8)}: ${row.reason}`,
    )
    .join('; ');
}

export async function writeApproval(ctx: MutationCtx, row: ApprovalRow, patch: Partial<ApprovalRow>) {
  await ctx.db.patch(row._id, { ...patch, version: row.version + 1 });
}

/** The owner's decision on a held landing settles the Lane requests it carries, so a builder waiting
 * on the request (wait {approval}) returns too; the requester's Lane gets one board note. */
export async function settleAttemptApprovals(
  ctx: MutationCtx,
  input: {
    projectId: Id<'hostedProjects'>;
    receiptId: string;
    operationId: string;
    by: string;
    status: 'granted' | 'declined';
    reason?: string;
  },
) {
  const now = Date.now();
  for (const { row, head } of await attemptApprovals(ctx, input.projectId, input.receiptId)) {
    // Already decided this way for this exact head (the Lane decision that approved the landing).
    if (
      row.decision?.operationId === input.operationId ||
      (row.status === input.status && row.decision?.head === head)
    )
      continue;
    await writeApproval(ctx, row, {
      status: input.status,
      decision: {
        operationId: input.operationId,
        by: input.by,
        at: now,
        head,
        via: 'landing',
        ...(input.reason ? { reason: input.reason } : {}),
      },
    });
    await noteDecision(ctx, row, input.status, input.by, input.operationId, input.reason);
  }
}

/** Landing with the grant ends the request (it never holds a later landing of the Lane). */
export async function endLandedApprovals(ctx: MutationCtx, matched: { row: ApprovalRow }[]) {
  for (const { row } of matched)
    if (row.live) await writeApproval(ctx, row, { live: false, ended: { kind: 'landed', at: Date.now() } });
}

/** A Lane set aside or moved to the trash takes its own request with it (Item 4f1f7984), requested, granted or
 * declined: one indexed read on the lifecycle write that already runs, so no row waits forever on a Lane that will
 * never land. The decision stays as recorded; only a Lane request (never a fork or settings row) is ended. */
export async function settleLaneApproval(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  laneId: string,
  /** When the Lane was set aside: a request made after it (the Lane was reopened and asked again before a delayed
   * cascade page ran) is a new request and stays. */
  abandonedAt: number,
) {
  const row = await approvalRow(ctx, projectId, laneId);
  if (row && !row.ended && !row.setting && row.pullRequest === undefined && row.at <= abandonedAt)
    await writeApproval(ctx, row, { live: false, ended: { kind: 'settled', at: Date.now() } });
}

/** Board notes are one line of at most BOARD_TEXT_CHARS: the free-text reason is shortened to fit
 * around the fixed parts (a refused note would be skipped silently). */
export function fitNote(before: string, reason: string, after: string) {
  const room = BOARD_TEXT_CHARS - [...before].length - [...after].length;
  const chars = [...reason];
  if (chars.length <= room) return `${before}${reason}${after}`;
  return `${before}${
    room > 1
      ? `${chars
          .slice(0, room - 1)
          .join('')
          .trimEnd()}…`
      : ''
  }${after}`;
}
/** One note to the requester's Lane: it shows on their next action and ends a blocked wait. */
export async function noteDecision(
  ctx: MutationCtx,
  row: ApprovalRow,
  status: 'granted' | 'declined',
  by: string,
  operationId: string,
  reason?: string,
) {
  await postSystemLaneNote(ctx, {
    projectId: row.projectId,
    // Deterministic per decision, so a replay returns the first note.
    id: operationId,
    toLaneId: row.laneId,
    reason: 'approval',
    fromLaneId: row.laneId,
    author: by,
    text: fitNote(
      `The project owner ${status === 'granted' ? 'granted' : 'declined'} the approval request on Lane ${row.laneId.slice(0, 8)}${reason ? ': ' : '.'}`,
      reason ?? '',
      `${reason ? '.' : ''}${status === 'granted' ? ' It can land now.' : ' Address it, then request-approval again.'}`,
    ),
  });
}
