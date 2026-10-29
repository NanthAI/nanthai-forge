// SPDX-License-Identifier: Apache-2.0
import { createReadStream } from 'node:fs';
import { stat, rm, mkdir, copyFile, writeFile, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fileDigest, createSourcePack } from './source-pack-archive.js';
import { refreshSourcePack } from './source-pack.js';
import { directSourceWindow } from './hosted-actions-direct.js';
import type { ActionsJobClient } from './hosted-actions-job-client.js';
import type { materializeActionsSource } from './hosted-actions-job-source.js';
import type { NativeState } from './native-state-format.js';
import { digest } from './hash.js';
import { invariant } from './errors.js';
/** Called only after publishing matrix/artifacts. Always pack the accepted base,
 * never let concurrent speculative Candidates churn the project's cache. */
export async function refreshActionsSourcePack(
  client: ActionsJobClient,
  source: Awaited<ReturnType<typeof materializeActionsSource>>,
  cache: string,
) {
  if (!client.capabilities.includes('sourcePack')) return false;
  const archive = join(cache, 'upload-source-pack.gz');
  try {
    if (
      !refreshSourcePack(
        source.packed ? client.sourcePack : null,
        source.deltaFiles,
        source.deltaBytes,
        source.totalBytes,
      )
    )
      return false;
    // Existing cache blobs have already passed either W2 or pack verification.
    const missing: string[] = [];
    for (const file of source.base.files) {
      try {
        await stat(join(cache, file.blob));
      } catch {
        missing.push(file.blob);
      }
    }
    for (let start = 0; start < missing.length; start += directSourceWindow) {
      const hashes = missing.slice(start, start + directSourceWindow);
      await source.connection.resolve(hashes);
      await source.connection.prepareRecipes(hashes);
      await source.reader.resolveMany(hashes);
    }
    const object = await createSourcePack(client.run!.candidate.base.head, source.base, cache, archive);
    if (!object) return false;
    const target = (await client.call({ kind: 'sourcePack', phase: 'prepare', object })) as {
      url: string;
      headers: Record<string, string>;
    } | null;
    if (!target) return false;
    const response = await client.request(target.url, {
      method: 'PUT',
      headers: target.headers,
      body: createReadStream(archive),
      duplex: 'half',
      redirect: 'error',
      signal: AbortSignal.timeout(120_000),
    } as unknown as RequestInit);
    invariant(response.ok || response.status === 412, 'R2_UPLOAD_FAILED', 'Pack upload failed.');
    await client.call({ kind: 'sourcePack', phase: 'commit', object });
    return true;
  } catch {
    // A failed refresh never invalidates the published plan.
    console.log('source pack: refresh skipped (storage or cache bound)');
    return false;
  } finally {
    await rm(archive, { force: true });
  }
}

/** Seed the separate refresh job from the already uploaded Candidate artifact. */
export async function warmPackCache(state: NativeState, directory: string, cache: string) {
  await mkdir(cache, { recursive: true });
  for (const file of state.files) {
    const path = join(directory, file.path),
      target = join(cache, file.blob);
    if (file.mode === 'symlink') {
      const bytes = await readlink(path);
      invariant(digest(bytes) === file.blob, 'SOURCE_HASH_MISMATCH', 'Artifact link differs.');
      await writeFile(target, bytes, { mode: 0o600 });
    } else {
      invariant((await fileDigest(path)) === file.blob, 'SOURCE_HASH_MISMATCH', 'Artifact file differs.');
      await copyFile(path, target);
    }
  }
}
