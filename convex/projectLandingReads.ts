// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// History (Item c613e6bc, replacing To read 9e748e41 and Landed today): what landed, newest first, with this
// account's read marks, and the one write that marks landings read. Read state is per account, so a browser, a phone
// and the CLI agree. Nothing here holds a landing or counts toward Needs you.
//
// list, one page of HISTORY_PAGE rows: 1 read-state row + one indexed range of receipts below the `before` cursor
// (at most HISTORY_PAGE + 1, plus the few read one by one in the unread view; at most HISTORY_SCAN when filtered,
// since receipts have no actor or Item index) + 3 indexed rows per listed landing (its finish, Lane head and Item
// head; up to 3 more for the Intent's goal when it is not an Item's first) and, with the Item filter, 1 finish row per
// scanned receipt. History evidence uses the request and exact landing note instead of the finish and Lane
// head where retained. Missing links fall back to the older reads, inside the same page limits. The query
// re-runs on changes to the records it reads, never on a clock. mark: 1 read + 1 write, idempotent.
import { v } from 'convex/values';
import { mutation, query } from './cliServer';
import { accessibleProject, requireDeviceWrite } from './projectAuthority';
import { hasWriteRole, projectRole } from './projectRole';
import { landingRow } from './projectHostedLandingStore';
import { landedTimingOf } from './projectLaneTiming';
import type { HostedAcceptance } from '../src/hosted-acceptance';
import type { HostedLandingState } from '../src/hosted-landing';
import { finishRow } from './projectHostedFinishWake';
import { hostedRecordBody, recordHead } from './projectHostedRecords';
import { LANDING_READ_SET } from './projectLandingReadFields';
import { report } from './errors';
import { invariant } from '../src/errors';
import { readAuthorship } from '../src/work-actor-types';
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { landingMessageText } from './projectHostedLandingMessageBody';

export const HISTORY_PAGE = 30;
/** Receipts one filtered page looks through at most (a receipt is about 2 to 6 KB); `next` resumes below them. */
export const HISTORY_SCAN = 120;
/** The landing message shown on expand is cut at this many characters. */
export const HISTORY_MESSAGE_CHARS = 600;

async function readState(ctx: QueryCtx | MutationCtx, projectId: Id<'hostedProjects'>, account: string) {
  return ctx.db
    .query('projectLandingReads')
    .withIndex('by_project_and_account', q => q.eq('projectId', projectId).eq('account', account))
    .unique();
}

type Receipt = {
  id: string;
  at: string;
  message?: string;
  messageRef?: string;
  actor?: { id: string; kind: 'agent' | 'person' };
  automatic?: boolean;
  agentRun?: string;
  agentClient?: string;
  authorship?: { kind: 'agent' | 'person'; declaration?: 'unknown' | 'not-declared'; actor?: string };
};

const firstLine = (message: string) =>
  message
    .split('\n')
    .find(line => line.trim())
    ?.trim() ?? null;

/** Who a receipt names: the builder's account, and the agent run when an agent built it. */
function whoOf(receipt: Receipt) {
  const builder = readAuthorship(receipt);
  const agent = builder.kind === 'agent';
  return {
    actor: builder.actor ?? null,
    agent,
    agentRun: agent ? (receipt.agentRun ?? null) : null,
    // The model the run declared; 'not-declared' or 'unknown' when it did not; null for a person.
    model: agent ? builder.model : null,
  };
}

/** `by` is `handle` (a person and the agents acting for them) or `handle/run` (one agent run). */
function byMatches(by: string, who: ReturnType<typeof whoOf>) {
  const slash = by.indexOf('/');
  if (slash < 0) return who.actor === by;
  return who.actor === by.slice(0, slash) && who.agentRun === by.slice(slash + 1);
}

const legacyIntentOf = async (
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  row: Doc<'projectHostedAcceptances'>,
) => {
  const finish = await finishRow(ctx, { projectId, submissionId: row.submissionId });
  return finish
    ? ((JSON.parse(finish.value) as { source?: { intentId?: string } }).source?.intentId ?? null)
    : null;
};

/** The Item a landing's Intent belongs to, when the Intent is an Item's first: one head, its value inline. */
async function itemOf(ctx: QueryCtx, projectId: Id<'hostedProjects'>, intentId: string | null) {
  if (!intentId) return null;
  const head = await recordHead(ctx, projectId, 'issue', intentId);
  if (!head?.value) return null;
  const item = JSON.parse(head.value) as { title?: unknown };
  return typeof item.title === 'string' ? { id: intentId, title: item.title } : null;
}

/** The goal an Intent was started with: an Item's title when started from one. Read only for a landing whose Intent
 * is not an Item's first (a follow-up of a reopened Item, or unplanned work): head, record and, unless inline, body. */
async function goalOf(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  intentId: string | null,
  selected?: Doc<'projectHostedRecordHeads'> | null,
) {
  if (!intentId) return null;
  const head = selected === undefined ? await recordHead(ctx, projectId, 'intent', intentId) : selected;
  const record = head ? await ctx.db.get(head.recordId) : null;
  if (!record) return null;
  try {
    const outcome = (JSON.parse(await hostedRecordBody(ctx, record)) as { outcome?: unknown }).outcome;
    return typeof outcome === 'string' ? outcome : null;
  } catch {
    // A record whose bytes cannot be proven leaves the landing's own first line as its title.
    return null;
  }
}

/** `recent` (History): the newest landings whatever their read state, each with `read`. `unread`: only those this
 * account has not read. `before` pages below a landing sequence; `by`, `item` and `kind` filter (see HISTORY_SCAN). */
export const list = query({
  args: {
    projectId: v.id('hostedProjects'),
    view: v.optional(v.union(v.literal('unread'), v.literal('recent'))),
    before: v.optional(v.number()),
    by: v.optional(v.string()),
    item: v.optional(v.string()),
    /** Only landings built by an agent run, or only those a person built (df06081d). */
    kind: v.optional(v.union(v.literal('agent'), v.literal('person'))),
    /** History needs receipt evidence; the lighter FYI read does not. */
    evidence: v.optional(v.boolean()),
  },
  returns: v.string(),
  handler: async (ctx, { projectId, view = 'unread', before, by, item, kind, evidence }) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read what landed.');
      invariant(
        (by === undefined || (by.length > 0 && by.length <= 200)) &&
          (item === undefined || (item.length > 0 && item.length <= 64)),
        'BAD_ARGUMENT',
        'by: a handle or handle/run; item: an Item id.',
      );
      const project = await accessibleProject(ctx, projectId, user.subject);
      const canRevert =
        evidence &&
        project.sourceAuthority?.mode === 'server' &&
        (await hasWriteRole(ctx, project, user.subject));
      const state = await readState(ctx, projectId, user.subject);
      const through = state?.through ?? -1;
      const marked = new Set(state?.read ?? []);
      const isRead = (sequence: number) => sequence <= through || marked.has(sequence);
      const filtered = Boolean(by || item || kind);
      const extra = view === 'unread' ? Math.min(marked.size, HISTORY_PAGE) : 0;
      const budget = filtered ? HISTORY_SCAN : HISTORY_PAGE + 1 + extra;
      const fetched = await ctx.db
        .query('projectHostedAcceptances')
        .withIndex('by_project_and_sequence', q => {
          const project = q.eq('projectId', projectId);
          const low = view === 'unread' ? project.gt('sequence', through) : project;
          return before === undefined ? low : low.lt('sequence', before);
        })
        .order('desc')
        .take(budget);
      const intentHeads = new Map<string, Doc<'projectHostedRecordHeads'> | null>();
      const rows = [];
      let last: number | null = null;
      for (const row of fetched) {
        if (rows.length === HISTORY_PAGE) break;
        last = row.sequence;
        if (view === 'unread' && isRead(row.sequence)) continue;
        const receipt = JSON.parse(row.value) as Receipt &
          Pick<HostedAcceptance, 'check' | 'checked' | 'undo'>;
        const who = whoOf(receipt);
        if (by && !byMatches(by, who)) continue;
        if (kind && (who.agent ? 'agent' : 'person') !== kind) continue;
        // Reuse the request row in place of the finish row for modern History: it carries both the
        // Intent link and recorded submission timing. Retained legacy records can still link via finish.
        const request = evidence ? await landingRow(ctx, row, false) : null;
        const intentId =
          request?.intentId ?? request?.heldIntent ?? (await legacyIntentOf(ctx, projectId, row));
        let selected: Doc<'projectHostedRecordHeads'> | null | undefined;
        if (item) {
          if (!intentId) continue;
          if (!intentHeads.has(intentId))
            intentHeads.set(intentId, await recordHead(ctx, projectId, 'intent', intentId));
          selected = intentHeads.get(intentId);
          if (selected?.planningItemId !== item) continue;
        }
        const note =
          intentId && evidence
            ? await ctx.db
                .query('projectIntentLandingNotes')
                .withIndex('by_project_and_receipt_and_intent_and_kind', q =>
                  q
                    .eq('projectId', projectId)
                    .eq('receiptId', row.receiptId)
                    .eq('intentId', intentId)
                    .eq('kind', 'landed'),
                )
                .unique()
            : null;
        const lane =
          intentId && !note?.laneIds.length
            ? await ctx.db
                .query('projectHostedRecordHeads')
                .withIndex('by_project_and_kind_and_parent', q =>
                  q.eq('projectId', projectId).eq('kind', 'lane').eq('parent', intentId),
                )
                .first()
            : null;
        const exactUndo =
          receipt.automatic === true &&
          receipt.undo?.kind === 'revert' &&
          receipt.undo.receiptId === row.receiptId;
        // The compensation itself proves undo even when the original Intent has no Item.
        // One indexed probe per displayed exact-undo target, never a scan of failed or pending reverses.
        const reverted =
          Boolean(note?.revertedBy) ||
          (evidence &&
            exactUndo &&
            Boolean(
              await ctx.db
                .query('projectHostedLandingRequests')
                .withIndex('by_project_and_revert_and_phase', q =>
                  q.eq('projectId', projectId).eq('revertOf', row.receiptId).eq('phase', 'landed'),
                )
                .first(),
            ));
        const message = ((await landingMessageText(ctx, projectId, receipt)) ?? '').trim();
        const displayItem = await itemOf(ctx, projectId, intentId);
        rows.push({
          sequence: row.sequence,
          receiptId: receipt.id,
          at: receipt.at,
          title: firstLine(message),
          message: message ? message.slice(0, HISTORY_MESSAGE_CHARS) : null,
          item: displayItem,
          goal: displayItem ? null : await goalOf(ctx, projectId, intentId, selected),
          ...who,
          automatic: receipt.automatic === true,
          laneId: note?.laneIds[0] ?? lane?.key ?? null,
          read: isRead(row.sequence),
          ...(evidence
            ? {
                check: receipt.check
                  ? 'passed'
                  : receipt.check === null || receipt.checked === false
                    ? 'unchecked'
                    : null,
                toMain:
                  landedTimingOf(
                    receipt as HostedAcceptance,
                    request ? (JSON.parse(request.value) as HostedLandingState) : null,
                  )?.toMain ?? null,
                canRevert: Boolean(canRevert && exactUndo && !reverted),
                reverted,
              }
            : {}),
        });
      }
      // Nothing is left when the range ended inside its budget and every row of it was looked at.
      const exhausted = fetched.length < budget && last === (fetched.at(-1)?.sequence ?? null);
      return JSON.stringify({
        // A row made only by Needs me's FYI clear has marked nothing here.
        started: state !== null && (state.through >= 0 || state.read.length > 0),
        through: state?.through ?? null,
        // The newest landing in this range: Mark all as read marks through it.
        newest: before === undefined ? (fetched[0]?.sequence ?? null) : null,
        rows,
        /** Pass as `before` for the next page; null when nothing is left. */
        next: exhausted ? null : last,
        /** How far back a filtered page looked (receipts read), so the screen can say so when it found few. */
        scanned: fetched.length,
      });
    } catch (error) {
      return report(error);
    }
  },
});

/** Mark landings read (or unread again, for Undo). `through` marks every landing up to that sequence. */
/** Per-account read state is a write for explicit project participants, including read members. */
export async function requireLandingReadWrite(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  actor: string,
) {
  await requireDeviceWrite(ctx, projectId);
  const project = await accessibleProject(ctx, projectId, actor);
  invariant(
    project.visibility !== 'public' || (await projectRole(ctx, project, actor)),
    'PROJECT_UNAVAILABLE',
    'Project membership is required to update read state.',
  );
}

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
      await requireLandingReadWrite(ctx, projectId, user.subject);
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
