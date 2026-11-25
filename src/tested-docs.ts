// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
/** Markdown files a test, build or check script may read ("tested docs").
 *
 * Owner decision 2026-11-06 (Issue 7fe54c7c): a change still lands on its first
 * check when the only overlap with main's gains is a text-clean merge of
 * Markdown, unless a test or script reads that Markdown. The runner computes
 * this list from the exact checked source and pins it in the check selection,
 * so the server reads no source and any CI can produce it.
 *
 * The signal is deliberately coarse: a Markdown file counts as tested when its
 * file name (case-insensitive) appears in any text file of
 * the repository. That covers literal reads (`readFileSync('docs/x.md')`),
 * fixtures that reuse a real name, and manifests that list documents (the docs
 * package manifest, llms sources). Directory walkers that only read paths,
 * links, final newlines or forbidden lines stay prose: a clean merge keeps each
 * side's lines, and the main audit covers the rest. Doubt means tested; a missing
 * or over-cap list makes every Markdown file tested.
 */
export const TESTED_DOCS_RULE = 'name-mention-v2';
/** More entries than this and the list is dropped (every Markdown is tested). */
export const TESTED_DOCS_MAX = 4096;
export type TestedDocs = { rule: typeof TESTED_DOCS_RULE; paths: string[] };
export const markdownPath = (path: string) => /\.md$/i.test(path);
/** Binary and media files never name a document. Every other file with an extension is read as text, whatever
 * its language: a test or script in any ecosystem can read a Markdown file (`include_str!`, `os.ReadFile`,
 * `open`). `read` returns undefined for non-text. */
const binaryFile =
  /\.(?:png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|eot|pdf|zip|gz|tgz|wasm|mp[34]|mov|webm|bin)$/i;
/** An executable script with no extension: read only when its first line is a shebang. */
const extensionless = (path: string) => !path.startsWith('node_modules/') && !baseName(path).includes('.');
const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1).toLowerCase();

/** `read` returns a file's text, or undefined when it is not readable as text. */
export function testedDocs(
  paths: Iterable<string>,
  read: (path: string) => string | undefined,
): TestedDocs | undefined {
  const readerPath = (path: string) =>
    !path.startsWith('node_modules/') &&
    !markdownPath(path) &&
    !binaryFile.test(path) &&
    baseName(path).includes('.');
  const all = [...paths];
  const docs = all.filter(markdownPath);
  if (!docs.length) return { rule: TESTED_DOCS_RULE, paths: [] };
  const wanted = new Set(docs.map(baseName));
  const named = new Set<string>();
  for (const path of all) {
    if (named.size === wanted.size) continue;
    const bare = !readerPath(path) && extensionless(path);
    if (!bare && !readerPath(path)) continue;
    const text = read(path);
    if (text === undefined || (bare && !text.startsWith('#!'))) continue;
    for (const match of text.matchAll(/[\w.@-]*\.md\b/gi)) {
      const name = match[0].toLowerCase();
      if (wanted.has(name)) named.add(name);
    }
  }
  const tested = docs.filter(path => named.has(baseName(path))).sort();
  return tested.length > TESTED_DOCS_MAX ? undefined : { rule: TESTED_DOCS_RULE, paths: tested };
}

/** The pinned list from a check selection, or undefined (every Markdown tested). */
export function pinnedTestedDocs(selection: Record<string, unknown> | null): Set<string> | undefined {
  const value = selection?.testedDocs as Partial<TestedDocs> | undefined;
  if (
    !value ||
    value.rule !== TESTED_DOCS_RULE ||
    !Array.isArray(value.paths) ||
    value.paths.length > TESTED_DOCS_MAX ||
    value.paths.some(path => typeof path !== 'string')
  )
    return undefined;
  return new Set(value.paths);
}
