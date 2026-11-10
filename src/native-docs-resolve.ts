// SPDX-License-Identifier: Apache-2.0
import { attributionEdits as edits, attributionLines as lines } from './native-text-merge.js';
import { overlappingPaths, type NativeFile, type NativeSource } from './native-source.js';
import { nativeMergeMessage, type NativeMergeResolution } from './native-merge.js';
import type { NativeInsertionOrder } from './native-text-merge.js';
import { conflictRule, markdownDoc, type ConflictRule } from './docs-resolution.js';
import { declaredMergePaths, FORGE_CONFIG_FILE, type DeclaredMergePaths } from './project-config.js';
export { DOCS_RULE, markdownDoc, conflictRule, type ConflictRule } from './docs-resolution.js';

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
/** forge.json files above this size declare no merge paths (the file is settings, not data). */
const CONFIG_MAX_BYTES = 128 * 1024;
/** The merge paths accepted `main` declares. Read from main only: the Lane being merged cannot
 * widen the rule for its own landing. One small object read, only on a conflicted composition. */
function mainMergePaths(source: NativeSource, main: string): DeclaredMergePaths {
  const file = source.state(main).files.find(item => item.path === FORGE_CONFIG_FILE);
  return mergePathsOf(file?.mode === 'file' ? source.object(file.blob) : undefined);
}
/** The merge paths main's forge.json bytes declare (none when absent or over CONFIG_MAX_BYTES).
 * Shared with the save's trial merge, so a notice never names what compose would merge. */
export function mergePathsOf(bytes: Buffer | undefined): DeclaredMergePaths {
  return !bytes || bytes.length > CONFIG_MAX_BYTES
    ? { union: [], fragments: [] }
    : declaredMergePaths(bytes.toString('utf8'));
}

/** diff3 groups of both sides' edits; each group with edits on both sides goes to `both`, which
 * returns its merged lines or null (the whole file then stays a conflict). */
function resolveGroups(
  base: Buffer,
  main: Buffer,
  lane: Buffer,
  both: (
    group: Edit[],
    original: string[],
    x: string[],
    y: string[],
    start: number,
    end: number,
  ) => string[] | null,
): Buffer | null {
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
          : both(group, original, x, y, start, end);
    if (!resolved) return null;
    output.push(...resolved);
  }
  output.push(...original.slice(cursor));
  // Never join two sides' lines when one side lacked a final newline.
  return Buffer.from(
    output.map((line, i) => (i < output.length - 1 && !line.endsWith('\n') ? `${line}\n` : line)).join(''),
  );
}

/** Deterministic resolution of a Markdown diff3 conflict, or null when any hunk is
 * ambiguous. Positional hunks keep both insertions (main first). Overlapping edits
 * resolve only inside list/table/blank lines: both sides' new lines, main first; or
 * when both sides only appended text to the end of one prose line: main's text first. */
export function resolveMarkdownText(base: Buffer, main: Buffer, lane: Buffer): Buffer | null {
  return resolveGroups(
    base,
    main,
    lane,
    (group, original, x, y, start, end) =>
      positional(group, original) ??
      listUnion(x, y, original.slice(start, end)) ??
      lineAppends(group, original),
  );
}

/** A declared shared list (forge.json `merge`): every conflicting hunk keeps main's entries, then
 * the Lane's new ones; an entry either side removed stays removed and an entry both added appears
 * once. `union` entries are lines; `fragments` entries are blocks separated by blank lines, so a
 * multi-line entry (a changelog section) stays whole. Text only; binary input stays a conflict. */
export function resolveListText(base: Buffer, main: Buffer, lane: Buffer, rule: ConflictRule): Buffer | null {
  if (rule === 'docs') return resolveMarkdownText(base, main, lane);
  return resolveGroups(base, main, lane, (_group, original, x, y, start, end) => {
    const region = original.slice(start, end);
    if (rule === 'union') return entryUnion(x.map(one), y.map(one), region.map(one)).flat();
    return joinBlocks(entryUnion(blocks(x), blocks(y), blocks(region)));
  });
}
const one = (line: string) => [line];
const blank = (line: string) => !line.trim();
const key = (entry: string[]) =>
  entry
    .filter(line => !blank(line))
    .map(line => line.trimEnd())
    .join('\n');
/** Main's entries (less base entries the Lane removed), then the Lane's entries main lacks. */
function entryUnion(x: string[][], y: string[][], region: string[][]) {
  const keys = (entries: string[][]) => new Set(entries.map(key)),
    base = keys(region),
    lane = keys(y),
    main = keys(x);
  return [
    ...x.filter(entry => !base.has(key(entry)) || lane.has(key(entry))),
    ...y.filter(entry => !main.has(key(entry)) && !base.has(key(entry))),
  ];
}
/** Blocks: each run of non-blank lines with the blank lines after it; leading blank lines alone. */
function blocks(region: string[]) {
  const result: string[][] = [];
  for (const line of region) {
    const last = result.at(-1);
    if (last && (blank(line) || !blank(last.at(-1)!))) last.push(line);
    else result.push([line]);
  }
  return result;
}
/** Blocks back to lines, with a blank line between two blocks that had none. */
function joinBlocks(entries: string[][]) {
  const output: string[] = [];
  for (const entry of entries) {
    const last = output.at(-1);
    if (last !== undefined && !blank(last) && !blank(entry[0]!)) {
      if (!last.endsWith('\n')) output[output.length - 1] = `${last}\n`;
      output.push(last.endsWith('\r\n') ? '\r\n' : '\n');
    }
    output.push(...entry);
  }
  return output;
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

/** Compose `lane` with `main`, resolving conflicts in Markdown docs and in main's declared shared
 * lists (forge.json `merge`) with the deterministic rules above. Null when any conflict is outside
 * them, binary, a delete, a path clash or an ambiguous hunk; callers keep conflicts.
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
  // Every conflict qualifies before any file bytes are read or requested. forge.json is read only
  // when main has one; without it only Markdown docs can qualify.
  const configured = source.state(main).files.some(item => item.path === FORGE_CONFIG_FILE);
  if (!configured && !merged.conflicts.every(item => markdownDoc(item.path))) return null;
  const declared = configured ? mainMergePaths(source, main) : { union: [], fragments: [] },
    rules = merged.conflicts.map(item => conflictRule(item.path, declared));
  for (const [i, item] of merged.conflicts.entries()) {
    const ours = item[mainOf],
      theirs = item[laneOf];
    if (!rules[i] || item.reason || !ours || !theirs || (!item.base && ours.mode !== theirs.mode))
      return null;
  }
  const files: NativeFile[] = [...merged.files];
  const blobs = merged.conflicts.map((item, i) =>
    source.docsContent
      ? source.docsContent(item, order, rules[i]!)
      : (() => {
          const bytes = resolveListText(
            item.base ? source.object(item.base.blob) : Buffer.alloc(0),
            source.object(item[mainOf]!.blob),
            source.object(item[laneOf]!.blob),
            rules[i]!,
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
