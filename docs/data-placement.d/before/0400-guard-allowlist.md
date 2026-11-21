## Guard allowlist

Every entry has an owner reason and expires on 2027-01-31; an expired entry fails the guard. Kinds: **write** (`storage.store`, `generateUploadUrl`), **read** (`storage.get`, `storage.getUrl`, `storage.getMetadata`), **handle** (a `ctx.storage` value passed on), **field** (`v.id('_storage')`), **native-url** (`nativeLegacyUrl` references outside the shared read seam).

| File | Kinds | Why |
| --- | --- | --- |
| `convex/legacyStorageRead.ts` | read | Shared legacy read seam. On a Convex miss, a tombstone pins the R2 copy. Byte reads verify size and SHA-256. URL reads sign a five-minute GET for the exact copy key. |
| `convex/blobStore.ts` | handle | Deletes existing legacy copies. Every upload goes to R2. |
| `convex/projectWorkIndexRetry.ts` | handle, native-url | Wraps the native Convex reader for Work index retries. |
| `convex/storageMeter.ts` | handle | Wraps native Convex reads for egress diagnostics. |
| `convex/projectR2Backfill.ts` | field, native-url | Backfill reads the native source of each legacy copy it moves. |
| `convex/r2BackfillFields.ts` | field | Backfill names each legacy Convex copy it moves. |
| `convex/projectBackups.ts`, `convex/projectBackupActions.ts`, `convex/projectProposals.ts`, `convex/projectProposalActions.ts`, `convex/projectExchange.ts`, `convex/projectLifecycle.ts`, `convex/projectObjectFields.ts`, `convex/projectHostedActionsPlan.ts`, `convex/projectHostedFinishDriver.ts`, `convex/projectSourceStepFields.ts`, `convex/projectWorkIndexFields.ts`, `convex/schema.ts` | field | Legacy `storageId` columns, readable until cleanup. |
| `convex/projectBootstrapStore.ts`, `convex/projectGithubImportBatch.ts`, `convex/projectGithubImportObjects.ts` | field | Legacy `storageId` receipts beside the R2 key; nothing new writes them. |

The approved dev cleanup also uses legacy `_storage` pins in
`convex/legacyStorageCleanupFields.ts`, `convex/projectLegacyStorageCleanup.ts` and
`convex/projectLegacyStorageRepair.ts` (field allowlist, expires 2027-01-31). It deletes
only verified frozen-manifest files; the repair records a backfill time and moves no bytes.
