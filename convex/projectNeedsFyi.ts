// SPDX-License-Identifier: Apache-2.0
// Needs me › FYI (Item 48049998, decision b15fff49): what the reader may want to know but need not act on, newest
// first, from one bounded subscription, plus the one write that dismisses rows or clears the list. The held Lanes
// that wait on no person (an agent's conflict, a refusal, a withdrawn landing) come from projectNeedsMe:read, which
// the page already holds; this read adds what is not state on the line:
//   - landings, newest FYI_LANDINGS above the clear line (the receipt, plus two small rows for its Lane, plus the
//     landing row only when it was checked again, for the CI time thrown away);
//   - main breaking (main-audit red verdicts and the culprit named after one, newest FYI_EVENTS);
//   - settings and access changes, for the owner only (newest FYI_EVENTS policy edits and invitations, no address);
//   - coordination messages addressed to the reader that ask nothing (one receipt and one presence row each, so an
//     acknowledged message, or one whose Lane landed or was abandoned, drops out). A message with choices waits on
//     the reader and goes to Needs you instead (projectNeedsMe:read via `messagesTo`).
// Dismissals and the clear line live on the reader's existing read-state row (projectLandingReads, one per account
// and project), written only on a click and never on view or by a landing. Nothing here takes a clock argument; the
// page windows rows by the clear line or the start of today itself, so idle and hidden tabs cost nothing.
import { v } from 'convex/values';
import { mutation, query } from './cliServer';
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { accessibleProject } from './projectAuthority';
import { finishRow } from './projectHostedFinishWake';
import { culpritOf } from './projectMainRed';
import { landingRow } from './projectHostedLandingStore';
import { session } from './coordinationWrite';
import { storedLandingStateSchema } from '../src/hosted-landing';
import { discardedRunnerSeconds } from '../src/cost-budgets';
import { report } from './errors';
import { invariant } from '../src/errors';
import { landingMessageText } from './projectHostedLandingMessageBody';

export const FYI_LANDINGS = 12;
export const FYI_EVENTS = 6;
export const FYI_MESSAGES = 12;
/** Dismissed row versions kept per reader and project; the oldest fall off (their rows are long gone by then). */
export const FYI_DISMISSED = 200;
/** One dismiss call names at most this many rows; more is "Clear all". */
export const FYI_DISMISS_BATCH = 50;
const TEXT = 280;
const KEY = /^[a-z]{2,12}:[A-Za-z0-9._:-]{1,100}@[A-Za-z0-9._:-]{1,40}$/;

type Ctx = QueryCtx | MutationCtx;
export type FyiState = { clearedAt: number | null; clearedSequence: number | null; dismissed: string[] };

async function stateRow(ctx: Ctx, projectId: Id<'hostedProjects'>, account: string) {
  return ctx.db
    .query('projectLandingReads')
    .withIndex('by_project_and_account', q => q.eq('projectId', projectId).eq('account', account))
    .unique();
}
const stateOf = (row: Doc<'projectLandingReads'> | null): FyiState => ({
  clearedAt: row?.fyi?.clearedAt ?? null,
  clearedSequence: row?.fyi?.clearedSequence ?? null,
  dismissed: row?.fyi?.dismissed ?? [],
});
const oneLine = (text: unknown) =>
  typeof text === 'string'
    ? (text
        .split('\n')
        .find(line => line.trim())
        ?.replace(/\s+/g, ' ')
        .trim()
        .slice(0, TEXT) ?? null)
    : null;

/** Messages addressed to this account that it has not acknowledged and whose Lane is still open, newest first.
 * `asks` picks the ones with choices (they wait on the reader) or the ones without (FYI). One index range of at most
 * FYI_MESSAGES rows, then one receipt, one presence and one session point read per row. */
export async function messagesTo(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  actor: string,
  asks: boolean,
) {
  const rows = await ctx.db
    .query('projectCoordinationEvents')
    .withIndex('by_project_and_kind_and_recipientActor', q =>
      q.eq('projectId', projectId).eq('kind', 'message').eq('recipientActor', actor),
    )
    .order('desc')
    .take(FYI_MESSAGES);
  const out = [];
  for (const row of rows) {
    if (row.command.kind !== 'message' || row.actor === actor) continue;
    if (Boolean(row.command.choices?.length) !== asks) continue;
    const acked = await ctx.db
      .query('projectCoordinationReceipts')
      .withIndex('by_project_and_message_and_actor', q =>
        q.eq('projectId', projectId).eq('messageId', row.operationId).eq('actor', actor),
      )
      .unique();
    if (acked) continue;
    const laneId = row.laneId ?? row.command.context.laneId;
    // A Lane's presence row is deleted when it closes: the message ends with its Lane (landed or abandoned).
    if (laneId) {
      const open = await ctx.db
        .query('projectHostedPresence')
        .withIndex('by_project_and_lane', q => q.eq('projectId', projectId).eq('laneId', laneId))
        .unique();
      if (!open) continue;
    }
    const sender = row.command.sessionId ? await session(ctx, projectId, row.command.sessionId) : null;
    out.push({
      id: row.operationId,
      at: row.at,
      actor: row.actor,
      agent: sender && sender.kind !== 'person' ? sender.name : null,
      text: oneLine(row.command.text) ?? '',
      choices: row.command.choices ?? [],
      laneId: laneId ?? null,
    });
  }
  return { rows: out, more: rows.length === FYI_MESSAGES };
}

/** The policy's top-level areas an edit changed, in the reader's words (the full before/after is in Settings). */
function changedAreas(row: Doc<'projectPolicyChanges'>) {
  const before = row.previous as Record<string, unknown>;
  const after = row.policy as Record<string, unknown>;
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter(key => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
    .sort();
}

export const read = query({
  args: { projectId: v.id('hostedProjects') },
  returns: v.string(),
  handler: async (ctx, { projectId }) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read what happened.');
      const project = await accessibleProject(ctx, projectId, user.subject);
      const owner = project.owner === user.subject;
      const state = stateOf(await stateRow(ctx, projectId, user.subject));
      const since = state.clearedSequence ?? -1;
      const [accepted, audits, messages] = await Promise.all([
        ctx.db
          .query('projectHostedAcceptances')
          .withIndex('by_project_and_sequence', q => q.eq('projectId', projectId).gt('sequence', since))
          .order('desc')
          .take(FYI_LANDINGS + 1),
        ctx.db
          .query('projectHostedMainAuditEvents')
          .withIndex('by_project_and_sequence', q => q.eq('projectId', projectId))
          .order('desc')
          .take(FYI_EVENTS),
        messagesTo(ctx, projectId, user.subject, false),
      ]);
      const landings = [];
      for (const row of accepted.slice(0, FYI_LANDINGS)) {
        const receipt = JSON.parse(row.value) as {
          id: string;
          at: string;
          message?: string;
          messageRef?: string;
          actor?: { id: string; kind: string };
          automatic?: boolean;
          check?: unknown;
          firstCheck?: { landedOn: string; reason?: string };
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
        // Checked again after main moved: the earlier check's runner time was thrown away. Read only then.
        const redone = receipt.firstCheck?.landedOn === 'recheck';
        let thrown: number | null = 0;
        if (redone) {
          const landing = await landingRow(ctx, { projectId, submissionId: row.submissionId });
          const parsed = landing ? storedLandingStateSchema.safeParse(JSON.parse(landing.value)) : null;
          thrown = parsed?.success ? discardedRunnerSeconds(parsed.data) : null;
        }
        landings.push({
          receiptId: receipt.id,
          sequence: row.sequence,
          at: Date.parse(receipt.at),
          title: oneLine(await landingMessageText(ctx, projectId, receipt)),
          actor: receipt.actor?.id ?? null,
          agent: receipt.actor?.kind === 'agent',
          checked: receipt.check !== null && receipt.check !== undefined,
          redone,
          redoneWhy: redone ? (receipt.firstCheck?.reason ?? null) : null,
          thrown,
          laneId: lane?.key ?? null,
        });
      }
      // The culprit the bisect named after a red is its own event in the same page (convex/projectMainRed.ts reads
      // the whole episode on open); named here from the rows in hand, never with another read. A culprit event sorts
      // below its red, so a red at the edge of this page can show here without the culprit its view names.
      const broke = audits
        .filter(row => row.kind === 'red')
        .map(row => ({
          sequence: row.sequence,
          at: Date.parse(row.at),
          head: row.head.slice(0, 12),
          culprit: culpritOf(row, audits),
          drill: Boolean(row.drill),
        }));
      // Settings and access are the owner's: other readers never see who was invited or what changed.
      const [policies, invites] = owner
        ? await Promise.all([
            ctx.db
              .query('projectPolicyChanges')
              .withIndex('by_project', q => q.eq('projectId', projectId))
              .order('desc')
              .take(FYI_EVENTS),
            ctx.db
              .query('projectInvites')
              .withIndex('by_project', q => q.eq('projectId', projectId))
              .order('desc')
              .take(FYI_EVENTS),
          ])
        : [[], []];
      const settings = policies.flatMap(row => {
        const areas = changedAreas(row);
        return areas.length
          ? [{ id: row.operationId, at: Date.parse(row.at), actor: row.actor, areas, rule: row.rule ?? null }]
          : [];
      });
      const access = invites.map(row => ({
        id: row._id as string,
        at: row._creationTime,
        role: row.role ?? 'write',
        // A handle invitation names its handle; an email invitation never shows the address.
        handle: row.kind === 'handle' ? (row.recipient ?? null) : null,
        state: row.state ?? null,
        inviter: row.inviter ?? null,
      }));
      return JSON.stringify({
        owner,
        state,
        landings,
        landingsMore: accepted.length > FYI_LANDINGS,
        broke,
        settings,
        access,
        messages: messages.rows,
        messagesMore: messages.more,
      });
    } catch (error) {
      return report(error);
    }
  },
});

/**
 * Dismiss rows (by `kind:id@version`, so a newer version shows again), clear the whole list (a clear line in time
 * and in landing sequence), or put an earlier state back (Undo). One read and one write; repeating is a no-op.
 * Never touches anything that holds work: approvals are not FYI rows and have no key here.
 */
export const dismiss = mutation({
  args: {
    projectId: v.id('hostedProjects'),
    keys: v.optional(v.array(v.string())),
    clearAll: v.optional(v.boolean()),
    restore: v.optional(
      v.object({
        clearedAt: v.union(v.number(), v.null()),
        clearedSequence: v.union(v.number(), v.null()),
        dismissed: v.array(v.string()),
      }),
    ),
  },
  returns: v.string(),
  handler: async (ctx, { projectId, keys = [], clearAll, restore }) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to clear what you have seen.');
      await accessibleProject(ctx, projectId, user.subject);
      invariant(
        keys.length <= FYI_DISMISS_BATCH && keys.every(key => KEY.test(key)),
        'BAD_ARGUMENT',
        `Dismiss at most ${FYI_DISMISS_BATCH} rows by their kind:id@version keys, or clear all.`,
      );
      invariant(
        !restore ||
          (restore.dismissed.length <= FYI_DISMISSED && restore.dismissed.every(key => KEY.test(key))),
        'BAD_ARGUMENT',
        'Restore only a state this mutation returned.',
      );
      const row = await stateRow(ctx, projectId, user.subject);
      const before = stateOf(row);
      let next: FyiState;
      if (restore) next = restore;
      else if (clearAll) {
        const newest = await ctx.db
          .query('projectHostedAcceptances')
          .withIndex('by_project_and_sequence', q => q.eq('projectId', projectId))
          .order('desc')
          .first();
        next = {
          clearedAt: Date.now(),
          clearedSequence: newest?.sequence ?? before.clearedSequence,
          dismissed: [],
        };
      } else {
        const set = [...before.dismissed.filter(key => !keys.includes(key)), ...keys];
        next = { ...before, dismissed: set.slice(-FYI_DISMISSED) };
      }
      const fyi = {
        ...(next.clearedAt === null ? {} : { clearedAt: next.clearedAt }),
        ...(next.clearedSequence === null ? {} : { clearedSequence: next.clearedSequence }),
        dismissed: next.dismissed,
      };
      if (JSON.stringify(stateOf(row)) === JSON.stringify(stateOf({ fyi } as Doc<'projectLandingReads'>)))
        return JSON.stringify({ before, changed: false });
      if (row) await ctx.db.patch(row._id, { fyi });
      // A new row reads as "nothing marked" for To read (through -1, no reads); `fyi` is the only state set.
      else
        await ctx.db.insert('projectLandingReads', {
          projectId,
          account: user.subject,
          through: -1,
          read: [],
          at: Date.now(),
          fyi,
        });
      return JSON.stringify({ before, changed: true });
    } catch (error) {
      return report(error);
    }
  },
});
