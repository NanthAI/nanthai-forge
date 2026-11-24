// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
'use node';
import { createHash } from 'node:crypto';
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { internal } from './_generated/api';
import type { Doc } from './_generated/dataModel';
import { internalAction } from './server';
import { archiveDownload } from './archiveDownload';
import { rawContent } from './projectObjectContent';
import { isR2Object } from './projectObjectFields';
import type { ObjectView } from './projectObjectFind';
import { exchangeFetch } from '../src/exchange-request';
import { digest } from '../src/hash';
import { invariant } from '../src/errors';

/** Object bytes are buffered by the product reader, so a call proves at most 64 MiB of objects.
 * Backup archives stream through a hash, so any size is bounded in memory. */
const objectProofBytes = 64 * 1024 * 1024;
const proof = v.object({
  id: v.string(),
  path: v.string(),
  pointer: v.boolean(),
  size: v.number(),
  sha256: v.string(),
  /** Object: the saved-continuation ownership proof (projectConvexSourceOwnership:owns) for its
   * pointer. Backup: whether its old id still resolves as an archive alias (r2ArchiveSource). */
  alias: v.union(v.null(), v.boolean()),
});
type Proof = typeof proof.type;

/** Read-only byte proof for the F6 converter (convex/storagePointerRetire.ts). Reads each named
 * row through the product read path, refuses unless the bytes match the row's pinned digest and
 * size, and returns exactly one entry per requested id, in order. Run it on the same ids before
 * and after `run {apply:true}`: equal `sha256`/`size`, `pointer` true then false for cleared rows,
 * and an unchanged `alias` for blocked ones are the byte-equal proof. */
export const read = internalAction({
  args: { objects: v.array(v.id('projectObjects')), backups: v.array(v.id('projectBackups')) },
  returns: v.array(proof),
  handler: async (ctx, ids): Promise<Proof[]> => {
    const rows: { objects: ObjectView[]; backups: Doc<'projectBackups'>[]; owners: string[] } =
      await ctx.runQuery(internal.storagePointerRetire.proofRows, ids);
    const total = rows.objects.reduce((n, row) => n + row.size, 0);
    invariant(total <= objectProofBytes, 'BAD_ARGUMENT', 'Prove at most 64 MiB of objects per call.');
    const out: Proof[] = [];
    for (const row of rows.objects) {
      const bytes = await rawContent(ctx, row, { sha256: row.digest, size: row.size });
      const sha256 = digest(bytes);
      invariant(
        sha256 === row.digest && bytes.length === row.size,
        'BLOB_DIGEST_MISMATCH',
        `Object ${row._id} differs from its pin.`,
      );
      const alias = row.storageId
        ? await ctx.runQuery(
            makeFunctionReference<'query', { projectId: string; ref: string }, boolean>(
              'projectConvexSourceOwnership:owns',
            ),
            {
              projectId: row.projectId,
              ref: row.storageId,
            },
          )
        : null;
      out.push({
        id: String(row._id),
        path: isR2Object(row) ? 'r2' : 'native',
        pointer: !!row.storageId,
        size: bytes.length,
        sha256,
        alias,
      });
    }
    for (const [i, row] of rows.backups.entries()) {
      const direct = await archiveDownload(ctx, row);
      invariant(direct?.url, 'R2_OBJECT_UNAVAILABLE', `Backup ${row._id} has no direct R2 read.`);
      const response = await exchangeFetch('F6 proof backup download', direct.url, {
        headers: { 'accept-encoding': 'identity' },
      });
      invariant(
        response.ok && response.body,
        'R2_OBJECT_UNAVAILABLE',
        `Backup ${row._id} bytes are unavailable.`,
      );
      const hash = createHash('sha256');
      let size = 0;
      for await (const part of response.body as unknown as AsyncIterable<Uint8Array>) {
        size += part.length;
        hash.update(part);
      }
      const sha256 = hash.digest('hex');
      invariant(
        sha256 === row.digest && size === row.size,
        'BLOB_DIGEST_MISMATCH',
        `Backup ${row._id} differs from its pin.`,
      );
      const resolved: { digest: string; size: number } | null = row.storageId
        ? await ctx.runQuery(
            makeFunctionReference<
              'query',
              { storageId: string; actor: string | null },
              { digest: string; size: number } | null
            >('r2ArchiveSource:resolve'),
            { storageId: row.storageId, actor: rows.owners[i] || null },
          )
        : null;
      const alias = row.storageId ? resolved?.digest === row.digest && resolved.size === row.size : null;
      out.push({ id: row._id, path: 'r2', pointer: !!row.storageId, size, sha256, alias });
    }
    invariant(
      out.map(item => item.id).join() === [...ids.objects, ...ids.backups].join(),
      'BAD_ARGUMENT',
      'The proof must answer exactly the requested rows.',
    );
    return out;
  },
});
