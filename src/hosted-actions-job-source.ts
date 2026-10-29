// SPDX-License-Identifier: Apache-2.0
import { mkdir, copyFile, chmod, symlink, rm, readlink, lstat, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { SourceWorkerReader } from './hosted-source-worker-reader.js';
import { parseNativeState, type NativeState } from './native-state-format.js';
import { ActionsJobClient } from './hosted-actions-job-client.js';
import { directSourceWindow } from './hosted-actions-direct.js';
import { fileDigest, downloadSourcePack, unpackSourcePack } from './source-pack-archive.js';
import { digest } from './hash.js';
import { invariant } from './errors.js';

export async function materializeActionsSource(client: ActionsJobClient, directory: string, cache: string) {
  const started = Date.now(),
    run = client.run!;
  const connection = client.transport(),
    { transport, resolve, prepareRecipes } = connection;
  let reader = new SourceWorkerReader(cache, transport);
  const heads = [run.request.expectedHead, run.candidate.base.head];
  await resolve(heads);
  await prepareRecipes(heads);
  const [candidateRef, baseRef] = await transport.describeBatch!(heads);
  const state = parseNativeState(await reader.bytes(candidateRef!));
  const base = parseNativeState(await reader.bytes(baseRef!));
  let selected = state.files,
    reason = 'no pack',
    packed: NativeState | null = null;
  const archive = join(cache, 'source-pack.gz');
  if (client.capabilities.includes('sourcePack') && client.sourcePack) {
    try {
      const pack = client.sourcePack;
      const packState =
        pack.stateRef === heads[0]
          ? state
          : pack.stateRef === heads[1]
            ? base
            : await (async () => {
                await resolve([pack.stateRef]);
                await prepareRecipes([pack.stateRef]);
                return parseNativeState(
                  await reader.bytes((await transport.describeBatch!([pack.stateRef]))[0]!),
                );
              })();
      await downloadSourcePack(pack, archive, client.request);
      await unpackSourcePack(pack, packState, archive, cache);
      const old = new Map(packState.files.map(file => [file.path, file]));
      selected = state.files.filter(file => old.get(file.path)?.blob !== file.blob);
      packed = packState;
    } catch {
      reason = 'invalid or unavailable pack';
      // Discard every extracted cache byte. A failed pack must not supply W2 bytes.
      await rm(cache, { recursive: true, force: true });
      await mkdir(cache, { recursive: true });
      reader = new SourceWorkerReader(cache, transport);
    } finally {
      await rm(archive, { force: true });
    }
  }
  const download = async () => {
    let next = 0,
      completed = 0,
      failed = false;
    const worker = async () => {
      try {
        while (!failed && next < selected.length) {
          const start = next;
          next += directSourceWindow;
          const page = selected.slice(start, start + directSourceWindow),
            hashes = page.map(file => file.blob);
          await resolve(hashes);
          await prepareRecipes(hashes);
          await reader.resolveMany(hashes);
          completed += page.length;
          console.log(
            `Actions source: ${completed}/${selected.length} files, ${reader.metrics.downloadedBytes} bytes, ${((Date.now() - started) / 1000).toFixed(1)}s`,
          );
        }
      } catch (error) {
        failed = true;
        throw error;
      }
    };
    // Drain in-flight work on failure before returning; links and plan publication
    // happen only after every page has succeeded. Bytes stay in streamed disk files.
    const pages = await Promise.allSettled(Array.from({ length: 3 }, worker));
    for (const page of pages) if (page.status === 'rejected') throw page.reason;
  };
  const materialize = async () => {
    await rm(directory, { recursive: true, force: true });
    await mkdir(directory, { recursive: true });
    // Copy even unchanged files: a clean tree applies deletions, directory changes
    // and modes without exposing any write to a link from the cached tree.
    await download();
    for (const file of state.files) {
      if (file.mode === 'symlink') continue;
      const path = join(directory, file.path);
      await mkdir(dirname(path), { recursive: true });
      await copyFile(join(cache, file.blob), path);
      await chmod(path, file.mode === 'executable' ? 0o755 : 0o644);
    }
    for (const file of state.files.filter(file => file.mode === 'symlink')) {
      await mkdir(dirname(join(directory, file.path)), { recursive: true });
      await symlink(readFileSync(join(cache, file.blob), 'utf8'), join(directory, file.path));
    }
    await verifySourceTree(state, directory);
  };
  try {
    await materialize();
  } catch (error) {
    if (!packed) throw error;
    packed = null;
    reason = 'pack tree verification failed';
    selected = state.files;
    await rm(cache, { recursive: true, force: true });
    await mkdir(cache, { recursive: true });
    reader = new SourceWorkerReader(cache, transport);
    await materialize();
  }
  const old = new Map(packed?.files.map(file => [file.path, file]) ?? []);
  const inventory = new Map(state.files.map(file => [file.path, file]));
  const changed = [...new Set([...old.keys(), ...inventory.keys()])].filter(path => {
    const before = old.get(path),
      after = inventory.get(path);
    return before?.blob !== after?.blob || before?.mode !== after?.mode;
  });
  let deltaBytes = 0,
    totalBytes = 0;
  for (const file of state.files) {
    const size = (await stat(join(cache, file.blob))).size;
    totalBytes += size;
    if (old.get(file.path)?.blob !== file.blob) deltaBytes += size;
  }
  console.log(
    packed
      ? `source: pack ${client.sourcePack!.stateRef} + delta ${changed.length} files (${deltaBytes} bytes) in ${((Date.now() - started) / 1000).toFixed(1)}s`
      : `source: full download (${reason})`,
  );
  return { state, base, packed, deltaFiles: changed.length, deltaBytes, totalBytes, connection, reader };
}
export async function verifySourceTree(state: NativeState, directory: string) {
  for (const file of state.files) {
    const path = join(directory, file.path),
      info = await lstat(path);
    const hash =
      file.mode === 'symlink'
        ? (invariant(info.isSymbolicLink(), 'SOURCE_HASH_MISMATCH', 'Expected source link.'),
          digest(await readlink(path)))
        : (invariant(
            info.isFile() && Boolean(info.mode & 0o111) === (file.mode === 'executable'),
            'SOURCE_HASH_MISMATCH',
            'Source mode differs.',
          ),
          await fileDigest(path));
    invariant(hash === file.blob, 'SOURCE_HASH_MISMATCH', 'Final source tree differs.');
  }
}
