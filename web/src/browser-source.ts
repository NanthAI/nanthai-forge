// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { readSubmodulePointers } from '../../src/gitlink';
import { verifiedBytes } from './verified-blob';
import { ObjectDownloadReader, type DownloadTransport } from '../../src/blob-download';
import { parseNativeState } from '../../src/state/format';
import { reviewPaths, reviewTextPage, type ReviewPath } from '../../src/source-review-format';
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
type BrowserClient = Client & Partial<Pick<ConvexReactClient, 'action'>>;
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
  checkpointDescribe?: true;
};
type SourcePair = Pick<SourceInput, 'projectId' | 'backupId' | 'base' | 'head'>;
type SourceFiles = { available: true; paths: (ReviewPath & { add?: number; del?: number })[] };
type SourceUnavailable = { available: false; reason: string };
type FileComparison = { file: ReviewPath; comparison: ReturnType<typeof computeHunks> };
export type BrowserComparison =
  | SourceUnavailable
  | (SourceFiles & { readFile: (path: string) => Promise<FileComparison> });
const readers = new WeakMap<Client, Map<string, ObjectDownloadReader>>();
type CheckpointRead = {
  pin: { backupId: Id<'projectBackups'>; backupDigest: string; manifestDigest: string };
  active: Map<string, number>;
};
function browserTransport(
  client: Client,
  projectId: Id<'hostedProjects'>,
  checkpoint?: CheckpointRead,
): DownloadTransport {
  const scope = (ids: string[]) => (ids.some(id => checkpoint?.active.has(id)) ? checkpoint?.pin : undefined);
  const describe = (digests: string[], signed?: boolean) => {
    const selected = scope(digests);
    return client.mutation(api.projectObjectDownloads.describe, {
      projectId,
      digests,
      ...(signed ? { signed: true } : {}),
      ...(selected ? { checkpoint: selected } : {}),
    });
  };
  return {
    describe,
    sign: async digests => {
      if (!scope(digests))
        return (
          await client.mutation(api.projectObjectDownloads.signDownloads, { projectId, digests })
        ).filter(row => 'url' in row);
      return (await describe(digests, true)).flatMap(row =>
        row.location === 'r2' && row.url
          ? [{ digest: row.digest, size: row.size, url: row.url, ...(row.range ? { range: row.range } : {}) }]
          : [],
      );
    },
  };
}
export function browserObjects(client: Client, projectId: Id<'hostedProjects'>) {
  let projects = readers.get(client);
  if (!projects) {
    projects = new Map();
    readers.set(client, projects);
  }
  let reader = projects.get(projectId);
  if (!reader) {
    reader = new ObjectDownloadReader(browserTransport(client, projectId));
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
async function pinComparison(client: Client, input: SourcePair, open = false) {
  const selection = { projectId: input.projectId, backupId: input.backupId },
    plan = await sourcePlan(client, selection, [input.base, input.head]);
  if (plan.transport !== 'objects' || plan.format !== 'native')
    return {
      available: false as const,
      reason:
        'This checkpoint uses a source archive. Its existing download contains source and Work for local review.',
    };
  const checkpoint: CheckpointRead | undefined =
    open && plan.checkpointDescribe
      ? {
          pin: {
            backupId: input.backupId,
            backupDigest: plan.backupDigest,
            manifestDigest: plan.manifestDigest,
          },
          active: new Map(),
        }
      : undefined;
  const shared = browserObjects(client, input.projectId);
  const reader = checkpoint
    ? shared.withTransport(browserTransport(client, input.projectId, checkpoint))
    : shared;
  const pins = new Map(plan.pins?.map(pin => [pin.sha256, pin]));
  const check = async (digests: string[] = []) => {
    const current = await sourcePlan(client, selection, digests);
    invariant(
      current.backupDigest === plan.backupDigest && current.manifestDigest === plan.manifestDigest,
      'SOURCE_CHANGED',
      'The selected checkpoint changed while reading.',
    );
    return current;
  };
  let manifestIndex: Promise<void> | undefined;
  const bytes = async (ids: string[], checked?: SourcePlan) => {
    for (let at = 0; at < ids.length; at += 100) {
      const missing = ids.slice(at, at + 100).filter(id => !pins.has(id));
      if (!missing.length) continue;
      const current = (at === 0 ? checked : undefined) ?? (await check(missing));
      if (current.pins) for (const pin of current.pins) pins.set(pin.sha256, pin);
      else {
        manifestIndex ??= browserManifest(client, input.projectId, plan)
          .then(({ manifest }) => {
            for (const file of manifest.files)
              if (file.path === `objects/${file.sha256}`) pins.set(file.sha256, file);
          })
          .catch(error => {
            manifestIndex = undefined;
            throw error;
          });
        await manifestIndex;
      }
    }
    const selected = ids.map(id => {
      const pin = pins.get(id);
      invariant(pin, 'SOURCE_UNAVAILABLE', 'This source object is not retained in the selected checkpoint.');
      return pin;
    });
    if (!checkpoint) return reader.read(selected);
    // The enclosing logical read checks the checkpoint before and after IO.
    // Recipe descendants still check access, without rereading the checkpoint per page.
    for (const id of ids) checkpoint.active.set(id, (checkpoint.active.get(id) ?? 0) + 1);
    try {
      return await reader.read(selected);
    } finally {
      for (const id of ids) {
        const pending = checkpoint.active.get(id)! - 1;
        if (pending) checkpoint.active.set(id, pending);
        else checkpoint.active.delete(id);
      }
    }
  };
  const [aState, bState] = await bytes([input.base, input.head]),
    state = parseNativeState(bState!),
    paths = reviewPaths(parseNativeState(aState!).files, state.files);
  return { available: true as const, plan, paths, state, bytes, check, checkpointScoped: !!checkpoint };
}

function filePins(file: ReviewPath) {
  return [file.before?.blob, file.after?.blob].filter((id): id is string => !!id);
}
function fileSides(file: ReviewPath, contents: Uint8Array[]) {
  return {
    before: file.before ? contents.shift()! : new Uint8Array(),
    after: file.after ? contents.shift()! : new Uint8Array(),
  };
}

/** Keep the file list of this verified checkpoint while the Changes panel is open. Each selection
 * still checks the checkpoint before and after IO and verifies the exact selected object bytes. */
export async function openBrowserComparison(
  client: BrowserClient,
  input: SourcePair,
  viewOnly = false,
): Promise<BrowserComparison> {
  if (viewOnly) {
    const index = JSON.parse(await readBrowserSource(client, input, true)) as SourceFiles | SourceUnavailable;
    if (!index.available) return index;
    return {
      ...index,
      async readFile(path) {
        const file = JSON.parse(await readBrowserSource(client, { ...input, file: path }, true)) as
          | (FileComparison & { available: true })
          | SourceUnavailable;
        if (!file.available) throw new Error(file.reason);
        return file;
      },
    };
  }
  const pinned = await pinComparison(client, input, true);
  if (!pinned.available) return pinned;
  const { paths, bytes, check, checkpointScoped } = pinned;
  if (!checkpointScoped) await check();
  return {
    available: true,
    paths,
    async readFile(path) {
      const file = paths.find(file => file.path === path);
      invariant(file, 'NOT_FOUND', 'Choose a file from this source comparison.');
      const ids = filePins(file);
      const current = checkpointScoped ? undefined : await check(ids);
      const { before, after } = fileSides(file, await bytes(ids, current));
      const comparison = computeHunks(before, after, 3);
      if (!checkpointScoped) await check();
      return { file, comparison };
    },
  };
}

export async function readBrowserSource(
  client: BrowserClient,
  input: SourceInput,
  viewOnly = false,
): Promise<string> {
  if (viewOnly) {
    invariant(client.action, 'SOURCE_UNAVAILABLE', 'The public file viewer is unavailable.');
    return client.action(api.projectSourceReview.read, { ...input, render: true });
  }
  const pinned = await pinComparison(client, input);
  if (!pinned.available) return JSON.stringify(pinned);
  const { paths, plan, state, bytes, check } = pinned;
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
    const { before: a, after: b } = fileSides(file, await bytes(filePins(file)));
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
  await check();
  return JSON.stringify({
    available: true,
    backupId: plan.backupId,
    backupDigest: plan.backupDigest,
    ...result,
  });
}
