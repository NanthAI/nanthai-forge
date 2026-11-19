## Guard allowlist

Every entry has an owner reason and expires on 2027-01-31; an expired entry fails the guard. Kinds: **write** (`storage.store`, `generateUploadUrl`), **read** (`storage.get`, `storage.getUrl`), **handle** (a `ctx.storage` value passed on), **field** (`v.id('_storage')`).

| File | Kinds | Why |
| --- | --- | --- |
| `convex/blobStore.ts` | read, handle | Legacy ids read Convex; every write goes to R2. |
| `convex/projectConvexSourceTransport.ts`, `convex/projectConvexSourceStorage.ts`, `convex/projectGithubMirror.ts`, `convex/projectWorkIndexRetry.ts`, `convex/storageMeter.ts` | read (and handle for the two wrappers) | Read legacy Convex copies; `storageMeter` meters that egress. |
| `convex/projectR2Backfill.ts`, `convex/r2BackfillFields.ts` | read, field | Backfill names and downloads each legacy copy it moves. |
| `convex/projectBackups.ts`, `convex/projectBackupActions.ts`, `convex/projectProposals.ts`, `convex/projectProposalActions.ts`, `convex/projectExchange.ts`, `convex/projectLifecycle.ts`, `convex/projectObjectFields.ts`, `convex/projectHostedActionsPlan.ts`, `convex/projectHostedFinishDriver.ts`, `convex/projectSourceStepFields.ts`, `convex/projectWorkIndexFields.ts`, `convex/schema.ts` | field | Legacy `storageId` columns, readable until cleanup. |
| `convex/projectBootstrapStore.ts`, `convex/projectGithubImportBatch.ts`, `convex/projectGithubImportObjects.ts` | field | Legacy `storageId` receipts beside the R2 key; nothing new writes them. |

The approved dev cleanup also uses legacy `_storage` pins in
`convex/legacyStorageCleanupFields.ts`, `convex/projectLegacyStorageCleanup.ts` and
`convex/projectLegacyStorageRepair.ts` (field allowlist, expires 2027-01-31). It deletes
only verified frozen-manifest files; the repair records a backfill time and moves no bytes.
