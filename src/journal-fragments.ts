// SPDX-License-Identifier: Apache-2.0
import { canonicalPayload } from './hosted-source-operation.js';
import { digest } from './state/hash.js';
import { invariant } from './errors.js';
import {
  journalSegmentSchema,
  journalSegmentText,
  JOURNAL_PAGE_ROWS,
  type JournalSegment,
} from './journal-segment.js';
/** Fragment the canonical logical segment, preserving the original JSON document bytes.
 * Bound each frame by source bytes and its nested JSON escaping, leaving room for capture metadata within 500 KiB.
 * This is transport framing, not another archive codec: S1 still packs every physical segment. */
export function journalFragmentTexts(segment: JournalSegment) {
  const text = canonicalPayload(journalSegmentSchema.parse(segment));
  invariant(
    Object.values(segment.tables).flat().length <= JOURNAL_PAGE_ROWS,
    'EVIDENCE_CHANGED',
    'Journal row count exceeds its bounded page.',
  );
  const bytes = new TextEncoder().encode(text),
    pieces: string[] = [];
  for (let at = 0; at < bytes.length;) {
    let end = at,
      escaped = 0;
    // Canonical JSON has no raw control characters. Quotes and backslashes expand
    // eightfold across the fragment row, segment string and capture reply.
    while (end < bytes.length && end - at < 200 * 1024) {
      const weight = bytes[end] === 34 || bytes[end] === 92 ? 8 : 1;
      if (escaped + weight > 384 * 1024) break;
      escaped += weight;
      end++;
    }
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
    pieces.push(new TextDecoder('utf-8', { fatal: true }).decode(bytes.slice(at, end)));
    at = end;
  }
  const sha256 = digest(text);
  return pieces.map((text, part) =>
    journalSegmentText({
      ...segment,
      tables: {
        projectHostedRecordBodies: [
          canonicalPayload({
            _id: `${sha256}:${part}`,
            projectId: segment.projectId,
            journalFragment: { sha256, part, count: pieces.length, text },
          }),
        ],
      },
    }),
  );
}
export function joinJournalFragments(segments: JournalSegment[]): JournalSegment {
  const pieces = segments.map(segment => {
    const rows = Object.values(segment.tables).flat();
    invariant(rows.length === 1, 'EVIDENCE_CHANGED', 'Journal fragment coverage differs.');
    return JSON.parse(rows[0]!).journalFragment as {
      sha256: string;
      part: number;
      count: number;
      text: string;
    };
  });
  const first = pieces[0];
  invariant(
    first &&
      first.count === pieces.length &&
      pieces.every(
        (part, i) => part.sha256 === first.sha256 && part.count === pieces.length && part.part === i,
      ),
    'EVIDENCE_CHANGED',
    'Journal fragment order or coverage differs.',
  );
  const text = pieces.map(part => part.text).join('');
  invariant(digest(text) === first.sha256, 'EVIDENCE_CHANGED', 'Original journal fragment bytes differ.');
  const logical = journalSegmentSchema.parse(JSON.parse(text)),
    physical = segments[0]!;
  invariant(
    logical.projectId === physical.projectId &&
      logical.scope === physical.scope &&
      logical.from === physical.from &&
      logical.through === physical.through &&
      logical.startKey === physical.startKey &&
      logical.endKey === physical.endKey &&
      canonicalPayload(logical) === text,
    'EVIDENCE_CHANGED',
    'Journal fragment selection differs.',
  );
  return logical;
}
