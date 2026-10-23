// SPDX-License-Identifier: Apache-2.0
import { attributionLines, attributionEdits } from './native-text-merge.js';
import { digest } from './hash.js';

type Edit = NonNullable<ReturnType<typeof attributionEdits>>[number];
// Derived alignments only. Keys are exact blob pairs; no source text is returned.
const cache = new Map<string, { before: number; after: number; edits: Edit[] } | null>();
export function alignment(before: Buffer, after: Buffer) {
  const key = `${digest(before)}:${digest(after)}`;
  if (cache.has(key)) return cache.get(key)!;
  let result: { before: number; after: number; edits: Edit[] } | null = null;
  if (before.length <= 1024 * 1024 && after.length <= 1024 * 1024) {
    const a = attributionLines(before),
      b = attributionLines(after);
    if (a && b && a.length <= 20000 && b.length <= 20000) {
      const edits = attributionEdits(a, b);
      if (edits) result = { before: a.length, after: b.length, edits };
    }
  }
  if (cache.size >= 128) cache.delete(cache.keys().next().value!);
  cache.set(key, result);
  return result;
}
export type Attribution = { laneId: string; saveIndex: number; head: string };
export function advanceAttribution(
  before: Buffer,
  after: Buffer,
  labels: (Attribution | null)[],
  actor: Attribution | null,
) {
  const diff = alignment(before, after);
  if (!diff) return null;
  const next: (Attribution | null)[] = [];
  let cursor = 0;
  for (const edit of diff.edits) {
    next.push(...labels.slice(cursor, edit.start), ...edit.lines.map(() => actor));
    cursor = edit.end;
  }
  next.push(...labels.slice(cursor));
  return next;
}
export function attributionRanges(labels: Attribution[][], baseLines: boolean[] = []) {
  const ranges: {
    startLine: number;
    endLine: number;
    source: 'save' | 'base' | 'unattributed';
    attributions: Attribution[];
  }[] = [];
  for (const [index, values] of labels.entries()) {
    const attributions = [...new Map(values.map(value => [JSON.stringify(value), value])).values()];
    const source = attributions.length
      ? ('save' as const)
      : baseLines[index]
        ? ('base' as const)
        : ('unattributed' as const);
    const previous = ranges.at(-1);
    if (
      previous &&
      previous.source === source &&
      JSON.stringify(previous.attributions) === JSON.stringify(attributions)
    )
      previous.endLine++;
    else
      ranges.push({
        startLine: index + 1,
        endLine: index + 1,
        source,
        attributions,
      });
  }
  return ranges;
}
