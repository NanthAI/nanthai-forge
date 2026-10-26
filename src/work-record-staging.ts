// SPDX-License-Identifier: Apache-2.0
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { durableReplace } from './native-durability.js';
import { workLocked } from './work-lock.js';
import { processIdentity } from './local-process.js';

/** Lock order: owner then this short publication fence. A staging writer holds
 * only this fence while announcing itself, and releases it before owner admission. */
export function recordCollectionFence<T>(directory: string, run: () => T): T {
  return workLocked(join(directory, 'record-collection-lock'), run, {
    operation: 'record staging/collection',
  });
}
export function pendingRecordWriter(directory: string) {
  const staging = join(directory, 'record-staging');
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  const path = join(staging, `${randomUUID()}.json`);
  const identity = { ...processIdentity(), host: hostname() };
  const details = new Map<string, { sha256: string; size: number }>();
  writeFileSync(path, JSON.stringify(identity), {
    flag: 'wx',
    mode: 0o600,
  });
  // Announce before checking the fence. If collection already passed its root
  // scan, wait before writing any page. If it begins after this check, it sees
  // our pin. Ordinary writers need no additional lock admission.
  if (existsSync(join(directory, 'record-collection-lock'))) recordCollectionFence(directory, () => {});
  return Object.assign(
    () => {
      try {
        unlinkSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    },
    {
      pin(pin: { sha256: string; size: number }) {
        details.set(pin.sha256, pin);
        durableReplace(
          path,
          Buffer.from(
            JSON.stringify({ ...identity, details: [...details.values()].map(detailRef => ({ detailRef })) }),
          ),
        );
        // Announce before the fence, then write/rewrite the object after any
        // collector which already scanned the previous marker has finished.
        if (existsSync(join(directory, 'record-collection-lock'))) recordCollectionFence(directory, () => {});
      },
    },
  );
}
