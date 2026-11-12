// SPDX-License-Identifier: Apache-2.0
import { ZodError } from 'zod';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { NativeSource } from './native-source.js';
import type { RecoveryObjects } from './recovery-hosted-objects.js';
import type { RecoveryTransport } from './recovery-source.js';
import type { PhysicalArchiveEntry } from './physical-source-archive-format.js';
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
  const entries: PhysicalArchiveEntry[] = [];
  try {
    await retain(roots.map(row => row.root));
    const objects = new Map<string, DownloadPin>();
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
    for (const row of roots) {
      const read = async (pin: import('./physical-manifest-codec.js').PhysicalPin) =>
        pin.pack
          ? source.object(pin.pack.digest).subarray(pin.pack.offset, pin.pack.offset + pin.size)
          : source.object(pin.sha256);
      const reader = await PhysicalManifestReader.open(row.state.sha256, row.root, read);
      await reader.readChunks(reader.root.chunks.map(chunk => chunk.bucket));
    }
  } catch (error) {
    const code =
      (error as { code?: string; data?: { code?: string } }).code ??
      (error as { data?: { code?: string } }).data?.code;
    if (
      !(error instanceof SyntaxError || error instanceof ZodError) &&
      ![
        'SOURCE_UNAVAILABLE',
        'SOURCE_HASH_MISMATCH',
        'INVALID_NATIVE_SOURCE',
        'INVALID_WORK_BACKUP',
      ].includes(code ?? '')
    )
      throw error;
    // Derived metadata never blocks canonical source/Work recovery. Keep the
    // exact expected pins and any verified root; the archive labels its missing
    // physical closure instead of claiming complete metadata or source absence.
    entries.length = 0;
    for (const row of roots) {
      const unavailable =
        code === 'SOURCE_UNAVAILABLE' || code === 'INVALID_NATIVE_SOURCE'
          ? 'SOURCE_UNAVAILABLE'
          : 'SOURCE_HASH_MISMATCH';
      try {
        const reader = await PhysicalManifestReader.open(row.state.sha256, row.root, async pin =>
          source.object(pin.sha256),
        );
        entries.push({
          placement: 'archive',
          ...row,
          objects: physicalArchiveObjects(reader.root),
          unavailable,
          rootRetained: true,
        });
      } catch {
        entries.push({ placement: 'archive', ...row, objects: [], unavailable });
      }
    }
  }
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
