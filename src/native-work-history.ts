// SPDX-License-Identifier: Apache-2.0
import { readFileSync, writeFileSync, mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkStore } from './work-store.js';
import { NativeSource } from './native-source.js';
import { historicalCommandSchema, type HistoricalWork } from './native-history-types.js';
import { manifestSchema } from './work-archive-metadata.js';
import { withWorkArchive } from './work-backup-archive.js';
import { restoreWork } from './work-backup.js';
import { readSource } from './files.js';
import { digest } from './hash.js';
import { invariant } from './errors.js';
import { isCheckLogPath, runLogRecord } from './check-log-policy.js';
import { parseWorkBytes } from './work-metadata.js';

export function validateHistoricalObjects(store: WorkStore, records: HistoricalWork[]) {
  const source = new NativeSource(store.root);
  return records.map(record => {
    const bytes = source.object(record.archive.sha256);
    invariant(
      bytes.length === record.archive.size,
      'INVALID_WORK_BACKUP',
      'Original historical archive size changed.',
    );
    return record.archive.sha256;
  });
}

export async function historicalWork(store: WorkStore, input: unknown, revision: number) {
  invariant(
    store.native,
    'UNSUPPORTED_NATIVE_WORK',
    'Historical attachment uses the selected native owner; the original Git owner remains available.',
  );
  const parsed = historicalCommandSchema.safeParse(input);
  invariant(
    parsed.success,
    'BAD_ARGUMENT',
    'Select the original archive identity, accepted native source or retained history record.',
  );
  const command = parsed.data,
    source = new NativeSource(store.root);
  if (command.action === 'import-work-history') {
    const request = digest(
      JSON.stringify({
        sha256: command.sha256,
        name: command.name,
        acceptanceId: command.acceptanceId,
        head: command.expectedHead,
      }),
    );
    const retained = store.locked(() => {
      const data = store.load(),
        existing = data.historicalWork?.find(item => item.id === command.operationId);
      if (existing) {
        invariant(
          existing.request === request,
          'WORK_OPERATION_CHANGED',
          'Use this historical import’s original archive and mapping.',
        );
        source.object(existing.archive.sha256);
        return existing;
      }
      invariant(
        data.revision === revision,
        'WORK_STALE',
        'Work changed before selecting the original archive.',
      );
      const acceptance = data.channelMoves.find(item => item.id === command.acceptanceId);
      invariant(
        acceptance?.status === 'accepted' && acceptance.head === command.expectedHead,
        'SOURCE_UNAVAILABLE',
        'Select a retained native acceptance and its original State.',
      );
      source.state(command.expectedHead);
      return null;
    });
    if (retained) return { revision: store.load().revision, result: retained };
    const inputRoot = realpathSync(dirname(command.path)),
      bytes = readSource(inputRoot, basename(command.path), Number.MAX_SAFE_INTEGER, command.sha256);
    invariant(
      bytes && digest(bytes) === command.sha256,
      'INVALID_WORK_BACKUP',
      'Selected archive bytes differ from their original identity.',
    );
    const record = await withWorkArchive(command.path, async (directory, archive) => {
      invariant(
        archive.sha256 === command.sha256 && archive.size === bytes.length,
        'INVALID_WORK_BACKUP',
        'Original archive changed during validation.',
      );
      const manifestBytes = readFileSync(join(directory, 'manifest.json')),
        manifest = manifestSchema.parse(JSON.parse(manifestBytes.toString('utf8'))),
        work = readFileSync(join(directory, 'work.json'));
      // The explicit Git compatibility boundary validates full original refs, source and private evidence.
      const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'forge-history-validation-')));
      try {
        await restoreWork(directory, join(scratch, 'original'));
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
      const result: HistoricalWork = {
        id: command.operationId,
        request,
        name: command.name,
        at: new Date().toISOString(),
        archive,
        original: {
          head: manifest.head,
          revision: manifest.revision,
          manifestSha256: digest(manifestBytes),
          workSha256: digest(work),
        },
        destination: { head: command.expectedHead, acceptanceId: command.acceptanceId },
        provenance: 'original-git-work-archive',
        coverage: manifest.coverage,
        unavailable: manifest.unavailable,
      };
      return result;
    });
    return store.locked(() => {
      const data = store.load(),
        existing = data.historicalWork?.find(item => item.id === command.operationId);
      if (existing) {
        invariant(
          existing.request === request,
          'WORK_OPERATION_CHANGED',
          'The original historical import changed.',
        );
        return { revision: data.revision, result: existing };
      }
      invariant(
        data.revision === revision,
        'WORK_STALE',
        'Work changed during validation. Retained original objects are preserved; reconcile the same operation.',
      );
      // Older schema-1 readers reject before rewriting, instead of silently dropping this attachment.
      source.put(bytes);
      data.schema = Math.max(data.schema, 2) as 2 | 3 | 4 | 5;
      data.historicalWork = [...(data.historicalWork ?? []), record];
      data.revision++;
      store.save(data);
      return { revision: data.revision, result: record };
    });
  }
  const snapshot = store.locked(() => {
    const data = store.load(),
      record = data.historicalWork?.find(item => item.id === command.id);
    invariant(record, 'NOT_FOUND', 'Original historical Work not found.');
    return { revision: data.revision, record };
  });
  const bytes = source.object(snapshot.record.archive.sha256);
  invariant(
    bytes.length === snapshot.record.archive.size,
    'INVALID_WORK_BACKUP',
    'Original historical archive size changed.',
  );
  if (command.action === 'export-work-history')
    return {
      revision: snapshot.revision,
      result: {
        private: true,
        path: join(source.directory, snapshot.record.archive.sha256),
        ...snapshot.record,
      },
    };
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'forge-history-read-'))),
    path = join(scratch, 'original.tar.gz');
  try {
    writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
    return await withWorkArchive(path, async directory => {
      const manifestBytes = readFileSync(join(directory, 'manifest.json')),
        manifest = manifestSchema.parse(JSON.parse(manifestBytes.toString('utf8'))),
        work = readFileSync(join(directory, 'work.json'));
      invariant(
        digest(manifestBytes) === snapshot.record.original.manifestSha256 &&
          digest(work) === snapshot.record.original.workSha256,
        'INVALID_WORK_BACKUP',
        'Historical metadata differs from its retained original.',
      );
      if (command.action === 'list-work-history-files')
        return {
          revision: snapshot.revision,
          result: {
            private: true,
            provenance: snapshot.record,
            files: manifest.files.slice(command.offset, command.offset + command.limit),
            total: manifest.files.length,
            nextOffset: Math.min(manifest.files.length, command.offset + command.limit),
          },
        };
      if (command.action === 'read-work-history-record') {
        const data = JSON.parse(work.toString('utf8')) as Record<string, unknown[]>,
          records = data[command.collection] ?? [];
        const record = command.recordId
          ? records.find(item => (item as { id?: string }).id === command.recordId)
          : records;
        invariant(record !== undefined, 'NOT_FOUND', 'Historical record not found.');
        return {
          revision: snapshot.revision,
          result: { private: true, provenance: snapshot.record, collection: command.collection, record },
        };
      }
      const file = manifest.files.find(item => item.path === command.path);
      if (isCheckLogPath(command.path)) {
        const data = parseWorkBytes(work),
          run = data.runs.find(run => command.path.startsWith(`check-${run.id}/`));
        if (run) {
          const record = runLogRecord(data, run);
          if (record.status === 'provider-held' || (!file && record.status !== 'included'))
            return {
              revision: snapshot.revision,
              result: {
                private: true,
                provenance: snapshot.record,
                path: command.path,
                ...record,
                text: run.failureSummary ?? '',
                totalBytes: 0,
                offset: 0,
                nextOffset: 0,
                more: false,
              },
            };
        }
      }
      invariant(file, 'NOT_FOUND', 'Original evidence file is unavailable or not retained.');
      const selected = readSource(directory, file.path, file.size + 1, file.sha256);
      invariant(
        selected && selected.length === file.size && digest(selected) === file.sha256,
        'INVALID_WORK_BACKUP',
        'Original historical evidence changed.',
      );
      return {
        revision: snapshot.revision,
        result: {
          private: true,
          provenance: snapshot.record,
          path: file.path,
          sha256: file.sha256,
          totalBytes: file.size,
          offset: command.offset,
          nextOffset: Math.min(file.size, command.offset + command.bytes),
          encoding: 'base64',
          data: selected.subarray(command.offset, command.offset + command.bytes).toString('base64'),
        },
      };
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
