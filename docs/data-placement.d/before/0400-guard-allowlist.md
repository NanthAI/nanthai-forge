## Guard allowlist

The guard lists every use of Convex file storage in `convex/`: **write** (`storage.store`, `generateUploadUrl`), **read** (`storage.get`, `storage.getUrl`, `storage.getMetadata`), **handle** (a `ctx.storage` value passed on) and **field** (`v.id('_storage')`). Each entry needs an owner reason and an expiry date, and an expired entry fails the guard.

The read-through for retired files, the write pause, the cleanup modules, the `storageId` columns on objects, backups and proposals, and the R2 backfill that moved native files are deleted (Item c0af6cfa, family F6). What remains reads an import's or derived artifact's own reference when it is not an `r2blob:` id (dev holds none):

| File | Kinds | Why |
| --- | --- | --- |
| `convex/blobStore.ts` | handle | Reads and deletes an artifact reference that is not an `r2blob:` id. Every upload goes to R2. |
| `convex/projectWorkIndexRetry.ts` | handle, read | Wraps that reader for Work index retries. |
| `convex/storageMeter.ts` | handle, read | Wraps that reader for egress diagnostics. |

A new use of Convex file storage fails `npm run verify`; bytes go to R2.
