// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { mutation, query, type MutationCtx, type QueryCtx } from './cliServer';
import type { Id } from './_generated/dataModel';
import { boardCaller } from './projectAudience';
import { hasWriteRole } from './projectRole';
import { boardInbox, boardMessageView } from './projectBoardDelivery';
import { laneConflicts } from './projectHostedConflicts';
import {
  BOARD_EVIDENCE_MS,
  BOARD_LANE_WINDOW,
  BOARD_MEMBER_DAY_POSTS,
  BOARD_PROJECT_LIVE_CAP,
  BOARD_RETENTION_MS,
  assertBoardOpen,
  boardStopped,
  chargeAccount,
  chargeWindow,
  cleanupExpired,
  sendBoardAlerts,
} from './projectBoardLimits';
import { assertBoardPaths, assertBoardText, boardIdPrefix, parseBoardTarget } from '../src/board-text';
import { isAgentSlug } from '../src/agent-slug';
import { canonicalPayload } from '../src/hosted-source-operation';
import { digest } from '../src/state/hash';
import { invariant } from '../src/errors';
import { report } from './errors';
import { tightestBudget } from './abuseLimits';
import { recordFeedAttention } from './projectFeedStore';
import { projectSaveFailures } from './projectHostedSaveStore';

const day = 24 * 60 * 60 * 1000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Index range for a full id or a unique prefix: 2 rows at most tell unique from ambiguous. */
const prefixRange = (ref: string) => ({
  full: uuid.test(ref),
  upper: `${ref}\uffff`,
});

async function laneRow(ctx: QueryCtx | MutationCtx, projectId: Id<'hostedProjects'>, ref: string) {
  const { full, upper } = prefixRange(ref);
  const rows = await ctx.db
    .query('projectHostedOverlapLanes')
    .withIndex('by_project_and_lane', q =>
      full
        ? q.eq('projectId', projectId).eq('laneId', ref)
        : q.eq('projectId', projectId).gte('laneId', ref).lt('laneId', upper),
    )
    .take(2);
  invariant(
    rows.length === 1,
    rows.length ? 'BAD_ARGUMENT' : 'NOT_FOUND',
    rows.length
      ? `Lane prefix ${ref} is ambiguous (${rows.map(row => row.laneId.slice(0, 13)).join(', ')}); use more characters.`
      : `No Lane ${ref} in this project.`,
  );
  return rows[0]!;
}

/** A contributor sees only their own notes: anyone else's answers exactly like a missing note. */
const missingNote = (ref: string) =>
  `No board message ${boardIdPrefix(ref)} in this project (notes expire after 14 days).`;
async function readableMessage(
  ctx: QueryCtx | MutationCtx,
  caller: { projectId: Id<'hostedProjects'>; actor: string; team: boolean },
  ref: string,
) {
  // A prefix is matched across every note, so its ambiguity would reveal notes a contributor cannot read.
  invariant(
    caller.team || prefixRange(boardIdPrefix(ref)).full,
    'BAD_ARGUMENT',
    'Contributors name their notes by the full id the post returned.',
  );
  const row = await messageRow(ctx, caller.projectId, ref);
  invariant(caller.team || row.author === caller.actor, 'NOT_FOUND', missingNote(ref));
  return row;
}

async function messageRow(ctx: QueryCtx | MutationCtx, projectId: Id<'hostedProjects'>, ref: string) {
  const id = boardIdPrefix(ref);
  const { full, upper } = prefixRange(id);
  const rows = await ctx.db
    .query('projectBoardMessages')
    .withIndex('by_project_and_id', q =>
      full
        ? q.eq('projectId', projectId).eq('id', id)
        : q.eq('projectId', projectId).gte('id', id).lt('id', upper),
    )
    .take(2);
  invariant(
    rows.length === 1,
    rows.length ? 'BAD_ARGUMENT' : 'NOT_FOUND',
    rows.length ? `Message prefix ${id} is ambiguous; use more characters.` : missingNote(id),
  );
  return rows[0]!;
}

/** One mutation per post. Reads: ~20 point/range rows (access, replay, 3 switches, Lane, target and, for a Lane
 * note or reply, its holder's role: none for the owner or the caller, one indexed read for a member;
 * dedupe, 2 rate windows, account, cleanup ≤20, project, inbox), ~6 KB. Writes: message, evidence,
 * inbox, project count, 2 windows, account (7 rows, ~2.5 KB) plus ≤20 expired-row deletes. */
export const post = mutation({
  args: {
    projectId: v.id('hostedProjects'),
    operationId: v.string(),
    text: v.string(),
    to: v.optional(v.string()),
    replyTo: v.optional(v.string()),
    laneId: v.optional(v.string()),
    paths: v.optional(v.array(v.string())),
    /** The posting agent session's slug (feature agent-slug, c29d0780); absent for a person. */
    agent: v.optional(v.string()),
  },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const { actor, project, team } = await boardCaller(ctx, input.projectId);
      const projectId = input.projectId;
      invariant(uuid.test(input.operationId), 'BAD_ARGUMENT', 'operationId must be a lowercase UUID.');
      const old = await ctx.db
        .query('projectBoardMessages')
        .withIndex('by_project_and_id', q => q.eq('projectId', projectId).eq('id', input.operationId))
        .unique();
      if (old) {
        invariant(
          old.author === actor && old.body === input.text,
          'WORK_OPERATION_CHANGED',
          'This operationId already posted a different note. Use a new UUID.',
        );
        return canonicalPayload({ status: 'duplicate', id: old.id, target: old.targetKey, at: old.at });
      }
      assertBoardOpen(await boardStopped(ctx, projectId, actor));
      assertBoardText(input.text);
      assertBoardPaths(input.paths);
      invariant(
        input.agent === undefined || isAgentSlug(input.agent),
        'BAD_ARGUMENT',
        'agent must be a Forge agent slug (two words from the fixed list).',
      );
      invariant(
        (input.to === undefined) !== (input.replyTo === undefined),
        'BAD_ARGUMENT',
        'Choose to (a new note) or replyTo (a reply), not both.',
      );
      const now = Date.now();
      let fromLaneId: string | undefined;
      if (input.laneId) {
        const lane = await laneRow(ctx, projectId, input.laneId.toLowerCase());
        // Your own Lane, in any state: a queued or accepted landing closes the Lane but not the
        // conversation about it (ce974f90). Recipients must still be open (LANE_NOT_ACTIVE below).
        invariant(lane.actor === actor, 'BAD_ARGUMENT', 'laneId must be your own Lane in this project.');
        fromLaneId = lane.laneId;
      }
      let targetKey: string, recipients: number | null, replyTo: string | undefined;
      let recipientActor: string | undefined;
      if (input.replyTo) {
        // A reply goes to the Lane that wrote the original, else to the original's target.
        // A contributor answers only in their own threads; the team answers anyone it can read.
        const original = await readableMessage(ctx, { projectId, actor, team }, input.replyTo);
        replyTo = original.id;
        const laneId =
          original.fromLaneId ??
          (original.targetKey.startsWith('lane:') ? original.targetKey.slice(5) : undefined);
        targetKey = laneId ? `lane:${laneId}` : original.targetKey;
        recipients = original.fromLaneId ? 1 : null;
        if (laneId) {
          const lane = await ctx.db
            .query('projectHostedOverlapLanes')
            .withIndex('by_project_and_lane', q => q.eq('projectId', projectId).eq('laneId', laneId))
            .unique();
          const holder = lane ? (lane.holderActor ?? lane.actor) : original.fromLaneId && original.author;
          // A Lane answers only while whoever holds it is on the team; otherwise the reply stays in the team inbox.
          if (holder && (holder === actor || (await hasWriteRole(ctx, project, holder))))
            recipientActor = holder;
          else {
            targetKey = 'project';
            recipients = null;
          }
        }
      } else {
        const target = parseBoardTarget(input.to!);
        if (target.kind === 'lane') {
          const lane = await laneRow(ctx, projectId, target.ref);
          invariant(lane.open, 'LANE_NOT_ACTIVE', `Lane ${lane.laneId.slice(0, 8)} is no longer open.`);
          targetKey = `lane:${lane.laneId}`;
          recipientActor = lane.holderActor ?? lane.actor;
          // Notes go to the team only: a Lane held by someone no longer on it cannot be messaged.
          invariant(
            recipientActor === actor || (await hasWriteRole(ctx, project, recipientActor)),
            'BAD_ARGUMENT',
            `Lane ${lane.laneId.slice(0, 8)} is held by someone outside this project's team; board notes reach the team only.`,
          );
          recipients = 1;
        } else if (target.kind === 'issue') {
          targetKey = `issue:${target.id}`;
          const heads = await ctx.db
            .query('projectHostedRecordHeads')
            .withIndex('by_project_and_kind_and_parent', q =>
              q.eq('projectId', projectId).eq('kind', 'lane').eq('parent', target.id),
            )
            .take(11);
          recipients = heads.filter(head => head.status === 'active').length;
        } else {
          targetKey = 'project';
          recipients = null;
        }
      }
      const bodyHash = digest(JSON.stringify([targetKey, input.text, input.paths ?? []]));
      const same = (
        await ctx.db
          .query('projectBoardMessages')
          .withIndex('by_project_and_author_and_hash_and_at', q =>
            q
              .eq('projectId', projectId)
              .eq('author', actor)
              .eq('bodyHash', bodyHash)
              .gt('at', now - day),
          )
          .order('desc')
          .take(2)
      ).find(row => !row.resolvedAt);
      // A withdrawn note does not block saying it again.
      if (same)
        return canonicalPayload({ status: 'duplicate', id: same.id, target: same.targetKey, at: same.at });
      const window = await chargeWindow(
        ctx,
        projectId,
        fromLaneId ? `lane:${fromLaneId}` : `member:${actor}`,
        {
          ...BOARD_LANE_WINDOW,
          now,
          message: `${BOARD_LANE_WINDOW.posts} notes per 10 minutes per Lane.`,
          limit: 'board-10min',
        },
      );
      const daily = await chargeWindow(ctx, projectId, `day:${actor}`, {
        ms: day,
        posts: BOARD_MEMBER_DAY_POSTS,
        now,
        aligned: true,
        message: `${BOARD_MEMBER_DAY_POSTS} notes a day per member per project.`,
        limit: 'board-day',
      });
      const deleted = await cleanupExpired(ctx, projectId, now);
      const counter = await ctx.db
        .query('projectBoardProjects')
        .withIndex('by_project', q => q.eq('projectId', projectId))
        .unique();
      const live = Math.max(0, (counter?.live ?? 0) - deleted);
      invariant(
        live < BOARD_PROJECT_LIVE_CAP,
        'BOARD_FULL',
        `This project holds ${BOARD_PROJECT_LIVE_CAP} live notes, the limit. Notes expire after 14 days.`,
      );
      const bytes = new TextEncoder().encode(input.text).length + JSON.stringify(input.paths ?? []).length;
      const { alerts, budget: account } = await chargeAccount(ctx, {
        author: actor,
        projectId,
        bytes,
        youngProject: !counter && now - project._creationTime < day,
        now,
      });
      const id = input.operationId;
      const at = Math.max(now, (counter?.lastAt ?? 0) + 1);
      await ctx.db.insert('projectBoardMessages', {
        projectId,
        id,
        author: actor,
        ...(input.agent ? { agent: input.agent } : {}),
        ...(fromLaneId ? { fromLaneId } : {}),
        targetKey,
        ...(replyTo ? { replyTo } : {}),
        body: input.text,
        ...(input.paths?.length ? { paths: input.paths } : {}),
        bytes,
        bodyHash,
        at,
        expiresAt: now + BOARD_RETENTION_MS,
      });
      await ctx.db.insert('boardEvidence', {
        messageId: id,
        projectId,
        author: actor,
        ...(fromLaneId ? { fromLaneId } : {}),
        targetKey,
        at,
        bytes,
        recipients,
        // From the stored `at` (bumped past the counter's lastAt when posts share a millisecond).
        expiresAt: at + BOARD_EVIDENCE_MS,
      });
      const inbox = await ctx.db
        .query('projectBoardInboxes')
        .withIndex('by_project_and_key', q => q.eq('projectId', projectId).eq('key', targetKey))
        .unique();
      if (inbox) await ctx.db.patch(inbox._id, { latestAt: at, count: inbox.count + 1 });
      else await ctx.db.insert('projectBoardInboxes', { projectId, key: targetKey, latestAt: at, count: 1 });
      if (targetKey.startsWith('lane:'))
        await recordFeedAttention(ctx, projectId, targetKey.slice(5), id, 'note', recipientActor);
      if (counter) await ctx.db.patch(counter._id, { live: live + 1, lastAt: at });
      else await ctx.db.insert('projectBoardProjects', { projectId, live: 1, firstPostAt: now, lastAt: at });
      await sendBoardAlerts(ctx, alerts);
      const budget = tightestBudget(window, daily, account);
      return canonicalPayload({
        status: 'posted',
        id,
        target: targetKey,
        at,
        ...(recipients !== null ? { recipients } : {}),
        ...(budget ? { budget } : {}),
      });
    } catch (error) {
      return report(error);
    }
  },
});

/** Withdraw a note (friction 9d7bd94f): the author or any member with write access, the same access
 * as post. A resolved note stops arriving as board.notices and stops waking waits; `board {id}` and
 * `board {all:true}` still show it, marked resolved by a Forge handle with the optional reason.
 * Idempotent. Reads: access, 3 switches, the note (≈6 rows); writes: one patch (≈0.4 KB). */
export const resolve = mutation({
  args: {
    projectId: v.id('hostedProjects'),
    id: v.string(),
    text: v.optional(v.string()),
    agent: v.optional(v.string()),
  },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const { actor, team } = await boardCaller(ctx, input.projectId);
      assertBoardOpen(await boardStopped(ctx, input.projectId, actor));
      if (input.text !== undefined) assertBoardText(input.text);
      invariant(
        input.agent === undefined || isAgentSlug(input.agent),
        'BAD_ARGUMENT',
        'agent must be a Forge agent slug (two words from the fixed list).',
      );
      const note = await readableMessage(ctx, { projectId: input.projectId, actor, team }, input.id);
      if (note.resolvedAt)
        return canonicalPayload({ status: 'already-resolved', id: note.id, at: note.resolvedAt });
      const at = Date.now();
      await ctx.db.patch(note._id, {
        resolvedAt: at,
        resolvedBy: actor,
        ...(input.agent ? { resolvedAgent: input.agent } : {}),
        ...(input.text ? { resolvedText: input.text } : {}),
      });
      return canonicalPayload({ status: 'resolved', id: note.id, at });
    } catch (error) {
      return report(error);
    }
  },
});

/** One bounded query. Inbox: 3 inbox point reads + ≤3×11 message rows (~10 KB at most).
 * One message: 1 range read + ≤21 replies. The team reads everything; a contributor (board audience
 * `team-and-contributors`) reads only their own notes by id (docs/access.md#audience). */
export const read = query({
  args: {
    projectId: v.id('hostedProjects'),
    laneId: v.optional(v.string()),
    after: v.optional(v.number()),
    laneAfter: v.optional(v.number()),
    projectAfter: v.optional(v.number()),
    id: v.optional(v.string()),
    limit: v.optional(v.number()),
    /** Include resolved notes (marked `resolved`). Sent only with `board {all:true}`. */
    all: v.optional(v.boolean()),
  },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const { actor, team } = await boardCaller(ctx, input.projectId);
      const projectId = input.projectId;
      // A contributor reads one of their own notes and its replies by id, never the team's inboxes.
      invariant(
        team || input.id,
        'BAD_ARGUMENT',
        'Contributors read their own notes by id: board {"id":"NOTE_ID"} shows a note you posted and its replies.',
      );
      const off = await boardStopped(ctx, projectId);
      if (off && input.id) return canonicalPayload({ status: 'off', messages: [], more: 0 });
      if (input.id) {
        const message = await readableMessage(ctx, { projectId, actor, team }, input.id);
        const replies = await ctx.db
          .query('projectBoardMessages')
          .withIndex('by_project_and_reply', q => q.eq('projectId', projectId).eq('replyTo', message.id))
          .take(21);
        return canonicalPayload({
          status: 'ok',
          message: boardMessageView(message),
          replies: replies.slice(0, 20).map(boardMessageView),
          moreReplies: replies.length > 20,
        });
      }
      let intentId: string | undefined, laneId: string | undefined;
      let conflicts: Awaited<ReturnType<typeof laneConflicts>> = [];
      let laneFailure;
      if (input.laneId) {
        const lane = await laneRow(ctx, projectId, input.laneId.toLowerCase());
        laneId = lane.laneId;
        intentId = lane.intentId;
        laneFailure = lane.saveFailure;
        if (lane.open) conflicts = await laneConflicts(ctx, projectId, laneId, lane.head);
      }
      const limit = Math.min(10, Math.max(1, Math.floor(input.limit ?? 10)));
      const saveFailures = laneId
        ? laneFailure
          ? [{ laneId, ...laneFailure }]
          : []
        : await projectSaveFailures(ctx, projectId, limit + 1);
      const failureFields = saveFailures.length
        ? {
            saveFailures: saveFailures.slice(0, limit),
            ...(saveFailures.length > limit ? { moreSaveFailures: true } : {}),
          }
        : {};
      if (off)
        return canonicalPayload({
          status: 'off',
          messages: [],
          more: 0,
          ...(laneId ? { conflicts } : {}),
          ...failureFields,
        });
      const inbox = await boardInbox(ctx, {
        projectId,
        ...(laneId ? { laneId } : {}),
        ...(intentId ? { intentId } : {}),
        after: input.after ?? 0,
        ...(!input.all && input.laneAfter !== undefined ? { laneAfter: input.laneAfter } : {}),
        ...(!input.all && input.projectAfter !== undefined ? { projectAfter: input.projectAfter } : {}),
        limit,
        // Ordinary pages continue at the last note returned across the three inboxes.
        order: input.all ? 'desc' : 'asc',
        ...(input.all ? { includeResolved: true } : {}),
      });
      return canonicalPayload({
        status: 'ok',
        ...inbox,
        ...(conflicts.length ? { conflicts } : {}),
        ...failureFields,
      });
    } catch (error) {
      return report(error);
    }
  },
});
