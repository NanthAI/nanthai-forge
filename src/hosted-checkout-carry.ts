// SPDX-License-Identifier: Apache-2.0
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { digest } from './hash.js';
import { ForgeError } from './errors.js';
import type { NativeFile } from './native-state-format.js';
import type { CheckoutChange } from './hosted-checkout-clean.js';
import type { CheckoutDelta } from './hosted-checkout-delta.js';

/* A sync applied in place moves only the paths its delta names. Unsaved changes anywhere else stay
 * exactly where they are under the new baseline, as Git carries them through a pull. A change that
 * meets the delta, or any change to Forge metadata, refuses before anything is installed. */

const metadata = (path: string) => path === '.forge' || path.startsWith('.forge/');

export function refuseMetadataChange(changes: readonly CheckoutChange[]) {
  const change = changes.find(item => metadata(item.path));
  if (change)
    throw new ForgeError(
      'WORK_CONFLICT',
      `Existing Forge metadata at ${JSON.stringify(change.path)} is preserved.`,
      undefined,
      { obstruction: { kind: 'unknown-metadata', path: change.path } },
    );
}

export function refuseDeltaConflict(
  root: string,
  changes: readonly CheckoutChange[],
  delta: CheckoutDelta,
  saved: readonly NativeFile[],
  target: readonly NativeFile[],
) {
  const change = deltaConflict(changes, delta);
  if (change)
    throw new ForgeError(
      'WORK_CONFLICT',
      `Local checkout changes at ${JSON.stringify(change.path)} are preserved.`,
      undefined,
      { obstruction: changeObstruction(root, change, saved, target) },
    );
}

/** The refusal detail a strict clean check gives for one local change. */
function changeObstruction(
  root: string,
  change: CheckoutChange,
  saved: readonly NativeFile[],
  target: readonly NativeFile[],
) {
  const { path } = change;
  if (metadata(path)) return { kind: 'unknown-metadata', path };
  if (change.kind === 'deleted') return { kind: 'deletion', path };
  const file = saved.find(item => item.path === path) ?? target.find(item => item.path === path);
  const at = join(root, path),
    stat = lstatSync(at);
  const bytes = stat.isSymbolicLink()
    ? readlinkSync(at, { encoding: 'buffer' })
    : stat.isFile() && stat.nlink === 1
      ? readFileSync(at)
      : null;
  return {
    path,
    kind: change.kind === 'edited' ? 'source-edit' : 'extra-source',
    expectedDigest: file?.blob ?? null,
    observedDigest: bytes ? digest(bytes) : null,
    expectedMode: file?.mode ?? null,
    observedMode: stat.isSymbolicLink()
      ? 'symlink'
      : stat.isFile()
        ? stat.mode & 0o111
          ? 'executable'
          : 'file'
        : 'other',
  };
}
/** Every local change that an in-place apply would move, replace or build on. */
export function deltaConflicts(changes: readonly CheckoutChange[], delta: CheckoutDelta) {
  const paths = [...delta.install, ...delta.remove].map(file => file.path);
  const meets = (path: string) =>
    metadata(path) ||
    paths.some(other => other === path || other.startsWith(`${path}/`) || path.startsWith(`${other}/`));
  return changes.filter(change => meets(change.path));
}
const deltaConflict = (changes: readonly CheckoutChange[], delta: CheckoutDelta) =>
  deltaConflicts(changes, delta)[0];
