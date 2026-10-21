// SPDX-License-Identifier: Apache-2.0
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { commitExchangeDirectory } from './native-exchange-files.js';
import { digest } from './hash.js';
import { nativeManifestSchema } from './work-archive-metadata.js';
import { reconcileHostedWork } from './native-companion.js';
import { ConvexExchange } from './exchange-client.js';
import { WorkStore } from './work-store.js';
import { exchangeJournalDelta } from './exchange-journal-delta.js';
import { retainExchangeMetadata, retainedExchangeBase } from './exchange-receive-cache.js';
import { ForgeError, invariant } from './errors.js';
import type { WorkData } from './work-types.js';

export async function reconcileExchange(
  root: string,
  request: {
    url: string;
    projectId: string;
    backupId: string;
    operationId: string;
    revision: number;
    preserveLocalSource?: boolean;
  },
  // Not part of the retained request: a bound push merges into newer local Work.
  options: {
    followLocal?: boolean;
    candidate?: WorkData;
    onCandidate?: (data: WorkData) => void;
    onProgress?: (detail: string) => void;
  } = {},
) {
  const store = new WorkStore(root),
    transport = new ConvexExchange(
      request.url,
      process.env.FORGE_AUTH_TOKEN,
      request.projectId,
      request.operationId,
      null,
    );
  transport.metadataCacheDirectory = store.directory;
  const directory = join(store.directory, `exchange-receive-${request.operationId}`),
    receiptPath = join(directory, 'request.json');
  let stage = 'manifest',
    done = 0,
    total: number | undefined;
  const calls = new Map<string, number>();
  const progress = () =>
    options.onProgress?.(
      `${stage}${total === undefined ? '' : ` ${done}/${total} bytes`}${calls.size ? `; waiting on ${[...calls.keys()].join(', ')}` : ''}`,
    );
  transport.onCall = (call, pending) => {
    const count = (calls.get(call) ?? 0) + (pending ? 1 : -1);
    if (count > 0) calls.set(call, count);
    else calls.delete(call);
    progress();
  };
  transport.onWorkProgress = (received, size) => {
    stage = 'manifest / work.json download';
    done = received;
    total = size;
    progress();
  };
  let command;
  if (existsSync(receiptPath)) {
    const original = JSON.parse(readFileSync(receiptPath, 'utf8'));
    invariant(
      JSON.stringify(original.request) === JSON.stringify(request),
      'WORK_OPERATION_CHANGED',
      'Retain the original reconcile request.',
    );
    command = original.command;
  } else {
    stage = 'journal delta';
    progress();
    let received,
      pagingAvailable = true;
    try {
      received = await exchangeJournalDelta(store, transport, request.backupId, options.onProgress);
    } catch (error) {
      if (
        !(error instanceof ForgeError) ||
        !['INVALID_WORK_JOURNAL', 'INVALID_WORK_BACKUP', 'JOURNAL_PAGING_UNAVAILABLE'].includes(error.code)
      )
        throw error;
      const reason = `journal delta fallback: ${error.code}: ${error.message}`;
      process.stderr.write(`${reason}\n`);
      options.onProgress?.(reason);
      pagingAvailable = error.code === 'INVALID_WORK_JOURNAL';
    }
    if (!received) {
      stage = 'manifest';
      progress();
      const original = await transport.manifest(request.backupId),
        bytes = Buffer.from(original.json);
      invariant(
        digest(bytes) === original.digest && bytes.length === original.size,
        'INVALID_WORK_BACKUP',
        'Original exchange manifest changed.',
      );
      const manifest = nativeManifestSchema.parse(JSON.parse(original.json)),
        file = manifest.files.find(file => file.path === 'work.json');
      invariant(file, 'INVALID_WORK_BACKUP', 'Original Work is absent from the manifest.');
      stage = 'work.json download';
      done = 0;
      total = file.size;
      progress();
      transport.onDownloadProgress = (pin, received) => {
        if (pin.sha256 === file.sha256) {
          done = received;
          progress();
        }
      };
      const cached = retainedExchangeBase(store.directory, original.digest);
      const work = cached?.work ?? (await transport.download(file));
      // Also retain flat/legacy object checkpoints before a journal-export failure.
      retainExchangeMetadata(store.directory, bytes, bytes, work);
      if (pagingAvailable) {
        // Recover the exact base, then read all events in bounded pages. A cold
        // owner must not make the new server rebuild the entire hosted Work.
        received = await exchangeJournalDelta(store, transport, request.backupId, options.onProgress, {
          reuseReceived: false,
        });
      } else {
        stage = 'journal export';
        total = undefined;
        progress();
        const journal = await transport.journal(),
          parsed = JSON.parse(journal);
        invariant(
          parsed.source?.backupId === request.backupId &&
            parsed.base.archiveSha256 === (original.sourceDigest ?? original.digest),
          'WORK_STALE',
          'Hosted source changed. Keep the original request and select its matching checkpoint.',
        );
        received = { original, work, journal, parsed };
      }
    }
    const { original, work, journal, parsed } = received,
      bytes = Buffer.from(original.json);
    const journalPath = join(directory, 'journal.json');
    command = {
      action: 'reconcile-hosted-work',
      ...(request.preserveLocalSource ? { preserveLocalSource: true } : {}),
      transport: 'objects',
      operationId: request.operationId,
      projectKey: parsed.projectKey,
      archivePath: directory,
      archiveSha256: original.sourceDigest ?? original.digest,
      manifestSha256: original.digest,
      journalPath,
      journalSha256: digest(journal),
    };
    commitExchangeDirectory(directory, {
      'manifest.json': bytes,
      'work.json': work,
      'journal.json': journal,
      'request.json': JSON.stringify({ request, command }),
    });
  }
  stage = 'local merge';
  total = undefined;
  progress();
  return reconcileHostedWork(store, command, request.revision, options);
}
