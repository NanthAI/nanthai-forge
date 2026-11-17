// SPDX-License-Identifier: Apache-2.0
// Where each line of a combined result came from (Item a1e3d771), from three exact retained inputs: main's version
// (this Lane's base), the Lane ahead's saved version, and this Lane's saved result. A line kept from main is main's; a
// new line that the Lane ahead also added is the Lane ahead's; any other new line is this Lane's. Which of this
// Lane's saves (or the resolution itself) wrote a line is not retained, so it is never claimed. Lines the Lane ahead
// added that are not in the result are listed as left out. Pure: bytes in, lines out.
import { computeHunks } from '../../../../src/review-hunks-core';

export type Origin = 'main' | 'ahead' | 'lane';
export type OriginLine = { text: string; from: Origin; n?: number; gone?: true };
export type LineOrigin = {
  lines: OriginLine[];
  /** Lines the Lane ahead added that the result does not keep. */
  leftOut: string[];
  tally: Record<Origin, number> & { leftOut: number };
  /** The full alignment was over the compare budget: lines are shown as a replacement block. */
  rough: boolean;
};

type Op = { kind: 'context' | 'removed' | 'added'; text: string };
const ALL = Number.MAX_SAFE_INTEGER;

/** Every line of `b` against `a`, in order, or null when either side is binary or over the text limit. */
function align(a: Uint8Array, b: Uint8Array): { ops: Op[]; rough: boolean } | null {
  const result = computeHunks(a, b, ALL) as {
    hunks: { lines: Op[] }[];
    truncated: boolean;
    content?: string;
  };
  if (result.truncated && !result.hunks.length) return null;
  if (!result.hunks.length) {
    const text = new TextDecoder().decode(b);
    return {
      ops: (text ? text.split('\n') : []).map(line => ({ kind: 'context', text: line })),
      rough: false,
    };
  }
  return { ops: result.hunks.flatMap(hunk => hunk.lines), rough: result.truncated };
}

function bag(lines: readonly string[]) {
  const counts = new Map<string, number>();
  for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);
  return counts;
}
const take = (counts: Map<string, number>, line: string) => {
  const left = counts.get(line) ?? 0;
  if (!left) return false;
  counts.set(line, left - 1);
  return true;
};

/** Attribute the result's lines, or null when a side is not text this page can compare. */
export function lineOrigin(main: Uint8Array, ahead: Uint8Array, result: Uint8Array): LineOrigin | null {
  const mine = align(main, result),
    theirs = align(main, ahead);
  if (!mine || !theirs) return null;
  const added = bag(theirs.ops.filter(op => op.kind === 'added').map(op => op.text));
  const removedAhead = bag(theirs.ops.filter(op => op.kind === 'removed').map(op => op.text));
  const tally = { main: 0, ahead: 0, lane: 0, leftOut: 0 };
  const lines: OriginLine[] = [];
  let n = 0;
  for (const op of mine.ops) {
    if (op.kind === 'removed') {
      // A main line the result drops: the Lane ahead's removal when it removed the same line, otherwise this Lane's.
      lines.push({ text: op.text, from: take(removedAhead, op.text) ? 'ahead' : 'lane', gone: true });
      continue;
    }
    const from: Origin = op.kind === 'context' ? 'main' : take(added, op.text) ? 'ahead' : 'lane';
    tally[from]++;
    lines.push({ text: op.text, from, n: ++n });
  }
  // In the Lane ahead's own order: its added lines the result did not keep.
  const leftOut = theirs.ops
    .filter(op => op.kind === 'added')
    .map(op => op.text)
    .filter(line => take(added, line));
  tally.leftOut = leftOut.length;
  return { lines, leftOut, tally, rough: mine.rough || theirs.rough };
}
