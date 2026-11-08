// SPDX-License-Identifier: Apache-2.0
// Spelling-only renames (case or Unicode normalization) inside an in-place delta apply.
import { readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { checkoutPathExists as exists } from './hosted-checkout-files.js';
import {
  deltaPendingError,
  spelledExactly,
  type DeltaJournal,
  type DeltaRespell,
} from './hosted-checkout-delta.js';

const rerun = 'Move it out of the checkout, then rerun the command.';
/** With a spelling change, a path the apply moves or removes counts only under its exact
 * spelling: a case-insensitive lookup could otherwise find (and move) the other spelling's bytes.
 * Paths it installs over still use the plain lookup, so another spelling is kept, never replaced. */
export const exactly = (root: string, journal: DeltaJournal) =>
  journal.respell
    ? (path: string) => exists(join(root, path)) && spelledExactly(root)(path)
    : (path: string) => exists(join(root, path));
export const parentOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
const leafOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);
function names(root: string, directory: string) {
  try {
    return new Set(readdirSync(join(root, directory)));
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return null;
    throw error;
  }
}
/** Give a directory its new spelling through a temporary name in the same parent (a direct
 * case-only rename is a no-op on some case-insensitive filesystems). Each step is decided from the
 * exact entries, so a resumed apply finishes from wherever it stopped. */
export function respellForward(root: string, entry: DeltaRespell, track: (path: string) => void) {
  const parent = parentOf(entry.path),
    listed = names(root, parent);
  if (!listed) return;
  track(entry.path);
  const temporary = join(root, parent, entry.temporary),
    final = join(root, entry.path);
  if (listed.has(leafOf(entry.path))) {
    if (listed.has(entry.temporary))
      throw deltaPendingError(
        `${JSON.stringify(entry.path)} appeared while its old spelling was being renamed.`,
        entry.path,
        rerun,
      );
    return;
  }
  if (!listed.has(entry.temporary)) {
    if (!listed.has(leafOf(entry.from))) return; // Emptied and removed: the install makes it.
    renameSync(join(root, parent, leafOf(entry.from)), temporary);
  }
  renameSync(temporary, final);
}
/** Undo a respell: the new spelling (or the temporary) goes back to the installed spelling, only
 * while the installed spelling is not itself an entry. */
export function respellBack(root: string, entry: DeltaRespell, track: (path: string) => void) {
  const parent = parentOf(entry.path),
    listed = names(root, parent),
    old = leafOf(entry.from);
  if (!listed || listed.has(old)) return;
  track(entry.path);
  const temporary = join(root, parent, entry.temporary);
  if (!listed.has(entry.temporary)) {
    if (!listed.has(leafOf(entry.path))) return;
    renameSync(join(root, entry.path), temporary);
  }
  renameSync(temporary, join(root, parent, old));
}
