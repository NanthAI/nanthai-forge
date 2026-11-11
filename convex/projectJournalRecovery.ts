// SPDX-License-Identifier: Apache-2.0
import { journalOperationRecoveryRow } from './projectJournalOperationRecovery';
import type { QueryCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import type { RecoveryTable } from '../src/recovery-hosted-protocol';
import { RECOVERY_PAGE_BYTES, RECOVERY_PAGE_ROWS } from '../src/recovery-hosted-protocol';
import { JOURNAL_TABLES, type JournalIndex } from '../src/journal-segment';
import { requireJournal } from './projectJournalStore';
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
    .query('projectJournalSegments')
    .withIndex('by_project_and_key', q => {
      const range = q.eq('projectId', project._id);
      return cursor.cursor === null
        ? range
        : cursor.offset === undefined
          ? range.gt('key', cursor.cursor)
          : range.gte('key', cursor.cursor);
    })
    .order('asc')
    .first();
  if (!row) return canonicalPayload({ table, rows: [], cursor: null, done: true });
  if (row.category === 'fragment')
    return canonicalPayload({
      table,
      rows: [],
      done: false,
      cursor: recoveryCapsuleCursor({ table, phase: 'journal', cursor: row.key }),
    });
  const index = JSON.parse(row.value) as JournalIndex,
    offset = cursor.offset ?? 0;
  const segment = requireJournal(ctx, index);
  const selected = segment.tables[table as (typeof JOURNAL_TABLES)[number]] ?? [];
  invariant(offset <= selected.length, 'EVIDENCE_CHANGED', 'Journal recovery offset differs.');
  const rows: string[] = [];
  let bytes = 0,
    consumed = 0;
  for (const original of selected.slice(offset, offset + RECOVERY_PAGE_ROWS)) {
    const text =
      table === 'projectHostedOperations'
        ? await journalOperationRecoveryRow(ctx, project._id, original)
        : original;
    if (text === null) {
      consumed++;
      continue;
    }
    const size = new TextEncoder().encode(text).length;
    if (rows.length && bytes + size > RECOVERY_PAGE_BYTES) break;
    consumed++;
    rows.push(text);
    bytes += size;
  }
  const next = offset + consumed;
  return canonicalPayload({
    table,
    rows,
    done: false,
    cursor: recoveryCapsuleCursor({
      table,
      phase: 'journal',
      cursor: row.key,
      ...(next < selected.length ? { offset: next } : {}),
    }),
  });
}
