// SPDX-License-Identifier: Apache-2.0
// A line comparison of two Item versions (Item 4c9e961e): the longest common run of lines, then what each side adds.
// Pure and bounded: past `limit` lines on either side the middle is compared as one changed block, so a huge body
// can never stall the page.
export type DiffLine = { kind: 'same' | 'old' | 'new'; text: string };

export function lineDiff(before: string, after: string, limit = 1500): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');
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
  // Longest common subsequence table over the changed middle only.
  const rows = midA.length + 1,
    cols = midB.length + 1;
  const table = new Uint16Array(rows * cols);
  for (let i = midA.length - 1; i >= 0; i--)
    for (let j = midB.length - 1; j >= 0; j--)
      table[i * cols + j] =
        midA[i] === midB[j]
          ? table[(i + 1) * cols + j + 1]! + 1
          : Math.max(table[(i + 1) * cols + j]!, table[i * cols + j + 1]!);
  const mid: DiffLine[] = [];
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
