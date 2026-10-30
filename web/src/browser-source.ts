import { readSubmodulePointers } from '../../src/gitlink';
// SPDX-License-Identifier: Apache-2.0
import { verifiedBytes } from './verified-blob';
import { ObjectDownloadReader } from '../../src/blob-download';
import { parseNativeState } from '../../src/native-state-format';
import { reviewPaths, reviewTextPage } from '../../src/source-review-format';
import { computeHunks } from '../../src/review-hunks-core';
import { readChangeMap } from '../../src/change-map';
import { sourceFilePageText } from '../../src/source-file-page-core';
import { sourceManifestSchema } from '../../src/work-archive-metadata';
import type { DownloadPin } from '../../src/blob-download-format';
import { downloadPinSchema, downloadTreeSchema } from '../../src/blob-download-format';
import { invariant } from '../../src/errors';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import type { ConvexReactClient } from 'convex/react';
import { z } from 'zod';

type Client = Pick<ConvexReactClient, 'mutation'>;
export type SourceInput = {
  projectId: Id<'hostedProjects'>;
  backupId: Id<'projectBackups'>;
  base: string;
  head: string;
  file?: string;
  map?: boolean;
  submodules?: boolean;
  beforeOffset?: number;
  afterOffset?: number;
  line?: number;
};
export type SourcePlan = {
  backupId: string;
  backupDigest: string;
  manifestDigest: string;
  format: string;
  operationId: string;
  transport: string;
  root: DownloadPin;
  pins: DownloadPin[] | null;
};
const readers = new WeakMap<Client, Map<string, ObjectDownloadReader>>();
export function browserObjects(client: Client, projectId: Id<'hostedProjects'>) {
  let projects = readers.get(client);
  if (!projects) {
    projects = new Map();
    readers.set(client, projects);
  }
  let reader = projects.get(projectId);
  if (!reader) {
    reader = new ObjectDownloadReader({
      describe: digests => client.mutation(api.projectObjectDownloads.describe, { projectId, digests }),
      sign: digests => client.mutation(api.projectObjectDownloads.signDownloads, { projectId, digests }),
    });
    projects.set(projectId, reader);
  }
  return reader;
}
export async function sourcePlan(
  client: Client,
  input: Pick<SourceInput, 'projectId' | 'backupId'>,
  digests: string[] = [],
) {
  return JSON.parse(
    await client.mutation(api.projectObjectDownloads.source, { ...input, digests }),
  ) as SourcePlan;
}
const metadataRoot = z.object({
  kind: z.literal('forge-native-exchange'),
  schema: z.union([z.literal(1), z.literal(2)]),
  manifest: downloadPinSchema.extend({ tree: downloadTreeSchema }),
  work: downloadPinSchema.extend({ tree: downloadTreeSchema.optional() }),
  records: downloadPinSchema.extend({ tree: downloadTreeSchema }).optional(),
});
/** Original immutable manifest bytes; never substitute a newer backup on an index miss. */
export async function browserManifest(client: Client, projectId: Id<'hostedProjects'>, plan: SourcePlan) {
  const reader = browserObjects(client, projectId),
    [root] = await reader.read([plan.root]);
  const value: unknown = JSON.parse(new TextDecoder().decode(root));
  const exchange = metadataRoot.safeParse(value);
  const manifestBytes = exchange.success
    ? await reader.tree(exchange.data.manifest, exchange.data.manifest.tree)
    : root!;
  await verifiedBytes(manifestBytes, plan.manifestDigest);
  const manifest = sourceManifestSchema.parse(JSON.parse(new TextDecoder().decode(manifestBytes)));
  return { manifest, manifestBytes, exchange: exchange.success ? exchange.data : null };
}
export async function readBrowserSource(client: Client, input: SourceInput): Promise<string> {
  const selection = { projectId: input.projectId, backupId: input.backupId },
    plan = await sourcePlan(client, selection, [input.base, input.head]);
  if (plan.transport !== 'objects' || plan.format !== 'native')
    return JSON.stringify({
      available: false,
      reason:
        'This checkpoint uses a source archive. Its existing download contains source and Work for local review.',
    });
  const reader = browserObjects(client, input.projectId),
    pins = new Map(plan.pins?.map(pin => [pin.sha256, pin]));
  let manifest: Awaited<ReturnType<typeof browserManifest>> | undefined;
  const bytes = async (ids: string[]) => {
    for (let at = 0; at < ids.length; at += 100) {
      const missing = ids.slice(at, at + 100).filter(id => !pins.has(id));
      if (!missing.length) continue;
      const current = await sourcePlan(client, selection, missing);
      invariant(
        current.backupDigest === plan.backupDigest && current.manifestDigest === plan.manifestDigest,
        'SOURCE_CHANGED',
        'The selected checkpoint changed while reading.',
      );
      if (current.pins) for (const pin of current.pins) pins.set(pin.sha256, pin);
      else {
        manifest ??= await browserManifest(client, input.projectId, plan);
        for (const file of manifest.manifest.files)
          if (file.path === `objects/${file.sha256}`) pins.set(file.sha256, file);
      }
    }
    return reader.read(
      ids.map(id => {
        const pin = pins.get(id);
        invariant(
          pin,
          'SOURCE_UNAVAILABLE',
          'This source object is not retained in the selected checkpoint.',
        );
        return pin;
      }),
    );
  };
  const [aState, bState] = await bytes([input.base, input.head]),
    state = parseNativeState(bState!),
    paths = reviewPaths(parseNativeState(aState!).files, state.files);
  let result: object = { base: input.base, head: input.head, paths };
  if (input.submodules)
    result = {
      base: input.base,
      head: input.head,
      pointers: await readSubmodulePointers(state.files, bytes),
    };
  else if (input.map)
    result = {
      base: input.base,
      head: input.head,
      map: await readChangeMap(input.base, input.head, paths, bytes),
    };
  else if (input.file !== undefined) {
    const file = paths.find(file => file.path === input.file);
    invariant(file, 'NOT_FOUND', 'Choose a file from this source comparison.');
    const contents = await bytes([file.before?.blob, file.after?.blob].filter((id): id is string => !!id)),
      a = file.before ? contents.shift()! : new Uint8Array(),
      b = file.after ? contents.shift()! : new Uint8Array();
    result = {
      base: input.base,
      head: input.head,
      file,
      ...(file.after?.mode === 'gitlink'
        ? { submodule: (await readSubmodulePointers(state.files, bytes, file.path))[0] }
        : {}),
      before: file.before ? reviewTextPage(a, input.beforeOffset) : null,
      after: file.after ? reviewTextPage(b, input.afterOffset) : null,
      ...(input.line !== undefined && file.after
        ? { source: sourceFilePageText(b, input.file, input.line, file.after.blob) }
        : {}),
      comparison: {
        ...computeHunks(a, b, 3),
        beforeBlob: file.before?.blob ?? null,
        afterBlob: file.after?.blob ?? null,
      },
    };
  }
  const final = await sourcePlan(client, selection);
  invariant(
    final.backupDigest === plan.backupDigest && final.manifestDigest === plan.manifestDigest,
    'SOURCE_CHANGED',
    'The selected checkpoint changed while reading.',
  );
  return JSON.stringify({
    available: true,
    backupId: plan.backupId,
    backupDigest: plan.backupDigest,
    ...result,
  });
}
