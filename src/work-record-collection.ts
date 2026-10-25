import { recordCollectionFence } from './work-record-staging.js';
// SPDX-License-Identifier: Apache-2.0
import { lstatSync, readdirSync, unlinkSync, type Stats } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { invariant } from './errors.js';
import { recordObject } from './work-records.js';
import { recordRoots } from './work-record-reachability.js';
import { backupRecordsOwner, verifiedRecordBackup } from './work-record-backup.js';
import { syncDirectory } from './native-durability.js';
import type { WorkStore } from './work-store.js';

export const collectRecordsSchema = z.object({
  action: z.literal('collect-records'),
  operationId: z.uuid().optional(),
  apply: z.boolean().default(false),
  backup: z.boolean().default(false),
});
type Page = { id: string; bytes: number };
/** Reads never take a lock or create a backup. Application serializes with Work
 * publication; every deletion is independently retryable and leaves all retained
 * roots intact. Active writers pin pages before staging and wait out collection. */
export function collectRecords(store: WorkStore, input: unknown, hooks: { removed?(page: Page): void } = {}) {
  const command = collectRecordsSchema.parse(input);
  const run = () => {
    const began = performance.now(),
      revision = store.revision(),
      directory = join(store.directory, 'records'),
      candidates: Page[] = [],
      kept: (Page & { reasons: string[] })[] = [],
      preserved: { name: string; reason: string }[] = [];
    const inventory = new Map<string, Stats>();
    for (const name of readdirSync(directory)) {
      const info = lstatSync(join(directory, name));
      if (/^[a-f0-9]{64}$/.test(name) && info.isFile() && !info.isSymbolicLink() && info.nlink === 1)
        inventory.set(name, info);
      else preserved.push({ name, reason: 'Not an ordinary immutable record page.' });
    }
    const roots = recordRoots(store, new Set(inventory.keys()));
    for (const [id, info] of inventory) {
      const reasons = roots.kept.get(id);
      if (reasons) kept.push({ id, bytes: info.size, reasons: [...reasons].sort() });
      else {
        try {
          recordObject(store.directory, id);
        } catch {
          preserved.push({
            name: id,
            reason: 'Unreferenced page could not be verified; retained for diagnosis.',
          });
          continue;
        }
        candidates.push({ id, bytes: info.size });
      }
    }
    let backup;
    if (command.apply) {
      invariant(store.native, 'UNSUPPORTED_NATIVE_WORK', 'Apply record collection to a native owner.');
      backup = command.backup ? backupRecordsOwner(store, revision) : verifiedRecordBackup(store, revision);
      invariant(
        backup,
        'RECORD_BACKUP_REQUIRED',
        'A verified full-directory backup of the current Work revision is required. Select backup:true to create one before collection.',
      );
    }
    const removed: Page[] = [];
    for (const page of command.apply ? candidates : []) {
      const path = join(directory, page.id),
        before = inventory.get(page.id)!,
        info = lstatSync(path);
      invariant(
        info.isFile() &&
          !info.isSymbolicLink() &&
          info.nlink === 1 &&
          info.ino === before.ino &&
          info.size === before.size &&
          info.mtimeMs === before.mtimeMs,
        'SOURCE_CHANGED',
        'Record page changed during collection; retry to recompute reachability.',
      );
      recordObject(store.directory, page.id);
      unlinkSync(path);
      removed.push(page);
      hooks.removed?.(page);
    }
    if (command.apply) syncDirectory(directory);
    const bytes = (pages: Page[]) => pages.reduce((total, page) => total + page.bytes, 0);
    return {
      revision,
      result: {
        action: command.action,
        dryRun: !command.apply,
        before: {
          pages: inventory.size,
          bytes: [...inventory.values()].reduce((total, info) => total + info.size, 0),
        },
        retained: { pages: kept.length, bytes: bytes(kept) },
        reclaimable: { pages: candidates.length, bytes: bytes(candidates) },
        afterBytes:
          bytes(kept) +
          [...inventory]
            .filter(([id]) => preserved.some(item => item.name === id))
            .reduce((total, [, info]) => total + info.size, 0),
        kept,
        candidates,
        removed,
        preserved,
        ...(backup ? { backup: { path: backup.path, revision: backup.revision, at: backup.at } } : {}),
        durationMs: performance.now() - began,
        coverage:
          'Current Work closure, kept backup Work pins, unexpired closed-Lane/latest open-Lane snapshots and pending local metadata pins. Source objects and evidence files are untouched. Backup archives created by export-work contain self-contained portable Work and do not reference local pages.',
        ...(command.apply
          ? {
              undo: `Restore the full owner directory from ${backup!.path} into a separate directory; the backup includes every removed page.`,
            }
          : {}),
      },
    };
  };
  return command.apply
    ? store.locked(() => recordCollectionFence(store.directory, run), { operation: 'collect Work records' })
    : run();
}
