// SPDX-License-Identifier: Apache-2.0
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { NativeSource } from './native-source.js';
import type { RecoveryObjects } from './recovery-hosted-objects.js';
import type { RecoveryTransport } from './recovery-source.js';
import type { DownloadPin } from './blob-download-format.js';
import type { HostedRecoveryPage } from './recovery-hosted-protocol.js';
import { physicalArchiveObjects } from './physical-source-archive.js';
import { PhysicalManifestReader } from './physical-manifest.js';
import { canonicalPayload } from './hosted-source-operation.js';
import { invariant } from './errors.js';

/** Recovery's existing table page supplies roots. Fetch whole metadata objects in
 * bounded windows, sharing durable downloads with the logical source queue.
 * Coordinates are archival: a new owner uploads its own physical bindings. */
export async function retainPhysicalRoots(
  source: NativeSource,
  retained: RecoveryObjects,
  transport: RecoveryTransport,
  roots: NonNullable<HostedRecoveryPage['physicalRoots']>,
  previous?: DownloadPin,
): Promise<DownloadPin | undefined> {
  if (!roots.length) return previous;
  const retain = async (pins: DownloadPin[]) => {
    const unique = [...new Map(pins.map(pin => [pin.sha256, pin])).values()];
    for (let at = 0; at < unique.length; at += 100) {
      const page = unique.slice(at, at + 100),
        missing = page.filter(pin => !existsSync(join(source.directory, pin.sha256)));
      if (missing.length) await transport.prepareDownloads?.(missing);
      await retained.prefetch(page);
      for (const pin of page) await retained.retain(pin, false, false);
    }
  };
  await retain(roots.map(row => row.root));
  const entries = [],
    objects = new Map<string, DownloadPin>();
  for (const row of roots) {
    const reader = await PhysicalManifestReader.open(row.state.sha256, row.root, async pin =>
      source.object(pin.sha256),
    );
    const whole = physicalArchiveObjects(reader.root);
    for (const object of whole) {
      const prior = objects.get(object.sha256);
      invariant(
        !prior || prior.size === object.size,
        'INVALID_WORK_BACKUP',
        'Archived metadata body sizes differ.',
      );
      objects.set(object.sha256, { sha256: object.sha256, size: object.size });
    }
    entries.push({ placement: 'archive', ...row, objects: whole });
  }
  await retain([...objects.values()]);
  const bytes = Buffer.from(
    canonicalPayload({
      kind: 'forge-source-physical-archive',
      schema: 1,
      previous: previous ?? null,
      entries,
    }),
  );
  return { sha256: source.put(bytes), size: bytes.length };
}
