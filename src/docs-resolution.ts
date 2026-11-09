// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';

/** Markdown documentation, matching the standard check's docs scope. Runtime-neutral (no Node
 * globals) so Convex queue advice can tell docs paths apart; the rule itself is native-docs-resolve. */
export const markdownDoc = (path: string) => /^(?:docs\/.+|[^/]+)\.md$/.test(path);
export const DOCS_RULE = 'keep both sides, main first';
/** Paths named in a record; the count past them is `more`. */
export const DOCS_RESOLUTION_PATHS = 100;

/** What a hosted composition merged with the Markdown docs rule (Issue 561996ac). */
export const docsMergeSchema = z
  .object({
    paths: z.array(z.string().min(1)).min(1).max(DOCS_RESOLUTION_PATHS),
    more: z.number().int().positive().optional(),
    rule: z.literal(DOCS_RULE),
  })
  .strict();
export type DocsMerge = z.infer<typeof docsMergeSchema>;
/** A receipt's record: the merge plus how to undo it. */
export const docsResolutionSchema = docsMergeSchema.extend({ undo: z.string().min(1) }).strict();

export function docsMerge(paths: Iterable<string>): DocsMerge | undefined {
  const all = [...new Set(paths)].sort();
  if (!all.length) return undefined;
  const more = all.length - DOCS_RESOLUTION_PATHS;
  return { paths: all.slice(0, DOCS_RESOLUTION_PATHS), ...(more > 0 ? { more } : {}), rule: DOCS_RULE };
}
const where = "at each merged point main's lines come first, then the Lane's";
/** Undo for an accepted landing: revert it, or edit the listed paths in a new Lane. */
export function landingDocsUndo(receiptId: string) {
  return `Markdown conflicts were merged automatically (${where}). To undo, edit the listed paths in a new Lane and land it, or revert this whole landing: revert {"target":{"kind":"receipt","receiptId":"${receiptId}"}}.`;
}
/** Undo for a Lane sync: the Lane's prior head keeps the exact earlier bytes. */
export function syncDocsUndo(head: string) {
  return `Markdown conflicts were merged automatically (${where}). To undo, edit the listed paths in this Lane and save; show {"state":"${head}","path":"PATH"} returns each file as it was before this sync.`;
}
