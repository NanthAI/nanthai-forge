// SPDX-License-Identifier: Apache-2.0
import type { Hunk } from './Diff';
export type Line = Hunk['lines'][number] & { before: number | ''; after: number | ''; index: number };
export type DiffRow = { left?: Line; right?: Line };
export function numberedLines(hunk: Hunk, trimFinal = false): Line[] {
  let before = hunk.beforeStart,
    after = hunk.afterStart;
  const lines = trimFinal && hunk.lines.at(-1)?.text === '' ? hunk.lines.slice(0, -1) : hunk.lines;
  return lines.map((line, index) => ({
    ...line,
    index,
    before: line.kind === 'added' ? '' : before++,
    after: line.kind === 'removed' ? '' : after++,
  }));
}
/** Pair only adjacent removal/addition runs; never pair across context or hunk boundaries. */
export function pairedLines(lines: Line[]): DiffRow[] {
  const rows: DiffRow[] = [];
  for (let i = 0; i < lines.length;) {
    const line = lines[i]!;
    if (line.kind === 'context') {
      rows.push({ left: line, right: line });
      i++;
      continue;
    }
    const removed: Line[] = [],
      added: Line[] = [];
    const first = line.kind;
    while (i < lines.length && lines[i]!.kind === first)
      (first === 'removed' ? removed : added).push(lines[i++]!);
    while (i < lines.length && lines[i]!.kind !== 'context' && lines[i]!.kind !== first)
      (first === 'removed' ? added : removed).push(lines[i++]!);
    rows.push(...alignChanges(removed, added));
  }
  return rows;
}
/** Align inserted lines around their closest modified counterparts, preserving source order. */
function alignChanges(left: Line[], right: Line[]): DiffRow[] {
  if (left.length * right.length > 250_000)
    return [...left.map(line => ({ left: line })), ...right.map(line => ({ right: line }))];
  const similarity = (a: string, b: string) => {
    const aw: string[] = a.match(/[\p{L}\p{N}_$]+/gu) ?? [];
    const bw: string[] = b.match(/[\p{L}\p{N}_$]+/gu) ?? [];
    const shared = aw.filter(word => bw.includes(word)).length / Math.max(1, aw.length, bw.length);
    return aw[0] && aw[0] === bw[0] ? 1 + shared : shared;
  };
  const scores = left.map(a => right.map(b => similarity(a.text, b.text)));
  const table = Array.from({ length: left.length + 1 }, () => new Float64Array(right.length + 1));
  for (let i = left.length - 1; i >= 0; i--)
    for (let j = right.length - 1; j >= 0; j--)
      table[i]![j] = Math.max(
        table[i + 1]![j]!,
        table[i]![j + 1]!,
        scores[i]![j]! >= 0.5 ? scores[i]![j]! + table[i + 1]![j + 1]! : 0,
      );
  const rows: DiffRow[] = [];
  let i = 0,
    j = 0;
  while (i < left.length || j < right.length) {
    if (
      i < left.length &&
      j < right.length &&
      ((scores[i]![j]! >= 0.5 && table[i]![j] === scores[i]![j]! + table[i + 1]![j + 1]!) ||
        (left.length - i === right.length - j && table[i]![j] === 0))
    )
      rows.push({ left: left[i++]!, right: right[j++]! });
    else if (i < left.length && (j === right.length || table[i + 1]![j]! > table[i]![j + 1]!))
      rows.push({ left: left[i++]! });
    else rows.push({ right: right[j++]! });
  }
  return rows;
}
export type Word = { text: string; kind: 'same' | 'added' | 'removed' };
/** Word LCS. Very long lines use their common ends to keep rendering bounded. */
export function wordChanges(before: string, after: string): Word[] {
  const a = before.match(/\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) ?? [],
    b = after.match(/\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) ?? [];
  let start = 0,
    end = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  while (end < a.length - start && end < b.length - start && a[a.length - end - 1] === b[b.length - end - 1])
    end++;
  const left = a.slice(start, a.length - end),
    right = b.slice(start, b.length - end);
  const result: Word[] = a.slice(0, start).map(text => ({ text, kind: 'same' }));
  if (left.length * right.length > 250_000) {
    result.push({ text: left.join(''), kind: 'removed' }, { text: right.join(''), kind: 'added' });
  } else {
    const table = Array.from({ length: left.length + 1 }, () => new Uint32Array(right.length + 1));
    for (let i = left.length - 1; i >= 0; i--)
      for (let j = right.length - 1; j >= 0; j--)
        table[i]![j] =
          left[i] === right[j] ? 1 + table[i + 1]![j + 1]! : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    let i = 0,
      j = 0;
    while (i < left.length || j < right.length) {
      if (i < left.length && j < right.length && left[i] === right[j]) {
        result.push({ text: left[i++]!, kind: 'same' });
        j++;
      } else if (i < left.length && (j === right.length || table[i + 1]![j]! >= table[i]![j + 1]!))
        result.push({ text: left[i++]!, kind: 'removed' });
      else result.push({ text: right[j++]!, kind: 'added' });
    }
  }
  result.push(...a.slice(a.length - end).map(text => ({ text, kind: 'same' as const })));
  return result
    .filter(word => word.text)
    .reduce<Word[]>((words, word) => {
      if (words.at(-1)?.kind === word.kind) words.at(-1)!.text += word.text;
      else words.push({ ...word });
      return words;
    }, []);
}
