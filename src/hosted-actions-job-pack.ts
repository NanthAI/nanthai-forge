// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { createReadStream } from 'node:fs';
import { stat, lstat, rm, mkdir, copyFile, writeFile, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fileDigest, createSourcePack } from './source-pack-archive.js';
import { refreshSourcePack, type SourcePackDownload } from './source-pack.js';
import { sourceWindowOrder } from './hosted-actions-direct.js';
import type { ActionsJobClient } from './hosted-actions-job-client.js';
import type { materializeActionsSource } from './hosted-actions-job-source.js';
import type { NativeState } from './state/format.js';
import { digest } from './hash.js';
import { retryActionsInfrastructure, actionsInfrastructureResponse } from './hosted-actions-retry.js';
import { invariant } from './errors.js';
import { SourceWorkerReader } from './hosted-source-worker-reader.js';

type RefreshSource = Pick<
  Awaited<ReturnType<typeof materializeActionsSource>>,
  'base' | 'packed' | 'deltaFiles' | 'deltaBytes' | 'totalBytes' | 'connection' | 'reader'
>;

/** Restore the separate job's source context from the plan artifact. */
export async function refreshActionsPackArtifact(
  client: ActionsJobClient,
  source: Omit<RefreshSource, 'connection' | 'reader'> & {
    state: NativeState;
    sourcePack: SourcePackDownload | null;
    requiresStateBinding?: boolean;
  },
  directory: string,
  cache: string,
) {
  client.sourcePack = source.sourcePack;
  try {
    await warmPackCache(source.state, directory, cache);
  } catch {
    return skipRefresh('candidate-cache');
  }
  const connection =
    source.requiresStateBinding === true
      ? client.transport(cache, { packBaseBound: true })
      : client.transport();
  const reader = new SourceWorkerReader(cache, connection.transport, undefined, 16);
  return refreshActionsSourcePack(client, { ...source, connection, reader }, cache);
}

/** Called only after publishing matrix/artifacts. Always pack the accepted base,
 * never let concurrent speculative Candidates churn the project's cache. */
export async function refreshActionsSourcePack(
  client: ActionsJobClient,
  source: RefreshSource,
  cache: string,
) {
  if (!client.capabilities.includes('sourcePack')) return skipRefresh('capability-unavailable');
  if (
    !refreshSourcePack(
      source.packed ? client.sourcePack : null,
      source.deltaFiles,
      source.deltaBytes,
      source.totalBytes,
    )
  )
    return skipRefresh('delta-within-threshold');
  const archive = join(cache, 'upload-source-pack.gz');
  let reason = 'base-source';
  try {
    // Existing cache blobs have already passed either W2 or pack verification.
    const missing: string[] = [];
    for (const file of source.base.files) {
      try {
        await stat(join(cache, file.blob));
      } catch {
        missing.push(file.blob);
      }
    }
    await source.connection.selectState(client.run!.candidate.base.head, false);
    const objects = sourceWindowOrder(missing);
    for (let start = 0; start < objects.length;) {
      const hashes = objects.slice(start, start + client.sourceWindow);
      const count = await source.connection.resolveWindow(hashes);
      const selected = hashes.slice(0, count);
      await source.connection.prepareRecipes(selected);
      await source.connection.prepareRuns(selected);
      await source.reader.resolveMany(selected);
      start += count;
    }
    reason = 'archive-create';
    const object = await createSourcePack(client.run!.candidate.base.head, source.base, cache, archive);
    if (!object) return skipRefresh('archive-bounds');
    reason = 'reservation';
    const target = (await client.call({ kind: 'sourcePack', phase: 'prepare', object })) as {
      url: string;
      headers: Record<string, string>;
    } | null;
    if (!target) return skipRefresh('reservation-unavailable');
    reason = 'upload';
    await retryActionsInfrastructure(
      async signal => {
        const body = createReadStream(archive);
        try {
          const response = await actionsInfrastructureResponse(
            await client.request(target.url, {
              method: 'PUT',
              headers: target.headers,
              body,
              duplex: 'half',
              redirect: 'error',
              signal,
            } as unknown as RequestInit),
          );
          invariant(response.ok || response.status === 412, 'R2_UPLOAD_FAILED', 'Pack upload failed.');
        } finally {
          body.destroy();
        }
      },
      120_000,
      360_000,
    );
    reason = 'commit';
    await client.call({ kind: 'sourcePack', phase: 'commit', object });
    return true;
  } catch (error) {
    // A failed refresh never invalidates the published plan.
    const code = (error as { code?: unknown } | null)?.code;
    if (code === 'CHECK_CANCELLED') return skipRefresh('check-cancelled');
    if (reason === 'base-source' && code === 'SOURCE_UNAVAILABLE')
      return skipRefresh('base-source-unavailable');
    return skipRefresh(reason);
  } finally {
    await rm(archive, { force: true }).catch(() =>
      console.log('source pack: refresh cleanup failed (archive-cleanup)'),
    );
  }
}

function skipRefresh(reason: string) {
  console.log(`source pack: refresh skipped (${reason})`);
  return false;
}

/** Seed the separate refresh job from the already uploaded Candidate artifact. */
export async function warmPackCache(state: NativeState, directory: string, cache: string) {
  await mkdir(cache, { recursive: true });
  for (const file of state.files) {
    const path = join(directory, file.path),
      target = join(cache, file.blob);
    // A materialized submodule has no pointer file; the refresh reads its tiny blob.
    if (file.mode === 'gitlink' && (await lstat(path)).isDirectory()) continue;
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
