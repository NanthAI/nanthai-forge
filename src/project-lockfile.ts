// SPDX-License-Identifier: Apache-2.0
import { pinLockfiles } from './ecosystems.js';

/** Root dependency lockfiles Forge recognises, from the ecosystem registry (src/ecosystems.ts), npm
 * first. A check pin names the first one present, so a pnpm, Yarn, Bun, Cargo, Go, Python, Ruby or PHP
 * project pins its own lockfile bytes instead of the empty digest; a project with
 * `package-lock.json` pins exactly what it pinned before. */
export const PROJECT_LOCKFILES: readonly string[] = pinLockfiles();

/** The project's lockfile path, or undefined when the root has none of PROJECT_LOCKFILES. */
export function projectLockfile(has: (path: string) => boolean): string | undefined {
  return PROJECT_LOCKFILES.find(path => has(path));
}
