// SPDX-License-Identifier: Apache-2.0
import { gzipSync } from 'fflate';
import { canonicalPayload } from '../src/hosted-source-operation';
import { journalTablePins, type JournalSegment } from '../src/journal-segment';
import { digest } from '../src/state/hash';
import type { QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { phaseKey, receiptRow, type Control } from './projectJournalMaintenance';

/** The capture can pin Intent archive bytes before its action uploads them, without a separate transaction. */
export function encodePlannedJournal(text: string, segment: JournalSegment) {
  const plain = new TextEncoder().encode(text);
  const body = gzipSync(plain, { level: 9, mtime: 0 });
  const pointer = {
    protocol: 1 as const,
    sha256: digest(body),
    size: body.length,
    rawSize: plain.length,
    version: segment.through,
    tables: canonicalPayload(journalTablePins(segment.tables)),
  };
  return { body, pointer };
}

export async function pendingIntentArchives(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  keys: readonly string[],
) {
  if (!keys.length) return [];
  const controls = await Promise.all(
    [false, true].map(existing =>
      receiptRow(ctx, projectId, phaseKey({ projectId, operationId: '', existing })),
    ),
  );
  const pending = controls.flatMap(row => {
    const value = row && (JSON.parse(row.envelope) as Control).pending;
    return value ? [value] : [];
  });
  const related = await Promise.all(
    pending.map(async capture => {
      if (capture.intentKeys) return capture.intentKeys.some(key => keys.includes(key));
      // A capture left by the earlier writer has no derived hint. The source headers are still live.
      const rows = await Promise.all(
        capture.refs
          .filter(ref => ref.table === 'projectHostedRecords')
          .map(ref => ctx.db.get(ref.id as Id<'projectHostedRecords'>)),
      );
      return rows.some(row => row?.kind === 'intent' && keys.includes(row.key));
    }),
  );
  return pending.flatMap((capture, i) =>
    related[i] ? [{ input: capture.input, availableAt: capture.until }] : [],
  );
}
