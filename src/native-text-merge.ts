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
function edits(before: string[], after: string[]): Edit[] | null {
  // Myers shortest edit path; cap computation, never source/history retention.
  // Falling back preserves the pre-existing explicit-conflict behavior.
  let previous = new Map<number, number>([[1, 0]]),
    budget = 2_000_000;
  const trace: Map<number, number>[] = [];
  for (let distance = 0; distance <= Math.min(before.length + after.length, 512); distance++) {
    trace.push(previous);
    const next = new Map<number, number>();
    for (let k = -distance; k <= distance; k += 2) {
      if (--budget < 0) return null;
      let x =
        k === -distance || (k !== distance && (previous.get(k - 1) ?? -1) < (previous.get(k + 1) ?? -1))
          ? (previous.get(k + 1) ?? 0)
          : (previous.get(k - 1) ?? 0) + 1;
      let y = x - k;
      while (x < before.length && y < after.length && before[x] === after[y]) {
        x++;
        y++;
        if (--budget < 0) return null;
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
  if (!first || !second) return null;
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
/** One Git-style conflict hunk. Marker lines and a terminated last line take the hunk's EOL
 * (Issue d36380ca): CRLF when every terminated line of its sides ends in CRLF, LF when they
 * are mixed, and the surrounding file's rule (else LF) when no side line is terminated. */
function markerHunk(x: string[], y: string[], labels: [string, string], encoding: Encoding, fileEol: string) {
  const eol = linesEol([...x, ...y]) ?? fileEol;
  const terminated = (part: string[]) =>
    part.length && !part.at(-1)!.endsWith('\n') ? [...part.slice(0, -1), part.at(-1)! + eol] : part;
  return [
    `<<<<<<< ${label(labels[0], encoding)}${eol}`,
    ...terminated(x),
    `=======${eol}`,
    ...terminated(y),
    `>>>>>>> ${label(labels[1], encoding)}${eol}`,
  ];
}
/** Both whole sides as one conflict hunk, for text whose hunks merge but whose merge was
 * refused (for example by the import reconcile). Null for binary input. */
export function wholeFileConflict(left: Buffer, right: Buffer, labels: [string, string]): Buffer | null {
  const text = textLines([left, right]);
  if (!text) return null;
  const [a, b] = text.lines as [string[], string[]];
  return encode(markerHunk(a, b, labels, text.encoding, '\n'), text.encoding);
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
  const hunk = (x: string[], y: string[]) => markerHunk(x, y, labels, text.encoding, fileEol);
  const bytes = (output: string[]) => encode(output, text.encoding)!;
  const first = edits(original, a),
    second = edits(original, b);
  if (!first || !second) return { bytes: bytes(hunk(a, b)), conflicted: true };
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
    if (start < cursor) return { bytes: bytes(hunk(a, b)), conflicted: true };
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
      output.push(...hunk(x, y));
    }
  }
  output.push(...original.slice(cursor));
  return { bytes: bytes(output), conflicted, ...(resolutions.length ? { resolutions } : {}) };
}

// Shared deterministic alignment for source attribution; this never executes source.
export { lines as attributionLines, edits as attributionEdits };
