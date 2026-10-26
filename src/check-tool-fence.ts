// SPDX-License-Identifier: Apache-2.0
import { realpathSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { peersFileStamp } from './agent-peers-cache.js';
import type { CheckEnvironment } from './work-types.js';

/** Pin tool resolution and metadata around the byte observation. Publication
 * checks only these stamps, including missing earlier PATH candidates, without
 * hashing a large executable while holding the owner writer lock. */
export function checkToolFence(executables: string[], environment: CheckEnvironment) {
  const snapshot = () =>
    JSON.stringify(
      executables.map(executable => {
        const paths = isAbsolute(executable)
          ? [executable]
          : (environment.env.PATH ?? '')
              .split(delimiter)
              .filter(Boolean)
              .map(directory => join(directory, executable));
        const observed: unknown[] = [];
        for (const path of paths) {
          if (!isAbsolute(path)) {
            observed.push([path, 'relative']);
            break;
          }
          try {
            const locator = realpathSync(path),
              stat = statSync(locator);
            observed.push([path, locator, peersFileStamp(locator)]);
            if (stat.isFile() && (process.platform === 'win32' || stat.mode & 0o111)) break;
          } catch {
            observed.push([path, 'unavailable']);
          }
        }
        return observed;
      }),
    );
  const before = snapshot();
  return () => snapshot() === before;
}
