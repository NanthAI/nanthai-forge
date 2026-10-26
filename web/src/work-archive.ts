// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { workArchiveMetadata, sourceManifestSchema, archiveChannels } from '../../src/work-archive-metadata';
import { latestWorkFormat } from '../../src/work-format';

export type WorkArchivePreview = {
  manifestDigest: string;
  head: string;
  format: 'sha1' | 'sha256' | 'native';
  revision: number;
  intents: number;
  lanes: number;
  views: number;
  runs: number;
  files: number;
  unavailable: number;
  channels: { name: string; head: string }[];
};
const hash = async (bytes: Uint8Array) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)), byte =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
// Display-only summary; full Work/source/evidence validation belongs to local restore.
const summarySchema = z.object({
  schema: z.number().int().min(1).max(latestWorkFormat),
  revision: z.number().safe().nonnegative(),
  intents: z.array(z.unknown()),
  lanes: z.array(z.unknown()),
  views: z.array(z.unknown()),
  runs: z.array(z.unknown()),
  nativeHead: z.string().optional(),
  channelMoves: z.array(z.object({ channel: z.string(), head: z.string(), status: z.string() })).default([]),
});

export async function previewWorkArchive(file: File): Promise<WorkArchivePreview> {
  const { manifest: manifestBytes, work: workBytes } = await workArchiveMetadata(file);
  const manifest = sourceManifestSchema.parse(JSON.parse(new TextDecoder().decode(manifestBytes)));
  if (
    manifest.kind === 'forge-source-and-work' &&
    (manifest.head.length !== (manifest.format === 'sha1' ? 40 : 64) ||
      manifest.refs.some(pin => pin.head.length !== manifest.head.length))
  )
    throw new Error('Archive source format differs from its pins.');
  const workFile = manifest.files.find(item => item.path === 'work.json');
  if (workBytes.length !== workFile?.size || (await hash(workBytes)) !== workFile.sha256)
    throw new Error('Work bytes differ from the archive manifest.');
  const work = summarySchema.parse(JSON.parse(new TextDecoder().decode(workBytes)));
  if (work.revision !== manifest.revision)
    throw new Error('Archive Work revision differs from the manifest.');
  if (
    manifest.kind === 'forge-native-work-backup' &&
    (work.nativeHead !== manifest.head ||
      !manifest.files.some(file => file.path === `objects/${manifest.head}` && file.sha256 === manifest.head))
  )
    throw new Error('Native bootstrap State differs from its archive pins.');
  const channels = archiveChannels(manifest, work);
  return {
    manifestDigest: await hash(manifestBytes),
    head: manifest.head,
    format: manifest.kind === 'forge-native-work-backup' ? 'native' : manifest.format,
    revision: work.revision,
    intents: work.intents.length,
    lanes: work.lanes.length,
    views: work.views.length,
    runs: work.runs.length,
    files: manifest.files.length,
    unavailable: manifest.unavailable.length,
    channels,
  };
}

export async function archiveDigest(file: Blob): Promise<string> {
  // ponytail: Web Crypto requires a complete buffer; introduce streaming hashing if measured large-archive browser memory warrants it.
  return hash(new Uint8Array(await file.arrayBuffer()));
}
