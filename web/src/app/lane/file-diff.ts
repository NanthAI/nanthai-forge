// SPDX-License-Identifier: Apache-2.0
// One changed file's body, read only when the reader opens it (Item 4bc460aa): one describe call names the exact
// blobs' sizes and signs them, then the bytes come straight from object storage and are checked against their digest.
// Nothing is read for a file that stays folded; a file over the drawing limit is named, never downloaded.
import type { ConvexReactClient } from 'convex/react';
import { ObjectDownloadReader } from '../../../../src/blob-download';
import type { DownloadRow } from '../../../../src/blob-download-format';
import { computeHunks } from '../../../../src/review-hunks-core';
import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';

export type Side = { blob: string; mode: string } | null;
export type DiffLine = { kind: 'context' | 'removed' | 'added'; text: string; escaped?: true };
export type Hunk = { beforeStart: number; afterStart: number; lines: DiffLine[] };
export type FileBody =
  | { kind: 'diff'; hunks: Hunk[]; add: number; del: number; encoding?: 'not-utf-8'; rough?: true }
  | { kind: 'same' }
  | { kind: 'binary'; size: number }
  | { kind: 'large'; size: number }
  | { kind: 'submodule' };

/** Larger files are named and linked to Code, never drawn here (the shared text limit, src/review-hunks-core.ts). */
export const DRAW_BYTES = 1024 * 1024;

type Client = Pick<ConvexReactClient, 'mutation'>;

/** Count the drawn lines of each kind: the file row's +/− figures once its body is read. */
export function lineCounts(hunks: readonly Hunk[]) {
  let add = 0,
    del = 0;
  for (const hunk of hunks)
    for (const line of hunk.lines) {
      if (line.kind === 'added') add++;
      else if (line.kind === 'removed') del++;
    }
  return { add, del };
}

/** Exact bytes for a few blobs, or their total size when one is over the drawing limit (then nothing is fetched).
 * Calls: a signed describe (which also names the sizes), at most one storage GET per blob, and the reader's own
 * after-read describe that re-checks access. A sign call happens only after a URL expires. */
export async function readExact(
  client: Client,
  projectId: Id<'hostedProjects'>,
  blobs: readonly string[],
): Promise<{ large: true; size: number } | { large: false; size: number; bytes: Map<string, Uint8Array> }> {
  const digests = [...new Set(blobs)];
  if (!digests.length) return { large: false, size: 0, bytes: new Map() };
  const rows = await client.mutation(api.projectObjectDownloads.describe, {
    projectId,
    digests,
    signed: true,
  });
  const size = new Map(rows.map(row => [row.digest, row.size]));
  const total = digests.reduce((sum, id) => sum + (size.get(id) ?? 0), 0);
  if (digests.some(id => (size.get(id) ?? 0) > DRAW_BYTES)) return { large: true, size: total };
  // The rows just described answer the reader's first describe; its re-check and any retry ask again.
  let first: DownloadRow[] | null = rows;
  const reader = new ObjectDownloadReader({
    describe: async (ids, signed) => {
      const reuse = first;
      first = null;
      return reuse && ids.every(id => size.has(id))
        ? reuse.filter(row => ids.includes(row.digest))
        : client.mutation(api.projectObjectDownloads.describe, {
            projectId,
            digests: ids,
            ...(signed ? { signed: true } : {}),
          });
    },
    sign: async ids =>
      (await client.mutation(api.projectObjectDownloads.signDownloads, { projectId, digests: ids })).filter(
        row => 'url' in row,
      ),
  });
  const read = await reader.read(digests.map(id => ({ sha256: id, size: size.get(id)! })));
  return { large: false, size: total, bytes: new Map(digests.map((id, index) => [id, read[index]!])) };
}

/** Read and compare one file: the bytes of its two exact sides, then the shared hunk rules. */
export async function readFileBody(
  client: Client,
  projectId: Id<'hostedProjects'>,
  before: Side,
  after: Side,
): Promise<FileBody> {
  if (before?.mode === 'gitlink' || after?.mode === 'gitlink') return { kind: 'submodule' };
  const read = await readExact(
    client,
    projectId,
    [before?.blob, after?.blob].filter((id): id is string => !!id),
  );
  if (read.large) return { kind: 'large', size: read.size };
  const of = (side: Side) => (side ? read.bytes.get(side.blob)! : new Uint8Array());
  const result = computeHunks(of(before), of(after), 3) as {
    hunks: Hunk[];
    truncated: boolean;
    content?: string;
    encoding?: 'not-utf-8';
  };
  if (result.truncated && !result.hunks.length) return { kind: 'binary', size: read.size };
  if (!result.hunks.length) return { kind: 'same' };
  return {
    kind: 'diff',
    hunks: result.hunks,
    ...lineCounts(result.hunks),
    ...(result.encoding ? { encoding: result.encoding } : {}),
    ...(result.truncated ? { rough: true as const } : {}),
  };
}
