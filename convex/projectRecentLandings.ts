// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { getDocumentSize } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { lineSummary } from './projectLiveLineStore';
import { needsFix } from '../src/culprit-bisect';
import type { HostedAcceptance } from '../src/hosted-acceptance';
import {
  RECENT_LANDING_COUNT,
  recentLandingTitle,
  type RecentLandingTitle,
} from './projectRecentLandingTitles';

const BYTES = 64 * 1024;
export type RecentRevert = { original: string; receipt: string; sequence: number };

/** Record only on the existing revert-notice step. A sequence-sorted window survives re-land and
 * Item removal, including standalone Lanes. Replays and old arrivals that do not enter it write nothing. */
export async function rememberRecentRevert(
  db: MutationCtx['db'],
  projectId: Doc<'hostedProjects'>['_id'],
  revert: RecentRevert,
) {
  const old = await lineSummary(db, projectId);
  if (!old) return;
  const value = JSON.parse(old.value) as { recentReverts?: RecentRevert[] };
  const previous = value.recentReverts ?? [];
  if (previous.some(link => link.receipt === revert.receipt)) return;
  const recentReverts = [...previous, revert]
    .sort((a, b) => b.sequence - a.sequence)
    .slice(0, RECENT_LANDING_COUNT);
  if (recentReverts.includes(revert))
    await db.patch(old._id, { value: JSON.stringify({ ...value, recentReverts }) });
}

/** Same window for the home read and its one-off title repair. Stop after five rows or one byte lookahead. */
export async function recentLandingReceipts(
  db: Pick<QueryCtx['db'], 'query'>,
  projectId: Id<'hostedProjects'>,
) {
  const receipts = db
    .query('projectHostedAcceptances')
    .withIndex('by_project_and_sequence', q => q.eq('projectId', projectId))
    .order('desc');
  const rows = [];
  let bytes = 0;
  for await (const row of receipts) {
    bytes += getDocumentSize(row);
    if (rows.length && bytes > BYTES) break;
    rows.push(row);
    if (rows.length === RECENT_LANDING_COUNT) break;
  }
  return rows;
}

/** The same receipt order as Code History, without a message-body read. */
export async function recentLandings(
  ctx: QueryCtx,
  project: Doc<'hostedProjects'>,
  retained: readonly RecentRevert[] = [],
  titles: readonly RecentLandingTitle[] = [],
) {
  const fixes = needsFix(project).filter(fix => fix.state === 'reverted' && fix.revertReceiptId);
  const removed = new Set([...retained.map(revert => revert.original), ...fixes.map(fix => fix.receiptId)]);
  const reverts = new Set([
    ...retained.map(revert => revert.receipt),
    ...fixes.map(fix => fix.revertReceiptId),
  ]);
  const rows = await recentLandingReceipts(ctx.db, project._id);
  return Promise.all(
    rows.map(async row => {
      const receipt = JSON.parse(row.value) as HostedAcceptance;
      const title = titles.find(([id]) => id === row.receiptId)?.[1] ?? recentLandingTitle(receipt.message);
      // Notices also cover standalone Lanes; retained Item notes still attest a revert after the notice clears.
      const notes =
        removed.has(row.receiptId) || reverts.has(row.receiptId)
          ? []
          : await ctx.db
              .query('projectIntentLandingNotes')
              .withIndex('by_project_and_receipt_and_intent_and_kind', q =>
                q.eq('projectId', project._id).eq('receiptId', row.receiptId),
              )
              .take(5);
      const takenOut = removed.has(row.receiptId) || notes.some(note => Boolean(note.revertedBy));
      const revert = reverts.has(row.receiptId) || notes.some(note => note.kind === 'reverted');
      return {
        receiptId: row.receiptId,
        sequence: row.sequence,
        at: receipt.at,
        title,
        ...(takenOut ? { takenOut: true as const } : {}),
        ...(revert ? { revert: true as const } : {}),
      };
    }),
  );
}
