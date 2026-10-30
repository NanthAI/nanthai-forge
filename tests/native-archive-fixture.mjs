// SPDX-License-Identifier: Apache-2.0
import { readFileSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { exportNativeWork } from '../dist/native-backup.js';
import { digest } from '../dist/hash.js';
export async function captureNativeArchive(store, revision, operationId = randomUUID()) {
  const { result } = await exportNativeWork(store, revision, false);
  const directory = join(store.directory, `exchange-${operationId}`);
  renameSync(result.path, directory);
  return { directory, json: result.json, manifest: JSON.parse(result.json) };
}
export async function transferArchiveFixture(store, transport) {
  const archive = await captureNativeArchive(store, store.revision());
  for (const pin of archive.manifest.files) {
    if (transport.uploadFile && pin.size > 2 * 1024 * 1024)
      await transport.uploadFile(pin, archive.directory, pin.path);
    else await transport.upload(pin, readFileSync(join(archive.directory, pin.path)));
  }
  return {
    ...archive,
    digest: digest(archive.json),
    backupId: 'synthetic',
    objects: archive.manifest.files.length,
  };
}
