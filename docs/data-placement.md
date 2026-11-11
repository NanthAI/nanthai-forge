# Data placement

Bytes go to R2. Convex holds records, read and written in pages, never per file.

This page lists every byte store and every Convex table: what it holds, and whether it grows with repository size (one row or object per file or physical object), with activity (per save, landing, run or event) or stays fixed (per project, account or setting). The guard in `tests/hot-storage-invariant.test.mjs` enforces the byte rule; its allowlist is reproduced below.

## Byte stores

| Store | Holds | Grows with | Written by |
| --- | --- | --- | --- |
| R2 `v1/p/<project>/o/<sha256>` | Project objects: file contents, State manifests, Work metadata, recipe leaves, source-job outputs, cursors (`r2source:`), checkpoint roots, exchange-cache artifacts. Content-addressed, create-only, checksum-bound PUT. | Repo size | Presigned PUTs from the CLI and hosted workers; `storeSourceBytes`, import upload, `storeProjectArtifact` inside Convex actions. |
| R2 `v1/p/<project>/…` archives and packs | Backup and proposal archives, original-archive receipts, source packs, check logs. | Activity | Presigned PUTs; `archiveTarget`, `projectSourcePacks`. |
| R2 `v1/p/<project>/o/<sha256>` history chunks | Imported Git history: the Git host's pack bytes unchanged (same commit ids), split into content-addressed chunks of at most 32 MiB; pinned by `projectHistoryPacks`. Chunks a fetch created but never recorded (over the limit, failed or stale) are deleted at once, with one scheduled retry if a delete fails. | History size, up to the project's history limit (default 1 GiB) | `projectHistoryImport` (import run, read catch-up, first [Git serving](git-serving.md) request of a mirrored project). |
| R2 `v1/p/<project>/o/<sha256>` history tree indexes | [Git serving](git-serving.md) Lane refs: one object per imported or catch-up history pack holding only its trees (whole or as deltas; 1.65 MB for this repository's 25 MB pack), pinned by `projectHistoryPacks.trees`. Removed with the project's history. | Trees of stored history | `gitServeTrees.indexPacks` (scheduled once when a pack is recorded). |
| R2 `v1/p/<project>/o/<sha256>` Lane Git packs and alias object | [Git serving](git-serving.md) Lane refs: one pack per fetched Lane head (its built commit plus the trees and blobs the parent commit lacks) and its side-band framed copy for protocol v2 on the Worker path, pinned by `projectGitLaneCommits`, and one JSON map of source SHA-256 to Git blob ids for the last built head and base, pinned by `projectHistory.laneAliases`. A replaced pack or alias object, and packs of closed Lanes, are deleted when the next build records. | Changed bytes of fetched Lanes; aliases about two States of ids | `gitServeLane` (first Git fetch of a Lane head). |
| R2 `v1/p/<project>/o/<sha256>` Forge main packs, object sets and tree listings | [Git serving](git-serving.md) on a project without a GitHub mirror: Forge-built commits for main's landings, whole objects only (each pack holds what no earlier pack has), pinned by `projectHistoryPacks` rows with source `forge`; per pack row an object set (sorted ids of its trees and the ids they name); per Forge row its tip tree listing. Merged Forge packs and their sets and listings are deleted when the merge records. | Changed bytes of main's landings, counted in the history limit; object sets about 20 bytes per object | `gitServeMain` (first Git ref listing after landings). |
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
| `placementPatchProbe1`, `placementPatchProbe9`, `placementPatchProbe24` | Temporary synthetic S0 billed-patch calibration: three document sizes, with 1/9/24 distinct custom indexes on the key and small numeric columns. Internal writer runs only on the project dev deployment; no product caller or timer. Cleanup removes the nine synthetic rows, then the next S3 landing removes tables and writer. | Fixed nine synthetic rows during the authorized experiment |
| `legacyStorageCleanupPages` | Retry receipts for approved maintenance pages; no file bodies. | Maintenance pages |
| `legacyStorageCleanupWindows` | One metadata fence per approved dev cleanup window; closing it invalidates older deletion transactions. No source or file bytes. | Approved maintenance windows |
| `projectObjects` | One row per physical object: digest, size, placement (`r2Key`, `location`, legacy `storageId`), recipe pin. No bytes. | Repo size |
| `projectObjectReceipts` | Original upload-id, nonce, size and digest pins after immutable descriptors move into catalog pages; current project access still gates replay. Bounded migration cursor receipts use the same table. See [storage compaction](operations/storage-compaction.md). | Compacted descriptor count |
| `projectObjectCatalog` | Sorted immutable object descriptors from imports or explicit compaction, 256 per row (digest, size, recipe or packed byte range; physical packs retain protected source pins), instead of one `projectObjects` row per object; `findObject` reads it. | Repo size / 256 |
| `projectGithubImports`, `projectGithubImportInventory` | GitHub import jobs and their paged inventory (keys and positions per page). Inventory rows are deleted once the import is published. | Repo size, during an import |
| `projectSourcePacks` | Latest source pack per project (R2 key and pins). | Fixed |
| `projectHistory`, `projectHistoryPacks` | Imported Git history: one status row per project (repository, import commit and State, stored bytes, owner limit, cached trailer of one joined pack set) and one row per Git pack (tip commit, R2 chunk pins, pack checksum, object set; Forge packs also their tip State, tree, tree listing and last landing), never one per commit. | Imports, history reads and Git ref listings after main's mirror moved |
| `projectGitMainCommits` | [Git serving](git-serving.md) on a project without a GitHub mirror: one small row per Forge-built main commit (State, commit id, tree id, landing sequence), written with its Forge pack, so a Lane based on any landed State builds on that commit with one indexed read. No bytes. | Landings on unmirrored projects that Git requests reached |
| `gitWorkerUsage` | Large-pack Worker use per UTC day: packs and bytes per project and for all projects ('*'), checked before a redirect and counted before bytes flow; rows older than 7 days are deleted when their scope is next written. | Git fetches served through the [large-pack Worker](git-serving.md#large-packs) |
| `projectSourceSteps`, `projectSourceTasks`, `projectSourceBatches`, `projectSourcePools` | Source-job steps, fan-out tasks and worker pools; cursors are `r2source:` pins. | Activity |
| `projectHostedStates`, `projectHostedSaves`, `projectHostedSavePages`, `projectHostedSyncs`, `projectHostedSeeds`, `projectHostedSeedPages` | Saved States and their paged inputs/outputs. | Activity (pages, not files) |
| `projectHostedComposes`, `projectHostedComposePages`, `projectHostedComposeSelections`, `projectHostedAcceptances`, `projectHostedAcceptanceEvents`, `projectHostedAcceptancePages`, `projectHostedAcceptancePlans`, `projectHostedAcceptanceSnapshots` | Candidates, acceptance and their pages. | Activity |
| `projectFinishReadRows`, `projectHostedLandingRequests`, `projectHostedLandingAttempts`, `projectHostedLandingBatches`, `projectHostedLandingQueues`, `projectHostedLandingQueueStatus`, `projectHostedLandingDesired`, `projectHostedLandingAliases`, `projectHostedLandingCheckWakes`, `projectHostedLandingObservations`, `projectHostedFinishes`, `projectHostedStallAlerts`, `projectLandingSpeed`, `projectHostedApprovals` | Landing queue and finish records; `projectHostedApprovals` holds one approval request per Lane; `projectLandingSpeed` holds one project's last 7 days of landing timings for the regression alert. | Activity |
| `projectHostedCheckRuns`, `projectHostedCheckShards`, `projectHostedCheckCallbacks`, `projectHostedCheckWorkers`, `projectHostedCheckSettings`, `projectHostedCheckSettingVersions`, `projectHostedTestTimings`, `projectHostedActionsExports`, `projectHostedActionsResults`, `projectCheckRequests`, `projectCheckRunners` | Check runs, shards, results and settings. | Activity |
| `projectHostedOutputStreams`, `projectHostedOutputChunks`, `projectHostedOutputHeads`, `projectHostedOutputSummaries`, `projectCheckLogCleanups`, `projectCheckLogCleanupPages`, `projectCheckLogRetentions`, `projectCheckLogSourcePins` | Check output in bounded text chunks and its cleanup. | Activity |
| `projectHostedChannels`, `projectHostedOperations`, `projectHostedLifecycleEvents`, `projectHostedLifecycleGuards`, `projectHostedLifecyclePlans`, `projectHostedLifecyclePointers`, `projectHostedMainAudits`, `projectHostedMainAuditEvents`, `projectHostedTrust` | Channels, operation receipts, Lane lifecycle and main audits. | Activity |
| `projectReleaseSignatures` | Owner Ed25519 signatures over released States with their release number (64 bytes each, at most 4 per State); verified by the CLI updater. | Releases |
| `projectHostedRecords`, `projectHostedRecordHeads`, `projectHostedRecordBodies`, `projectHostedDisplayRecords`, `projectHostedSnapshots`, `projectHostedSnapshotHeads`, `projectHostedSnapshotPages`, `projectHostedDecisions`, `projectHostedDecisionMaintainers`, `projectHostedFriction` | Work records (Intents, Lanes, decisions), snapshots and display copies. | Activity |
| `projectHostedFrictionHints` | Bounded duplicate-candidate replay receipts when inline hints would exceed a friction row. Written atomically with capture and removed on project deletion. | Overflow captures |
| `projectHostedOverlapLanes`, `projectHostedOverlapMain`, `projectHostedOverlapMainLog` | Saved-path projections behind peers, behind-main and the trial merge; the log keeps the newest 64 landings' paths. | Activity |
| `projectHostedStackDependents` | One row per open Lane stacked on a parent Lane (parent Lane, pinned parent head, the parent's newest saved head and a conflicted automatic restack head, marks of the parent events already announced); written only by stacked Lane records, deleted when the Lane closes or unstacks and with the project. | Activity |
| `projectHostedConflictNotices` | Exact conflicts at save (flip 4): one row per Lane and other side (a Lane or main) with file paths, line ranges and the other Lane's goal (at most 160 characters); closed rows stay as the lead-time record. No file bytes. | Activity |
| `projectHostedPresence` | One slim row per open Lane (Issue, goal, up to 10 saved paths, handle-mapped actor, last activity) for presence; deleted when the Lane closes. | Activity |
| `projectLaneSnapshots` | Unsaved-work snapshots of a Lane checkout (policy `autoSnapshot`, Issue 7ac4e32f): one slim row per snapshot or undo/redo/restore move (head, tree digest, page and pack pins, counts; no file bytes) plus one Lane row with its expiry job. Bytes live in R2 under `v1/p/<project>/s/<lane>/`, one pack object per snapshot (its pages and new files); at most 64 MiB per snapshot and 512 MiB per Lane; the whole Lane expires 14 days after its latest snapshot and `x snapshots {"purge":true}` deletes it for real. | Activity, bounded by retention |
| `projectBoardClaims` | Automatic file claims: one row per Lane and unsaved path written ("touching PATH"), at most 30 live per Lane, 14 days; hidden once the Lane saves the path or closes. | Activity, bounded by retention |
| `projectBoardMessages`, `projectBoardInboxes`, `projectBoardSenders`, `projectBoardProjects`, `boardAccounts`, `boardSwitches`, `boardAudit`, `boardEvidence` | Agent board notes (at most 240 characters, 14 days, 5,000 per project), per-target inbox and rate-window counters, account day totals, operator switches and audit, and body-free evidence rows. | Activity, bounded by retention |
| `projectReadBudgets`, `projectStorageUsage`, `accountStorageUsage` | Abuse-limit counters (`convex/abuseLimits.ts`): signed-out read calls per public project in the current window, and reserved stored objects and bytes per project (sharded) and per owning account (added in roll-ups); fixed rows per scope, reset or updated in place. | Activity, bounded by shard count |
| `projectWorkGenerations`, `projectWorkHeads`, `projectWorkEvents`, `projectWorkDetailMigrations`, `projectReturnPages`, `projectReturnSupersessions` | Work projection generations, heads/events, migration and return pages; canonical history remains separately retained. | Activity |
| `projectWorkRecords` | General Work projections, including activity/status readers; eight custom B-tree indexes. | Activity |
| `projectPlanningRecords` | Planning roots, versions, comments and search fragments; thirteen custom B-tree indexes plus search, confined to planning rows. | Planning activity |
| `projectWorkDataRecords` | Source projections, `viewFiles`, non-planning `:payload` parts and `_workStore*` comparison rows; six custom B-tree indexes. | Source/Work projection size |
| `projectCoordinationClaims`, `projectCoordinationEvents`, `projectCoordinationReceipts`, `projectCoordinationSessions` | Live coordination (advisory). | Activity |
| `projectBackups`, `projectProposals`, `projectUploadCleanup`, `projectRecoveryConnections` | Backup and proposal archive rows (R2 key, legacy `storageId`) and upload cleanup. | Activity |
| `projectPublications`, `projectPublicationAttempts`, `projectPublicationPages`, `projectGithubBindings`, `projectGithubMirrors`, `projectGithubMirrorJobs` | Publication and GitHub mirror state. | Activity |
| `projectSelfMetricReceipts`, `projectSelfMetricBills` | Self-metric receipts and recorded bills. | Activity |
| `hostedProjects`, `projectSlugs`, `projectContributors`, `projectInvites`, `projectReaders`, `projectReaderOperations`, `projectAccessOperations`, `projectActorNames` (former-member provenance only; no names), `projectPolicyChanges`, `projectInterests`, `projectBriefingSources`, `projectSourceAuthorityTransitions`, `projectSourceCutovers` | Project identity, access, policy and authority. | Fixed |
| `imports`, `importArtifacts`, `importReaders`, `importRemovalOperations`, `teamImports`, `sourceZones`, `zoneChanges`, `zoneReaders`, `derivedArtifacts`, `artifactBlobs` | Indexed public imports, Zones, derivatives and `r2blob:` metadata. | Repo size, per import |
| `forgeAccounts`, `accountHandles`, `accountItems`, `accountOperations`, `handleOperations`, `cliCredentials`, `deviceCodes`, `deviceAttempts`, `agentGrants`, `agentEvents`, `agentUserSettings`, `agentGuidanceOperations`, `agentGuidanceMaintainerOperations`, `teams`, `teamMembers`, `savedViews`, `interestChanges`, `clientErrors` | Accounts, credentials, agent grants, teams and settings. | Fixed |
| `githubBindingInstallations`, `githubBindingOperations`, `githubBindingRemovals`, `githubBindingWebhookReceipts`, `githubDeliveries` | GitHub App installations and webhook receipts. | Activity |
| `githubRunnerGrants` | One row per Forge owner and runner repository proven by configure-runner. | Fixed |
| `githubRepositoryVisibility` | Last GitHub visibility read per runner repository (private projects only), overwritten in place and reused for 5 minutes. | Fixed, one row per runner repository |
| `secretObjects`, `secretVersions`, `secretGrants`, `secretEvents`, `secretDeletions` | Encrypted Secret Objects and grants. | Fixed |

## Planning search

Before filing an Issue or friction, search for an existing planning item and
comment on it instead of creating a duplicate. One `planning {"search":"relevant words","limit":10}`
is enough; `status:"all"` also finds closed work. Page `nextCursor` only to browse, never
for a duplicate check: each search is billed at the whole index size. Search is read-only,
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
the planning partition of the Work index, atomically maintained by planning writes and rebuilds.
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
`search_planning` sits on `projectPlanningRecords`. Its seven
ordinary planning indexes and full-text index cover planning rows and search fragments.
The core table has no planning/search indexes. Reads select their physical domain directly,
without a layout query, mirror or legacy fallback. The historical dogfood reading was 7.47 MB billed per
search before isolation; post-migration query-GB must be measured independently.
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

## Work projection index domains

Derived rows are split without changing logical collection names, record keys,
positions or values. `projectPlanningRecords` holds `planning*` roots/versions/comments and
`planningSearch:payload` search fragments. Other `:payload` chunks, `source*`, `viewFiles`
and `_workStore*` comparison rows live in `projectWorkDataRecords`. Other collections stay
in `projectWorkRecords`. All remain disposable projections of retained canonical Work/source.
No collection is dropped: generic record pages, selected lookups and source-return snapshots
are readers even when no specialised screen names that collection.

The index reader map (repository-relative paths):

| Index | Collections / reader |
| --- | --- |
| `by_generation_and_collection_and_activityAt` | `lanes`, `runs`; `convex/coordinationCounts.ts:95` |
| `by_generation_and_actor` | Any collection with imported `actor` metadata; `convex/projectActorNames.ts:67`; retained on all three tables |
| `by_generation_and_collection_and_key` | Every collection; `convex/projectWorkRecordTables.ts:40` selected lookup; planning id resolution in `convex/projectHostedPlanning.ts` |
| `by_generation_and_collection_and_position` | Every collection, including source/payload/comparison pages; `convex/projectWorkIndex.ts:170`, `convex/projectWorkIndexBuildStore.ts:50`, `convex/projectWorkStoreDigests.ts:161` |
| `by_generation_and_collection_and_parent_and_position` | Payload chunks, `viewFiles`, `laneViews`, `viewAcceptances`, `runs`, `notes`, planning history and other parent-selected collections; `convex/hostedRecordValue.ts:27`, `convex/projectWorkIndex.ts:175` |
| `by_generation_and_collection_and_status_and_position` | `intents`, `landingEntries`, `landingBatches`; `convex/projectWork.ts:395`, `convex/projectWorkIndexBuildStore.ts:202`, `convex/projectSourceAuthorityDrain.ts:24` |
| `by_project` | Every collection; dynamic permanent purge, `convex/projectPurgeRows.ts:26` and `convex/projectPurgeInventory.ts` |
| `by_generation` | Every collection; generation retirement in `convex/projectWorkIndexStore.ts:344` and explicit `convex/projectWorkRecordMigration.ts:103` |
| Seven `by_planning_*` indexes | `planningSearch` roots only; all filter combinations in `convex/projectPlanningList.ts:31`–75 |
| `search_planning` | `planningSearch` roots/fragments only; `convex/projectHostedPlanningSearch.ts:90` |

All three domains retain the common key/position/parent/project/generation indexes and
actor visibility. Activity/status indexes belong only to the general Work domain.
The data domain therefore has six custom B-tree indexes; the planning domain has thirteen
plus search. Counting a document, two built-ins and one full-copy-equivalent search sensitivity
gives 9 copies/data write, 17/planning write and 11/general Work write, against 19
before splitting. The seven planning-filter indexes and full-text index no longer cover
general Work rows.
These are an index-count/storage sensitivity, not a claim that Convex copies an entire
payload into every index.

The frozen 154,496-row dogfood shape and bounded oldest/tail samples model 0.309 GB logical:
136,243 data rows / 0.287 GB, 46 planning rows / 0.000078 GB, and 18,207 other rows / 0.022 GB.
The full-copy sensitivity is 5.88 GB before and 2.83 GB after all legacy indexes are removed,
a modelled 3.05 GB reduction. Frozen counts omit later writes; the deployment-wide mixed
sample model was 8.41 GB versus the owner's 10.84 GB dashboard. Neither model is measured
reclaimed disk. `tests/work-index-cost.test.mjs` ratchets table index counts and a landing-shaped
projection byte model; the landing storage guard separately tracks retained document bytes.

The completed dev copy plus bounded aggregate audit reconstructs about 0.418 GB of retained
logical documents: 39.5 MB general Work, 16.4 MB planning and 361.9 MB data. At the same
copy-count sensitivity this is about 7.94 GB before and 3.97 GB after. These current native-byte
measurements include writes absent from the frozen generation counts above. They remain a
storage model; the dashboard figure measures provider storage. A further split of the small
core activity/status groups saves at most about 0.08 GB; isolating planning history from its
search roots saves about 0.11 GB. Neither warrants another live rewrite in this bounded slice.

`projectWorkRecordMigration:run` explicitly drives at most 100 transactional pages per call;
resume its phase/cursor and original operation id. Each copy page reads at most 100 rows with
a 512 KB target (plus the provider's final-row overshoot) and upserts exact derived bytes.
The temporary dual-read/write rollout path is removed once every retained dev partition
selects the split tables. Ordinary inserts
route to one table, and reads use that domain with no layout lookup or extra RPC.
At the one-time cutover, a fresh public generation preserves the record partition and Work
revision. Outstanding list/search cursors receive `WORK_STALE` instructing callers to restart
the list/search; fresh cursors retain their existing shape and pagination behaviour.
Copy receipts in existing `projectReturnPages` retain old row ids and sizes, so cleanup deletes
those exact duplicates without an application-level second payload scan. The provider still
bills the deleted document bytes as reads. Every page has a durable operation
receipt, including replay after subsequent pages. The original canonical source, Work history,
planning versions, landing receipts and audit remain untouched. Retirement and project purge
cover all three tables. There is no scheduler, idle call or recurring migration scan.

The deployment-wide mixed-sample envelope predicts roughly 1.4 GB for old-row reads,
new-row writes, duplicate deletions and compact receipts, below the approved 1.5 GB migration
budget, including measured fixed page overhead. The completed dev migration billed
0.840 GB read and 0.530 GB write (1.369 GB total); the aggregate domain verification added
0.056 GB reads, for 1.425 GB together. It found no moved collection left in the core table.
Ordinary write I/O per landing and the post-cleanup dashboard are measured separately.

## Where the bytes and I/O go (2026-11-10)

The owner's placement yardstick is that Convex serves three jobs: CI and landing
orchestration, the realtime agent message board, and the web app (with a future
iOS app). Immutable, content-addressed, large, or historical data read only on
demand belongs in R2 behind a pointer. This is the rule for future placement;
the candidates below remain review work, not approved migrations or deletions.
Convex queries/mutations cannot fetch R2 bodies themselves; moving a body must
preserve transactional readers or use an action without adding per-item calls.

### Dashboard storage and the sample model

Convex database storage includes documents **and indexes**. For design sensitivity,
count each index as approximately one extra copy of its rows. This is a model of
amplification, not a vendor formula asserting that every index stores the whole
payload. The inventory model counts one document, two built-ins, custom B-tree
indexes and one extra copy-equivalent for a search index. Search bytes may behave
differently. Provider document/index breakdown remains unmeasured.

All dashboard numbers below are **measured, owner dashboard, 10 November, before
cleanup**: 21.47 GB total, versus about 8.7 GB on the previous day. The roughly
2.4-fold rise across many tables coincided with a plan change; a measurement
change is a hypothesis, not established growth attribution. The dashboard exposes
five named tables and a 6.12 GB remainder, not individual sizes for that remainder.
Those reported components sum to 21.52 GB, 0.05 GB above the reported total;
the source does not reconcile that discrepancy, so it is not allocated to a table.
The other columns are **modelled** from bounded chronological JSON samples and
full table counts, not full-table byte sums or random samples. GB is decimal.

| Table | Dashboard GB (measured) | Rows counted | Sample mean / p95 JSON B | Logical / indexed GB (modelled) | Contents and preservation |
| --- | ---: | ---: | ---: | ---: | --- |
| `projectWorkRecords` (before split) | 10.84 | 200,262 | 2,210 / 4,186 | 0.443 / 8.409 | Work/source/planning projections: rebuildable; canonical source, planning history and audit kept forever. |
| `projectHostedCheckRuns` | 2.01 | 2,200 | 27,081 / 86,119 | 0.060 / 0.655 | Verdict, proof and source/configuration pins kept; execution detail is operational exhaust under the approved window. |
| `projectHostedCheckCallbacks` | 0.89 | 24,186 | 2,471 / 1,703 | 0.060 / 0.299 | Callback inbox payload is exhaust; digest retry receipts and reuse aliases remain. |
| `projectObjects` | 0.84 | 119,617 | 526 / 613 | 0.063 / 0.629 | R2 descriptors, not source bytes. Reachable Git/State bindings remain; immutable descriptor copies can use catalog pages. |
| `projectSourceTasks` | 0.82 | 30,402 | 5,696 / 12,934 | 0.173 / 0.866 | Fan-out inputs/progress/results: operational after whole-job completion; retained job outcome/source live elsewhere. |
| All other tables | 6.12 | — | — | Not individually dashboard-reconciled | Includes the candidate classes below; not an unexplained second byte store. |
| **Total** | **21.47** | — | — | No exact physical total model | Dashboard after cleanup remains a lead measurement. |

The Work sample contains 645 rows. Its current deployment-wide count differs
from the frozen dogfood generation's 154,496 rows, of which 103,355 are `viewFiles`.
Their sampled sizes are 1.94–2.97 KB, with contributors the largest nested field;
legacy payload pages reach roughly 10–36 KB. Dividing indexed dashboard storage
by a frozen generation count does not establish 70 KB logical Work rows. Work,
check-run and callback models do not fully explain their dashboard figures.

### Split indexes and catalog placement

The [Work projection index domains](#work-projection-index-domains) give the
reader map and completed migration. **Modelled copy-equivalents per write** fell
from 19 to core 11 / planning 17 / data 9; these are not measured billed write
bytes. The frozen dogfood model is 5.88 → 2.83 GB. Reconstruction from measured
native document bytes is 7.94 → 3.97 GB under the same copy assumption; physical
reclamation still needs the dashboard. Routing now reads one physical domain,
without layout lookups, fallback mirrors, extra RPCs or idle scans.

Immutable descriptors now share existing 256-entry `projectObjectCatalog` pages.
Mutable State parents/generation/protection, pending uploads and small new outputs
stay rows; random insertion into dense pages would increase read/write I/O.
`projectObjectReceipts` keeps original upload-id, nonce and size retry/cleanup
pins with three indexes instead of the descriptor table's seven. **Measured dev
migration:** 38,003 descriptors across nine projects, every digest/size verified;
18,427,473 serialized bytes removed versus 11,604,506 receipt bytes plus
3,367,626 catalog bytes (including pre-existing pages). The conservative net
logical reduction is at least 3,455,341 B, not a dashboard saving. See
[compaction](operations/storage-compaction.md) and
[maintenance costs](operations/cost-to-serve.md#maintenance-cost-and-unmeasured-work).

### Open placement candidates

This inventory of the remaining large classes is **modelled**, from the same
pre-cleanup samples. Indexed sizes assume approximate full copies; potential
savings are ceilings/ranges before pointer/R2 costs and overlap with expiry.
They must not be summed as a measured saving. Keeping history forever permits
moving exact bytes behind verified pointers, not deleting them.
The [placement review](research/placement-review.md) gives a verdict for every table and R2
use and proposes the slices; none is approved yet.

| Table | Rows / sample mean B | Logical / indexed GB model | What remains to assess |
| --- | ---: | ---: | --- |
| `projectHostedRecordBodies` | 109,335 / 1,279 | 0.140 / 0.839 | Immutable journal/Work bodies, including planning/audit, must stay forever; exact R2 body plus compact hot pointer is a candidate (~0.70 GB ceiling). |
| `projectHostedActionsResults` | 20,490 / 2,151 | 0.044 / 0.176 | Report detail is operational; lossless row compaction landed. Further R2 detail placement (~0.15 GB original ceiling) is undecided. |
| `projectHostedLandingObservations` | 44,941 / 2,293 | 0.103 / 0.412 | Versioned observation copies include committed recovery/audit history; assess deltas/references (~0.35 GB ceiling), not blanket expiry. |
| `projectHostedRecords` | 109,335 / 487 | 0.053 / 0.426 | Immutable versions/audit stay; deduplicate inline body copies only with equal read-call cost (~0.06 GB ceiling). |
| `projectHostedOperations` | 18,368 / 1,860 | 0.034 / 0.171 | Retry outcomes/receipts stay; bulk transport body pointers are an option (~0.14 GB ceiling), with no proven extra-R2-read win. |
| `projectHostedSaves` | 3,054 / 3,066 | 0.009 / 0.047 | Save/State receipts stay; completed protocol copies are a candidate (0.03–0.16 GB range), not an agreed cut. |
| `projectHostedOverlapLanes` | 1,338 / 9,371 | 0.013 / 0.075 | Current saved-path projection is rebuildable; intern/compress paths (0.03–0.12 GB range), preserving current pins. |
| `projectHostedLandingAttempts` | 4,081 / 4,176 | 0.017 / 0.102 | Causal attempt evidence stays; intern repeated Candidate/policy snapshots (~0.07 GB ceiling). |
| `projectHostedRecordHeads` | 20,071 / 750 | 0.015 / 0.136 | Rebuildable but transaction-critical CAS/current heads; keep pending read-cost parity, zero committed saving. |
| `projectFinishReadRows` | 10,180 / 1,227 | 0.012 / 0.150 | Transactional metric/public projections are rebuildable; narrow nested copies without changing readers (~0.08 GB ceiling). |
| `projectHostedLandingRequests` | 1,479 / 7,713 | 0.011 / 0.308 | Admission/selection/receipt/audit preserved; assess compact hot envelope plus immutable R2 body (~0.20 GB ceiling). |

Other review options are a State-bound R2 descriptor manifest (trusted incremental
baseline plus changed pins, never a fresh full descriptor scan per State), Work
payload/actor interning, and a different overall stack. None is built or selected
by this inventory. All audited indexes have readers, including generic pages and
snapshots; no unread collection was established. Further core/planning-history
splits model only about 0.08 / 0.11 GB and were not pursued in this slice.

Evidence: storage Issue [8c4f126b](https://nanthai-forge-dev.netlify.app/?project=mh7aafndrxmj8c2q0931zbjk2n8h4ffs&projectTab=planning&planningItem=8c4f126b-0c04-492e-a66a-aabc6acd4981) (inventory comment `b69f2f14`, catalog
completion `a67d6495`, catch-up `257c5a66`, final split evidence), and cost Issue
[298f9675](https://nanthai-forge-dev.netlify.app/?project=mh7aafndrxmj8c2q0931zbjk2n8h4ffs&projectTab=planning&planningItem=298f9675-b8ad-49d6-96c3-07d94e5f9ebd). The [placement review](phase6-plan.md#p6-close-order-owner-2026-11-10)
decides the next implementation slices.

## Advisory retention

Client errors expire strictly after 30 days from creation, in pages of at most
eight rows in existing scheduled check-expiry transactions. There is no new cron,
idle call or diagnostics-only continuation; a backlog drains on later maintenance.
The receipt includes deleted row and logical byte totals and reconciles retries.
At two check-expiry phases per landing, the added budget per 1,000 landings is
zero function calls, at most 2,000 indexed page reads and 16,000 deletes; at the
observed one error/week it is approximately one delete/week. Billed I/O and wall
time remain unmeasured; memory is bounded to eight documents (8 MiB schema ceiling).
No R2 bytes are involved in diagnostic deletion.

Owner-selected coordination detail retention is 14 days hot then R2 archival by
S2 (27d4c1fd), with nothing deleted. Messages, handoffs, acknowledgements and agent
lifecycle audit stay indefinitely; agent access diagnostics have no window until
volume warrants one. See [decisions](decisions.md#advisory-windows).
