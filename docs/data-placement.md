# Data placement

Bytes go to R2. Convex holds records, read and written in pages, never per file.

This page lists every byte store and every Convex table: what it holds, and whether it grows with repository size (one row or object per file or physical object), with activity (per save, landing, run or event) or stays fixed (per project, account or setting). The guard in `tests/hot-storage-invariant.test.mjs` enforces the byte rule; its allowlist is reproduced below.

## Byte stores

| Store | Holds | Grows with | Written by |
| --- | --- | --- | --- |
| R2 `v1/p/<project>/o/<sha256>` | Project objects: file contents, State manifests, Work metadata, recipe leaves, source-job outputs, cursors (`r2source:`), checkpoint roots, exchange-cache artifacts. Content-addressed, create-only, checksum-bound PUT. | Repo size | Presigned PUTs from the CLI and hosted workers; `storeSourceBytes`, import upload, `storeProjectArtifact` inside Convex actions. |
| R2 `v1/p/<project>/…` archives and packs | Backup and proposal archives, original-archive receipts, source packs, check logs. | Activity | Presigned PUTs; `archiveTarget`, `projectSourcePacks`. |
| R2 `v1/p/<project>/o/<sha256>` history chunks | Imported Git history: the Git host's pack bytes unchanged (same commit ids), split into content-addressed chunks of at most 32 MiB; pinned by `projectHistoryPacks`. Chunks a fetch created but never recorded (over the limit, failed or stale) are deleted at once, with one scheduled retry if a delete fails. | History size, up to the project's history limit (default 1 GiB) | `projectHistoryImport` (import run, read catch-up, first [Git serving](git-serving.md) request of a mirrored project). |
| R2 `v1/p/<project>/o/<sha256>` Lane Git packs and alias object | [Git serving](git-serving.md) Lane refs: one pack per fetched Lane head (its built commit plus the trees and blobs the parent commit lacks), pinned by `projectGitLaneCommits`, and one JSON map of source SHA-256 to Git blob ids for the last built head and base, pinned by `projectHistory.laneAliases`. A replaced pack or alias object, and packs of closed Lanes, are deleted when the next build records. | Changed bytes of fetched Lanes; aliases about two States of ids | `gitServeLane` (first Git fetch of a Lane head). |
| R2 `v1/i/…`, `v1/d/…` (`r2blob:` refs) | Indexed import artifacts and binary derivatives, through `artifactBlobs`. | Repo size per import | `blobStore(ctx).store(..., { r2Namespace })`. |
| Convex file storage | Legacy copies only (written before R2 was the only path), until Issue 40dad5e0 moves and deletes them. | Nothing new | Nothing. No code calls `storage.store` or `generateUploadUrl`. |
| Convex documents | Records below. Large values are paged; byte bodies are pins (`digest`, `size`, `r2Key`), not bytes. | See tables | Mutations. |

**Placement rule** (`r2Config()` in `convex/r2.ts`): every deployment writes R2, self-host included, for every project. There is no opt-in, flag or Convex byte mode. If the `R2_*` settings are missing, writes fail with `R2_NOT_CONFIGURED`. A self-hosted instance can point `R2_ENDPOINT` at any S3-compatible bucket. Rows written earlier in Convex storage stay readable from it until backfilled.

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

## Convex tables

| Tables | Hold | Grows with |
| --- | --- | --- |
| `legacyStorageCleanupPages` | Retry receipts for approved maintenance pages; no file bodies. | Maintenance pages |
| `legacyStorageCleanupWindows` | One metadata fence per approved dev cleanup window; closing it invalidates older deletion transactions. No source or file bytes. | Approved maintenance windows |
| `projectObjects` | One row per physical object: digest, size, placement (`r2Key`, `location`, legacy `storageId`), recipe pin. No bytes. | Repo size |
| `projectObjectCatalog` | Sorted pins of a GitHub archive import, 256 per row (digest, size, recipe or packed byte range; physical packs retain protected source pins), instead of one `projectObjects` row per object; `findObject` reads it. | Repo size / 256 |
| `projectGithubImports`, `projectGithubImportInventory` | GitHub import jobs and their paged inventory (keys and positions per page). Inventory rows are deleted once the import is published. | Repo size, during an import |
| `projectSourcePacks` | Latest source pack per project (R2 key and pins). | Fixed |
| `projectHistory`, `projectHistoryPacks` | Imported Git history: one status row per project (repository, import commit and State, stored bytes, owner limit, cached trailer of one joined pack set) and one row per Git pack (tip commit, R2 chunk pins, pack checksum), never one per commit. | Imports, history reads and Git ref listings after main's mirror moved |
| `gitWorkerUsage` | Large-pack Worker use per UTC day: packs and bytes per project and for all projects ('*'), checked before a redirect and counted before bytes flow; rows older than 7 days are deleted when their scope is next written. | Git fetches served through the [large-pack Worker](git-serving.md#large-packs) |
| `projectSourceSteps`, `projectSourceTasks`, `projectSourceBatches`, `projectSourcePools` | Source-job steps, fan-out tasks and worker pools; cursors are `r2source:` pins. | Activity |
| `projectHostedStates`, `projectHostedSaves`, `projectHostedSavePages`, `projectHostedSyncs`, `projectHostedSeeds`, `projectHostedSeedPages` | Saved States and their paged inputs/outputs. | Activity (pages, not files) |
| `projectHostedComposes`, `projectHostedComposePages`, `projectHostedComposeSelections`, `projectHostedAcceptances`, `projectHostedAcceptanceEvents`, `projectHostedAcceptancePages`, `projectHostedAcceptancePlans`, `projectHostedAcceptanceSnapshots`, `projectHostedAckBatches` | Candidates, acceptance and their pages. | Activity |
| `projectFinishReadRows`, `projectHostedLandingRequests`, `projectHostedLandingAttempts`, `projectHostedLandingBatches`, `projectHostedLandingQueues`, `projectHostedLandingQueueStatus`, `projectHostedLandingDesired`, `projectHostedLandingAliases`, `projectHostedLandingCheckWakes`, `projectHostedLandingObservations`, `projectHostedFinishes`, `projectHostedStallAlerts`, `projectLandingSpeed`, `projectHostedApprovals` | Landing queue and finish records; `projectHostedApprovals` holds one approval request per Lane; `projectLandingSpeed` holds one project's last 7 days of landing timings for the regression alert. | Activity |
| `projectHostedCheckRuns`, `projectHostedCheckShards`, `projectHostedCheckCallbacks`, `projectHostedCheckWorkers`, `projectHostedCheckSettings`, `projectHostedCheckSettingVersions`, `projectHostedTestTimings`, `projectHostedActionsExports`, `projectHostedActionsResults`, `projectCheckRequests`, `projectCheckRunners` | Check runs, shards, results and settings. | Activity |
| `projectHostedOutputStreams`, `projectHostedOutputChunks`, `projectHostedOutputHeads`, `projectHostedOutputSummaries`, `projectCheckLogCleanups`, `projectCheckLogCleanupPages`, `projectCheckLogRetentions`, `projectCheckLogSourcePins` | Check output in bounded text chunks and its cleanup. | Activity |
| `projectHostedChannels`, `projectHostedOperations`, `projectHostedLifecycleEvents`, `projectHostedLifecycleGuards`, `projectHostedLifecyclePlans`, `projectHostedLifecyclePointers`, `projectHostedMainAudits`, `projectHostedMainAuditEvents`, `projectHostedTrust` | Channels, operation receipts, Lane lifecycle and main audits. | Activity |
| `projectReleaseSignatures` | Owner Ed25519 signatures over released States with their release number (64 bytes each, at most 4 per State); verified by the CLI updater. | Releases |
| `projectHostedRecords`, `projectHostedRecordHeads`, `projectHostedRecordBodies`, `projectHostedDisplayRecords`, `projectHostedSnapshots`, `projectHostedSnapshotHeads`, `projectHostedSnapshotPages`, `projectHostedDecisions`, `projectHostedDecisionMaintainers`, `projectHostedFriction` | Work records (Intents, Lanes, decisions), snapshots and display copies. | Activity |
| `projectHostedFrictionHints` | Bounded duplicate-candidate replay receipts when inline hints would exceed a friction row. Written atomically with capture and removed on project deletion. | Overflow captures |
| `projectHostedOverlapLanes`, `projectHostedOverlapMain`, `projectHostedOverlapDeliveries`, `projectHostedOverlapAcks` | Overlap notices and answers. | Activity |
| `projectHostedStackDependents` | One row per open Lane stacked on a parent Lane (parent Lane, pinned parent head, the parent's newest saved head and a conflicted automatic restack head, marks of the parent events already announced); written only by stacked Lane records, deleted when the Lane closes or unstacks and with the project. | Activity |
| `projectHostedPresence` | One slim row per open Lane (Issue, goal, up to 10 saved paths, handle-mapped actor, last activity) for presence; deleted when the Lane closes. | Activity |
| `projectBoardClaims` | Automatic file claims: one row per Lane and unsaved path written ("touching PATH"), at most 30 live per Lane, 14 days; hidden once the Lane saves the path or closes. | Activity, bounded by retention |
| `projectBoardMessages`, `projectBoardInboxes`, `projectBoardSenders`, `projectBoardProjects`, `boardAccounts`, `boardSwitches`, `boardAudit`, `boardEvidence` | Agent board notes (at most 240 characters, 14 days, 5,000 per project), per-target inbox and rate-window counters, account day totals, operator switches and audit, and body-free evidence rows. | Activity, bounded by retention |
| `projectReadBudgets`, `projectStorageUsage`, `accountStorageUsage` | Abuse-limit counters (`convex/abuseLimits.ts`): signed-out read calls per public project in the current window, and reserved stored objects and bytes per project (sharded) and per owning account (added in roll-ups); fixed rows per scope, reset or updated in place. | Activity, bounded by shard count |
| `projectWorkGenerations`, `projectWorkRecords`, `projectWorkHeads`, `projectWorkEvents`, `projectWorkDetailMigrations`, `projectReturnPages`, `projectReturnSupersessions` | Work index generations and entries, Work events, return pages. | Activity |
| `projectCoordinationClaims`, `projectCoordinationEvents`, `projectCoordinationReceipts`, `projectCoordinationSessions` | Live coordination (advisory). | Activity |
| `projectBackups`, `projectProposals`, `projectUploadCleanup`, `projectRecoveryConnections` | Backup and proposal archive rows (R2 key, legacy `storageId`) and upload cleanup. | Activity |
| `projectPublications`, `projectPublicationAttempts`, `projectPublicationPages`, `projectGithubBindings`, `projectGithubMirrors`, `projectGithubMirrorJobs` | Publication and GitHub mirror state. | Activity |
| `projectSelfMetricReceipts`, `projectSelfMetricBills` | Self-metric receipts and recorded bills. | Activity |
| `hostedProjects`, `projectSlugs`, `projectContributors`, `projectInvites`, `projectReaders`, `projectReaderOperations`, `projectAccessOperations`, `projectActorNames` (former-member provenance only; no names), `projectPolicyChanges`, `projectInterests`, `projectBriefingSources`, `projectSourceAuthorityTransitions`, `projectSourceCutovers`, `ownerAcceptanceMachines`, `ownerAcceptanceRequests` | Project identity, access, policy and authority. | Fixed |
| `imports`, `importArtifacts`, `importReaders`, `importRemovalOperations`, `teamImports`, `sourceZones`, `zoneChanges`, `zoneReaders`, `derivedArtifacts`, `artifactBlobs` | Indexed public imports, Zones, derivatives and `r2blob:` metadata. | Repo size, per import |
| `forgeAccounts`, `accountHandles`, `accountItems`, `accountOperations`, `handleOperations`, `cliCredentials`, `deviceCodes`, `deviceAttempts`, `agentGrants`, `agentEvents`, `agentUserSettings`, `agentGuidanceOperations`, `agentGuidanceMaintainerOperations`, `teams`, `teamMembers`, `savedViews`, `interestChanges`, `clientErrors` | Accounts, credentials, agent grants, teams and settings. | Fixed |
| `githubBindingInstallations`, `githubBindingOperations`, `githubBindingRemovals`, `githubBindingWebhookReceipts`, `githubDeliveries` | GitHub App installations and webhook receipts. | Activity |
| `githubRunnerGrants` | One row per Forge owner and runner repository proven by configure-runner. | Fixed |
| `githubRepositoryVisibility` | Last GitHub visibility read per runner repository (private projects only), overwritten in place and reused for 5 minutes. | Fixed, one row per runner repository |
| `secretObjects`, `secretVersions`, `secretGrants`, `secretEvents`, `secretDeletions` | Encrypted Secret Objects and grants. | Fixed |

## Planning search

Before filing an Issue or friction, search for an existing planning item and
comment on it instead of creating a duplicate. Use `planning {"search":"relevant words"}`
and follow `nextCursor`; `status:"all"` also finds closed work. Search is read-only,
ranked by Convex full-text relevance, and filters status/kind/initiative inside the
search index. Omitted status includes proposed/open/in-progress; an explicit status
is exact. Cursors bind the search, filters, page size and generation. `query` reports
the actual normalized terms and any terms omitted by the provider’s 16-term bound.
List/search summaries include `initiativeId` (null when unassigned), `bodyLength` and
`hasDoneWhen`. Unprepared legacy payload headers report null for unknown body
metadata; preparation fills it without per-item list reads. A detail read requires a complete UUID; validation names `id` and its shape.

New Issues and friction captures return `likelyDuplicates`, a bounded five-result
search of active Issues before creation. This is advisory: it adds no confirmation
or denial. Original-operation retries retain the original candidates. Partial or
unavailable index coverage is named. Search does not reconcile Intent status.

Search materialization normally adds one derived `planningSearch` row per current item in
the existing Work index, atomically maintained by planning writes and rebuilds.
Search previews bound title/body to 400 characters and report lengths/truncation;
full source remains unchanged. Rows are measured with Convex's physical-size helper.
Oversized text uses 16k-character, whole-word fragments plus a compact current root;
search returns each item at its best matching fragment, rejecting retired versions.
Fragment pages can contain fewer items or no items; follow nextCursor to completion.
Legacy generations report `partial-needs-preparation`. After deployment, the owner
can explicitly run `projectHostedPlanningPrepare:page` with projectId, owner, exact
generationId, a fresh operationId per page and cursor:null initially, then the
returned nextCursor until isDone. Replay the same page/operation after an unknown
reply. Each page prepares at most 20 items/4 MB of search-row output, plus metadata on
legacy payload headers; source and history remain
unchanged. An item can span output pages; cursors pin its version. Each operation
hydrates at most one payload-bearing item (up to 100 existing payload parts). Larger
legacy payloads report WORK_INDEX_REBUILD_REQUIRED and use the existing paged index
rebuild; they are never silently excluded from complete coverage. Reads never start a preparation or rebuild.

A search page makes one external Convex query after capability discovery (a cold
client adds one discovery query). A fresh managed CLI also reads release metadata
once before dispatch: three steady-current queries for a cold CLI search in total.
MCP pays release/discovery at startup, then one query per warm search. Startup bytes
and update work are separate and unmeasured here. Search has no per-result external
calls, writes, R2 requests or idle calls. Ordinary rows use one indexed search.
For each distinct oversized item/version encountered on a page, fragment validation
adds at most one compact root read and one indexed top-fragment read. Thus up to 100
roots and 100 bounded fragments can additionally be read, with at most 101 search
engine queries inside the same external call; each query incurs the provider's
query-GB charge. Ordinary 1k/10k fixtures incur no such additional reads. It reads at most 100 matching search rows, with a 512,000-byte read target
(the provider can include the final row beyond the target), plus current access and
generation metadata. `matchedRecordBytes` counts serialized returned DB rows, not
billed DB I/O. At 1,000 and 10,000 items the page budget is the same; total retained
search text/index storage grows with item bytes. Convex also charges search query-GB
against the entire search-index size, including retained generations and other
projects; equality filters do not reduce that charge. See [Convex costs](https://docs.convex.dev/search/text-search#costs).
For 1 KiB search documents, 50 returned rows are approximately 50 KiB plus fixed
metadata at either scale; nominal indexed text is about 1 MiB/10 MiB respectively
(actual index overhead and provider billing must be measured after deployment).
Synthetic 500-character-body fixtures read 53 documents per 50-result page: about
74.8 KB serialized DB read bytes at 1,000 items and 75.0 KB at 10,000. These include
50 matches and three access/generation/head records; they are fixture measurements,
not provider billing or production latency.
Peak result memory is O(page bytes), and wall time is indexed lookup plus one page;
live latency and billed usage are unverified until the lead deploys and measures.
Issue creation keeps its existing workspace-query + command-action calls; duplicate
lookup runs inside the workspace query. A pre-search server adds one rejected
argument probe before the ordinary workspace query and explicitly reports duplicate
coverage as unavailable; its ordinary filing remains available. Friction keeps one capture mutation. Both
read up to five candidate rows plus fragment validation when needed; planning writes add one derived row per ordinary item or bounded fragments for oversized text, and
friction retains the bounded candidate page with its original record. If adding hints
would exceed the existing physical row limit, the same mutation writes one bounded
indexed receipt separately; replay adds one receipt-row lookup in that case (and
when probing a legacy record). Normal filings retain one row/write. The receipt
follows existing project deletion; neither source inputs nor filing capability are
reduced. For 364 items,
membership/Done-when triage takes four 100-item list commands (12 backend queries plus four fresh managed CLI release reads: 16 total),
with no per-Initiative scans or per-Issue detail calls. Full bodies still require
detail reads. The reported earlier 340-item triage used four list commands, six
Initiative scans and 181 detail reads; those were command counts, not measured
Convex call totals.

Vector search is deferred: lexical recall must be measured on historical duplicate
groups first; this implementation uses no embedding provider or embedding spend.

## Measuring it

The [legacy storage audit](operations/legacy-storage-cleanup.md#read-only-audit-and-disposition-planner) pages every table and `_storage` without deploying code, reports physical bytes separately from document JSON sizes, and prepares a dry-run-only disposition plan. R2 LIST size matches do not replace full-digest purge verification.

Hosted self-metrics include **bytes by location**: every Convex file-storage write on the deployment in the window, read from the `_storage` system table newest first (`projectBytePlacement:convexWritten`, pages of 64; one call when nothing was written). It must read 0 bytes; any byte adds a warning to the headline. An older deployment without the query reports the metric as unknown, never 0.

`nforge maintenance r2-backfill ROOT --dry-run` reports, per project, the legacy rows still only in Convex storage (count, bytes, estimated move cost) and the Convex copies already moved to R2 that cleanup could delete. It reads indexed rows in pages of 100 and moves nothing. The move and the delete are separate, owner-approved steps ([R2 backfill](operations/r2-backfill.md)).


Hosted State topological levels (`stateGeneration`) are optional scalar metadata
on the State's existing `projectObjects` row, or a sparse indexed scalar in its
existing `projectObjectCatalog` page. Trusted workers derive them from verified
parents during ordinary output/import publication. They add no R2 object or
change to a State manifest/hash. Worker-published States also record their exact
parent digests (`stateParents`, at most 16 short strings) on the same row; older rows
and catalog entries have none and are read as before. The explicit dev generation pass verifies source
bytes and patches those same metadata records in bounded pages. Ancestry proof
cuts and operation-local level maps remain in the existing R2 progress cursor,
not a growing Convex State or job record.
