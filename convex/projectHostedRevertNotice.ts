// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { internalMutation, type MutationCtx } from './server';
import type { Doc, Id } from './_generated/dataModel';
import { acceptancePage, acceptanceRow } from './projectHostedAcceptanceStore';
import { readHostedRecord, writeHostedRecord } from './projectHostedRecords';
import { postSystemLaneNote } from './projectBoardSystem';
import { hostedAcceptanceSchema, type HostedAcceptance } from '../src/hosted-acceptance';
import { hostedRecordSchema } from '../src/hosted-records';
import { composeLaneSchema, validateComposePage } from '../src/hosted-compose';
import { canonicalPayload } from '../src/hosted-source-operation';
import {
  REVERT_NOTICE_FANOUT,
  reopenCommand,
  revertNoticeId,
  revertNoticeSummary,
  revertNoticeText,
} from '../src/hosted-revert-notice';

type Revert = {
  projectId: Id<'hostedProjects'>;
  /** The accepted compensating landing. */
  receiptId: string;
  /** The receipt it reverted. */
  revertOf: string;
  actor: string;
  agent?: string;
};

/**
 * A compensating landing (request `revertOf`, from the CLI, the browser or main-audit recovery) was
 * accepted: tell the reverted work (Issue 8dbccdfb). Scheduled once from the landing's own `landed`
 * transition, so the normal landing path pays nothing and idle pays nothing. Per revert:
 *  - each Lane the reverted receipt landed (first input page, at most REVERT_NOTICE_FANOUT) gets its
 *    landing stamp marked `revertedBy` (Lane status and lane-history then say reverted, not current)
 *    and one board note naming the exact reopen command, delivered on that Lane's next action;
 *  - the reverted Intent gets a `reverted` needsFix notice (Now and CLI status), unless main-audit
 *    recovery already owns one for this receipt, or the Intent was abandoned.
 * Reads: project, both receipts, the reverted input page, then per Lane its overlap row and the board
 * note's own reads; the Candidate and Intent records. Replay-safe: every write is skipped when present.
 */
export async function noticeRevert(ctx: MutationCtx, input: Revert) {
  const project = await ctx.db.get(input.projectId);
  if (!project || project.sourceAuthority?.mode !== 'server') return { lanes: 0, notes: 0, needsFix: false };
  const [originalRow, revertRow] = await Promise.all([
    acceptanceRow(ctx, { projectId: input.projectId, receiptId: input.revertOf }),
    acceptanceRow(ctx, { projectId: input.projectId, receiptId: input.receiptId }),
  ]);
  if (!originalRow || !revertRow) return { lanes: 0, notes: 0, needsFix: false };
  const original = hostedAcceptanceSchema.parse(JSON.parse(originalRow.value));
  const revert = hostedAcceptanceSchema.parse(JSON.parse(revertRow.value));
  const revertLane = await firstLane(ctx, input.projectId, input.receiptId);
  const page = await acceptancePage(ctx, {
    projectId: input.projectId,
    receiptId: input.revertOf,
    kind: 'inputs',
    index: 0,
  });
  const lanes: string[] = [];
  let notes = 0;
  for (const value of page ? validateComposePage(JSON.parse(page.value)).entries : []) {
    if (lanes.length >= REVERT_NOTICE_FANOUT) break;
    const entry = composeLaneSchema.safeParse(value);
    if (!entry.success) continue;
    const laneId = entry.data.laneId;
    lanes.push(laneId);
    const row = await ctx.db
      .query('projectHostedOverlapLanes')
      .withIndex('by_project_and_lane', q => q.eq('projectId', input.projectId).eq('laneId', laneId))
      .unique();
    if (row?.landed?.receiptId === input.revertOf && !row.landed.revertedBy)
      await ctx.db.patch(row._id, {
        landed: { ...row.landed, revertedBy: { receiptId: input.receiptId, at: revert.at } },
      });
    const posted = await postSystemLaneNote(ctx, {
      projectId: input.projectId,
      id: revertNoticeId(input.receiptId, laneId),
      toLaneId: laneId,
      fromLaneId: revertLane ?? laneId,
      author: input.actor,
      ...(input.agent ? { agent: input.agent } : {}),
      text: revertNoticeText({ revertOf: input.revertOf, receiptId: input.receiptId, laneId }),
    });
    if (posted === 'posted') notes++;
  }
  const needsFix = await markIntent(ctx, project, original, revert, lanes[0]);
  return { lanes: lanes.length, notes, needsFix };
}

async function firstLane(ctx: MutationCtx, projectId: Id<'hostedProjects'>, receiptId: string) {
  const page = await acceptancePage(ctx, { projectId, receiptId, kind: 'inputs', index: 0 });
  const first = page ? validateComposePage(JSON.parse(page.value)).entries[0] : undefined;
  const lane = composeLaneSchema.safeParse(first);
  return lane.success ? lane.data.laneId : null;
}

async function markIntent(
  ctx: MutationCtx,
  project: Doc<'hostedProjects'>,
  original: HostedAcceptance,
  revert: HostedAcceptance,
  laneId: string | undefined,
) {
  const key = { projectId: project._id, actor: project.owner };
  const candidate = await readHostedRecord(ctx, { ...key, kind: 'candidate', key: original.candidate.id });
  if (!candidate) return false;
  const intentId = hostedRecordSchema.options[3].parse(JSON.parse(candidate.value)).intentId;
  const row = await readHostedRecord(ctx, { ...key, kind: 'intent', key: intentId });
  if (!row) return false;
  const intent = hostedRecordSchema.options[0].parse(JSON.parse(row.value));
  // Main-audit recovery already wrote its richer notice for this receipt; an abandoned Intent stays closed.
  if (intent.status === 'abandoned' || intent.needsFix?.receiptId === original.id) return false;
  const notice = {
    state: 'reverted' as const,
    receiptId: original.id,
    revertReceiptId: revert.id,
    // A later landing of this Intent (its re-land) clears the notice (onRecoveryAccepted).
    sequence: revert.snapshot.revision,
    head: original.candidate.head,
    previousHead: original.previous.head,
    failed: [],
    summary: revertNoticeSummary({ revertOf: original.id, receiptId: revert.id }),
    undo: laneId ? reopenCommand(laneId) : `nforge agent ROOT start '${JSON.stringify({ intentId })}'`,
  };
  await writeHostedRecord(ctx, {
    ...key,
    authorityEpoch: project.sourceAuthority!.epoch,
    expectedVersion: intent.version,
    // A completed Intent is open work again: its change is no longer on main.
    record: { ...intent, version: intent.version + 1, status: 'active', needsFix: notice },
  });
  const current = (await ctx.db.get(project._id))!;
  await ctx.db.patch(project._id, {
    needsFix: {
      ...current.needsFix,
      [intentId]: canonicalPayload({
        at: revert.at,
        state: notice.state,
        receiptId: notice.receiptId,
        revertReceiptId: notice.revertReceiptId,
        head: notice.head,
        summary: notice.summary.slice(0, 240),
        undo: notice.undo,
      }),
    },
  });
  return true;
}

export const accepted = internalMutation({
  args: {
    projectId: v.id('hostedProjects'),
    receiptId: v.string(),
    revertOf: v.string(),
    actor: v.string(),
    agent: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, input) => {
    await noticeRevert(ctx, input);
    return null;
  },
});
