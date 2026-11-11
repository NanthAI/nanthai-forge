// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { canonicalPayload } from './hosted-source-operation.js';
import { digest } from './state/hash.js';
import type { LandingCapsulePointer } from './hosted-landing.js';
import { invariant } from './errors.js';

export const JOURNAL_TABLES = [
  'projectHostedRecords',
  'projectHostedRecordBodies',
  'projectHostedOperations',
  'projectHostedSavePages',
  'projectCoordinationEvents',
] as const;
export const JOURNAL_PAGE_ROWS = 100;
export const JOURNAL_PAGE_BYTES = 500 * 1024;
const position = z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const journalSegmentSchema = z
  .object({
    protocol: z.literal(1),
    kind: z.literal('forge-journal-segment'),
    projectId: z.string(),
    scope: z.string(),
    from: position,
    through: position,
    startKey: z.string().optional(),
    endKey: z.string().optional(),
    tables: z.partialRecord(z.enum(JOURNAL_TABLES), z.array(z.string())),
  })
  .strict();
export type JournalSegment = z.infer<typeof journalSegmentSchema>;
export type JournalRecordPin = [
  number,
  string,
  number,
  string,
  string,
  string,
  string,
  number,
  string | null,
  [string, number, number]?,
  boolean?,
];
export type JournalIndex = Pick<JournalSegment, 'scope' | 'from' | 'through' | 'startKey' | 'endKey'> & {
  keys?: string[];
  pointer: LandingCapsulePointer;
  records?: JournalRecordPin[];
  savePages?: [number, string][];
  parts?: LandingCapsulePointer[];
};
export function journalTablePins(tables: JournalSegment['tables']) {
  return JOURNAL_TABLES.flatMap((table, ordinal) => {
    const rows = tables[table] ?? [];
    return rows.length
      ? [
          [
            ordinal,
            rows.length,
            rows.reduce((n, text) => n + new TextEncoder().encode(text).length, 0),
            digest(canonicalPayload(rows)),
          ],
        ]
      : [];
  });
}
export function journalSegmentText(input: JournalSegment) {
  const value = journalSegmentSchema.parse(input);
  invariant(value.from <= value.through, 'EVIDENCE_CHANGED', 'Journal revision range differs.');
  let count = 0,
    bytes = 0;
  for (const rows of Object.values(value.tables)) {
    const ids = new Set<string>();
    for (const text of rows!) {
      const row = JSON.parse(text);
      invariant(
        row && typeof row._id === 'string' && row.projectId === value.projectId && !ids.has(row._id),
        'EVIDENCE_CHANGED',
        'Journal rows differ from their project or repeat an identity.',
      );
      ids.add(row._id);
      count++;
      bytes += new TextEncoder().encode(text).length;
    }
  }
  invariant(
    count > 0 && count <= JOURNAL_PAGE_ROWS && bytes <= JOURNAL_PAGE_BYTES,
    'EVIDENCE_CHANGED',
    'Journal segment differs from its bounded page.',
  );
  return canonicalPayload(value);
}
export function readJournalSegment(
  text: string,
  pin: LandingCapsulePointer,
  projectId: string,
  index: Pick<JournalIndex, 'scope' | 'from' | 'through' | 'startKey' | 'endKey'>,
) {
  const value = journalSegmentSchema.parse(JSON.parse(text));
  invariant(
    value.projectId === projectId &&
      value.startKey === index.startKey &&
      value.endKey === index.endKey &&
      value.scope === index.scope &&
      value.from === index.from &&
      value.through === index.through &&
      value.through === pin.version &&
      journalSegmentText(value) === text &&
      canonicalPayload(journalTablePins(value.tables)) === pin.tables,
    'EVIDENCE_CHANGED',
    'Journal segment differs from its revision or table pins.',
  );
  return value;
}
