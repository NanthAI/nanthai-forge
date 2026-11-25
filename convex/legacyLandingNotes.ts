// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// One-off conversion (Item c0af6cfa, F8 leftover). Not part of the product: it lives in the pinned in-between
// release, runs once per deployment and is deleted with its last proof (docs/operations/legacy-item-shapes.md).
// Landing notes written before this release name no revert on the original landing, and notes archived to a
// capsule before it carry no landing time. This sets both from rows that already exist.
import { v } from 'convex/values';
import { internal } from './_generated/api';
import { internalAction, internalMutation } from './server';
import { acceptanceRow } from './projectHostedAcceptanceStore';
import { bounded, bytes, confirmed, meter, PAGE_RESERVE } from './legacyWorkMarkerRows';
import type { HostedAcceptance } from '../src/hosted-acceptance';

const NOTES_PER_PAGE = 64;
type Counts = {
  notes: number;
  revertedMissing: number;
  revertedSet: number;
  atMissing: number;
  atSet: number;
};

/** One page of landing notes (all projects, by creation order). A `reverted` note whose original `landed` note
 * has no `revertedBy` gets it set on that original; an archived note with no `at` takes its receipt's time.
 * `apply:false` only counts. Every read is capped by the page's remaining bytes. A page that runs out stops
 * with `incomplete` and is read again from its own cursor: what it already wrote is skipped on the rerun. */
export const notesPage = internalMutation({
  args: { deployment: v.string(), cursor: v.union(v.string(), v.null()), apply: v.boolean() },
  returns: v.any(),
  handler: async (ctx, { deployment, cursor, apply }) => {
    confirmed(deployment);
    const page = meter();
    const counts: Counts = { notes: 0, revertedMissing: 0, revertedSet: 0, atMissing: 0, atSet: 0 };
    const blocked: string[] = [];
    const stop = () => ({ counts, readBytes: page.used, blocked, next: cursor, incomplete: true });
    const read = await bounded(
      page,
      options => ctx.db.query('projectIntentLandingNotes').paginate(options),
      NOTES_PER_PAGE,
      cursor,
    );
    // A cut page is fine: its cursor continues after the rows it returned.
    for (const note of read.rows) {
      if (page.left <= 0) return stop();
      counts.notes++;
      if (note.kind === 'reverted' && note.revertOf) {
        const original = await bounded(
          page,
          options =>
            ctx.db
              .query('projectIntentLandingNotes')
              .withIndex('by_project_and_receipt_and_intent_and_kind', q =>
                q
                  .eq('projectId', note.projectId)
                  .eq('receiptId', note.revertOf!)
                  .eq('intentId', note.intentId)
                  .eq('kind', 'landed'),
              )
              .paginate(options),
          1,
        );
        if (!original.complete) return stop();
        const [landed] = original.rows;
        if (landed && !landed.revertedBy) {
          counts.revertedMissing++;
          if (apply) {
            await ctx.db.patch(landed._id, { revertedBy: note.receiptId });
            counts.revertedSet++;
          }
        }
      }
      if ('capsule' in note && !note.at) {
        counts.atMissing++;
        const row = await acceptanceRow(ctx, { projectId: note.projectId, receiptId: note.receiptId });
        if (row) {
          page.left -= bytes(row);
          page.used += bytes(row);
        }
        const at = row ? (JSON.parse(row.value) as HostedAcceptance).at : undefined;
        if (!at) blocked.push(`${note.projectId}:${note.receiptId}:no-receipt`);
        else if (apply) {
          await ctx.db.patch(note._id, { at });
          counts.atSet++;
        }
      }
    }
    return {
      counts,
      readBytes: page.used,
      blocked,
      next: read.result.isDone ? null : read.result.continueCursor,
      incomplete: false,
    };
  },
});

/** Drive every page within one stated read budget. A replay of an applied run prints 0 for `revertedMissing`
 * and `atMissing`. A stop says why: `budget`, `page` (one page needs more than its allowance) or `over`. */
export const notesRun = internalAction({
  args: { deployment: v.string(), apply: v.boolean(), budgetBytes: v.number() },
  returns: v.any(),
  handler: async (ctx, { deployment, apply, budgetBytes }) => {
    confirmed(deployment);
    const totals: Counts = { notes: 0, revertedMissing: 0, revertedSet: 0, atMissing: 0, atSet: 0 };
    const blocked: string[] = [];
    let readBytes = 0;
    let stopped: string | null = null;
    let cursor: string | null = null;
    do {
      if (readBytes + PAGE_RESERVE > budgetBytes) {
        stopped = 'budget';
        break;
      }
      const result: {
        counts: Counts;
        readBytes: number;
        blocked: string[];
        next: string | null;
        incomplete: boolean;
      } = await ctx.runMutation(internal.legacyLandingNotes.notesPage, { deployment, cursor, apply });
      for (const key of Object.keys(totals) as (keyof Counts)[]) totals[key] += result.counts[key];
      blocked.push(...result.blocked);
      readBytes += result.readBytes;
      if (result.incomplete) {
        stopped = 'page';
        break;
      }
      cursor = result.next;
    } while (cursor !== null);
    if (readBytes > budgetBytes) stopped = 'over';
    return { apply, readBytes, budgetBytes, counts: totals, blocked, stopped };
  },
});
