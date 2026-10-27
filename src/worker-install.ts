// SPDX-License-Identifier: Apache-2.0
import { realpathSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { invariant } from './errors.js';

export function pinWorkerInstall(moduleUrl: string) {
  const directory = realpathSync(dirname(fileURLToPath(moduleUrl)));
  const identity = statSync(directory);
  return (workerUrl: URL | string) => {
    const path = fileURLToPath(workerUrl);
    let same = false;
    try {
      const current = statSync(directory);
      same =
        current.dev === identity.dev &&
        current.ino === identity.ino &&
        dirname(realpathSync(path)) === directory;
    } catch {
      /* A moved install is no longer the parent's loaded package. */
    }
    invariant(
      same,
      'WORKER_INSTALL_MISMATCH',
      'Worker install differs from its parent; restart the owner from the selected install.',
    );
    return realpathSync(path);
  };
}
export const workerPath = pinWorkerInstall(import.meta.url);
