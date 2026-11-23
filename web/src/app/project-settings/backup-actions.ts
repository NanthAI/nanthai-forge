// SPDX-License-Identifier: Apache-2.0
// The backup calls of Settings > Project, moved from the old project screen without a new
// server call: download a stored checkpoint, reconcile or resume an upload, and store a chosen archive as this
// project's backup. Each press does its own work; nothing runs on open.
import type { ConvexReactClient } from 'convex/react';
import type { FunctionArgs, FunctionReturnType } from 'convex/server';
import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';
import { backupTransfer } from '../../backup-transfer-api';
import { downloadObjectArchive } from '../../object-archive';
import { snapshotDownload } from '../../snapshot';
import type { WorkArchivePreview } from '../../work-archive';

export type Backup = FunctionReturnType<typeof api.projectBackups.history>['page'][number];
export type UploadInput = FunctionArgs<typeof api.projectBackupActions.prepare>;
export type Upload = { file: File; input: UploadInput; id?: Id<'projectBackups'> };
export type Selected = { file: File; preview: WorkArchivePreview; digest: string };

/** Saves a downloaded checkpoint as a file; returns the words the page shows. */
export async function downloadBackup(client: ConvexReactClient, backup: Backup) {
  const objects = backup.transport === 'objects';
  const signed = objects
    ? null
    : await client.mutation(backupTransfer.sign, { id: backup.id, digest: backup.digest });
  const { blob, filename } = objects
    ? await downloadObjectArchive(client, backup.projectId, backup.id)
    : await snapshotDownload(async offset => ({
        ...(signed ??
          (await client.action(api.projectBackupActions.downloadPart, {
            id: backup.id,
            offset,
            digest: backup.digest,
          }))),
        contentType: 'application/gzip',
        repository: backup.name,
        head: backup.preview.head,
      }));
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return objects
    ? `Downloaded ${filename}; all member bytes match their SHA-256 pins. This is a new archive container.`
    : `Downloaded ${filename}; SHA-256 matches the original stored archive.`;
}

/** Looks for the original upload's bytes; the stored words, or null while none is complete. */
export async function reconcile(client: ConvexReactClient, id: Id<'projectBackups'>) {
  const observed = await client.action(api.projectBackupActions.reconcileUpload, { id });
  return observed.status === 'stored';
}

/** Stores the chosen archive. The original operation stays in `upload` so a retry reconciles it. */
export async function storeArchive(client: ConvexReactClient, upload: Upload) {
  if (!upload.id) {
    const projectId = await client.mutation(api.projectBackupObjects.open, {
      key: upload.input.key,
      name: upload.input.name,
    });
    const { uploadArchiveObjects } = await import('../../archive-object-upload');
    const seeded = await uploadArchiveObjects(client, projectId, upload.file, {
      operationId: upload.input.operationId,
      preview: upload.input.preview,
    });
    upload.id = seeded.backupId;
    return 'Source and Work stored as reusable private objects.';
  }
  const prepared = await client.mutation(backupTransfer.prepare, upload.input);
  upload.id = prepared.backup.id;
  let backup = prepared.backup;
  if (backup.status !== 'stored') {
    if (!prepared.target) throw new Error('The original upload destination is unavailable.');
    const response = await fetch(prepared.target.url, {
      method: 'PUT',
      headers: prepared.target.headers,
      body: upload.file,
    });
    if (!response.ok && response.status !== 412)
      throw new Error(`Archive upload returned HTTP ${response.status}.`);
    backup = await client.action(backupTransfer.complete, {
      id: upload.id,
      projectId: backup.projectId,
      digest: upload.input.digest,
      size: upload.input.size,
    });
  }
  return backup.current
    ? 'Source and Work stored as the current private backup.'
    : 'Source and Work retained. A newer current backup remains selected.';
}

/** The recovery request a person opens a checkpoint with (`nforge exchange NEW_DIRECTORY restore`). */
export function recoveryRequest(url: string, projectId: string, backupId: string) {
  const link = document.createElement('a');
  const blob = new Blob([JSON.stringify({ url, projectId, backupId }, null, 2)], {
    type: 'application/json',
  });
  link.href = URL.createObjectURL(blob);
  link.download = 'forge-restore.json';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
}
