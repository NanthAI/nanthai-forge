// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, lstatSync, chmodSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readSource } from './files.js';
import { validateArtifact } from './artifact-validation.js';
import { ForgeError, invariant } from './errors.js';
import type { GraphPack } from './types.js';

export const ARTIFACT = '.forge/index.json';
export function saveArtifact(root: string, pack: GraphPack): void {
  const serialized = JSON.stringify(pack);
  invariant(
    Buffer.byteLength(serialized) <= 64 * 1024 * 1024,
    'ARTIFACT_LIMIT',
    'Graph artifact exceeds the 64 MiB limit. Previous artifact is unchanged.',
  );
  const directory = join(root, '.forge');
  let temporary: string | undefined;
  try {
    try {
      mkdirSync(directory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const stat = lstatSync(directory);
    invariant(
      stat.isDirectory() && !stat.isSymbolicLink(),
      'UNSAFE_CACHE',
      'Forge cache must be a real private directory.',
    );
    chmodSync(directory, 0o700);
    temporary = join(directory, `index-${randomUUID()}.tmp`);
    writeFileSync(temporary, serialized, { flag: 'wx', mode: 0o600 });
    renameSync(temporary, join(root, ARTIFACT));
    temporary = undefined;
  } catch (error) {
    if (error instanceof ForgeError) throw error;
    throw new ForgeError('ARTIFACT_WRITE_FAILED', 'Could not atomically publish the local graph artifact.');
  } finally {
    if (temporary) {
      try {
        unlinkSync(temporary);
      } catch {
        /* A failed cleanup does not mask the write failure. */
      }
    }
  }
}
export function loadArtifact(root: string): GraphPack {
  const bytes = readSource(root, ARTIFACT, 64 * 1024 * 1024);
  invariant(bytes, 'INDEX_MISSING', 'No safe local index exists. Run nforge index first.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new ForgeError('INVALID_ARTIFACT', 'Index JSON is malformed. Rebuild the index.');
  }
  return validateArtifact(parsed);
}
