// SPDX-License-Identifier: Apache-2.0
'use node';

import type { Doc } from './_generated/dataModel';

import { type ExchangeObjectReader } from './projectExchangeReader';
import { exchangeRootSchema, isExchangeRoot, readByteTree } from '../src/native-exchange-tree';
import { recordMap, recordMetadata, workRecordRootSchema } from '../src/work-exchange-records';

import { sourceManifestSchema } from '../src/work-archive-metadata';
import { invariant } from '../src/errors';

export async function recordExchange(
  backup: Pick<Doc<'projectBackups'>, 'projectId' | 'digest' | 'size' | 'objectManifest'>,
  owner: string,
  reader: ExchangeObjectReader,
  bodyBudget = 8 * 1024 * 1024,
  metadataBatchSize = 100,
) {
  // Reuse authenticated record bodies across the validation phases of this one
  // action. This cache never serves a source-read endpoint or another action;
  // the underlying source readers recheck current authority and exact pins.
  // The underlying reader still checks authority on every actual storage read.
  const bodies = new Map<string, Promise<Buffer>>();
  let retained = 0;
  const readMany = async (pins: { sha256: string; size: number }[]) => {
    const missing = pins.filter(pin => !bodies.has(JSON.stringify([pin.sha256, pin.size])));
    if (missing.length) {
      const bytes = await reader.read(backup.projectId, owner, missing);
      for (const [index, pin] of missing.entries()) {
        if (retained + pin.size > bodyBudget) continue;
        retained += pin.size;
        bodies.set(JSON.stringify([pin.sha256, pin.size]), Promise.resolve(bytes[index]!));
      }
      const loaded = new Map(
        missing.map((pin, index) => [JSON.stringify([pin.sha256, pin.size]), bytes[index]!]),
      );
      return Promise.all(
        pins.map(
          pin =>
            bodies.get(JSON.stringify([pin.sha256, pin.size])) ??
            Promise.resolve(loaded.get(JSON.stringify([pin.sha256, pin.size]))!),
        ),
      );
    }
    return Promise.all(pins.map(pin => bodies.get(JSON.stringify([pin.sha256, pin.size]))!));
  };
  const read = (pin: { sha256: string; size: number }) => {
    const key = JSON.stringify([pin.sha256, pin.size]);
    const existing = bodies.get(key);
    if (existing) return existing;
    const result = reader.read(backup.projectId, owner, [pin]).then(bytes => bytes[0]!);
    if (retained + pin.size <= bodyBudget) {
      retained += pin.size;
      bodies.set(key, result);
      result.catch(() => {
        bodies.delete(key);
        retained -= pin.size;
      });
    }
    return result;
  };
  const bytes = await read({
    sha256: backup.objectManifest?.digest ?? backup.digest,
    size: backup.objectManifest?.size ?? backup.size,
  });
  const value: unknown = JSON.parse(bytes.toString('utf8'));
  if (!isExchangeRoot(value)) return;
  const root = exchangeRootSchema.parse(value);
  if (root.schema !== 2) return;
  // Metadata uses small content-defined chunks. Amortize their current-authority
  // lookups across bounded pin pages; byteTreeChunks still bounds each batch to
  // 2 MiB and verifies every chunk and the complete logical digest.
  const metadataOptions = { batchSize: metadataBatchSize };
  const recordBytes = await readByteTree(
    root.records,
    pins => reader.read(backup.projectId, owner, pins),
    metadataOptions,
  );
  const records = workRecordRootSchema.parse(JSON.parse(recordBytes.toString('utf8')));
  recordMap(records);
  invariant(
    records.work.sha256 === root.work.sha256 && records.work.size === root.work.size,
    'INVALID_WORK_BACKUP',
    'Exchange record root differs from logical Work.',
  );
  const manifestBytes = await readByteTree(
    root.manifest,
    pins => reader.read(backup.projectId, owner, pins),
    metadataOptions,
  );
  const manifest = sourceManifestSchema.parse(JSON.parse(manifestBytes.toString('utf8')));
  invariant(
    new Set(manifest.files.map(pin => pin.path)).size === manifest.files.length,
    'INVALID_WORK_BACKUP',
    'Manifest repeats a logical path.',
  );
  const sizes = new Map<string, number>();
  for (const pin of manifest.files) {
    invariant(
      !sizes.has(pin.sha256) || sizes.get(pin.sha256) === pin.size,
      'INVALID_WORK_BACKUP',
      'Identical content has inconsistent sizes.',
    );
    sizes.set(pin.sha256, pin.size);
  }
  const work = manifest.files.find(pin => pin.path === 'work.json'),
    metadata = recordMetadata(records);
  invariant(
    work?.sha256 === records.work.sha256 &&
      work.size === records.work.size &&
      metadata.revision === records.revision &&
      manifest.revision === records.revision &&
      manifest.kind === 'forge-native-work-backup' &&
      metadata.nativeHead === manifest.head,
    'INVALID_WORK_BACKUP',
    'Work record source or revision differs from its manifest.',
  );
  return {
    root,
    records,
    manifest,
    manifestBytes,
    read,
    readMany,
    releaseBodies() {
      bodies.clear();
      retained = 0;
    },
  };
}
