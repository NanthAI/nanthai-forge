// SPDX-License-Identifier: Apache-2.0
import { jsonValue, recordManifest, recordIO, putCollection, stageRecords } from './work-records.js';
import { WorkRecordTransaction, type WorkCollection, type WorkRecord } from './work-record-transaction.js';
import { safeParseWork } from './work-unified-types.js';
import type { WorkData } from './work-types.js';

/** Reuse unchanged immutable collections and stage only changed records. Older
 * layouts and collection removals retain the complete serialization path. The
 * caller keeps a pending-record pin through the final pointer CAS. */
export function stageWorkEdit(directory: string, data: WorkData, before: string, pointer: Buffer | null) {
  const manifest = pointer && recordManifest(JSON.parse(pointer.toString('utf8')));
  if (
    !manifest ||
    manifest.schema === 'forge-work-records-v1' ||
    Object.values(manifest.collections).some(index => !index.lookup)
  )
    return stageRecords(directory, data);
  const previous = JSON.parse(before) as Record<string, unknown>;
  const next = jsonValue(data) as Record<string, unknown>;
  for (const [key, index] of Object.entries(manifest.collections)) {
    const old = previous[key],
      value = next[key];
    // legacyIntentMerge uses a single-record collection behind an object field.
    if (!Array.isArray(value) || !Array.isArray(old)) {
      if (JSON.stringify(old) !== JSON.stringify(value)) return stageRecords(directory, data);
    } else if (value.length < index.count) return stageRecords(directory, data);
  }
  const tx = new WorkRecordTransaction(directory, manifest, pointer!);
  try {
    manifest.fields = Object.fromEntries(
      Object.entries(next).filter(([key, value]) => !Array.isArray(value) && !manifest.collections[key]),
    );
    for (const [key, value] of Object.entries(next)) {
      if (!Array.isArray(value) || JSON.stringify(value) === JSON.stringify(previous[key])) continue;
      const parsed = safeParseWork(
        { ...manifest.fields, intents: [], lanes: [], views: [], [key]: [] },
        true,
      );
      if (parsed.success && !Object.hasOwn(parsed.data, key)) {
        manifest.collections[key] = putCollection(recordIO(directory), value, true);
        continue;
      }
      const collection = key as WorkCollection,
        old = previous[key] as unknown[] | undefined;
      if (!manifest.collections[key] && !value.length)
        manifest.collections[key] = putCollection(recordIO(directory), []);
      for (let position = 0; position < value.length; position++) {
        if (old && position < old.length) {
          if (JSON.stringify(value[position]) !== JSON.stringify(old[position]))
            tx.replace(collection, position, value[position] as WorkRecord<typeof collection>);
        } else tx.append(collection, value[position] as WorkRecord<typeof collection>);
      }
    }
    // Defaulted empty collections may have been absent in the older pointer.
    for (const [key, value] of Object.entries(next))
      if (Array.isArray(value) && !manifest.collections[key])
        manifest.collections[key] = putCollection(recordIO(directory), value, true);
    manifest.keys = Object.keys(next);
    return manifest;
  } finally {
    tx.dispose();
  }
}
