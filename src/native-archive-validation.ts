// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { nativeManifestSchema } from './work-archive-metadata.js';
import { workSchema, type WorkData } from './work-types.js';
import { WorkStore } from './work-store.js';
import { nativeMarker } from './native-source.js';
import { nativeReachable } from './native-reachable.js';
import { artifactArchivePlan, validateArtifactAliasRecords } from './native-artifact-alias.js';
import { readSource } from './files.js';
import { digest } from './hash.js';
import { invariant } from './errors.js';
type Manifest = z.infer<typeof nativeManifestSchema>;

// Shared by independent full restoration and lossless archive conversion.
export function validateNativeArchiveRecords(store: WorkStore, manifest: Manifest, data: WorkData) {
  invariant(
    data.nativeHead === manifest.head && data.revision === manifest.revision,
    'INVALID_WORK_BACKUP',
    'Native Work source pins differ from the manifest.',
  );
  validateArtifactAliasRecords(data, manifest.files, artifactArchivePlan(manifest).aliases);
  const paths = new Set(manifest.files.map(file => file.path)),
    closure = nativeReachable(store, data);
  invariant(
    closure.every(id => paths.has(`objects/${id}`)),
    'INVALID_WORK_BACKUP',
    'Native backup omits reachable original source.',
  );
}

// The caller owns this safe, private extraction. Reposition it temporarily instead
// of copying an entire owner and every Lane merely to validate immutable closure.
export async function withValidatedNativeArchive<T>(
  directory: string,
  use: (value: {
    directory: string;
    manifest: Manifest;
    data: WorkData;
    physicalPath: (path: string) => string;
  }) => Promise<T>,
): Promise<T> {
  const manifest = nativeManifestSchema.parse(
      JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')),
    ),
    plan = artifactArchivePlan(manifest);
  for (const file of plan.physical) {
    const bytes = readSource(directory, file.path, file.size + 1, file.sha256);
    invariant(
      bytes && bytes.length === file.size && digest(bytes) === file.sha256,
      'INVALID_WORK_BACKUP',
      'Native backup bytes differ from their manifest.',
    );
  }
  const data = workSchema.parse(JSON.parse(readFileSync(join(directory, 'work.json'), 'utf8'))),
    aliases = new Map(plan.aliases.map(alias => [alias.path, alias.target]));
  const owner = realpathSync(mkdtempSync(join(dirname(directory), '.forge-native-validation-'))),
    work = join(owner, '.forge', 'work');
  let moved = false;
  try {
    mkdirSync(join(owner, '.forge'), { mode: 0o700 });
    nativeMarker(owner);
    renameSync(directory, work);
    moved = true;
    validateNativeArchiveRecords(new WorkStore(owner), manifest, data);
    return await use({ directory: work, manifest, data, physicalPath: path => aliases.get(path) ?? path });
  } finally {
    if (moved) renameSync(work, directory);
    rmSync(owner, { recursive: true, force: true });
  }
}
