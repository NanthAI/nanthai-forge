// SPDX-License-Identifier: Apache-2.0
import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { portableCheckPath } from './check-log-policy.js';
import { invariant } from './errors.js';
import { mapExchange } from './exchange-parallel.js';
import { fingerprintPrivateFile, readSource, safeRelative } from './files.js';
import { digest } from './hash.js';
import { withValidatedNativeArchive } from './native-archive-validation.js';
import { restoreNativeExchangeStage } from './native-backup.js';
import { nativeManifestSchema, sourceManifestSchema } from './work-archive-metadata.js';
import { overlayHostedJournal, restoreWork } from './work-backup.js';
import { parseWorkBytes } from './work-metadata.js';
import { WorkStore } from './work-store.js';
export type TransferReceipt = {
  uploadedObjects: number;
  uploadedBytes: number;
  uploadedLogicalObjects?: number;
};
export type ContentPin = { sha256: string; size: number };
export type ExchangeManifest = z.infer<typeof nativeManifestSchema>;
export interface ExchangeTransport {
  missing(objects: ContentPin[]): Promise<string[]>;
  upload(pin: ContentPin, bytes: Buffer): Promise<void | TransferReceipt>;
  uploadBatch?(objects: { pin: ContentPin; bytes: Buffer }[]): Promise<void | TransferReceipt>;
  uploadLazyBatch?(
    objects: { pin: ContentPin; read: () => Buffer | Promise<Buffer> }[],
  ): Promise<TransferReceipt>;
  uploadFile?(pin: ContentPin, root: string, path: string): Promise<TransferReceipt>;
  manifest(backupId: string): Promise<{ json: string; digest: string; size: number; sourceDigest?: string }>;
  download(pin: ContentPin): Promise<Buffer>;
  downloadBatch?(pins: ContentPin[]): Promise<Buffer[]>;
  downloadToFile?(pin: ContentPin, path: string): Promise<void>;
}
export async function pullNativeExchange(
  backupId: string,
  target: string,
  transport: ExchangeTransport,
  options: {
    cacheRoot?: string | undefined;
    journalPath?: string | undefined;
    exportOnly?: boolean;
    beforePublish?: (root: string) => void;
  } = {},
) {
  invariant(
    !existsSync(resolve(target)),
    'RESTORE_TARGET_EXISTS',
    'Choose a fresh destination; existing work remains unchanged.',
  );
  const original = await transport.manifest(backupId),
    bytes = Buffer.from(original.json);
  invariant(
    bytes.length === original.size && digest(bytes) === original.digest,
    'INVALID_WORK_BACKUP',
    'Exchange manifest differs from its original digest.',
  );
  const manifest = sourceManifestSchema.parse(JSON.parse(original.json));
  invariant(
    manifest.files.every(file => safeRelative(file.path)),
    'INVALID_WORK_BACKUP',
    'Exchange paths must be contained.',
  );
  invariant(
    new Set(manifest.files.map(file => file.path)).size === manifest.files.length,
    'INVALID_WORK_BACKUP',
    'Exchange repeats a logical path.',
  );
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'forge-exchange-')));
  let downloadedBytes = 0,
    reusedBytes = 0;
  try {
    const workPin = manifest.files.find(file => file.path === 'work.json');
    invariant(workPin, 'INVALID_WORK_BACKUP', 'Exchange omits its Work snapshot.');
    const workBytes = await transport.download(workPin);
    invariant(
      workBytes.length === workPin.size && digest(workBytes) === workPin.sha256,
      'INVALID_WORK_BACKUP',
      'Exchange Work differs from its original pin.',
    );
    const snapshot = parseWorkBytes(workBytes);
    const grouped = new Map<string, typeof manifest.files>();
    for (const file of manifest.files.filter(file => portableCheckPath(snapshot, file.path))) {
      const group = grouped.get(file.sha256);
      if (group) {
        invariant(
          group[0]!.size === file.size,
          'INVALID_WORK_BACKUP',
          'Identical content has inconsistent sizes.',
        );
        group.push(file);
      } else grouped.set(file.sha256, [file]);
    }
    const pending = [...grouped.values()],
      cache = options.cacheRoot ? new WorkStore(options.cacheRoot) : undefined;
    const batches: (typeof pending)[] = [];
    while (pending.length) {
      const batch = [pending.shift()!];
      let bytesInFlight = batch[0]![0]!.size;
      while (pending.length && batch.length < 8 && bytesInFlight + pending[0]![0]!.size <= 16 * 1024 * 1024) {
        const group = pending.shift()!;
        batch.push(group);
        bytesInFlight += group[0]!.size;
      }
      batches.push(batch);
    }
    await mapExchange(
      batches,
      2,
      async batch => {
        const content = new Map<string, Buffer>(),
          streamed = new Map<string, string>(),
          missing: ContentPin[] = [];
        for (const files of batch) {
          const file = files[0]!,
            sourceFile = files.find(item => item.path.startsWith('objects/'));
          const cached =
            cache && sourceFile
              ? readSource(cache.directory, sourceFile.path, file.size + 1, file.sha256)
              : null;
          if (cached && cached.length === file.size && digest(cached) === file.sha256) {
            content.set(file.sha256, cached);
            reusedBytes += cached.length;
          } else if (transport.downloadToFile && file.size > 2 * 1024 * 1024) {
            const path = join(directory, file.path);
            mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
            await transport.downloadToFile(file, path);
            // A transport optimization does not replace the caller's exact-byte check.
            const observed = await fingerprintPrivateFile(path, 'INVALID_WORK_BACKUP');
            invariant(
              observed.size === file.size && observed.sha256 === file.sha256,
              'INVALID_WORK_BACKUP',
              'Exchange content differs from the manifest.',
            );
            streamed.set(file.sha256, path);
            downloadedBytes += file.size;
          } else if (file.sha256 === workPin.sha256) {
            content.set(file.sha256, workBytes);
            downloadedBytes += workBytes.length;
          } else missing.push(file);
        }
        if (missing.length) {
          // Settle every transfer before removing staging on failure. A transport
          // may batch small objects; larger content keeps the ranged path.
          const outcomes = transport.downloadBatch
            ? (await transport.downloadBatch(missing)).map(bytes => ({
                status: 'fulfilled' as const,
                value: bytes,
              }))
            : await Promise.allSettled(missing.map(file => transport.download(file)));
          invariant(
            outcomes.length === missing.length,
            'INVALID_WORK_BACKUP',
            'Exchange download omitted requested content.',
          );
          for (const [index, outcome] of outcomes.entries()) {
            if (outcome.status === 'rejected') throw outcome.reason;
            const file = missing[index]!,
              bytes = outcome.value;
            invariant(
              bytes.length === file.size && digest(bytes) === file.sha256,
              'INVALID_WORK_BACKUP',
              'Exchange content differs from the manifest.',
            );
            content.set(file.sha256, bytes);
            downloadedBytes += bytes.length;
          }
        }
        for (const files of batch) {
          const bytes = content.get(files[0]!.sha256),
            staged = streamed.get(files[0]!.sha256);
          for (const member of files) {
            const path = join(directory, member.path);
            mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
            if (staged) {
              if (path !== staged) copyFileSync(staged, path, constants.COPYFILE_EXCL);
            } else writeFileSync(path, bytes!, { flag: 'wx', mode: 0o600 });
          }
          reusedBytes += (files.length - 1) * files[0]!.size;
        }
      },
      { bytes: 32 * 1024 * 1024, size: batch => batch.reduce((sum, files) => sum + files[0]!.size, 0) },
    );

    writeFileSync(join(directory, 'manifest.json'), bytes, { flag: 'wx', mode: 0o600 });
    if (options.journalPath)
      overlayHostedJournal(directory, original.sourceDigest ?? original.digest, options.journalPath);
    if (options.exportOnly) {
      invariant(
        manifest.kind === 'forge-native-work-backup',
        'INVALID_WORK_BACKUP',
        'Proposals require native source.',
      );
      await withValidatedNativeArchive(directory, async () => undefined);
      invariant(
        !existsSync(resolve(target)),
        'RESTORE_TARGET_EXISTS',
        'Choose a fresh proposal destination.',
      );
      renameSync(directory, resolve(target));
      return {
        root: resolve(target),
        backupId,
        digest: original.digest,
        downloadedBytes,
        reusedBytes,
        transport: 'objects' as const,
        exported: true,
      };
    }
    const result =
      manifest.kind === 'forge-native-work-backup'
        ? await restoreNativeExchangeStage(directory, target, options.beforePublish)
        : await restoreWork(directory, target);
    return {
      ...result,
      backupId,
      digest: original.digest,
      downloadedBytes,
      reusedBytes,
      transport: 'objects' as const,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
