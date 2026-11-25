// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { ActionCtx, MutationCtx, QueryCtx } from './server';
import type { Doc } from './_generated/dataModel';
import { internal } from './_generated/api';
import { artifactBlobId } from './artifactBlobFields';
import { artifactMetadata, removeArtifact } from './artifactStorage';
import { presignPut, presignGet, r2Config } from './r2';
import { exchangeFetch } from '../src/exchange-request';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { invariant } from '../src/errors';

/** `r2blob:<artifactBlobs ID>`. Any other reference names no stored bytes: reads find nothing and a
 * delete is a no-op. Owning callers always authorize before resolving a reference; storage metadata
 * never grants access. */
export type BlobId = string;
export type BlobMetadata = { size: number; sha256: string; contentType?: string | null };
export type StoreOptions = { sha256?: string; r2Namespace?: string };
export interface BlobReader {
  getUrl(id: BlobId): Promise<string | null>;
  getMetadata(id: BlobId): Promise<BlobMetadata | null>;
}
export interface BlobWriter extends BlobReader {
  delete(id: BlobId): Promise<void>;
}
export interface BlobStore extends BlobWriter {
  get(id: BlobId): Promise<Blob | null>;
  store(blob: Blob, options?: StoreOptions): Promise<BlobId>;
}

type Context = Partial<Pick<ActionCtx, 'runQuery' | 'runMutation' | 'runAction'>> & {
  db?: QueryCtx['db'] | MutationCtx['db'];
  scheduler?: MutationCtx['scheduler'];
};
export function blobStore(ctx: Pick<ActionCtx, 'runQuery' | 'runMutation' | 'runAction'>): BlobStore;
export function blobStore(ctx: Pick<MutationCtx, 'db' | 'scheduler'>): BlobWriter;
export function blobStore(ctx: Pick<QueryCtx, 'db'>): BlobReader;
export function blobStore(ctx: Context): BlobStore {
  const row = async (ref: string): Promise<Doc<'artifactBlobs'> | null> => {
    invariant(ctx.runQuery, 'INVALID_ARTIFACT', 'Artifact bytes require an action.');
    const value = await ctx.runQuery(internal.artifactStorage.get, { ref });
    return value?.committed ? value : null;
  };
  return {
    get: async id => {
      if (!artifactBlobId(id)) return null;
      const value = await row(id);
      if (!value) return null;
      const response = await exchangeFetch(
        'R2 artifact download',
        await presignGet(r2Config(), value.r2Key),
        { headers: { 'accept-encoding': 'identity' } },
      );
      invariant(response.ok, 'R2_OBJECT_UNAVAILABLE', 'Stored artifact bytes are unavailable.');
      const bytes = new Uint8Array(await response.arrayBuffer());
      invariant(
        bytes.length === value.size && bytesToHex(sha256(bytes)) === value.digest,
        'BLOB_DIGEST_MISMATCH',
        'Stored artifact differs from its digest.',
      );
      return new Blob([bytes], { type: value.contentType });
    },
    store: async (blob, options) => {
      invariant(options?.r2Namespace, 'R2_REQUIRED', 'Artifact bytes need an R2 namespace.');
      invariant(ctx.runMutation && ctx.runAction, 'INVALID_ARTIFACT', 'Artifact uploads require an action.');
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const value: Doc<'artifactBlobs'> = await ctx.runMutation(internal.artifactStorage.reserve, {
        namespace: options.r2Namespace,
        digest: bytesToHex(sha256(bytes)),
        size: bytes.length,
        contentType: blob.type,
      });
      const ref = `r2blob:${value._id}`;
      if (!value.committed) {
        const target = await presignPut(r2Config(), value.r2Key, value);
        const response = await exchangeFetch('R2 artifact upload', target.url, {
          method: 'PUT',
          headers: target.headers,
          body: bytes,
        });
        invariant(
          response.ok || response.status === 412,
          'R2_UPLOAD_FAILED',
          'Object storage could not upload the artifact.',
        );
        await ctx.runAction(internal.artifactStorage.commit, { ref });
      }
      return ref;
    },
    delete: async id => {
      if (!artifactBlobId(id)) return;
      if (ctx.db && ctx.scheduler) {
        const value = await ctx.db.get(artifactBlobId(id)!);
        if (value) await removeArtifact({ db: ctx.db as MutationCtx['db'], scheduler: ctx.scheduler }, value);
      } else {
        invariant(ctx.runMutation, 'INVALID_ARTIFACT', 'Artifact cleanup requires a writer.');
        await ctx.runMutation(internal.artifactStorage.remove, { ref: id });
      }
    },
    getUrl: async id => {
      if (!artifactBlobId(id)) return null;
      const value = await row(id);
      return value ? presignGet(r2Config(), value.r2Key) : null;
    },
    getMetadata: async id => {
      if (!artifactBlobId(id)) return null;
      if (ctx.db) return artifactMetadata({ db: ctx.db }, id);
      const value = await row(id);
      return value ? { size: value.size, sha256: value.digest, contentType: value.contentType } : null;
    },
  };
}
