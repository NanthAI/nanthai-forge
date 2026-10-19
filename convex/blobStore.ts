// SPDX-License-Identifier: Apache-2.0
import type { FileMetadata, StorageActionWriter, StorageReader, StorageWriter } from 'convex/server';
import type { Id } from './_generated/dataModel';

/** The one seam for file bytes held by Convex functions. Every store, read, URL
 * and delete goes through here so another backing store (R2) can be added
 * behind it. Today the only implementation is Convex file storage; behaviour
 * and byte counts are unchanged. Reads delegate to `ctx.storage` on each call,
 * so `meteredStorage` still counts them. */
export type BlobId = Id<'_storage'>;
export interface BlobReader {
  getUrl(id: BlobId | string): Promise<string | null>;
  getMetadata(id: BlobId | string): Promise<FileMetadata | null>;
}
export interface BlobWriter extends BlobReader {
  generateUploadUrl(): Promise<string>;
  delete(id: BlobId | string): Promise<void>;
}
export interface BlobStore extends BlobWriter {
  get(id: BlobId | string): Promise<Blob | null>;
  store(blob: Blob, options?: { sha256?: string }): Promise<BlobId>;
}

export function blobStore(ctx: { storage: StorageActionWriter }): BlobStore;
export function blobStore(ctx: { storage: StorageWriter }): BlobWriter;
export function blobStore(ctx: { storage: StorageReader }): BlobReader;
export function blobStore(ctx: { storage: StorageActionWriter | StorageWriter | StorageReader }): BlobStore {
  // Lazy on purpose: the context's storage can be wrapped after this is created.
  const s = () => ctx.storage as StorageActionWriter;
  return {
    get: id => s().get(id),
    store: (blob, options) => s().store(blob, options),
    delete: id => s().delete(id),
    getUrl: id => s().getUrl(id),
    getMetadata: id => s().getMetadata(id),
    generateUploadUrl: () => s().generateUploadUrl(),
  };
}
