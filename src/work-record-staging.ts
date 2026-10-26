// SPDX-License-Identifier: Apache-2.0
import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { workLocked } from './work-lock.js';
import { readSource } from './files.js';
import { processAlive, processIdentity } from './local-process.js';

/** Lock order: owner then this short publication fence. A staging writer holds
 * only this fence while announcing itself, and releases it before owner admission. */
export function recordCollectionFence<T>(directory: string, run: () => T): T {
  return workLocked(join(directory, 'record-collection-lock'), run, {
    operation: 'record staging/collection',
  });
}
export function pendingRecordWriter(directory: string): () => void {
  const staging = join(directory, 'record-staging');
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  const path = join(staging, `${randomUUID()}.json`);
  writeFileSync(path, JSON.stringify({ ...processIdentity(), host: hostname() }), {
    flag: 'wx',
    mode: 0o600,
  });
  // Announce before checking the fence. If collection already passed its root
  // scan, wait before writing any page. If it begins after this check, it sees
  // our pin. Ordinary writers need no additional lock admission.
  if (existsSync(join(directory, 'record-collection-lock'))) recordCollectionFence(directory, () => {});
  return () => {
    try {
      unlinkSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  };
}

/** Source-object collection shares the record fence: a staged record can already
 * name a detail object before its owner pointer is published. */
export function activeRecordWriters(directory: string) {
  const staging = join(directory, 'record-staging');
  if (!existsSync(staging)) return false;
  for (const name of readdirSync(staging)) {
    const bytes = readSource(staging, name, 4096);
    if (!bytes) return true;
    try {
      const value = JSON.parse(bytes.toString('utf8'));
      if (value.host !== hostname() || processAlive(value)) return true;
    } catch {
      return true;
    }
  }
  return false;
}
