// SPDX-License-Identifier: Apache-2.0
import type { QueryCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import type { RecoveryTable } from '../src/recovery-hosted-protocol';
import { RECOVERY_PAGE_BYTES, RECOVERY_PAGE_ROWS } from '../src/recovery-hosted-protocol';
import { JOURNAL_TABLES, type JournalIndex } from '../src/journal-segment';
import { journalIndexKind, requireJournal, loadedJournalRows } from './projectJournalStore';
import { recoveryCapsuleCursor } from './projectLandingCapsuleRecovery';
import { canonicalPayload } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';
/** The same S1 cursor merge advances into journal segments after landing capsules.
 * Publication and physical removal share one transaction and increment the recovery fence. */
export async function journalRecoveryPage(
  ctx: QueryCtx,
  project: Doc<'hostedProjects'>,
  table: RecoveryTable,
  cursor: { cursor: string | null; offset?: number },
) {
  if (!JOURNAL_TABLES.includes(table as never))
    return canonicalPayload({ table, rows: [], cursor: null, done: true });
  const row = await ctx.db
    .query('projectFinishReadRows')
    .withIndex('by_kind_and_project_and_submission', q => {
      const range = q.eq('kind', journalIndexKind).eq('projectId', project._id);
      return cursor.cursor === null
        ? range
        : cursor.offset === undefined
          ? range.gt('submissionId', cursor.cursor)
          : range.gte('submissionId', cursor.cursor);
    })
    .order('asc')
    .first();
  if (!row) return canonicalPayload({ table, rows: [], cursor: null, done: true });
  const index = JSON.parse(row.value) as JournalIndex,
    offset = cursor.offset ?? 0;
  requireJournal(ctx, index);
  const all = loadedJournalRows(ctx, table as (typeof JOURNAL_TABLES)[number]);
  const selected = all.filter(row => row.projectId === project._id).map(row => canonicalPayload(row));
  invariant(offset <= selected.length, 'EVIDENCE_CHANGED', 'Journal recovery offset differs.');
  const rows: string[] = [];
  let bytes = 0;
  for (const text of selected.slice(offset, offset + RECOVERY_PAGE_ROWS)) {
    const size = new TextEncoder().encode(text).length;
    if (rows.length && bytes + size > RECOVERY_PAGE_BYTES) break;
    rows.push(text);
    bytes += size;
  }
  const next = offset + rows.length;
  return canonicalPayload({
    table,
    rows,
    done: false,
    cursor: recoveryCapsuleCursor({
      table,
      phase: 'journal',
      cursor: row.submissionId!,
      ...(next < selected.length ? { offset: next } : {}),
    }),
  });
}
