// SPDX-License-Identifier: Apache-2.0
import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { exclusion } from './files.js';

/** Advisory metadata only: never follows symlinks or reads source bytes. Directory
 * timestamps are omitted so excluded build output cannot look like a source edit. */
export function observePresenceFiles(root: string) {
  let previous: string | undefined;
  const observe = () => {
    try {
      const files: string[][] = [];
      const walk = (directory: string) => {
        for (const name of readdirSync(join(root, directory)).sort()) {
          const path = directory ? `${directory}/${name}` : name;
          if (exclusion(path)) continue;
          let stat;
          try {
            stat = lstatSync(join(root, path), { bigint: true });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
            throw error;
          }
          if (stat.isDirectory()) walk(path);
          else
            files.push([
              path,
              ...[stat.dev, stat.ino, stat.size, stat.mode, stat.mtimeNs, stat.ctimeNs].map(String),
            ]);
        }
      };
      walk('');
      const current = JSON.stringify(files);
      const edited = previous !== undefined && current !== previous;
      previous = current;
      return edited;
    } catch {
      // An unavailable tree is unknown, not an empty tree or an edit. Retain the
      // last complete observation so recovery still compares against it.
      return false;
    }
  };
  observe();
  return observe;
}
