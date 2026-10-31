// SPDX-License-Identifier: Apache-2.0
import type { ConvexReactClient } from 'convex/react';
import type { Id } from '../../convex/_generated/dataModel';
import { api } from '../../convex/_generated/api';
import { sourceManifestSchema, workArchiveMetadata } from '../../src/work-archive-metadata';
import { archiveDigest, type WorkArchivePreview } from './work-archive';
import { buildSeedPages, type SeedEntry } from '../../src/hosted-seed-protocol';
import { canonicalPayload } from '../../src/hosted-source-operation';

/** Archives are local import files. Only verified logical content is uploaded;
 * repeated files and previous checkpoints share immutable project objects. */
export async function uploadArchiveObjects(
  client: ConvexReactClient,
  projectId: Id<'hostedProjects'>,
  file: File,
  seed?: { operationId: string; preview: WorkArchivePreview },
): Promise<{ digest: string; size: number; backupId?: Id<'projectBackups'> }> {
  const uploaded = new Map<string, number>();
  const put = async (bytes: Uint8Array) => {
    const blob = new Blob([new Uint8Array(bytes).buffer]);
    const digest = await archiveDigest(blob),
      size = bytes.length;
    if (!uploaded.has(digest)) {
      const prepared = await client.mutation(api.projectObjects.prepare, { projectId, digest, size });
      if (!prepared.stored) {
        if (!prepared.target) throw new Error('The original content upload is unavailable.');
        // The browser supplies Content-Length from the Blob; JavaScript cannot set it.
        const headers = Object.fromEntries(
          Object.entries(prepared.target.headers).filter(([name]) => name.toLowerCase() !== 'content-length'),
        );
        const response = await fetch(prepared.target.url, { method: 'PUT', headers, body: blob });
        if (!response.ok && response.status !== 412)
          throw new Error(`Content upload returned HTTP ${response.status}.`);
        // A create-only retry may find existing bytes; HEAD still verifies their exact pins.
        await client.action(api.projectObjectCommit.commitBatch, { objects: [{ id: prepared.id }] });
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
  const work = await put(metadata.work);
  const manifest = sourceManifestSchema.parse(JSON.parse(new TextDecoder().decode(metadata.manifest)));
  for (const pin of manifest.files)
    if (uploaded.get(pin.sha256) !== pin.size) throw new Error('Imported content differs from its manifest.');
  const manifestPin = await put(metadata.manifest);
  if (!seed) return manifestPin;
  // Import into a fresh hosted project using the existing finite seed protocol.
  // Metadata already read for upload stays byte-pinned; no whole-Work publication action runs.
  const pin = (value: { digest: string; size: number }) => ({ sha256: value.digest, size: value.size });
  const recipe = (value: { digest: string; size: number }) => ({
    ...pin(value),
    tree: { ...pin(value), height: 0, length: value.size },
  });
  const root = await put(
    new TextEncoder().encode(
      JSON.stringify({
        kind: 'forge-native-exchange',
        schema: 1,
        manifest: recipe(manifestPin),
        work: recipe(work),
      }),
    ),
  );
  const recovery = await put(
    new TextEncoder().encode(JSON.stringify({ schema: 1, kind: 'forge-native-seed-recovery', files: [] })),
  );
  const head = seed.preview.channels.find(channel => channel.name === 'main')?.head ?? manifest.head;
  const native = manifest.kind === 'forge-native-work-backup';
  const entries: SeedEntry[] = [...uploaded].map(([sha256, size]) => ({
    sha256,
    size,
    kind: native && sha256 === head ? 'state' : 'object',
  }));
  entries.sort((a, b) => a.sha256.localeCompare(b.sha256));
  const { pages, chain } = buildSeedPages(entries);
  const { intents, lanes, views, runs, files, unavailable } = seed.preview;
  const mainSize = uploaded.get(head);
  if (native && mainSize === undefined) throw new Error('Imported main State is absent from its archive.');
  const request = {
    schema: 1,
    operationId: seed.operationId,
    revision: manifest.revision,
    sourceHead: manifest.head,
    format: native ? 'native' : 'git',
    head,
    main: native ? { sha256: head, size: mainSize! } : null,
    receipt: null,
    receiptId: null,
    previousHead: null,
    previousReceiptId: null,
    work: pin(work),
    manifest: pin(manifestPin),
    root: pin(root),
    recovery: pin(recovery),
    pages: pages.length,
    objects: entries.length,
    chain,
    preview: { intents, lanes, views, runs, files, unavailable },
  };
  let progress = JSON.parse(
    await client.mutation(api.projectHostedSeed.begin, { projectId, request: canonicalPayload(request) }),
  );
  while (!progress.backupId && progress.nextPage < pages.length) {
    const index = progress.nextPage;
    progress = JSON.parse(
      await client.action(api.projectHostedSeedActions.stage, {
        projectId,
        operationId: seed.operationId,
        index,
        previous: progress.chain,
        body: canonicalPayload(pages[index]!),
      }),
    );
  }
  if (!progress.backupId)
    progress = JSON.parse(
      await client.action(api.projectHostedSeedActions.finish, { projectId, operationId: seed.operationId }),
    );
  if (!progress.backupId || (native && progress.mainDigest !== head))
    throw new Error('Seed did not commit the imported main State.');
  return { ...manifestPin, backupId: progress.backupId as Id<'projectBackups'> };
}
