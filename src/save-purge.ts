// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { invariant } from './errors.js';
import { digest } from './state/hash.js';
import { safeRelative } from './safe-relative.js';
import type { NativeState } from './state/format.js';

/** Owner purge of one save's stored bytes after a real leak (Item 9d3c407d, owner decision Q83). */
export const SAVE_PURGE_MAX_PATHS = 100;
export const SAVE_PURGE_CONFIRMATION = 'PURGE';
const oid = z.string().regex(/^[0-9a-f]{64}$/);
export const savePurgeInputSchema = z
  .object({
    operationId: z.uuid(),
    laneId: z.uuid(),
    /** The save: its head State and the State it was saved over. */
    head: oid,
    parent: oid,
    paths: z
      .array(z.string().min(1).max(4096).refine(safeRelative))
      .min(1)
      .max(SAVE_PURGE_MAX_PATHS)
      .refine(paths => new Set(paths).size === paths.length, 'Name each path once.'),
  })
  .strict();
export type SavePurgeInput = z.infer<typeof savePurgeInputSchema>;
export type SavePurgeFile = { path: string; blob: string };

/** The blobs one purge removes: each named path's bytes in the save's head, which the save itself
 * changed. `parent` is the head's own parent (one save) or the Lane's base (everything the Lane
 * wrote, as the Lane page shows it). Refused, before anything is marked: a path not changed, a link or submodule
 * pointer, an empty file, and bytes current main holds at any path (purging them would break main:
 * a landed leak needs a history rewrite, not a save purge). */
export function savePurgeSelection(
  input: Pick<SavePurgeInput, 'head' | 'parent' | 'paths'>,
  states: { head: NativeState; parent: NativeState; main: NativeState },
  base?: string,
) {
  invariant(
    states.head.parents.includes(input.parent) || input.parent === base,
    'BAD_ARGUMENT',
    'Select a save (its head and the State it was saved over) or the Lane head and its base.',
  );
  const before = new Map(states.parent.files.map(file => [file.path, file])),
    after = new Map(states.head.files.map(file => [file.path, file])),
    onMain = new Set(states.main.files.map(file => file.blob)),
    empty = digest('');
  const files: SavePurgeFile[] = [];
  for (const path of input.paths) {
    const file = after.get(path);
    invariant(
      file && (file.mode === 'file' || file.mode === 'executable'),
      'BAD_ARGUMENT',
      `${JSON.stringify(path)} is not a file in this save.`,
    );
    invariant(
      before.get(path)?.blob !== file.blob,
      'BAD_ARGUMENT',
      `This save did not change ${JSON.stringify(path)}; purge the save that did.`,
    );
    invariant(file.blob !== empty, 'BAD_ARGUMENT', `${JSON.stringify(path)} is empty; nothing to purge.`);
    invariant(
      !onMain.has(file.blob),
      'BAD_ARGUMENT',
      `Main holds the bytes of ${JSON.stringify(path)}, so purging them would break main. A landed leak needs its history rewritten; rotate the credential now.`,
    );
    files.push({ path, blob: file.blob });
  }
  return files;
}

/** The PURGED refusal every read of a purged object returns, value-free. */
export function purgedMessage(purged: { at: number; operationId: string }) {
  return `These saved bytes were purged by the project owner at ${new Date(purged.at).toISOString()} (purge ${purged.operationId}). Save the Lane without that file to go on.`;
}

/** The tombstone text kept in the Lane's history: what, when (the event time) and by whom (its author). */
export function purgeTombstone(head: string, files: readonly SavePurgeFile[]) {
  const listed = files.slice(0, 20).map(file => file.path);
  const more = files.length > listed.length ? ` and ${files.length - listed.length} more` : '';
  return `Purged the stored bytes of ${files.length} file(s) saved in ${head.slice(0, 12)} after a credential leak: ${listed.join(', ')}${more}. Reads of them now return PURGED; rotate the credential at its provider.`;
}
