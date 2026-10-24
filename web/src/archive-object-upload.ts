// SPDX-License-Identifier: Apache-2.0
import type { ConvexReactClient } from 'convex/react';
import type { Id } from '../../convex/_generated/dataModel';
import { api } from '../../convex/_generated/api';
import { sourceManifestSchema, workArchiveMetadata } from '../../src/work-archive-metadata';
import { archiveDigest } from './work-archive';

/** Archives are local import files. Only verified logical content is uploaded;
 * repeated files and previous checkpoints share immutable project objects. */
export async function uploadArchiveObjects(
  client: ConvexReactClient,
  projectId: Id<'hostedProjects'>,
  file: File,
) {
  const uploaded = new Map<string, number>();
  const put = async (bytes: Uint8Array) => {
    const blob = new Blob([new Uint8Array(bytes).buffer]);
    const digest = await archiveDigest(blob),
      size = bytes.length;
    if (!uploaded.has(digest)) {
      const prepared = await client.mutation(api.projectObjects.prepare, { projectId, digest, size });
      if (!prepared.stored && prepared.target) {
        // The browser supplies Content-Length from the Blob; JavaScript cannot set it.
        const headers = Object.fromEntries(
          Object.entries(prepared.target.headers).filter(([name]) => name.toLowerCase() !== 'content-length'),
        );
        const response = await fetch(prepared.target.url, { method: 'PUT', headers, body: blob });
        if (!response.ok && response.status !== 412)
          throw new Error(`Content upload returned HTTP ${response.status}.`);
        // A create-only retry may find existing bytes; HEAD still verifies their exact pins.
        await client.action(api.projectObjectCommit.commitBatch, { objects: [{ id: prepared.id }] });
      } else if (!prepared.stored) {
        const observed = prepared.created
          ? undefined
          : await client.mutation(api.projectObjects.reconcile, { id: prepared.id, cursor: null });
        if (!observed?.stored) {
          if (!prepared.uploadUrl) throw new Error('The original content upload is unavailable.');
          const response = await fetch(prepared.uploadUrl, {
            method: 'POST',
            headers: { 'Content-Type': prepared.contentType },
            body: blob,
          });
          if (!response.ok) throw new Error(`Content upload returned HTTP ${response.status}.`);
          const { storageId } = (await response.json()) as { storageId: Id<'_storage'> };
          await client.mutation(api.projectObjects.complete, { id: prepared.id, storageId });
        }
      }
      uploaded.set(digest, size);
    }
    return { digest, size };
  };
  const metadata = await workArchiveMetadata(file, {
    select: () => true,
    read: async (_name, bytes) => {
      await put(bytes);
    },
  });
  await put(metadata.work);
  const manifest = sourceManifestSchema.parse(JSON.parse(new TextDecoder().decode(metadata.manifest)));
  for (const pin of manifest.files)
    if (uploaded.get(pin.sha256) !== pin.size) throw new Error('Imported content differs from its manifest.');
  return put(metadata.manifest);
}
