// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { digest } from './state/hash.js';
const emptyBlob = digest('');
const position = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const range = z.object({ start: position, end: position });
const symbolLinksSchema = z.union([
  z
    .object({
      exports: z.array(z.string().max(200)).max(64),
      refs: z.array(z.string().max(300)).max(64),
    })
    .strict(),
  z.object({ unavailable: z.literal(true) }).strict(),
]);
export const overlapEvidenceSchema = z
  .object({
    baseBlob: z.string().regex(/^[a-f0-9]{64}$/),
    // Zero-based half-open ranges; start === end denotes an insertion.
    ranges: z.array(range).max(256),
    symbols: z.array(z.string().max(300)).max(256),
    // Cross-file advisory notes (3629cf24): changed exported names of this file and imported
    // symbols (`path#name`) its changed lines use. Sent only to servers advertising the feature.
    symbolLinks: symbolLinksSchema.optional(),
  })
  .strict();
export type OverlapEvidence = z.infer<typeof overlapEvidenceSchema>;
export type SymbolLinks = z.infer<typeof symbolLinksSchema>;
export type OverlapClass = 'blocking' | 'advisory';
type Change = {
  before: { blob: string; mode: string } | null;
  after: { blob: string; mode: string } | null;
  evidence?: OverlapEvidence;
};
/** Symbol ownership alone does not establish a composition conflict.
 * Only aligned changed ranges block. Unavailable evidence never proves independence. */
export function classifyOverlap(a: Change, b: Change): { class: OverlapClass; reason: string } {
  if (a.after === null && b.after === null) return { class: 'advisory', reason: 'same-result' };
  if (a.after && b.after && a.after.blob === b.after.blob && a.after.mode === b.after.mode)
    return { class: 'advisory', reason: 'same-result' };
  if (!a.after || !b.after) return { class: 'blocking', reason: 'delete-or-rename' };
  if (!a.before && !b.before) return { class: 'blocking', reason: 'different-additions' };
  const x = a.evidence,
    y = b.evidence;
  if (
    !x ||
    !y ||
    x.baseBlob !== (a.before?.blob ?? emptyBlob) ||
    y.baseBlob !== (b.before?.blob ?? emptyBlob) ||
    x.baseBlob !== y.baseBlob
  )
    return { class: 'advisory', reason: 'unavailable' };
  // Touching edits belong to one conflict region in the replay's diff3 rule.
  if (x.ranges.some(r => y.ranges.some(s => r.start <= s.end && s.start <= r.end)))
    return { class: 'blocking', reason: 'adjacent-or-intersecting-ranges' };
  return { class: 'advisory', reason: 'disjoint-ranges' };
}
