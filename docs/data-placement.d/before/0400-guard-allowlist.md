## Guard allowlist

Every entry has an owner reason and an expiry date; an expired entry fails the guard. Kinds: **write** (`storage.store`, `generateUploadUrl`), **read** (`storage.get`, `storage.getUrl`, `storage.getMetadata`), **handle** (a `ctx.storage` value passed on), **field** (`v.id('_storage')`). The Convex file-storage read-through for retired files, its pause switch and the cleanup modules are deleted (Item c0af6cfa, family F6); the entries below are the last native-storage code and leave with the `storageId` field (dated 2026-12-31).

| File | Kinds | Why |
| --- | --- | --- |
| `convex/blobStore.ts` | handle | Reads and deletes existing legacy copies. Every upload goes to R2. |
| `convex/projectConvexSourceStorage.ts`, `convex/projectConvexSourceTransport.ts`, `convex/projectGithubMirror.ts` | read | Read one legacy source copy by its old id. |
| `convex/projectWorkIndexRetry.ts` | handle, read | Wraps the native Convex reader for Work index retries. |
| `convex/storageMeter.ts` | handle, read | Wraps native Convex reads for egress diagnostics. |
| `convex/projectR2Backfill.ts` | field, read | Backfill reads the native source of each legacy copy it moves. |
| `convex/r2BackfillFields.ts` | field | Backfill names each legacy Convex copy it moves. |
| `convex/projectBackups.ts`, `convex/projectBackupActions.ts`, `convex/projectProposals.ts`, `convex/projectProposalActions.ts`, `convex/projectExchange.ts`, `convex/projectLifecycle.ts`, `convex/projectObjectFields.ts`, `convex/projectHostedActionsPlan.ts`, `convex/projectHostedFinishDriver.ts`, `convex/projectSourceStepFields.ts`, `convex/projectWorkIndexFields.ts`, `convex/schema.ts` | field | Legacy `storageId` columns; no row holds one on dev. |
| `convex/projectBootstrapStore.ts`, `convex/projectGithubImportBatch.ts`, `convex/projectGithubImportObjects.ts` | field | Legacy `storageId` receipts beside the R2 key; nothing writes them. |
