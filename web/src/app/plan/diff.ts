// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// A comparison of two Item versions (Item 4c9e961e): the longest common run of lines, then what each side adds, and
// inside a replaced line the words that changed, since prose changes by word. Pure and bounded: past `limit` lines
// (or words) on either side the middle is compared as one changed block, so a huge body can never stall the page.
export type DiffPart = { kind: 'same' | 'old' | 'new'; text: string };
export type DiffLine = DiffPart & { words?: DiffPart[] };

/** The common-subsequence walk over two token lists, keeping equal heads and tails out of the table. */
function sequence(a: readonly string[], b: readonly string[], limit: number): DiffPart[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length,
    endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const head = a.slice(0, start).map(text => ({ kind: 'same' as const, text }));
  const tail = a.slice(endA).map(text => ({ kind: 'same' as const, text }));
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  if (midA.length > limit || midB.length > limit)
    return [
      ...head,
      ...midA.map(text => ({ kind: 'old' as const, text })),
      ...midB.map(text => ({ kind: 'new' as const, text })),
      ...tail,
    ];
  const cols = midB.length + 1;
  const table = new Uint16Array((midA.length + 1) * cols);
  for (let i = midA.length - 1; i >= 0; i--)
    for (let j = midB.length - 1; j >= 0; j--)
      table[i * cols + j] =
        midA[i] === midB[j]
          ? table[(i + 1) * cols + j + 1]! + 1
          : Math.max(table[(i + 1) * cols + j]!, table[i * cols + j + 1]!);
  const mid: DiffPart[] = [];
  let i = 0,
    j = 0;
  while (i < midA.length && j < midB.length) {
    if (midA[i] === midB[j]) {
      mid.push({ kind: 'same', text: midA[i++]! });
      j++;
    } else if (table[(i + 1) * cols + j]! >= table[i * cols + j + 1]!)
      mid.push({ kind: 'old', text: midA[i++]! });
    else mid.push({ kind: 'new', text: midB[j++]! });
  }
  while (i < midA.length) mid.push({ kind: 'old', text: midA[i++]! });
  while (j < midB.length) mid.push({ kind: 'new', text: midB[j++]! });
  return [...head, ...mid, ...tail];
}

/** Words and the spaces between them, so joining the parts gives the line back exactly. */
const words = (line: string) => line.match(/\s+|[^\s]+/g) ?? [];

/** The words of one replaced line: the old line's parts carry `old` and `same`, the new line's `new` and `same`. */
function wordDiff(before: string, after: string, limit = 400) {
  const parts = sequence(words(before), words(after), limit);
  return {
    old: parts.filter(part => part.kind !== 'new'),
    new: parts.filter(part => part.kind !== 'old'),
  };
}

export function lineDiff(before: string, after: string, limit = 1500): DiffLine[] {
  const lines: DiffLine[] = sequence(before.split('\n'), after.split('\n'), limit);
  // A run of removed lines followed by as many added ones is a rewrite: mark the words that changed in each pair.
  for (let index = 0; index < lines.length;) {
    let olds = 0;
    while (lines[index + olds]?.kind === 'old') olds++;
    let news = 0;
    while (lines[index + olds + news]?.kind === 'new') news++;
    if (olds && olds === news)
      for (let pair = 0; pair < olds; pair++) {
        const left = lines[index + pair]!,
          right = lines[index + olds + pair]!;
        const changed = wordDiff(left.text, right.text);
        left.words = changed.old;
        right.words = changed.new;
      }
    index += Math.max(1, olds + news);
  }
  return lines;
}
