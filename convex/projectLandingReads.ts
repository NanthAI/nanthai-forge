// SPDX-License-Identifier: Apache-2.0
// To read (Item 9e748e41): what landed that this account has not read yet, newest first, and the one write that marks
// it read. Read state is per account, so a browser, a phone and the CLI agree. Nothing here holds a landing or counts
// toward Needs you.
//
// list: 1 read-state row + one indexed range of at most TO_READ_PAGE + 1 receipts above the read line (plus the few
// read one by one) + 2 indexed rows per listed landing for its Lane. It re-runs when a landing is accepted or the
// reader marks; never on a clock. mark: 1 read + 1 write, idempotent (marking twice is marking once).
import { v } from 'convex/values';
import { mutation, query } from './cliServer';
import { accessibleProject } from './projectAuthority';
import { finishRow } from './projectHostedFinishWake';
import { LANDING_READ_SET } from './projectLandingReadFields';
import { report } from './errors';
import { invariant } from '../src/errors';
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';

export const TO_READ_PAGE = 30;

async function readState(ctx: QueryCtx | MutationCtx, projectId: Id<'hostedProjects'>, account: string) {
  return ctx.db
    .query('projectLandingReads')
    .withIndex('by_project_and_account', q => q.eq('projectId', projectId).eq('account', account))
    .unique();
}

const titleOf = (message: unknown) =>
  typeof message === 'string'
    ? (message
        .split('\n')
        .find(line => line.trim())
        ?.trim() ?? null)
    : null;

/** `unread` (To read): landings this account has not read. `recent` (Landed today on Lanes): the newest landings
 * whatever their read state, each with `read`. */
export const list = query({
  args: {
    projectId: v.id('hostedProjects'),
    view: v.optional(v.union(v.literal('unread'), v.literal('recent'))),
  },
  returns: v.string(),
  handler: async (ctx, { projectId, view = 'unread' }) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read what landed.');
      await accessibleProject(ctx, projectId, user.subject);
      const state = await readState(ctx, projectId, user.subject);
      const through = state?.through ?? -1;
      const marked = new Set(state?.read ?? []);
      const isRead = (sequence: number) => sequence <= through || marked.has(sequence);
      const extra = view === 'unread' ? Math.min(marked.size, TO_READ_PAGE) : 0;
      const fetched = await ctx.db
        .query('projectHostedAcceptances')
        .withIndex('by_project_and_sequence', q =>
          view === 'unread'
            ? q.eq('projectId', projectId).gt('sequence', through)
            : q.eq('projectId', projectId),
        )
        .order('desc')
        .take(TO_READ_PAGE + 1 + extra);
      const unread = view === 'unread' ? fetched.filter(row => !isRead(row.sequence)) : fetched;
      const rows = [];
      for (const row of unread.slice(0, TO_READ_PAGE)) {
        const receipt = JSON.parse(row.value) as {
          id: string;
          at: string;
          message?: string;
          actor?: { id: string; kind: string };
          automatic?: boolean;
        };
        const finish = await finishRow(ctx, { projectId, submissionId: row.submissionId });
        const intentId = finish
          ? ((JSON.parse(finish.value) as { source?: { intentId?: string } }).source?.intentId ?? null)
          : null;
        const lane = intentId
          ? await ctx.db
              .query('projectHostedRecordHeads')
              .withIndex('by_project_and_kind_and_parent', q =>
                q.eq('projectId', projectId).eq('kind', 'lane').eq('parent', intentId),
              )
              .first()
          : null;
        rows.push({
          sequence: row.sequence,
          receiptId: receipt.id,
          at: receipt.at,
          title: titleOf(receipt.message),
          actor: receipt.actor?.id ?? null,
          agent: receipt.actor?.kind === 'agent',
          automatic: receipt.automatic === true,
          laneId: lane?.key ?? null,
          read: isRead(row.sequence),
        });
      }
      return JSON.stringify({
        // A row made only by Needs me's FYI clear has marked nothing here.
        started: state !== null && (state.through >= 0 || state.read.length > 0),
        through: state?.through ?? null,
        newest: fetched[0]?.sequence ?? null,
        rows,
        // More unread than listed: the count says "or more" and links the rest.
        more: unread.length > TO_READ_PAGE || fetched.length === TO_READ_PAGE + 1 + extra,
      });
    } catch (error) {
      return report(error);
    }
  },
});

/** Mark landings read (or unread again, for Undo). `through` marks every landing up to that sequence. */
export const mark = mutation({
  args: {
    projectId: v.id('hostedProjects'),
    read: v.optional(v.array(v.number())),
    unread: v.optional(v.array(v.number())),
    through: v.optional(v.number()),
    /** Undo of "mark all": put the read line back where it was. */
    restoreThrough: v.optional(v.number()),
  },
  returns: v.string(),
  handler: async (ctx, { projectId, read = [], unread = [], through, restoreThrough }) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to mark what you have read.');
      await accessibleProject(ctx, projectId, user.subject);
      invariant(
        read.length + unread.length <= LANDING_READ_SET,
        'BAD_ARGUMENT',
        `Mark at most ${LANDING_READ_SET} landings at once, or mark all with through.`,
      );
      const state = await readState(ctx, projectId, user.subject);
      // Unread only takes back landings read one by one; Undo of "mark all" restores the earlier line instead.
      const line = restoreThrough ?? Math.max(state?.through ?? -1, through ?? -1);
      const set = new Set(state?.read ?? []);
      for (const sequence of read) set.add(sequence);
      for (const sequence of unread) set.delete(sequence);
      const kept = [...set].filter(sequence => sequence > line).sort((a, b) => a - b);
      invariant(
        kept.length <= LANDING_READ_SET,
        'BAD_ARGUMENT',
        `More than ${LANDING_READ_SET} landings are marked one by one. Mark all as read to fold them.`,
      );
      const value = { through: line, read: kept, at: Date.now() };
      if (state) await ctx.db.patch(state._id, value);
      else await ctx.db.insert('projectLandingReads', { projectId, account: user.subject, ...value });
      // The state before this mark, so Undo can put it back exactly (restoreThrough plus read).
      return JSON.stringify({
        through: line,
        read: kept.length,
        previous: { through: state?.through ?? -1, read: state?.read ?? [] },
      });
    } catch (error) {
      return report(error);
    }
  },
});
