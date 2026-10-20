// SPDX-License-Identifier: Apache-2.0
import { reconcileNativeImports } from './native-import-merge.js';
/** Conservative line-based diff3. Ambiguous/expensive or non-text edits stay conflicts. */
type Edit = { start: number; end: number; lines: string[] };
function lines(bytes: Buffer): string[] | null {
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) return null;
    return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  } catch {
    return null;
  }
}
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
export function mergeNativeText(base: Buffer, left: Buffer, right: Buffer, path?: string): Buffer | null {
  const original = lines(base),
    a = lines(left),
    b = lines(right);
  if (!original || !a || !b) return null;
  const first = edits(original, a),
    second = edits(original, b);
  if (!first || !second) return null;
  const merged = [...first];
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
      const insertion = edit.start === edit.end,
        otherInsertion = other.start === other.end;
      const overlap =
        insertion && otherInsertion
          ? edit.start === other.start
          : insertion
            ? edit.start >= other.start && edit.start <= other.end
            : otherInsertion
              ? other.start >= edit.start && other.start <= edit.end
              : edit.start < other.end && other.start < edit.end;
      if (overlap) return null;
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
  return reconciled ? Buffer.from(reconciled.join('')) : null;
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
/** diff3 with Git-style conflict hunks for a working tree. Returns null for
 * non-text input. `conflicted` is false when every hunk merged cleanly. */
export function markNativeTextConflicts(
  base: Buffer,
  left: Buffer,
  right: Buffer,
  labels: [string, string],
): { bytes: Buffer; conflicted: boolean } | null {
  const original = lines(base),
    a = lines(left),
    b = lines(right);
  if (!original || !a || !b) return null;
  const terminated = (part: string[]) =>
    part.length && !part.at(-1)!.endsWith('\n') ? [...part.slice(0, -1), part.at(-1)! + '\n'] : part;
  const hunk = (x: string[], y: string[]) => [
    `<<<<<<< ${labels[0]}\n`,
    ...terminated(x),
    '=======\n',
    ...terminated(y),
    `>>>>>>> ${labels[1]}\n`,
  ];
  const first = edits(original, a),
    second = edits(original, b);
  if (!first || !second) return { bytes: Buffer.from(hunk(a, b).join('')), conflicted: true };
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
  const output: string[] = [];
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
    if (start < cursor) return { bytes: Buffer.from(hunk(a, b).join('')), conflicted: true };
    output.push(...original.slice(cursor, start));
    cursor = end;
    const x = apply(sides[0]!, start, end),
      y = apply(sides[1]!, start, end);
    if (!sides[0]!.length || !sides[1]!.length || x.join('') === y.join(''))
      output.push(...(sides[0]!.length ? x : y));
    else {
      conflicted = true;
      output.push(...hunk(x, y));
    }
  }
  output.push(...original.slice(cursor));
  return { bytes: Buffer.from(output.join('')), conflicted };
}

// Shared deterministic alignment for source attribution; this never executes source.
export { lines as attributionLines, edits as attributionEdits };
