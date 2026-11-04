// SPDX-License-Identifier: Apache-2.0
import { lstatSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { dirname, isAbsolute, join, sep } from 'node:path';
import { z } from 'zod';
import { ForgeError } from './errors.js';
import { durableReplace, syncDirectory } from './native-durability.js';

// Artifacts are native filesystem names, not portable source paths. Preserve
// names containing newlines or POSIX backslashes without allowing traversal.
const planSchema = z.array(
  z
    .string()
    .refine(
      path =>
        path.length > 0 &&
        !isAbsolute(path) &&
        !path.includes('\0') &&
        path
          .split(sep === '\\' ? /[\\/]/ : /\//)
          .every(part => part !== '.' && part !== '..' && part.length > 0),
    ),
);
function exists(path: string) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
/** Journal before swapping directories. Artifacts move only after the new tree
 * is installed, so a failed private stage never owns the user's only copy. */
export function planCheckoutPreservation(path: string, artifacts: string[]) {
  durableReplace(path, JSON.stringify(planSchema.parse(artifacts)));
}
function parents(root: string, path: string, create: boolean) {
  const realDirectory = (directory: string) => {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new ForgeError(
        'WORK_CONFLICT',
        `Artifact parent at ${JSON.stringify(path)} changed. Both checkout copies are preserved; retain the obstruction and replay the original operation.`,
        undefined,
        { obstruction: { kind: 'extra-source', path } },
      );
  };
  let directory = root;
  realDirectory(directory);
  for (const name of path.split('/').slice(0, -1)) {
    const parent = directory;
    directory = join(directory, name);
    if (create && !exists(directory)) {
      mkdirSync(directory);
      syncDirectory(parent);
    }
    realDirectory(directory);
  }
}
/** Resume individual renames from the retained old checkout. Never merge,
 * replace or unlink an occupied destination, including dangling links. */
export function preserveCheckoutArtifacts(
  root: string,
  previous: string,
  plan: string,
  legacyPlan: () => string[],
) {
  if (!exists(previous)) return;
  // Older interrupted installs have no artifact journal. Validate their saved
  // checkout before deriving it; an absent journal never means disposable bytes.
  if (!exists(plan)) planCheckoutPreservation(plan, legacyPlan());
  const paths = planSchema.parse(JSON.parse(readFileSync(plan, 'utf8')));
  for (const path of paths) {
    parents(previous, path, false);
    parents(root, path, true);
    const from = join(previous, path),
      to = join(root, path);
    if (exists(from)) {
      if (exists(to))
        throw new ForgeError(
          'WORK_CONFLICT',
          `Local artifact at ${JSON.stringify(path)} changed during apply. Both copies are preserved; retain the obstruction and replay the original operation.`,
          undefined,
          { obstruction: { kind: 'extra-source', path } },
        );
      renameSync(from, to);
    } else if (!exists(to))
      throw new ForgeError(
        'WORK_CONFLICT',
        `Local artifact at ${JSON.stringify(path)} moved during apply. The prior checkout is preserved.`,
        undefined,
        { obstruction: { kind: 'deletion', path } },
      );
    // Repeat directory barriers even if the rename completed before interruption.
    syncDirectory(dirname(from));
    syncDirectory(dirname(to));
  }
}
