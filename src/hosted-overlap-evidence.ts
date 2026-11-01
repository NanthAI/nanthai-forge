// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { digest } from './portable-hash.js';
const emptyBlob = digest('');

const position = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const overlapEvidenceSchema = z
  .object({
    baseBlob: z.string().regex(/^[a-f0-9]{64}$/),
    // Zero-based half-open ranges; start === end denotes an insertion.
    ranges: z.array(z.object({ start: position, end: position })).max(256),
    symbols: z.array(z.string().max(300)).max(256),
  })
  .strict();
export type OverlapEvidence = z.infer<typeof overlapEvidenceSchema>;
export type OverlapClass = 'blocking' | 'advisory';
type Change = {
  before: { blob: string; mode: string } | null;
  after: { blob: string; mode: string } | null;
  evidence?: OverlapEvidence;
};
/** Only positive overlap evidence blocks. Missing alignment is advice, never proof of conflict. */
export function classifyOverlap(a: Change, b: Change): { class: OverlapClass; reason: string } {
  if (!a.after || !b.after) return { class: 'blocking', reason: 'delete-or-rename' };
  const x = a.evidence,
    y = b.evidence;
  if (
    !x ||
    !y ||
    x.baseBlob !== (a.before?.blob ?? emptyBlob) ||
    y.baseBlob !== (b.before?.blob ?? emptyBlob)
  )
    return { class: 'advisory', reason: 'unavailable' };
  if (x.symbols.some(symbol => y.symbols.includes(symbol)))
    return { class: 'blocking', reason: 'same-symbol' };
  if (x.baseBlob !== y.baseBlob) return { class: 'advisory', reason: 'unavailable' };
  // An insertion occupies its anchor; adjacent changed lines are one line apart.
  if (
    x.ranges.some(r =>
      y.ranges.some(
        s => r.start <= Math.max(s.start, s.end - 1) + 1 && s.start <= Math.max(r.start, r.end - 1) + 1,
      ),
    )
  )
    return { class: 'blocking', reason: 'adjacent-or-intersecting-ranges' };
  return { class: 'advisory', reason: 'disjoint-ranges' };
}
