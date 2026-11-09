// SPDX-License-Identifier: Apache-2.0
import { attributionEdits as edits, attributionLines as lines } from './native-text-merge.js';
import { overlappingPaths, type NativeFile, type NativeSource } from './native-source.js';
import { nativeMergeMessage, type NativeMergeResolution } from './native-merge.js';
import type { NativeInsertionOrder } from './native-text-merge.js';
import { markdownDoc } from './docs-resolution.js';
export { DOCS_RULE, markdownDoc } from './docs-resolution.js';

type Edit = { start: number; end: number; lines: string[]; side: 0 | 1 };
const LIST = /^\s*(?:[-*+]\s|\d+[.)]\s|\|)|^\s*$/;
const overlaps = (a: Edit, b: Edit) => {
  const ai = a.start === a.end,
    bi = b.start === b.end;
  return ai && bi
    ? a.start === b.start
    : ai
      ? a.start >= b.start && a.start <= b.end
      : bi
        ? b.start >= a.start && b.start <= a.end
        : a.start < b.end && b.start < a.end;
};

/** Deterministic resolution of a Markdown diff3 conflict, or null when any hunk is
 * ambiguous. Positional hunks keep both insertions (main first). Overlapping edits
 * resolve only inside list/table/blank lines: both sides' new lines, main first; or
 * when both sides only appended text to the end of one prose line: main's text first. */
export function resolveMarkdownText(base: Buffer, main: Buffer, lane: Buffer): Buffer | null {
  const original = lines(base),
    a = lines(main),
    b = lines(lane);
  if (!original || !a || !b) return null;
  const first = edits(original, a),
    second = edits(original, b);
  if (!first || !second) return null;
  const all: Edit[] = [
    ...first.map(edit => ({ ...edit, side: 0 as const })),
    ...second.map(edit => ({ ...edit, side: 1 as const })),
  ].sort((x, y) => x.start - y.start || x.end - y.end || x.side - y.side);
  const groups: Edit[][] = [];
  for (const edit of all) {
    const group = groups.find(items => items.some(item => item.side !== edit.side && overlaps(edit, item)));
    if (group) group.push(edit);
    else groups.push([edit]);
  }
  const output: string[] = [];
  let cursor = 0;
  for (const group of groups.sort((x, y) => x[0]!.start - y[0]!.start)) {
    const start = Math.min(...group.map(edit => edit.start)),
      end = Math.max(...group.map(edit => edit.end));
    if (start < cursor) return null;
    output.push(...original.slice(cursor, start));
    cursor = end;
    const x = apply(group, original, 0, start, end),
      y = apply(group, original, 1, start, end);
    const mainEdits = group.some(edit => edit.side === 0),
      laneEdits = group.some(edit => edit.side === 1);
    const resolved =
      !mainEdits || !laneEdits
        ? mainEdits
          ? x
          : y
        : x.join('') === y.join('')
          ? x
          : (positional(group, original) ??
            listUnion(x, y, original.slice(start, end)) ??
            lineAppends(group, original));
    if (!resolved) return null;
    output.push(...resolved);
  }
  output.push(...original.slice(cursor));
  // Never join two sides' lines when one side lacked a final newline.
  return Buffer.from(
    output.map((line, i) => (i < output.length - 1 && !line.endsWith('\n') ? `${line}\n` : line)).join(''),
  );
}
function apply(group: Edit[], original: string[], side: 0 | 1, start: number, end: number) {
  const result: string[] = [];
  let at = start;
  for (const edit of group.filter(item => item.side === side)) {
    result.push(...original.slice(at, edit.start), ...edit.lines);
    at = edit.end;
  }
  return [...result, ...original.slice(at, end)];
}
/** Insertions at a shared point or at a replaced range's boundary; never inside it. */
function positional(group: Edit[], original: string[]) {
  for (const x of group)
    for (const y of group) {
      if (x.side === y.side || !overlaps(x, y)) continue;
      const xi = x.start === x.end,
        yi = y.start === y.end;
      if (!xi && !yi) return null;
      if (xi && !yi && x.start !== y.start && x.start !== y.end) return null;
    }
  const ordered = [...group].sort(
    (x, y) => x.start - y.start || Number(x.start !== x.end) - Number(y.start !== y.end) || x.side - y.side,
  );
  const result: string[] = [];
  let at = ordered[0]!.start;
  for (const edit of ordered) {
    result.push(...original.slice(at, edit.start), ...edit.lines);
    at = Math.max(at, edit.end);
  }
  return [...result, ...original.slice(at, Math.max(...group.map(edit => edit.end)))];
}
/** Both sides appended to the end of the same prose line (a sentence each, Issue 561996ac): the
 * line, main's addition, then the Lane's. Any other edit of that line stays a conflict. */
function lineAppends(group: Edit[], original: string[]) {
  const [first, second] = group;
  if (group.length !== 2 || !first || !second || first.side === second.side) return null;
  const main = first.side === 0 ? first : second,
    lane = main === first ? second : first;
  if (
    main.start !== lane.start ||
    main.end !== main.start + 1 ||
    lane.end !== lane.start + 1 ||
    main.lines.length !== 1 ||
    lane.lines.length !== 1
  )
    return null;
  const strip = (line: string) => line.replace(/\r?\n$/, '');
  const line = original[main.start]!,
    base = strip(line),
    ours = strip(main.lines[0]!),
    theirs = strip(lane.lines[0]!);
  if (!base.trim() || ours.length <= base.length || theirs.length <= base.length) return null;
  if (!ours.startsWith(base) || !theirs.startsWith(base)) return null;
  return [base + ours.slice(base.length) + theirs.slice(base.length) + line.slice(base.length)];
}
/** Overlapping list/table edits: removals by either side win, then main's and the
 * Lane's new lines in that order. Prose stays a conflict. */
function listUnion(x: string[], y: string[], region: string[]) {
  if (![...region, ...x, ...y].every(line => LIST.test(line.replace(/\r?\n$/, '')))) return null;
  return [
    ...x.filter(line => !region.includes(line) || y.includes(line)),
    ...y.filter(line => !x.includes(line) && !region.includes(line)),
  ];
}

/** Main's bytes of a docs conflict: the right side for a right-first (Lane-oriented) merge, the
 * left side for a left-first (main-oriented) one. */
export const docsMainSide = (order: NativeInsertionOrder) => (order === 'right-first' ? 'right' : 'left');

/** Compose `lane` with `main`, resolving Markdown-only text conflicts with the
 * deterministic rule above. Null when any conflict is outside Markdown docs,
 * binary, a delete, a path clash or an ambiguous hunk; callers keep conflicts.
 * `mainFirst` orients the merge as hosted compose does (main left, parents main then Lane);
 * the default orients it as a Lane sync (Lane left). A source that journals byte calculations
 * (`docsContent`) resolves each file there; the rule is the same. */
export function resolveDocsComposition(
  source: NativeSource,
  lane: string,
  main: string,
  message: string,
  at: string,
  options: { mainFirst?: boolean } = {},
): { head: string; paths: string[]; resolutions?: NativeMergeResolution[] } | null {
  const order: NativeInsertionOrder = options.mainFirst ? 'left-first' : 'right-first',
    [left, right] = options.mainFirst ? [main, lane] : [lane, main];
  const merged = source.mergeFiles(left, right, undefined, undefined, undefined, { insertionOrder: order });
  if (!merged.conflicts.length) return null;
  const mainOf = docsMainSide(order),
    laneOf = mainOf === 'left' ? 'right' : 'left';
  // Every conflict qualifies before any bytes are read or requested.
  for (const item of merged.conflicts) {
    const ours = item[mainOf],
      theirs = item[laneOf];
    if (
      !markdownDoc(item.path) ||
      item.reason ||
      !ours ||
      !theirs ||
      (!item.base && ours.mode !== theirs.mode)
    )
      return null;
  }
  const files: NativeFile[] = [...merged.files];
  const blobs = merged.conflicts.map(item =>
    source.docsContent
      ? source.docsContent(item, order)
      : (() => {
          const bytes = resolveMarkdownText(
            item.base ? source.object(item.base.blob) : Buffer.alloc(0),
            source.object(item[mainOf]!.blob),
            source.object(item[laneOf]!.blob),
          );
          return bytes ? source.put(bytes) : null;
        })(),
  );
  if (blobs.some(blob => !blob)) return null;
  merged.conflicts.forEach((item, i) => {
    const ours = item[mainOf]!,
      theirs = item[laneOf]!;
    files.push({
      path: item.path,
      mode: item.base && theirs.mode === item.base.mode ? ours.mode : theirs.mode,
      blob: blobs[i]!,
    });
  });
  if (overlappingPaths(files).length) return null;
  return {
    head: source.writeState(files, [left, right], nativeMergeMessage(message, merged.resolutions), at),
    ...(merged.resolutions.length ? { resolutions: merged.resolutions } : {}),
    paths: merged.conflicts.map(item => item.path).sort(),
  };
}
