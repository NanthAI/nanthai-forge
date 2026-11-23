// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
/** Shared documents split into one file per entry (Item 491ddd77).
 *
 * Nearly every Lane added a paragraph to a few shared documents, so their paths overlapped on
 * almost every landing and each overlap paid a full re-check. A split document keeps its headings
 * and, per section, one line `Entries: [NAME.d/SECTION](NAME.d/SECTION/)`; the entries are files
 * in that folder, one per entry, assembled in file-name order (a table-row entry joins the table
 * before it). Every reader (`nforge docs`, the
 * docs site, llms.txt, the package inventory) reads the assembled text, so it gets the same answer
 * as before the split. Links inside an entry are relative to the entry file, so they resolve on
 * GitHub and in the foundation link check; assembly rewrites them relative to the document.
 * Pure: the caller supplies directory listing and file reads.
 */
import { posix } from 'node:path';

export const ENTRIES_LINE = /^Entries: \[([^\]\s]+\.d\/[^\]\s]+)\]\(\1\/\)$/;
/** Entry files live under a `NAME.d/` folder next to `NAME.md`; they are never documents on their own. */
export const isDocumentFragment = (path: string) => /(?:^|\/)[^/]+\.d\//.test(path) && path.endsWith('.md');

export interface FragmentReader {
  /** File names (not paths) in a repository-relative folder; empty when it does not exist. */
  list(directory: string): string[];
  read(path: string): string;
}

const LINK = /(\[[^\]]*\]\()([^\s)]+)((?:\s+"[^"]*")?\))/g;
const relativeTarget = (target: string) => !/^(?:[a-z]+:|#|\/)/i.test(target);

/** Rewrites relative inline links written from `from` so they resolve from `to` (both folders).
 * Code fences stay as written, split exactly as the foundation link check splits them. */
export function relinkMarkdown(text: string, from: string, to: string): string {
  if (from === to) return text;
  return text
    .split(/(```[\s\S]*?```)/)
    .map((part, index) => (index % 2 ? part : relinkProse(part, from, to)))
    .join('');
}
function relinkProse(line: string, from: string, to: string): string {
  return line.replace(LINK, (whole, open: string, target: string, close: string) => {
    if (!relativeTarget(target)) return whole;
    const hash = target.indexOf('#');
    const path = hash < 0 ? target : target.slice(0, hash);
    const anchor = hash < 0 ? '' : target.slice(hash);
    if (!path) return whole;
    let moved = posix.relative(to, posix.join(from, path)) || '.';
    if (path.endsWith('/') && !moved.endsWith('/')) moved += '/';
    return `${open}${moved}${anchor}${close}`;
  });
}

/** An entry that is a table row continues the table the entry before it ended, so a table can
 * keep one row per file and still assemble whole. */
export const tableRow = (page: string, entry: string) =>
  entry.startsWith('|') && page.slice(page.lastIndexOf('\n') + 1).startsWith('|');

/** The entry folders a document names, repository-relative. */
export function documentFragmentFolders(path: string, text: string): string[] {
  const base = posix.dirname(path);
  return text
    .split('\n')
    .flatMap(line => ENTRIES_LINE.exec(line)?.[1] ?? [])
    .map(folder => posix.join(base, folder));
}

/** The document as readers see it: each entries line replaced by its folder's entries. A document
 * without entries lines is returned unchanged. */
export function assembleDocument(path: string, text: string, reader: FragmentReader): string {
  if (!text.includes('Entries: [')) return text;
  const base = posix.dirname(path);
  return text
    .split('\n')
    .map(line => {
      const folder = ENTRIES_LINE.exec(line)?.[1];
      if (!folder) return line;
      const directory = posix.join(base, folder);
      return reader
        .list(directory)
        .filter(name => name.endsWith('.md'))
        .sort()
        .map(name => relinkMarkdown(reader.read(`${directory}/${name}`).replace(/\n+$/, ''), directory, base))
        .reduce(
          (page, entry) => (page ? `${page}${tableRow(page, entry) ? '\n' : '\n\n'}${entry}` : entry),
          '',
        );
    })
    .join('\n');
}
