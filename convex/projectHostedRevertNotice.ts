// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { v } from 'convex/values';
import { mutation } from './cliServer';
import { internalMutation, type MutationCtx } from './server';
import type { Doc, Id } from './_generated/dataModel';
import { acceptancePage, acceptanceRow } from './projectHostedAcceptanceStore';
import { independentIntentItem, readHostedRecord, writeHostedRecord } from './projectHostedRecords';
import { postSystemLaneNote } from './projectBoardSystem';
import { markNoteReverted, postIntentLandingNote } from './projectIntentLandingNotes';
import { activeProject } from './projectAuthority';
import { requireMemberAuthority } from './projectLaneAuthority';
import { withoutRawId } from './projectNeedsMe';
import { rememberRecentRevert } from './projectRecentLandings';
import { report } from './errors';
import { invariant } from '../src/errors';
import { hostedAcceptanceSchema, type HostedAcceptance } from '../src/hosted-acceptance';
import { hostedRecordSchema } from '../src/hosted-records';
import { composeLaneSchema, validateComposePage } from '../src/hosted-compose';
import { canonicalPayload } from '../src/hosted-source-operation';
import {
  REVERT_NOTICE_FANOUT,
  REVERT_NOTICE_LEFT,
  reopenCommand,
  revertNoticeId,
  revertNoticeSummary,
  revertNoticeText,
  takenOutOf,
} from '../src/hosted-revert-notice';

type Revert = {
  projectId: Id<'hostedProjects'>;
  /** The accepted compensating landing. */
  receiptId: string;
  /** The receipt it reverted. */
  revertOf: string;
  actor: string;
  agent?: string;
  /** Forge's own main-audit recovery ran this revert: its notice holds work, so it keeps the shared shape. */
  auto?: true;
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
 * note's own reads; the Candidate and Intent records; one probe for the Item's system note (3a733ee8);
 * one read of the small line summary to retain the exact revert even without an Item.
 * Replay-safe: every write is skipped when present.
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
  await rememberRecentRevert(ctx.db, input.projectId, {
    original: original.id,
    receipt: revert.id,
    sequence: revertRow.sequence,
  });
  const revertLane = await firstLane(ctx, input.projectId, input.receiptId);
  const page = await acceptancePage(ctx, {
    projectId: input.projectId,
    receiptId: input.revertOf,
    kind: 'inputs',
    index: 0,
  });
  const lanes: string[] = [];
  let first: { owner: string | null; title: string | null } | undefined;
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
    first ??= {
      owner: row ? (row.holderActor ?? row.actor) : null,
      title: row ? withoutRawId(row.intent) || null : null,
    };
    if (row?.landed?.receiptId === input.revertOf && !row.landed.revertedBy)
      await ctx.db.patch(row._id, {
        landed: { ...row.landed, revertedBy: { receiptId: input.receiptId, at: revert.at } },
      });
    const posted = await postSystemLaneNote(ctx, {
      projectId: input.projectId,
      id: revertNoticeId(input.receiptId, laneId),
      toLaneId: laneId,
      reason: 'revert',
      ...(row ? { recipientActor: row.holderActor ?? row.actor } : {}),
      fromLaneId: revertLane ?? laneId,
      author: input.actor,
      ...(input.agent ? { agent: input.agent } : {}),
      text: revertNoticeText({ revertOf: input.revertOf, receiptId: input.receiptId, laneId }),
    });
    if (posted === 'posted') notes++;
  }
  const { needsFix, itemNote } = await markIntent(ctx, project, original, revert, lanes[0], {
    ...(input.auto ? {} : { by: input.actor, ...(input.agent ? { agent: input.agent } : {}) }),
    ...first,
  });
  // Issue 3a733ee8: the reverted Intent's Item gets a system note matching its landing note, and the landing
  // note names the revert (Item c0af6cfa).
  const itemId = itemNote
    ? await markNoteReverted(ctx, project, itemNote.intentId, itemNote.itemId, original.id, revert.id)
    : undefined;
  if (itemNote && itemId) {
    await postIntentLandingNote(ctx, input.projectId, {
      intentId: itemNote.intentId,
      itemId,
      receiptId: revert.id,
      kind: 'reverted',
      at: revert.at,
      laneIds: lanes,
      commit: revert.candidate.head,
      sequence: revert.snapshot.revision,
      actor: revert.actor.id,
      agentRun: revert.agentRun,
      agentClient: revert.agentClient,
      revertOf: original.id,
    });
  }
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
  /** Who took it out and whose Lane it was, for the web's card (absent for a main audit's own revert). */
  told: { by?: string; agent?: string; owner?: string | null; title?: string | null },
) {
  const key = { projectId: project._id, actor: project.owner };
  const candidate = await readHostedRecord(ctx, { ...key, kind: 'candidate', key: original.candidate.id });
  if (!candidate) return { needsFix: false, itemNote: null };
  const intentId = hostedRecordSchema.options[3].parse(JSON.parse(candidate.value)).intentId;
  const row = await readHostedRecord(ctx, { ...key, kind: 'intent', key: intentId });
  if (!row) return { needsFix: false, itemNote: null };
  // A legacy head can use the original note's recovered Item binding from the revert-link lookup.
  const intent = hostedRecordSchema.options[0].parse(JSON.parse(row.value));
  const itemNote =
    row.planningItemId === independentIntentItem ? null : { intentId, itemId: row.planningItemId };
  // Main-audit recovery already wrote its richer notice for this receipt; an abandoned Intent stays closed.
  if (intent.status === 'abandoned' || intent.needsFix?.receiptId === original.id)
    return { needsFix: false, itemNote };
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
        ...(told.by && laneId
          ? {
              lane: laneId,
              by: told.by,
              ...(told.agent ? { agent: told.agent } : {}),
              ...(told.owner ? { owner: told.owner } : {}),
              ...(told.title ? { title: told.title.slice(0, 120) } : {}),
            }
          : {}),
      }),
    },
  });
  return { needsFix: true, itemNote };
}

export const accepted = internalMutation({
  args: {
    projectId: v.id('hostedProjects'),
    receiptId: v.string(),
    revertOf: v.string(),
    actor: v.string(),
    agent: v.optional(v.string()),
    auto: v.optional(v.literal(true)),
  },
  returns: v.null(),
  handler: async (ctx, input) => {
    await noticeRevert(ctx, input);
    return null;
  },
});

/**
 * The web card's two answers to a revert (J08): `left` is the reader leaving the change out (the card goes for them),
 * `back` is the Lane reopened from the card (the card goes for everyone). Both only mark the project's notice entry;
 * its fix gate and the agent-facing text stay as they are. One project row read and write, on a click.
 */
export const resolveTaken = mutation({
  args: {
    projectId: v.id('hostedProjects'),
    intentId: v.string(),
    action: v.union(v.literal('left'), v.literal('back')),
  },
  returns: v.null(),
  handler: async (ctx, { projectId, intentId, action }) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to answer this.');
      const project = await activeProject(ctx, projectId, user.subject);
      const stored = project.needsFix?.[intentId];
      const entry = stored ? takenOutOf(JSON.parse(stored)) : null;
      invariant(entry, 'WORK_STALE', 'This change is no longer waiting for an answer.');
      if (action === 'back') requireMemberAuthority(project, entry.owner ?? entry.by, user.subject, 'Lane');
      const fix = JSON.parse(stored!) as Record<string, unknown>;
      const next =
        action === 'back'
          ? { ...fix, back: true }
          : {
              ...fix,
              left: [...entry.left.filter(id => id !== user.subject), user.subject].slice(
                -REVERT_NOTICE_LEFT,
              ),
            };
      await ctx.db.patch(projectId, {
        needsFix: { ...project.needsFix, [intentId]: canonicalPayload(next) },
      });
      return null;
    } catch (error) {
      return report(error);
    }
  },
});
