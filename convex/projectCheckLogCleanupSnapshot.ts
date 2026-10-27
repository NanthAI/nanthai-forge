// SPDX-License-Identifier: Apache-2.0
'use node';
import type { ActionCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { source } from './projectWorkLoad';
import { recordExchange } from './projectWorkRecordExchange';
import { exchangeObjectReader } from './projectExchangeReader';
import { partialWork } from '../src/work-exchange-delta';
import { readRecord } from '../src/work-exchange-records';
import { resolveExchangeWork } from '../src/native-exchange-stream';
import { sourceManifestSchema } from '../src/work-archive-metadata';
import { isCheckMaintenancePath } from '../src/check-log-policy';
import type { LogData, LogRun } from '../src/check-log-policy';
import { digest } from '../src/hash';
import { invariant } from '../src/errors';
import type { Identity } from './projectCheckLogCleanupTypes';
type Backup = Doc<'projectBackups'> | Doc<'projectProposals'>;
async function loadSnapshot(ctx: ActionCtx, input: Identity, backup: Backup) {
  const reader = exchangeObjectReader(ctx, true);
  const exchange =
    backup.transport === 'objects' ? await recordExchange(backup, input.actor, reader) : undefined;
  if (exchange) return { reader, exchange };
  const snapshot =
    'baseBackupId' in backup
      ? await (async () => {
          const pin = { sha256: backup.digest, size: backup.size };
          const resolved = await resolveExchangeWork(
            (await reader.read(input.projectId, input.actor, [pin]))[0]!,
            pins => reader.read(input.projectId, input.actor, pins),
          );
          return {
            manifest: sourceManifestSchema.parse(JSON.parse(resolved.manifest.toString('utf8'))),
            data: resolved.data,
          };
        })()
      : await source(ctx, backup._id, input.actor, reader, false, false);
  return { reader, snapshot };
}
/** One catalog, only for the currently selected snapshot, lives for this finite
 * action. Only referenced runs are read, in batches of at most fifty. */
export function snapshotReader(ctx: ActionCtx, input: Identity) {
  let key: string | undefined, loaded: ReturnType<typeof loadSnapshot>;
  return async (backup: Backup, offset: number) => {
    if (key !== backup._id) {
      key = backup._id;
      loaded = loadSnapshot(ctx, input, backup);
    }
    const { exchange, snapshot, reader } = await loaded;
    if (!exchange)
      return {
        files: snapshot!.manifest.files.slice(offset, offset + 50),
        total: snapshot!.manifest.files.length,
        data: { autonomyPolicy: snapshot!.data.autonomyPolicy, runs: snapshot!.data.runs } satisfies LogData,
      };
    invariant(
      exchange.manifest.revision === backup.preview.revision &&
        digest(exchange.manifestBytes) === backup.preview.manifestDigest,
      'INVALID_WORK_BACKUP',
      'Cleanup snapshot revision differs.',
    );
    const files = exchange.manifest.files.slice(offset, offset + 50);
    const keys = new Set(files.filter(f => isCheckMaintenancePath(f.path)).map(f => f.path.slice(6, 42)));
    const field = exchange.records.fields.find(f => f.name === 'runs');
    const pins = field && 'records' in field ? field.records.filter(r => keys.has(r.key)) : [];
    const bodies = pins.length ? await reader.read(input.projectId, input.actor, pins) : [];
    const runs = await Promise.all(pins.map((pin, i) => readRecord(pin, async () => bodies[i]!, 'runs')));
    const data = partialWork(exchange.records, []);
    return {
      files,
      total: exchange.manifest.files.length,
      data: { autonomyPolicy: data.autonomyPolicy, runs: runs as LogRun[] } satisfies LogData,
    };
  };
}
