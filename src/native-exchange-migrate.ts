// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { withWorkArchive } from './work-backup-archive.js';
import { withValidatedNativeArchive } from './native-archive-validation.js';
import { nativeManifestSchema } from './work-archive-metadata.js';
import { readSource } from './files.js';
import { digest } from './hash.js';
import { invariant } from './errors.js';
import type { ContentPin, ExchangeTransport } from './native-exchange.js';
export async function migrateNativeArchive(
  path: string,
  originalDigest: string,
  transport: ExchangeTransport & {
    migrate(
      backupId: string,
      operationId: string,
      originalDigest: string,
      manifest: ContentPin,
    ): Promise<unknown>;
  },
  backupId: string,
  operationId: string,
) {
  // Exact logical bytes and the same source/Work closure checks as full restore
  // are verified before retiring any original compressed container.
  return withWorkArchive(path, async (directory, archive) => {
    invariant(
      archive.sha256 === originalDigest,
      'INVALID_WORK_BACKUP',
      'The selected archive differs from the historical source receipt.',
    );
    const bytes = readFileSync(join(directory, 'manifest.json')),
      manifest = nativeManifestSchema.parse(JSON.parse(bytes.toString('utf8')));
    return withValidatedNativeArchive(directory, async validated => {
      const unique = [...new Map(manifest.files.map(file => [file.sha256, file])).values()],
        manifestPin = { sha256: digest(bytes), size: bytes.length };
      let uploadedBytes = 0,
        uploadedObjects = 0;
      const pins = [...unique, { path: 'manifest.json', ...manifestPin }];
      for (let offset = 0; offset < pins.length; offset += 100) {
        const page = pins.slice(offset, offset + 100),
          missing = new Set(await transport.missing(page));
        const pending = page.filter(pin => missing.has(pin.sha256));
        while (pending.length) {
          const batch = [pending.shift()!];
          let size = batch[0]!.size;
          while (pending.length && batch.length < 8 && size + pending[0]!.size <= 16 * 1024 * 1024) {
            const pin = pending.shift()!;
            batch.push(pin);
            size += pin.size;
          }
          const content = batch.map(pin => {
            // Original manifest/Work bytes never pass through parsed serialization.
            const original =
              pin.path === 'manifest.json'
                ? bytes
                : readSource(validated.directory, validated.physicalPath(pin.path), pin.size + 1, pin.sha256);
            invariant(
              original && original.length === pin.size && digest(original) === pin.sha256,
              'INVALID_WORK_BACKUP',
              'A logical archive member changed during migration.',
            );
            return { pin, bytes: original };
          });
          const sent = transport.uploadBatch
            ? await transport.uploadBatch(content)
            : (
                await Promise.all(
                  content.map(
                    async ({ pin, bytes }) =>
                      (await transport.upload(pin, bytes)) ?? {
                        uploadedObjects: 1,
                        uploadedBytes: bytes.length,
                      },
                  ),
                )
              ).reduce(
                (total, sent) => ({
                  uploadedObjects: total.uploadedObjects + sent.uploadedObjects,
                  uploadedBytes: total.uploadedBytes + sent.uploadedBytes,
                }),
                { uploadedObjects: 0, uploadedBytes: 0 },
              );
          uploadedBytes += sent?.uploadedBytes ?? content.reduce((sum, item) => sum + item.bytes.length, 0);
          uploadedObjects += sent?.uploadedObjects ?? content.length;
        }
      }
      const result = await transport.migrate(backupId, operationId, originalDigest, manifestPin);
      return {
        result,
        backupId,
        originalArchiveDigest: originalDigest,
        manifestDigest: manifestPin.sha256,
        uploadedBytes,
        uploadedObjects,
        logicalMembers: manifest.files.length,
        logicalBytes: manifest.files.reduce((sum, file) => sum + file.size, 0),
        logicalClosureVerified: true,
        fullRestoreVerified: false,
        originalCompressedRepresentationGuaranteed: false,
      };
    });
  });
}
