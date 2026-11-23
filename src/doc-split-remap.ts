// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
/** A declared split survives raw edits (Item 491ddd77).
 *
 * A split turns one shared document F into a skeleton (its headings and `Entries:` lines) plus
 * fragment files under `F.d/`, assembled by doc-fragments. While the split waits to land, other
 * Lanes keep landing raw edits to the old F. A plain merge of F always conflicts (the split
 * rewrote the whole file), so every raw edit used to send the split back for a manual fold.
 *
 * This moves each raw hunk into the file that now holds those lines, in either direction (a split
 * composed over raw edits, or a raw edit composed over a landed split). The rule is strict:
 * - every line of the split side's assembled page is tagged as a fragment line, a skeleton line,
 *   or a joiner (the blank line assembly puts between entries);
 * - a raw hunk that touches a range the split itself changed is a conflict;
 * - a replaced range must lie in one fragment, or in skeleton lines only; a range across two
 *   fragments, a joiner or an `Entries:` line is a conflict;
 * - an insertion joins the fragment ending just before it (sliding a blank-led insertion up past a
 *   joiner, which moves only its placement), else the fragment starting after it, else the skeleton
 *   when both neighbours are skeleton lines;
 * - proof: the new tree's assembled page must equal the split side's assembled page with the raw
 *   hunks applied, byte for byte. Anything else stays a conflict: nothing is lost or duplicated.
 * Pure: the caller supplies the texts and the split side's fragment reader.
 */
import {
  ENTRIES_LINE,
  assembleDocument,
  documentFragmentFolders,
  relinkMarkdown,
  tableRow,
  type FragmentReader,
} from './doc-fragments.js';
import { attributionEdits as edits } from './native-text-merge.js';

type Origin =
  | { kind: 'skeleton'; line: number }
  | { kind: 'fragment'; file: string; line: number }
  | { kind: 'joiner' }
  | { kind: 'entries' };
type Edit = { start: number; end: number; lines: string[] };
type Fragment = { directory: string; original: string; lines: string[] };

/** Lines as the native text merge splits them: each keeps its `\n`; a last line may lack one. */
const split = (text: string): string[] => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
const hasEntries = (text: string) => text.split('\n').some(line => ENTRIES_LINE.test(line));

/** The assembled page as lines, each tagged with where it lives. Null when an entry is empty
 * (assembly would drop or merge it) or when the result differs from the readers' assembly. */
function assembledLines(path: string, skeleton: string, reader: FragmentReader) {
  const base = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '.';
  const segments: { text: string; origin: Origin }[] = [];
  const fragments = new Map<string, Fragment>();
  const parts = skeleton.split('\n');
  for (const [index, part] of parts.entries()) {
    const folder = ENTRIES_LINE.exec(part)?.[1];
    let last: Origin = { kind: 'skeleton', line: index };
    if (!folder) segments.push({ text: part, origin: last });
    else {
      const directory = base === '.' ? folder : `${base}/${folder}`;
      let page = '';
      last = { kind: 'entries' };
      for (const name of reader
        .list(directory)
        .filter(item => item.endsWith('.md'))
        .sort()) {
        const file = `${directory}/${name}`,
          original = reader.read(file),
          entry = relinkMarkdown(original.replace(/\n+$/, ''), directory, base);
        if (!entry) return null;
        if (page) {
          const row = tableRow(page, entry);
          segments.push({ text: '\n', origin: last });
          if (!row) segments.push({ text: '\n', origin: { kind: 'joiner' } });
          page += row ? '\n' : '\n\n';
        }
        const lines = entry.split('\n');
        fragments.set(file, { directory, original, lines });
        for (const [line, text] of lines.entries()) {
          last = { kind: 'fragment', file, line };
          if (line) segments.push({ text: '\n', origin: segments.at(-1)!.origin });
          segments.push({ text, origin: last });
        }
        page += entry;
      }
    }
    // The newline after this part belongs to it: a blank line starts with it.
    if (index < parts.length - 1) segments.push({ text: '\n', origin: last });
  }
  const lines: { text: string; origin: Origin }[] = [];
  let open: { text: string; origin: Origin } | undefined;
  for (const segment of segments)
    for (const piece of segment.text.split(/(?<=\n)/)) {
      if (!piece) continue;
      open ??= { text: '', origin: segment.origin };
      open.text += piece;
      if (piece.endsWith('\n')) {
        lines.push(open);
        open = undefined;
      }
    }
  if (open) lines.push(open);
  const text = lines.map(line => line.text).join('');
  if (text !== assembleDocument(path, skeleton, reader)) return null;
  return { lines, fragments };
}

/** Does a raw edit touch a split edit? Same rule as the docs merge's grouping: ranges that
 * intersect, or an insertion at or inside the other's range. */
function touches(a: Edit, b: Edit) {
  const ai = a.start === a.end,
    bi = b.start === b.end;
  return ai && bi
    ? a.start === b.start
    : ai
      ? a.start >= b.start && a.start <= b.end
      : bi
        ? b.start >= a.start && b.start <= a.end
        : a.start < b.end && b.start < a.end;
}

/** A split: the split side's doc has `Entries:` lines, while the base and the raw side's do not. */
export const splitRecognised = (base: string, raw: string, skeleton: string) =>
  !hasEntries(base) && !hasEntries(raw) && hasEntries(skeleton);

/** How composition treats a docs conflict on `path` where `skeleton` may split the old file (base
 * and raw are its other two versions). One decision for compose and the save-time trial merge, so a
 * notice never predicts a conflict compose remaps:
 * - undefined: no split; the Markdown rule decides as before;
 * - 'conflict': a split compose keeps as a conflict (an `Entries:` folder outside `NAME.d/`, whose
 *   bytes the remap's proof would not see);
 * - 'remap': compose remaps the raw edits (its byte proof still has the last word). */
export function splitConflict(
  path: string,
  base: string,
  raw: string,
  skeleton: string,
): 'remap' | 'conflict' | undefined {
  if (!path.endsWith('.md') || !splitRecognised(base, raw, skeleton)) return undefined;
  const home = `${path.slice(0, -3)}.d/`;
  return documentFragmentFolders(path, skeleton).every(folder => `${folder}/`.startsWith(home))
    ? 'remap'
    : 'conflict';
}

export interface SplitRemap {
  /** The split side's skeleton, with any hunk that fell between skeleton lines. */
  skeleton: string;
  /** Fragment files (repository paths) the raw hunks went into, with their new text. */
  fragments: Map<string, string>;
}

/** Remap the raw side's edits of `path` (base -> raw) into the split side (skeleton plus the
 * fragments `reader` lists and reads). Null keeps the conflict. */
export function remapSplitEdit(input: {
  path: string;
  base: string;
  raw: string;
  skeleton: string;
  reader: FragmentReader;
}): SplitRemap | null {
  const { path, base, raw, skeleton, reader } = input;
  if (splitConflict(path, base, raw, skeleton) !== 'remap') return null;
  const assembled = assembledLines(path, skeleton, reader);
  if (!assembled) return null;
  const page = assembled.lines.map(line => line.text),
    original = split(base),
    splitEdits = edits(original, page),
    rawEdits = edits(original, split(raw));
  // Raw hunks in the assembled page's coordinates; any hunk touching the split's own edits stays.
  const hunks: Edit[] = [];
  for (const edit of rawEdits) {
    if (splitEdits.some(other => touches(edit, other))) return null;
    const shift = splitEdits
      .filter(other => other.start < edit.start)
      .reduce((sum, other) => sum + other.lines.length - (other.end - other.start), 0);
    hunks.push({ start: edit.start + shift, end: edit.end + shift, lines: edit.lines });
  }
  if (!hunks.length) return null;
  const merged: string[] = [];
  let cursor = 0;
  for (const hunk of hunks) {
    merged.push(...page.slice(cursor, hunk.start), ...hunk.lines);
    cursor = hunk.end;
  }
  merged.push(...page.slice(cursor));

  const origin = (index: number) => assembled.lines[index]?.origin;
  type Target = { file: string | null; start: number; end: number; lines: string[] };
  const targets: Target[] = [];
  const place = (file: string | null, start: number, end: number, lines: string[]) =>
    targets.push({ file, start, end, lines });
  let floor = 0;
  for (const hunk of hunks) {
    if (hunk.start < hunk.end) {
      const first = origin(hunk.start)!,
        inside = assembled.lines.slice(hunk.start, hunk.end).map(line => line.origin);
      if (first.kind === 'fragment') {
        if (!inside.every(item => item.kind === 'fragment' && item.file === first.file)) return null;
        place(first.file, first.line, first.line + inside.length, hunk.lines);
      } else if (first.kind === 'skeleton') {
        if (!inside.every((item, i) => item.kind === 'skeleton' && item.line === first.line + i)) return null;
        place(null, first.line, first.line + inside.length, hunk.lines);
      } else return null;
    } else {
      let at = hunk.start,
        lines = hunk.lines;
      const before = origin(at - 1);
      if (before?.kind !== 'fragment') {
        // A blank-led paragraph the diff placed after a joiner or blank skeleton line: the same
        // bytes inserted one line earlier end the fragment above. Placement only, never content.
        let slid = at,
          moved = lines;
        while (slid > floor && origin(slid - 1)?.kind !== 'fragment' && moved.at(-1) === page[slid - 1]) {
          moved = [page[slid - 1]!, ...moved.slice(0, -1)];
          slid--;
        }
        if (slid < at && origin(slid - 1)?.kind === 'fragment') {
          at = slid;
          lines = moved;
        }
      }
      const above = origin(at - 1),
        below = origin(at);
      if (above?.kind === 'fragment') place(above.file, above.line + 1, above.line + 1, lines);
      else if (below?.kind === 'fragment') place(below.file, below.line, below.line, lines);
      else if (
        (at === 0 || above?.kind === 'skeleton') &&
        (at === page.length || below?.kind === 'skeleton')
      ) {
        const line =
          above?.kind === 'skeleton' ? above.line + 1 : below?.kind === 'skeleton' ? below.line : 0;
        place(null, line, line, lines);
      } else return null;
    }
    floor = hunk.end;
  }

  // Apply per file, last hunk first. Fragment lines here are the assembled (relinked) lines, each
  // with its newline (the last one borrows the newline assembly adds after the entry).
  const home = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '.';
  let skeletonLines = split(skeleton);
  const fragments = new Map<string, string>();
  const byFile = new Map<string | null, Target[]>();
  for (const target of targets) byFile.set(target.file, [...(byFile.get(target.file) ?? []), target]);
  for (const [file, list] of byFile) {
    list.sort((a, b) => b.start - a.start);
    if (file === null) {
      for (const target of list)
        skeletonLines = [
          ...skeletonLines.slice(0, target.start),
          ...target.lines,
          ...skeletonLines.slice(target.end),
        ];
      continue;
    }
    const fragment = assembled.fragments.get(file)!;
    // The file's own lines (links as written in the fragment), index for index with the
    // assembled lines: relinking rewrites link targets only, never line breaks.
    const stripped = fragment.original.replace(/\n+$/, ''),
      tail = fragment.original.slice(stripped.length),
      own = stripped.split('\n').map(line => `${line}\n`);
    if (own.length !== fragment.lines.length) return null;
    let next = own;
    for (const target of list) {
      const added = split(relinkMarkdown(target.lines.join(''), home, fragment.directory));
      next = [...next.slice(0, target.start), ...added, ...next.slice(target.end)];
    }
    const text = next.join('');
    if (!text.endsWith('\n')) return null;
    fragments.set(file, `${text.slice(0, -1)}${tail}`);
  }
  const result = { skeleton: skeletonLines.join(''), fragments };
  const proof = assembleDocument(path, result.skeleton, {
    list: directory => reader.list(directory),
    read: file => fragments.get(file) ?? reader.read(file),
  });
  return proof === merged.join('') && !hasNewEntries(skeleton, result.skeleton) ? result : null;
}

/** A raw hunk may edit skeleton prose, never add or change an `Entries:` line. */
const hasNewEntries = (before: string, after: string) => {
  const entries = (text: string) =>
    text
      .split('\n')
      .filter(line => ENTRIES_LINE.test(line))
      .join('\n');
  return entries(before) !== entries(after);
};
