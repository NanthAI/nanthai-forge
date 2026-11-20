// SPDX-License-Identifier: Apache-2.0
// One-time privacy scrub (Item 76be0714, SI-04). Holder-change feed entries written before the kind-only rule named the
// earlier holder and the successor and carried the free-text reason, and the feed is readable by readers and, on a
// public project, by any signed-in account. This rewrites each such live entry's action to kind + Lane version and
// changes nothing else. Run `dryRun` first, then `apply`; delete this module once a dry run counts none.
import { v } from 'convex/values';
import type { Doc } from './_generated/dataModel';
import type { QueryCtx } from './_generated/server';
import { internal } from './_generated/api';
import { internalMutation, internalQuery } from './server';
import { hostedOperationRow } from './projectHostedOperations';
import { journalEnabled } from './projectJournalMaintenance';

/** Feed rows read per step; each step is one transaction. */
export const SCRUB_PAGE = 200;
/** While the journal writer runs, rows this old may be in a segment being captured (from 14 days): left alone and
 * counted, since a live edit would no longer match the bytes the journal keeps. With it off nothing is captured. */
const JOURNAL_SAFE_MS = 13 * 86_400_000;
/** Every form the current writer or this scrub writes: kind, then the Lane version when known. */
const CURRENT = /^holder (resume|takeover|take-back|handoff offered|handoff|change)(: v\d+)?$/;
const KIND = /^holder (handoff offered|resume|takeover|take-back|handoff): /;

/** The kind + Lane version form of an old holder action, or null when the action is not an old holder entry. The old
 * form was `holder KIND: FROM → TO (vN)[ · REASON]`; an old offer had no version (`offered` names it from its receipt,
 * else the entry keeps its kind alone). */
export function scrubbedAction(action: string, offeredVersion: number | null): string | null {
  if (!action.startsWith('holder ') || CURRENT.test(action)) return null;
  const kind = KIND.exec(action)?.[1];
  if (!kind) return 'holder change';
  if (kind === 'handoff offered')
    return offeredVersion === null ? 'holder handoff offered' : `holder handoff offered: v${offeredVersion}`;
  const version = / \(v(\d+)\)(?: · |$)/.exec(action.slice(kind.length + 9))?.[1];
  return version ? `holder ${kind}: v${version}` : `holder ${kind}`;
}

/** The Lane version an old offer's receipt recorded, when the receipt is still kept. */
async function offeredVersion(ctx: QueryCtx, event: Doc<'projectCoordinationEvents'>) {
  const row = await hostedOperationRow(ctx, event.projectId, event.actor, event.operationId);
  try {
    const version = (
      JSON.parse(row?.value ?? 'null') as {
        terminal?: { outcome?: { result?: { lane?: { version?: unknown } } } };
      } | null
    )?.terminal?.outcome?.result?.lane?.version;
    return typeof version === 'number' ? version : null;
  } catch {
    return null;
  }
}

async function step(ctx: QueryCtx, cursor: string | null) {
  const page = await ctx.db
    .query('projectCoordinationEvents')
    .withIndex('by_creation_time', q => q)
    .paginate({ cursor, numItems: SCRUB_PAGE, maximumRowsRead: SCRUB_PAGE });
  const edits: {
    id: Doc<'projectCoordinationEvents'>['_id'];
    command: Doc<'projectCoordinationEvents'>['command'];
  }[] = [];
  let journalBound = 0,
    withoutVersion = 0,
    oldest: number | null = null;
  for (const event of page.page) {
    const command = event.command as { kind?: string; action?: string };
    if (command.kind !== 'change' || typeof command.action !== 'string') continue;
    if (!command.action.startsWith('holder ') || CURRENT.test(command.action)) continue;
    oldest = Math.min(oldest ?? event.at, event.at);
    if (journalEnabled() && event.at < Date.now() - JOURNAL_SAFE_MS) {
      journalBound++;
      continue;
    }
    const offered = command.action.startsWith('holder handoff offered: ')
      ? await offeredVersion(ctx, event)
      : null;
    const action = scrubbedAction(command.action, offered)!;
    if (!/: v\d+$/.test(action)) withoutVersion++;
    edits.push({ id: event._id, command: { ...event.command, action } as typeof event.command });
  }
  return { page, edits, journalBound, withoutVersion, oldest };
}

/** Counts one page; the caller passes `cursor` back until `isDone`. Reads only, writes nothing. */
export const dryRun = internalQuery({
  args: { cursor: v.union(v.string(), v.null()) },
  returns: v.object({
    scanned: v.number(),
    toScrub: v.number(),
    withoutVersion: v.number(),
    journalBound: v.number(),
    oldestAt: v.union(v.number(), v.null()),
    cursor: v.string(),
    isDone: v.boolean(),
  }),
  handler: async (ctx, { cursor }) => {
    const { page, edits, journalBound, withoutVersion, oldest } = await step(ctx, cursor);
    return {
      scanned: page.page.length,
      toScrub: edits.length,
      withoutVersion,
      journalBound,
      oldestAt: oldest,
      cursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});

/** Rewrites one page's old holder actions and schedules the next page until done; `touched` carries the running total,
 * which the last step returns and logs. Safe to re-run: a rewritten entry no longer matches. */
export const apply = internalMutation({
  args: { cursor: v.union(v.string(), v.null()), touched: v.optional(v.number()) },
  returns: v.object({ touched: v.number(), isDone: v.boolean() }),
  handler: async (ctx, { cursor, touched = 0 }) => {
    const { page, edits } = await step(ctx, cursor);
    for (const edit of edits) await ctx.db.patch(edit.id, { command: edit.command });
    const total = touched + edits.length;
    if (!page.isDone)
      await ctx.scheduler.runAfter(0, internal.holderFeedScrub.apply, {
        cursor: page.continueCursor,
        touched: total,
      });
    else console.log(`holder feed scrub: ${total} entries rewritten`);
    return { touched: total, isDone: page.isDone };
  },
});
