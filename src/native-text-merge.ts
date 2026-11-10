// SPDX-License-Identifier: Apache-2.0
import { reconcileNativeImports } from './native-import-merge.js';
import { isTextBytes, linesEol, utf8Text } from './text-bytes.js';
/** Conservative line-based diff3. Ambiguous/expensive or non-text edits stay conflicts. */
type Edit = { start: number; end: number; lines: string[] };
export type NativeTextResolution = { baseLine: number; resolved: 'both-insertions' };
export type NativeInsertionOrder = 'left-first' | 'right-first';
type MergeOptions = {
  insertionOrder?: NativeInsertionOrder;
  resolutions?: NativeTextResolution[];
};
/** Shared punctuation/blank lines are normal block boundaries. Shared content
 * makes additions ambiguous: preserve the explicit conflict rather than interleave. */
function independentInsertions(first: Edit, second: Edit): boolean {
  if (first.start !== first.end || second.start !== second.end || first.start !== second.start) return false;
  const a = first.lines.join(''),
    b = second.lines.join('');
  if (!a || !b || !a.endsWith('\n') || !b.endsWith('\n')) return false;
  const x = a.trim(),
    y = b.trim();
  if (!x || !y || x.startsWith(y) || y.startsWith(x) || x.endsWith(y) || y.endsWith(x)) return false;
  const meaningful = new Set(
    first.lines.map(line => line.trim()).filter(line => !/^[\s{}()[\],;]*$/u.test(line)),
  );
  return !second.lines.some(line => meaningful.has(line.trim()));
}
function lines(bytes: Buffer): string[] | null {
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) return null;
    return split(text);
  } catch {
    return null;
  }
}
const split = (text: string) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
type Encoding = 'utf8' | 'latin1';
/** The three inputs as lines split on 0x0A, or null when one is binary (Git's rule, Issue
 * 113bc7b3). Valid UTF-8 everywhere merges as UTF-8 text, exactly as before. Otherwise every
 * input is read one character per byte (latin1), so lines compare and merge byte for byte
 * in any ASCII-compatible encoding (Windows-1252, Latin-1, Shift-JIS, EUC). */
function textLines(inputs: Buffer[]): { lines: string[][]; encoding: Encoding } | null {
  if (!inputs.every(isTextBytes)) return null;
  const utf8 = inputs.map(utf8Text);
  if (utf8.every(text => text !== null)) return { lines: utf8.map(split), encoding: 'utf8' };
  return { lines: inputs.map(bytes => split(bytes.toString('latin1'))), encoding: 'latin1' };
}
/** Lines back to exact bytes. Latin1 text holds only byte-sized characters; anything wider
 * (never produced by a byte merge) is refused instead of truncated. */
function encode(output: string[], encoding: Encoding): Buffer | null {
  const text = output.join('');
  if (encoding === 'utf8') return Buffer.from(text);
  return /[^\x00-\xff]/u.test(text) ? null : Buffer.from(text, 'latin1');
}
/** A marker label in the text's encoding: its UTF-8 bytes, so marker lines stay ASCII/UTF-8. */
const label = (value: string, encoding: Encoding) =>
  encoding === 'utf8' ? value : Buffer.from(value).toString('latin1');
/** Myers shortest edit path within a distance cap and a step budget (shared across calls). */
function myers(before: string[], after: string[], budget: { steps: number }): Edit[] | null {
  let previous = new Map<number, number>([[1, 0]]);
  const trace: Map<number, number>[] = [];
  for (let distance = 0; distance <= Math.min(before.length + after.length, 512); distance++) {
    trace.push(previous);
    const next = new Map<number, number>();
    for (let k = -distance; k <= distance; k += 2) {
      if (--budget.steps < 0) return null;
      let x =
        k === -distance || (k !== distance && (previous.get(k - 1) ?? -1) < (previous.get(k + 1) ?? -1))
          ? (previous.get(k + 1) ?? 0)
          : (previous.get(k - 1) ?? 0) + 1;
      let y = x - k;
      while (x < before.length && y < after.length && before[x] === after[y]) {
        x++;
        y++;
        if (--budget.steps < 0) return null;
      }
      next.set(k, x);
      if (x < before.length || y < after.length) continue;
      const operations: ('same' | 'delete' | 'insert')[] = [];
      for (let d = distance; d >= 0; d--) {
        const v = trace[d]!,
          diagonal = x - y;
        const prior =
          diagonal === -d || (diagonal !== d && (v.get(diagonal - 1) ?? -1) < (v.get(diagonal + 1) ?? -1))
            ? diagonal + 1
            : diagonal - 1;
        const px = v.get(prior) ?? 0,
          py = px - prior;
        while (x > px && y > py) {
          operations.push('same');
          x--;
          y--;
        }
        if (d > 0) {
          if (x === px) {
            operations.push('insert');
            y--;
          } else {
            operations.push('delete');
            x--;
          }
        }
      }
      let a = 0,
        b = 0,
        current: Edit | undefined;
      const result: Edit[] = [];
      for (const operation of operations.reverse()) {
        if (operation === 'same') {
          current = undefined;
          a++;
          b++;
          continue;
        }
        if (!current) {
          current = { start: a, end: a, lines: [] };
          result.push(current);
        }
        if (operation === 'delete') current.end = ++a;
        else current.lines.push(after[b++]!);
      }
      return result;
    }
    previous = next;
  }
  return null;
}
/** Lines that occur exactly once in both ranges, paired in increasing order on both sides
 * (patience anchors: the longest increasing run of the pairs). */
function anchors(before: string[], after: string[], [a0, a1]: [number, number], [b0, b1]: [number, number]) {
  const count = new Map<string, [number, number, number]>();
  for (let i = a0; i < a1; i++) {
    const entry = count.get(before[i]!) ?? [0, 0, i];
    entry[0]++;
    count.set(before[i]!, entry);
  }
  const pairs: [number, number][] = [];
  const seen = new Map<string, number>();
  for (let j = b0; j < b1; j++) {
    const entry = count.get(after[j]!);
    if (entry?.[0] === 1) {
      entry[1]++;
      seen.set(after[j]!, j);
    }
  }
  for (const [line, j] of seen) if (count.get(line)![1] === 1) pairs.push([count.get(line)![2], j]);
  pairs.sort((x, y) => x[0] - y[0]);
  // Longest increasing subsequence on the after side (patience sorting).
  const tails: number[] = [],
    back: number[] = [];
  pairs.forEach(([, j], index) => {
    let lo = 0,
      hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pairs[tails[mid]!]![1] < j) lo = mid + 1;
      else hi = mid;
    }
    back[index] = lo ? tails[lo - 1]! : -1;
    tails[lo] = index;
  });
  const chain: [number, number][] = [];
  for (let index = tails.at(-1) ?? -1; index >= 0; index = back[index]!) chain.push(pairs[index]!);
  return chain.reverse();
}
/** Edits for a range Myers could not align within its cap (Issue 10d253c6: a Lane that deleted
 * 500+ lines of a file conflicted with every edit main made anywhere in it, and its conflict draft
 * was the whole file). Unique common lines split the range; each gap gets Myers within the shared
 * budget, again anchored when that fails, and one replacement edit when nothing anchors it. Every
 * result is a valid edit script, so a merge of it is exact; a coarse gap only conflicts locally. */
function anchoredEdits(
  before: string[],
  after: string[],
  a: [number, number],
  b: [number, number],
  budget: { steps: number },
  depth = 0,
): Edit[] {
  let [a0, a1] = a,
    [b0, b1] = b;
  while (a0 < a1 && b0 < b1 && before[a0] === after[b0]) {
    a0++;
    b0++;
  }
  while (a1 > a0 && b1 > b0 && before[a1 - 1] === after[b1 - 1]) {
    a1--;
    b1--;
  }
  if (a0 === a1 && b0 === b1) return [];
  const replace = (): Edit[] => [{ start: a0, end: a1, lines: after.slice(b0, b1) }];
  if (a0 === a1 || b0 === b1) return replace();
  budget.steps -= a1 - a0 + b1 - b0;
  if (budget.steps < 0) return replace();
  // The whole range already failed Myers in `edits`; gaps try it first.
  const direct = depth ? myers(before.slice(a0, a1), after.slice(b0, b1), budget) : null;
  if (direct) return direct.map(edit => ({ ...edit, start: edit.start + a0, end: edit.end + a0 }));
  if (depth >= 8 || budget.steps < 0) return replace();
  const chain = anchors(before, after, [a0, a1], [b0, b1]);
  if (!chain.length) return replace();
  const result: Edit[] = [];
  let i = a0,
    j = b0;
  for (const [x, y] of [...chain, [a1, b1] as [number, number]]) {
    result.push(...anchoredEdits(before, after, [i, x], [j, y], budget, depth + 1));
    i = x + 1;
    j = y + 1;
  }
  return result;
}
function edits(before: string[], after: string[]): Edit[] {
  // Myers shortest edit path; cap computation, never source/history retention. Past the cap,
  // anchored alignment keeps the edits local instead of refusing the whole file.
  const budget = { steps: 2_000_000 };
  return (
    myers(before, after, budget) ??
    anchoredEdits(before, after, [0, before.length], [0, after.length], { steps: 4_000_000 })
  );
}
export function mergeNativeText(
  base: Buffer,
  left: Buffer,
  right: Buffer,
  path?: string,
  options: MergeOptions = {},
): Buffer | null {
  const text = textLines([base, left, right]);
  if (!text) return null;
  const [original, a, b] = text.lines as [string[], string[], string[]];
  const first = edits(original, a),
    second = edits(original, b);
  const merged = first.map(edit => ({ ...edit, lines: [...edit.lines] })),
    resolutions: NativeTextResolution[] = [];
  for (const edit of second) {
    let duplicate = false;
    for (const other of first) {
      if (
        edit.start === other.start &&
        edit.end === other.end &&
        edit.lines.join('') === other.lines.join('')
      ) {
        duplicate = true;
        break;
      }
      if (overlaps(edit, other)) {
        if (!independentInsertions(other, edit)) return null;
        const target = merged[first.indexOf(other)]!;
        target.lines =
          options.insertionOrder === 'right-first'
            ? [...edit.lines, ...other.lines]
            : [...other.lines, ...edit.lines];
        resolutions.push({ baseLine: edit.start + 1, resolved: 'both-insertions' });
        duplicate = true;
      }
    }
    if (!duplicate) merged.push(edit);
  }
  merged.sort((a, b) => a.start - b.start || a.end - b.end);
  const output: string[] = [];
  let cursor = 0;
  for (const edit of merged) {
    output.push(...original.slice(cursor, edit.start), ...edit.lines);
    cursor = edit.end;
  }
  output.push(...original.slice(cursor));
  const reconciled = reconcileNativeImports(original, a, b, output, path);
  if (!reconciled) return null;
  const bytes = encode(reconciled, text.encoding);
  if (!bytes) return null;
  options.resolutions?.push(...resolutions);
  return bytes;
}
type Side = Edit & { side: 0 | 1 };
function overlaps(edit: Edit, other: Edit) {
  const insertion = edit.start === edit.end,
    otherInsertion = other.start === other.end;
  return insertion && otherInsertion
    ? edit.start === other.start
    : insertion
      ? edit.start >= other.start && edit.start <= other.end
      : otherInsertion
        ? other.start >= edit.start && other.start <= edit.end
        : edit.start < other.end && other.start < edit.end;
}
/** One diff3-style conflict hunk (Git `merge.conflictStyle=diff3`): the left side, the base
 * lines both sides changed under `||||||| base`, then the right side (Issue 10d253c6: without the
 * base an agent could not see what the other side changed). Marker lines and a terminated last
 * line take the hunk's EOL (Issue d36380ca): CRLF when every terminated line of its sides ends in
 * CRLF, LF when they are mixed, and the surrounding file's rule (else LF) when no side line is
 * terminated. */
function markerHunk(
  x: string[],
  y: string[],
  base: string[],
  labels: [string, string],
  encoding: Encoding,
  fileEol: string,
) {
  const eol = linesEol([...x, ...y]) ?? fileEol;
  const terminated = (part: string[]) =>
    part.length && !part.at(-1)!.endsWith('\n') ? [...part.slice(0, -1), part.at(-1)! + eol] : part;
  return [
    `<<<<<<< ${label(labels[0], encoding)}${eol}`,
    ...terminated(x),
    `||||||| base${eol}`,
    ...terminated(base),
    `=======${eol}`,
    ...terminated(y),
    `>>>>>>> ${label(labels[1], encoding)}${eol}`,
  ];
}
/** Both whole sides as one conflict hunk, for text whose hunks merge but whose merge was
 * refused (for example by the import reconcile). Null for binary input. */
export function wholeFileConflict(
  base: Buffer,
  left: Buffer,
  right: Buffer,
  labels: [string, string],
): Buffer | null {
  const text = textLines([base, left, right]);
  if (!text) return null;
  const [original, a, b] = text.lines as [string[], string[], string[]];
  return encode(markerHunk(a, b, original, labels, text.encoding, '\n'), text.encoding);
}
/** Labels for a hunk where the Lane removed the region and the other side changed only lines
 * inside it (Issue 10d253c6: a Lane deleting native docs conflicted on every main edit inside the
 * deleted sections). Each of the other side's edits lies within one Lane edit that deletes more
 * base lines than it writes and more than the other side changed, so an ordinary same-line
 * conflict is never labelled. The Lane's marker offers its side as the suggested resolution and
 * names the base lines the other side changed (shown under `||||||| base`). Only the Lane's own
 * removal is offered: a removal by main or a sync target never suggests dropping the Lane's edit.
 * The hunk stays a conflict; nothing is resolved for the agent. */
function removalLabels(sides: Edit[][], labels: [string, string]): [string, string] | null {
  const lane = labels.indexOf('lane');
  if (lane < 0) return null;
  const own = sides[lane]!,
    peer = sides[1 - lane]!;
  if (!own.length || !peer.length) return null;
  for (const edit of peer) {
    const cover = own.find(item =>
      edit.start === edit.end
        ? item.start < edit.start && edit.start < item.end
        : item.start <= edit.start && edit.end <= item.end,
    );
    const removed = cover ? cover.end - cover.start : 0;
    if (!cover || removed <= cover.lines.length || edit.end - edit.start >= removed) return null;
  }
  const from = Math.min(...peer.map(edit => edit.start)) + 1,
    to = Math.max(...peer.map(edit => Math.max(edit.end, edit.start + 1))),
    other = labels[1 - lane]!,
    lines = from === to ? `line ${from}` : `lines ${from}-${to}`;
  const next: [string, string] = [...labels];
  next[lane] =
    `lane removed this region; ${other} changed only base ${lines} inside it. ` +
    `Suggested resolution: keep the lane side (move ${other}'s change elsewhere if it still matters)`;
  return next;
}
/** diff3 with Git-style conflict hunks for a working tree. Returns null for
 * non-text input. `conflicted` is false when every hunk merged cleanly. */
export function markNativeTextConflicts(
  base: Buffer,
  left: Buffer,
  right: Buffer,
  labels: [string, string],
  insertionOrder: NativeInsertionOrder = 'left-first',
): { bytes: Buffer; conflicted: boolean; resolutions?: NativeTextResolution[] } | null {
  const text = textLines([base, left, right]);
  if (!text) return null;
  const [original, a, b] = text.lines as [string[], string[], string[]];
  const fileEol = linesEol([...original, ...a, ...b]) ?? '\n';
  const hunk = (x: string[], y: string[], start: number, end: number, names = labels) =>
    markerHunk(x, y, original.slice(start, end), names, text.encoding, fileEol);
  const bytes = (output: string[]) => encode(output, text.encoding)!;
  const first = edits(original, a),
    second = edits(original, b);
  const all: Side[] = [
    ...first.map(edit => ({ ...edit, side: 0 as const })),
    ...second.map(edit => ({ ...edit, side: 1 as const })),
  ].sort((x, y) => x.start - y.start || x.end - y.end || x.side - y.side);
  // Group edits connected by cross-side overlap; one side's own edits never overlap.
  const groups: Side[][] = [];
  for (const edit of all) {
    const group = groups.find(items => items.some(item => item.side !== edit.side && overlaps(edit, item)));
    if (group) group.push(edit);
    else groups.push([edit]);
  }
  const output: string[] = [],
    resolutions: NativeTextResolution[] = [];
  let cursor = 0,
    conflicted = false;
  const apply = (items: Edit[], start: number, end: number) => {
    const result: string[] = [];
    let at = start;
    for (const edit of items) {
      result.push(...original.slice(at, edit.start), ...edit.lines);
      at = edit.end;
    }
    return [...result, ...original.slice(at, end)];
  };
  for (const group of groups.sort((x, y) => x[0]!.start - y[0]!.start)) {
    const start = Math.min(...group.map(edit => edit.start)),
      end = Math.max(...group.map(edit => edit.end)),
      sides = [0, 1].map(side => group.filter(edit => edit.side === side));
    if (start < cursor) return { bytes: bytes(hunk(a, b, 0, original.length)), conflicted: true };
    output.push(...original.slice(cursor, start));
    cursor = end;
    const x = apply(sides[0]!, start, end),
      y = apply(sides[1]!, start, end);
    if (!sides[0]!.length || !sides[1]!.length || x.join('') === y.join(''))
      output.push(...(sides[0]!.length ? x : y));
    else if (group.length === 2 && independentInsertions(sides[0]![0]!, sides[1]![0]!)) {
      output.push(...(insertionOrder === 'right-first' ? [...y, ...x] : [...x, ...y]));
      resolutions.push({ baseLine: start + 1, resolved: 'both-insertions' });
    } else {
      conflicted = true;
      output.push(...hunk(x, y, start, end, removalLabels(sides, labels) ?? labels));
    }
  }
  output.push(...original.slice(cursor));
  return { bytes: bytes(output), conflicted, ...(resolutions.length ? { resolutions } : {}) };
}

/** One conflicting region: 1-based inclusive line ranges in each side's own file (an empty side
 * range names the line the other side's edit sits at). */
export type NativeConflictRegion = { left: [number, number]; right: [number, number] };
/** Where mergeNativeText refuses: the regions the two sides both changed, in each side's own line
 * numbers, using the same edits, duplicate and independent-insertion rules. Null for non-text
 * (the merge refuses it too). An empty list with a refused merge
 * means the import reconcile refused it (the whole file). */
export function nativeConflictRegions(
  base: Buffer,
  left: Buffer,
  right: Buffer,
): NativeConflictRegion[] | null {
  const text = textLines([base, left, right]);
  if (!text) return null;
  const [original, a, b] = text.lines as [string[], string[], string[]];
  const first = edits(original, a),
    second = edits(original, b);
  const shift = (edit: Edit) => edit.lines.length - (edit.end - edit.start);
  // The region in one side's own file: the base lines start..end, moved by that side's earlier
  // edits and resized by its own edit inside the region.
  const span = (side: Edit[], own: Edit, start: number, end: number): [number, number] => {
    const from =
      side.reduce((line, edit) => (edit !== own && edit.end <= start ? line + shift(edit) : line), start) + 1;
    return [from, Math.max(from, from + end - start + shift(own) - 1)];
  };
  const regions: NativeConflictRegion[] = [];
  for (const edit of second)
    for (const other of first) {
      if (!overlaps(edit, other)) continue;
      const same =
        edit.start === other.start && edit.end === other.end && edit.lines.join('') === other.lines.join('');
      if (same || independentInsertions(other, edit)) continue;
      const start = Math.min(edit.start, other.start),
        end = Math.max(edit.end, other.end);
      regions.push({ left: span(first, other, start, end), right: span(second, edit, start, end) });
    }
  return regions;
}

// Shared deterministic alignment for source attribution; this never executes source.
export { lines as attributionLines, edits as attributionEdits };
