# Data placement

Bytes go to R2. Convex holds records, read and written in pages, never per file.

This page lists every byte store and every Convex table: what it holds, and whether it grows with repository size (one row or object per file or physical object), with activity (per save, landing, run or event) or stays fixed (per project, account or setting). The guard in `tests/hot-storage-invariant.test.mjs` enforces the byte rule; its allowlist is reproduced below.

## Byte stores

| Store | Holds | Grows with | Written by |
| --- | --- | --- | --- |
| R2 `v1/p/<project>/o/<sha256>` | Project objects: file contents, State manifests, Work metadata, recipe leaves, source-job outputs, cursors (`r2source:`), checkpoint roots, exchange-cache artifacts. Content-addressed, create-only, checksum-bound PUT. | Repo size | Presigned PUTs from the CLI and hosted workers; `storeSourceBytes`, import upload, `storeProjectArtifact` inside Convex actions. |
| R2 `v1/p/<project>/…` archives and packs | Backup and proposal archives, original-archive receipts, source packs, check logs. | Activity | Presigned PUTs; `archiveTarget`, `projectSourcePacks`. |
| R2 `v1/i/…`, `v1/d/…` (`r2blob:` refs) | Indexed import artifacts and binary derivatives, through `artifactBlobs`. | Repo size per import | `blobStore(ctx).store(..., { r2Namespace })`. |
| Convex file storage | Legacy copies only (written before R2 was the only path), until Issue 40dad5e0 moves and deletes them. | Nothing new | Nothing. No code calls `storage.store` or `generateUploadUrl`. |
| Convex documents | Records below. Large values are paged; byte bodies are pins (`digest`, `size`, `r2Key`), not bytes. | See tables | Mutations. |

**Placement rule** (`r2Config()` in `convex/r2.ts`): every deployment writes R2, self-host included, for every project. There is no opt-in, flag or Convex byte mode. If the `R2_*` settings are missing, writes fail with `R2_NOT_CONFIGURED`. A self-hosted instance can point `R2_ENDPOINT` at any S3-compatible bucket. Rows written earlier in Convex storage stay readable from it until backfilled.

## Guard allowlist

Every entry has an owner reason and expires on 2027-01-31; an expired entry fails the guard. Kinds: **write** (`storage.store`, `generateUploadUrl`), **read** (`storage.get`, `storage.getUrl`), **handle** (a `ctx.storage` value passed on), **field** (`v.id('_storage')`).

| File | Kinds | Why |
| --- | --- | --- |
| `convex/blobStore.ts` | read, handle | Legacy ids read Convex; every write goes to R2. |
| `convex/projectConvexSource.ts`, `convex/projectConvexSourceStorage.ts`, `convex/projectGithubMirror.ts`, `convex/projectWorkIndexRetry.ts`, `convex/storageMeter.ts` | read (and handle for the two wrappers) | Read legacy Convex copies; `storageMeter` meters that egress. |
| `convex/projectR2Backfill.ts`, `convex/r2BackfillFields.ts` | read, field | Backfill names and downloads each legacy copy it moves. |
| `convex/projectBackups.ts`, `convex/projectBackupActions.ts`, `convex/projectProposals.ts`, `convex/projectProposalActions.ts`, `convex/projectExchange.ts`, `convex/projectLifecycle.ts`, `convex/projectObjectFields.ts`, `convex/projectHostedActionsPlan.ts`, `convex/projectHostedFinishDriver.ts`, `convex/projectSourceStepFields.ts`, `convex/projectWorkIndexFields.ts`, `convex/schema.ts` | field | Legacy `storageId` columns, readable until cleanup. |
| `convex/projectBootstrapStore.ts`, `convex/projectGithubImportBatch.ts`, `convex/projectGithubImportObjects.ts` | field | Legacy `storageId` receipts beside the R2 key; nothing new writes them. |

## Convex tables

| Tables | Hold | Grows with |
| --- | --- | --- |
| `projectObjects` | One row per physical object: digest, size, placement (`r2Key`, `location`, legacy `storageId`), recipe pin. No bytes. | Repo size |
| `projectGithubImports`, `projectGithubImportInventory` | GitHub import jobs and their paged inventory (keys and positions per page). | Repo size, per import |
| `projectSourcePacks` | Latest source pack per project (R2 key and pins). | Fixed |
| `projectSourceSteps`, `projectSourceTasks`, `projectSourceBatches`, `projectSourcePools` | Source-job steps, fan-out tasks and worker pools; cursors are `r2source:` pins. | Activity |
| `projectHostedStates`, `projectHostedSaves`, `projectHostedSavePages`, `projectHostedSyncs`, `projectHostedSeeds`, `projectHostedSeedPages` | Saved States and their paged inputs/outputs. | Activity (pages, not files) |
| `projectHostedComposes`, `projectHostedComposePages`, `projectHostedComposeSelections`, `projectHostedAcceptances`, `projectHostedAcceptanceEvents`, `projectHostedAcceptancePages`, `projectHostedAcceptancePlans`, `projectHostedAcceptanceSnapshots`, `projectHostedAckBatches` | Candidates, acceptance and their pages. | Activity |
| `projectHostedLandingRequests`, `projectHostedLandingAttempts`, `projectHostedLandingBatches`, `projectHostedLandingQueues`, `projectHostedLandingDesired`, `projectHostedLandingAliases`, `projectHostedLandingCheckWakes`, `projectHostedLandingObservations`, `projectHostedFinishes`, `projectHostedStallAlerts` | Landing queue and finish records. | Activity |
| `projectHostedCheckRuns`, `projectHostedCheckShards`, `projectHostedCheckCallbacks`, `projectHostedCheckWorkers`, `projectHostedCheckSettings`, `projectHostedCheckSettingVersions`, `projectHostedTestTimings`, `projectHostedActionsExports`, `projectHostedActionsResults`, `projectCheckRequests`, `projectCheckRunners` | Check runs, shards, results and settings. | Activity |
| `projectHostedOutputStreams`, `projectHostedOutputChunks`, `projectHostedOutputHeads`, `projectHostedOutputSummaries`, `projectCheckLogCleanups`, `projectCheckLogCleanupPages`, `projectCheckLogRetentions`, `projectCheckLogSourcePins` | Check output in bounded text chunks and its cleanup. | Activity |
| `projectHostedChannels`, `projectHostedOperations`, `projectHostedLifecycleEvents`, `projectHostedLifecycleGuards`, `projectHostedLifecyclePlans`, `projectHostedLifecyclePointers`, `projectHostedMainAudits`, `projectHostedMainAuditEvents`, `projectHostedTrust` | Channels, operation receipts, Lane lifecycle and main audits. | Activity |
| `projectHostedRecords`, `projectHostedRecordHeads`, `projectHostedRecordBodies`, `projectHostedDisplayRecords`, `projectHostedSnapshots`, `projectHostedSnapshotHeads`, `projectHostedSnapshotPages`, `projectHostedDecisions`, `projectHostedDecisionMaintainers`, `projectHostedFriction` | Work records (Intents, Lanes, decisions), snapshots and display copies. | Activity |
| `projectHostedOverlapLanes`, `projectHostedOverlapMain`, `projectHostedOverlapDeliveries`, `projectHostedOverlapAcks` | Overlap notices and answers. | Activity |
| `projectWorkGenerations`, `projectWorkRecords`, `projectWorkHeads`, `projectWorkEvents`, `projectWorkDetailMigrations`, `projectReturnPages`, `projectReturnSupersessions` | Work index generations and entries, Work events, return pages. | Activity |
| `projectCoordinationClaims`, `projectCoordinationEvents`, `projectCoordinationReceipts`, `projectCoordinationSessions` | Live coordination (advisory). | Activity |
| `projectBackups`, `projectProposals`, `projectUploadCleanup`, `projectRecoveryConnections` | Backup and proposal archive rows (R2 key, legacy `storageId`) and upload cleanup. | Activity |
| `projectPublications`, `projectPublicationAttempts`, `projectPublicationPages`, `projectGithubBindings`, `projectGithubMirrors`, `projectGithubMirrorJobs` | Publication and GitHub mirror state. | Activity |
| `projectSelfMetricReceipts`, `projectSelfMetricBills` | Self-metric receipts and recorded bills. | Activity |
| `hostedProjects`, `projectSlugs`, `projectContributors`, `projectInvites`, `projectReaders`, `projectReaderOperations`, `projectAccessOperations`, `projectActorNames`, `projectPolicyChanges`, `projectInterests`, `projectBriefingSources`, `projectSourceAuthorityTransitions`, `projectSourceCutovers`, `ownerAcceptanceMachines`, `ownerAcceptanceRequests` | Project identity, access, policy and authority. | Fixed |
| `imports`, `importArtifacts`, `importReaders`, `importRemovalOperations`, `teamImports`, `sourceZones`, `zoneChanges`, `zoneReaders`, `derivedArtifacts`, `artifactBlobs` | Indexed public imports, Zones, derivatives and `r2blob:` metadata. | Repo size, per import |
| `forgeAccounts`, `accountHandles`, `accountItems`, `accountOperations`, `handleOperations`, `cliCredentials`, `deviceCodes`, `deviceAttempts`, `agentGrants`, `agentEvents`, `agentUserSettings`, `agentGuidanceOperations`, `agentGuidanceMaintainerOperations`, `teams`, `teamMembers`, `savedViews`, `interestChanges`, `clientErrors` | Accounts, credentials, agent grants, teams and settings. | Fixed |
| `githubBindingInstallations`, `githubBindingOperations`, `githubBindingRemovals`, `githubBindingWebhookReceipts`, `githubDeliveries` | GitHub App installations and webhook receipts. | Activity |
| `secretObjects`, `secretVersions`, `secretGrants`, `secretEvents`, `secretDeletions` | Encrypted Secret Objects and grants. | Fixed |

## Measuring it

Hosted self-metrics include **bytes by location**: every Convex file-storage write on the deployment in the window, read from the `_storage` system table newest first (`projectBytePlacement:convexWritten`, pages of 64; one call when nothing was written). It must read 0 bytes; any byte adds a warning to the headline. An older deployment without the query reports the metric as unknown, never 0.

`nforge maintenance r2-backfill ROOT --dry-run` reports, per project, the legacy rows still only in Convex storage (count, bytes, estimated move cost) and the Convex copies already moved to R2 that cleanup could delete. It reads indexed rows in pages of 100 and moves nothing. The move and the delete are separate, owner-approved steps ([R2 backfill](operations/r2-backfill.md)).
