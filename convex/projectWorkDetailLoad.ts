// SPDX-License-Identifier: Apache-2.0
'use node';
import { projectArchiveMetadata } from './projectArchiveMetadata';
import { internal } from './_generated/api';
import type { ActionCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import type { ExchangeObjectReader } from './projectExchangeReader';
import { exchangeRootSchema, isExchangeRoot, readByteTree } from '../src/native-exchange-tree';
import { workRecordRootSchema, workRecordChunks } from '../src/work-exchange-records';
import { batchedRecordReader } from '../src/native-exchange-stream';
import { parseJsonStream } from '../src/json-stream';
import { workDetailPins } from '../src/work-record-details';
import type { WorkData } from '../src/work-types';

/** The original backup remains immutable. Its migration receipt selects the
 * compact catalog at an exact journal revision; future events replay after it. */
export async function migratedWork(
  _ctx: ActionCtx,
  backup: Doc<'projectBackups'>,
  project: Doc<'hostedProjects'>,
  owner: string,
  reader: ExchangeObjectReader,
) {
  const migration = project.work?.recordDetails;
  if (!migration || migration.backupId !== backup._id) return;
  const [bytes] = await reader.read(backup.projectId, owner, [migration.root]);
  const original =
    backup.transport === 'objects'
      ? (
          await reader.read(backup.projectId, owner, [
            {
              sha256: backup.objectManifest?.digest ?? backup.digest,
              size: backup.objectManifest?.size ?? backup.size,
            },
          ])
        )[0]!
      : (
          await projectArchiveMetadata(
            _ctx,
            backup.storageId!,
            backup.size,
            backup.digest,
            () => _ctx.runQuery(internal.projectBackups.get, { id: backup._id, owner }),
            true,
            project.r2Writes ?? false,
          )
        ).manifest;
  const root = workRecordRootSchema.parse(JSON.parse(bytes!.toString('utf8')));
  const raw = JSON.parse(Buffer.from(original).toString('utf8'));
  const manifest = isExchangeRoot(raw)
    ? await readByteTree(exchangeRootSchema.parse(raw).manifest, pins =>
        reader.read(backup.projectId, owner, pins),
      )
    : Buffer.from(original);
  const bodies = batchedRecordReader(root, pins => reader.read(backup.projectId, owner, pins));
  let data: WorkData;
  try {
    data = (await parseJsonStream(workRecordChunks(root, bodies.read))) as WorkData;
  } finally {
    await bodies.drain();
  }
  return { manifest, data, work: root.work, revision: migration.revision, details: workDetailPins(data) };
}
