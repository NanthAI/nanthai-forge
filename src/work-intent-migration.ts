// SPDX-License-Identifier: Apache-2.0
import { closeSync, fsyncSync, openSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { invariant } from './errors.js';
import { digest } from './hash.js';
import { convertWorkTo18, intentMergeHash } from './work-intent-converter.js';
import {
  jsonValue,
  publishRecords,
  readRecords,
  readWorkFile,
  recordManifest,
  stageRecords,
} from './work-records.js';
import type { WorkStore } from './work-store.js';
import { unifiedWorkSchema, type UnifiedWorkData } from './work-unified-types.js';

export const intentMigrationReceiptFile = 'intent-merge-receipt.json';
const stableId = (seed: string) => {
  const h = digest(`intent-merge-v1:format18:migration:${seed}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
type Migrated = UnifiedWorkData & {
  intentMigration: { id: string; fromRevision: number; toRevision: number; workSha256: string };
};
function receiptOf(data: Migrated) {
  return { migrationId: data.intentMigration.id, ...data.intentMigration, receipt: data.intentMergeReceipt };
}
function writeReceipt(directory: string, value: unknown) {
  const temp = join(directory, `${intentMigrationReceiptFile}.${process.pid}.tmp`),
    fd = openSync(temp, 'w', 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value, null, 2) + '\n');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, join(directory, intentMigrationReceiptFile));
}

/**
 * Explicit, owner-locked migration of local Work to schema 18/20. Converted pages are staged as
 * content-addressed records and read back before one atomic commit-pointer rename; a failure
 * before the rename leaves the original pointer and every record untouched. The migration ID
 * derives from the original Work bytes, so a retry reproduces the same pages and receipt, and a
 * retry after the switch returns the recorded receipt without writing.
 */
export function migrateIntentWork(store: WorkStore, options: { beforeSwitch?: () => void } = {}) {
  return store.locked(
    () => {
      const current = store.load();
      if ([18, 20].includes(Number(current.schema))) {
        const data = current as unknown as Migrated;
        return {
          migrated: false,
          revision: data.revision,
          ...(data.intentMigration ? receiptOf(data) : { receipt: data.intentMergeReceipt }),
        };
      }
      store.records(); // Older commit pointers first take the existing validated record migration.
      const bytes = readWorkFile(store.directory)!,
        before = store.load(),
        workSha256 = digest(store.snapshotBytes());
      const converted = convertWorkTo18(before),
        id = stableId(workSha256);
      // New memberships continue each Initiative's displayed order after migrated placements.
      const placements = new Map<string, number>();
      for (const intent of converted.intents)
        for (const item of intent.memberships)
          placements.set(item.initiativeId, Math.max(placements.get(item.initiativeId) ?? 0, item.order + 1));
      const next: Migrated = {
        ...converted,
        revision: before.revision + 1,
        initiatives: converted.initiatives.map(item => ({
          ...item,
          nextMembershipOrder: Math.max(
            typeof item.nextMembershipOrder === 'number' ? item.nextMembershipOrder : 0,
            placements.get(item.id) ?? 0,
          ),
        })),
        intentMigration: { id, fromRevision: before.revision, toRevision: before.revision + 1, workSha256 },
      };
      unifiedWorkSchema.parse(next);
      const manifest = stageRecords(store.directory, next),
        staged = readRecords(store.directory, manifest);
      invariant(
        intentMergeHash(staged) === intentMergeHash(jsonValue(next)) &&
          unifiedWorkSchema.safeParse(staged).success,
        'INTENT_MIGRATION_INVALID',
        'Staged unified Work differs from its conversion. Original Work remains selected.',
      );
      const receipt = receiptOf(next);
      writeReceipt(store.directory, receipt);
      options.beforeSwitch?.();
      // The owner lock serializes writers; still refuse to switch over a different pointer.
      invariant(
        digest(readWorkFile(store.directory)!) === digest(bytes) &&
          recordManifest(JSON.parse(bytes.toString('utf8'))),
        'WORK_STALE',
        'Work changed during migration. Original Work remains selected; retry.',
      );
      publishRecords(store.directory, manifest);
      return { migrated: true, revision: next.revision, ...receipt };
    },
    { operation: 'intent migration' },
  );
}
