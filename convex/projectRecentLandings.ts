// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { getDocumentSize } from 'convex/values';
import type { Doc } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { lineSummary } from './projectLiveLineStore';
import { CODE_HISTORY_TITLE_CHARS } from '../src/code-history';
import { needsFix } from '../src/culprit-bisect';
import type { HostedAcceptance } from '../src/hosted-acceptance';

const RECENT = 5;
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
  const recentReverts = [...previous, revert].sort((a, b) => b.sequence - a.sequence).slice(0, RECENT);
  if (recentReverts.includes(revert))
    await db.patch(old._id, { value: JSON.stringify({ ...value, recentReverts }) });
}

/** The same receipt order as Code History, without message bodies, source or check logs. The iterator
 * shares the line query (which can already use its one paginate). Stop after five rows or one byte lookahead. */
export async function recentLandings(
  ctx: QueryCtx,
  project: Doc<'hostedProjects'>,
  retained: readonly RecentRevert[] = [],
) {
  const receipts = ctx.db
    .query('projectHostedAcceptances')
    .withIndex('by_project_and_sequence', q => q.eq('projectId', project._id))
    .order('desc');
  const fixes = needsFix(project).filter(fix => fix.state === 'reverted' && fix.revertReceiptId);
  const removed = new Set([...retained.map(revert => revert.original), ...fixes.map(fix => fix.receiptId)]);
  const reverts = new Set([
    ...retained.map(revert => revert.receipt),
    ...fixes.map(fix => fix.revertReceiptId),
  ]);
  const rows = [];
  let bytes = 0;
  for await (const row of receipts) {
    bytes += getDocumentSize(row);
    if (rows.length && bytes > BYTES) break;
    const receipt = JSON.parse(row.value) as HostedAcceptance;
    const title = receipt.message?.trim().split('\n', 1)[0]?.trim().slice(0, CODE_HISTORY_TITLE_CHARS);
    rows.push({ receiptId: row.receiptId, sequence: row.sequence, at: receipt.at, title: title || null });
    if (rows.length === RECENT) break;
  }
  return Promise.all(
    rows.map(async row => {
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
        ...row,
        ...(takenOut ? { takenOut: true as const } : {}),
        ...(revert ? { revert: true as const } : {}),
      };
    }),
  );
}
