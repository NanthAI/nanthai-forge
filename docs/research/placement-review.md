# Placement review: Convex, R2 and a third stack

Independent architecture review for Issue [4c8dfe6a](https://nanthai-forge-dev.netlify.app/?project=mh7aafndrxmj8c2q0931zbjk2n8h4ffs&projectTab=planning&planningItem=4c8dfe6a-3511-4d01-a36b-1158c4e42c69), 11 November 2026. The owner's yardstick: Convex should (1) orchestrate CI and landing, (2) be the realtime message board for agents and (3) power the web app and a future iOS app. Is it doing more, and should it?

This page proposes; it decides nothing, except where a section says a contract is decided ([S3 report transport](#s3-report-transport), the [S8a result](#s8-byte-plane-beside-r2-owner-decision-adds-5-a-month), the [S4 remaining-writers verdict](#s4-remaining-writers)). No slice below was filed, approved or built when the review was written. It changes no retention rule, plan, service or product limit.

## Verdict

**Convex does seven jobs, not three.** The four extra jobs are where the cost and the growth are:

| Job Convex does today | Wanted? | Verdict |
| --- | --- | --- |
| 1. Orchestrate CI and landing: queue, heads, receipts, check status | Yes | Stay. Convex is the right serializer; the rows are too fat and too indexed. |
| 2. Realtime board, presence, overlap and conflict notices | Yes | Stay. It is cheap and it is what Convex is best at. |
| 3. Read model for the web app and a future iOS app | Yes | Stay, without the per-file rows. |
| 4. Archive of all history: every record version, observation, attempt and receipt body ever written | No | Move to R2 as packed, verified objects; Convex keeps a pointer and a summary. |
| 5. File-level metadata: one descriptor per stored object, read O(files) by CI, clones and the source worker | No | Move to one R2 object bound to each State. |
| 6. Derived per-file projections (`viewFiles`, source rows, payload pages) | No | Derive on demand or store one R2 object per Candidate. |
| 7. Byte compute: building and merging States inside 512 MiB actions that mostly wait on R2 | No; costly at scale | Keep in Convex now; run it beside R2 when a spike proves it. |

**Recommendation: Option A now, Option B stopped by the [S8a memory result](workers-source-step-spike.md), Option C not now.**

- **A, Convex plus R2 tidied.** One rule: *Convex grows with open work, never with repository size or history length.* Modelled about $4.5 per 1,000 landings for Convex and R2 requests together (227% of the $2 target) against about $7.6 today, and retained Convex storage per landing falls about 13 times.
- **B, A plus a byte plane beside R2.** The source worker runs in a Cloudflare Worker with an R2 binding, the same pattern as the existing Git large-pack Worker. Modelled about $2.8 per 1,000 (140%). It adds $5 a month and saves almost nothing below roughly 35,000 to 50,000 landings a month, because the Professional plan already includes that much action compute. Its near-term value is speed, which a spike must measure.
- **C, consolidate on Cloudflare.** Modelled about $0.9 per 1,000 (46%). It is a rewrite of the product's core (182 tables, about 910 functions), loses the Convex realtime SDK, and saves under $500 a month at 100 times today's volume. Not now; triggers are named below.

No option reaches $2 per 1,000 on a 29,000-file repository by placement alone. After A and B the remainder is calls and row I/O in the control plane, which the measurements in slice S0 must rank before anyone optimizes them.

## How to read the numbers

Every number carries one of three labels.

- **Measured**: taken from a meter, dashboard, provider log or fixture named in the repo docs. A fixture measures serialized JSON bytes or call counts, not a bill.
- **Modelled**: arithmetic on measured inputs plus a stated assumption.
- **Unknown**: not measured. It is never treated as zero.

Prices are published list prices, read on 11 November 2026 ([sources](#pricing-sources)). Convex figures assume the **Professional** plan: $25 per developer per month, which includes 25 million calls, 250 GB-hours of action compute, 50 GB database storage, 50 GB database I/O and 50 GB egress each month; beyond that $2 per million calls, $0.30 per GB-hour, $0.20 per GB of I/O, $0.12 per GB of egress and $0.20 per GB-month of storage. Query and mutation compute is not billed. Two vendor statements matter throughout: database storage "includes database rows and indexes" and "each index is priced as another copy of the table"; database I/O is "document and index data transferred between Convex functions and the underlying database".

"$ per 1,000 landings" is always at overage list rates with no included amounts, so it is the marginal price at scale. Monthly bills apply the Professional inclusions once, with one developer seat. GB is decimal.

The post-fix re-smoke had not posted when this review was written. Everything described as "today, after the landed fixes" is modelled from the pre-fix smoke and the fixture evidence in [cost to serve](../operations/cost-to-serve.md#landed-fixes-and-fixture-evidence).

## What the evidence says

### 1. History in Convex is paid for every month, once per index

One exhaust-free landing leaves this behind in Convex (measured, fixture, serialized JSON after both expiry windows, `tests/fixtures/landing-storage-budget.json`):

| Landing shape | Retained JSON | With one copy per index and two built-in indexes (modelled) |
| --- | ---: | ---: |
| Fresh project, two shards | 50,417 B | 0.39 MB |
| Dogfood-shaped: 4,096 files, 128 changed, one main race, two large checks | 360,486 B | 1.98 MB |

At $0.20 per GB-month, 2 MB is $0.40 per 1,000 landings **per month, for as long as history is kept**, and constraint 9 keeps it forever. After a year, 1,000 landings have cost $4.85 in storage alone, more than twice the whole target (modelled). The dev deployment showed the same shape from the other side: the dashboard read 21.47 GB (measured, before cleanup) while a full export read about 1.31 GB (measured mean of three). If an export's I/O is the document bytes, which is an inference, dashboard storage was about 16 times the documents.

Two more costs follow the same rows. The weekly export reads every document, so its I/O grows with history: 1.31 GB per run is $0.26 at list today (measured bytes, modelled price), about $0.38 per 1,000 landings at 3,000 landings a month, and it rises every month that history accumulates. Expiry only helps rows nobody needs; these rows are history, so they cannot expire.

R2 charges $0.015 per GB-month, has no index copies and never needs re-exporting. The same document bytes cost roughly 70 to 200 times less there (modelled: 5.5 copies per document at the low end, the dashboard's ratio at the high end).

### 2. Work that scales with file count runs through Convex

A State is a flat manifest of every file (constraint 7). Three hot paths are therefore O(files) whatever the size of the change:

- **State bodies.** The source worker builds each State in an action and PUTs it to R2. That is Convex egress: 146 MB over ten landings in the pre-fix smoke on a 28,900-file repository (measured). The bounded recipe fix cuts a 29k-file State upload from 3.31 MB to 0.74 MB (measured, fixture).
- **Object descriptors.** CI asks Convex for one descriptor per file: 10.2 MB of database reads per cold 29k-file job from rows, 2.1 MB from catalog pages (measured, fixture). A warm job with a source pack reads about 50 to 90 KB (measured, dev, 4,090 files). The source worker's own lookups added 414 calls and 14.5 MB in the smoke (measured).
- **Memory.** A 29k-file compose peaks at 311 MiB and a 190k-file State does not fit an action at all (measured, [decisions](../decisions.md#chunked-flat-states-issue-2f4e04ad)).

Descriptor reads from a database at $0.20 per GB are about 1,000 times the price of one R2 GET of the same bytes. This is the second rule that follows: anything O(files) is an R2 object, not rows.

### 3. Actions pay for 512 MiB while they wait for R2

The smoke's 70 source steps used 0.062 GB-hours (measured): 3.2 GB-seconds per step, which is about 6 seconds at the Node runtime's 512 MiB. The same step's handler takes 0.35 to 0.66 seconds in fixtures (measured). The gap has not been profiled. Its known part is network wait: one Convex to R2 round trip is about 230 ms live ([decisions](../decisions.md#trees-in-packs-issue-676efbc2)) and a step makes several in sequence; cold starts and nested calls are the other candidates. Action compute was $1.86 per 1,000 landings in the smoke and no landed fix removes it (modelled from measured usage). It is included in the Professional plan up to about 40,000 landings a month at this rate, then it is the largest single line.

### 4. Hot rows are fat and heavily indexed

`projectHostedLandingRequests` carries 24 indexes on rows that average 7.7 KB on dev; `projectHostedCheckRuns` carries 9 on rows that average 27 KB, 86 KB at p95 (measured sample). Every phase change rewrites the document. One dev window measured 240 KB of database I/O per source commit and 121 KB per finish step (measured, [8c4f126b](https://nanthai-forge-dev.netlify.app/?project=mh7aafndrxmj8c2q0931zbjk2n8h4ffs&projectTab=planning&planningItem=8c4f126b-0c04-492e-a66a-aabc6acd4981), 51 and 68 calls). How many bytes Convex bills for a patch of an indexed document is **unknown**; slice S0 measures it, because it decides how much a header split is worth.

`projectHostedLandingObservations` stores a full copy of the public landing snapshot at every transition: about 30 rows per landing request on dev (44,941 rows for 1,479 requests, measured counts), 15 to 31 KB per landing (measured, fixture). The reader already falls back to the current state when a version row is missing (`convex/projectHostedFinishObserve.ts`), so the copies are a convenience, not a dependency.

### 5. R2 operations are outside the meter

The dev bucket served about 1,060 requests per landing in one window that included scratch traffic (measured total). Split by the ledger's ratio that is $1.38 per 1,000 at list (modelled; $0.38 if every request were a read, $4.77 if every one were a write). The split by class and caller is **unknown**. The Convex meter cannot see it, and the known writers are not small: one twelve-shard CI batch makes 38 Class A requests (measured, fixture).

### 6. The three wanted jobs are in the right place

- **Serializer.** A queue row is 281 bytes and a head pointer about 130 (measured, fixture). Convex mutations are serializable and their compute is free. The cost is in what is written around the queue, not in the queue.
- **Board and waits.** A peer wait is one subscription over at most about nine rows that reruns only when one changes (`convex/projectBoardWait.ts`). Board traffic projected to $0.04 per 1,000 landings (modelled, [cost architecture options](../operations/cost-architecture-options.md)).
- **Web.** The app is built on reactive queries (`web/src/hosted-work-index.ts`). A human session is modelled at $0.0004.

## Proposed placement rules

These extend "bytes go to R2". Each has one test a guard can enforce.

1. **Bytes are in R2.** Already enforced.
2. **Anything O(files) is one R2 object bound to a State, Candidate or run.** Descriptors, file lists, path inventories and per-file reports are never rows. Guard: rows written per landing do not depend on file count.
3. **Anything immutable and past its retry window is a packed R2 object.** Convex keeps the head, a pointer (digest, size, counts) and the numbers readers need without opening it. Guard: retained Convex bytes per landing.
4. **A hot row is a header.** Indexed fields and status only, about 1 KB; bodies sit in an unindexed row or in R2. Guard: bytes written per transition.
5. **Actions orchestrate; they do not hold source bytes when a byte plane is configured.** Guard: egress and GB-seconds per landing.
6. **Idle is zero.** No option adds a timer, poll or always-on worker.

Rule 3 moves exact bytes behind verified pointers. It deletes nothing, so it is preservation under constraint 9, not a new retention rule.

## Every Convex table

All 182 tables in `convex/` at review time, grouped where rows are alike. "Per landing" is retained JSON bytes for a fresh and a dogfood-shaped landing from the storage fixture (measured); a dash means the fixture landing writes nothing there. "Dev" figures are the 10 November inventory sample (measured counts and sample means, modelled GB). Per-table billed I/O per landing is **unknown** unless a figure is given. RT is realtime; Tx is transactional.

| Tables | Role | RT / Tx | Per landing and size | Verdict | Saving, timing, risk |
| --- | --- | --- | --- | --- | --- |
| `projectHostedLandingRequests`, `projectHostedLandingQueues`, `projectHostedLandingQueueStatus`, `projectHostedLandingDesired`, `projectHostedLandingAliases`, `projectHostedLandingCheckWakes`, `projectHostedLandingBatches`, `projectHostedStallAlerts`, `projectLandingSpeed`, `projectHostedApprovals`, `projectHostedFinishes` | Job 1: the landing queue and its serializer | RT yes; Tx yes | 4,975 / 5,258 B. Requests: 24 indexes, dev mean 7.7 KB, 0.31 GB modelled | **Stay.** Split requests into an indexed ticket and an unindexed body (S3) | Storage up to 0.2 GB modelled on dev; write I/O unknown until S0. No timing change. Risk: 24 index readers must keep their fields |
| `projectHostedLandingAttempts`, `projectHostedLandingObservations`, `projectFinishReadRows` | Per-landing history and read projections | RT while live; Tx while live | 26,123 / 47,638 B, the largest class on a fresh landing. Dev: 44,941 observations, 0.41 GB modelled | **Pointer plus R2** at terminal (S1). Observations: **derive on demand** while live, keep transitions in the capsule | About 85% of this class per landing. History views add one R2 GET. Risk: recovery export and metrics read these rows today |
| `projectHostedComposes`, `projectHostedComposePages`, `projectHostedComposeSelections`, `projectHostedAcceptances`, `projectHostedAcceptanceEvents`, `projectHostedAcceptancePages`, `projectHostedAcceptancePlans`, `projectHostedAcceptanceSnapshots` | Candidates and the acceptance receipt | RT while live; Tx yes (acceptance is the CAS on the Channel) | 6,734 / 9,732 B | `projectHostedAcceptances` and `projectHostedComposeSelections` **stay** (the receipt and its lookup). Events, pages, plans and snapshots: **pointer plus R2** (S1) | About 5 KB per landing. Risk: low; rows are immutable after acceptance |
| `projectHostedChannels`, `projectHostedOperations`, `projectHostedLifecycleEvents`, `projectHostedLifecycleGuards`, `projectHostedLifecyclePlans`, `projectHostedLifecyclePointers`, `projectHostedMainAudits`, `projectHostedMainAuditEvents`, `projectHostedTrust`, `projectReleaseSignatures` | Channel heads, retry receipts, lifecycle, main audit | RT for heads; Tx yes | 3,361 / 87,634 B, almost all in operations. Dev: 18,368 operations, mean 1.9 KB | Heads, guards, pointers, trust, signatures **stay**. Operations **stay 90 days** as today, with the transport body in the capsule (S2). Lifecycle and audit events: **pointer plus R2** after terminal | Up to 85 KB per dogfood-shaped landing. Risk: a retry inside 90 days must still reconcile from the compact receipt alone |
| `projectHostedRecords`, `projectHostedRecordHeads`, `projectHostedRecordBodies`, `projectHostedDisplayRecords`, `projectHostedSnapshots`, `projectHostedSnapshotHeads`, `projectHostedSnapshotPages` | The Work journal: immutable versions, current heads, recovery snapshots | Heads RT and Tx; old versions neither | 1,747 / 95,039 B. Dev: 109,335 versions for 20,071 heads; bodies 0.84 GB, headers 0.43 GB modelled | Heads and current versions **stay**. Superseded versions and bodies: **pointer plus R2** in journal segments (S2). Display records: **derive on demand**. Snapshot tables become the segment index and can merge into it | About 0.7 to 1.0 GB modelled on dev; 82% of versions are superseded. Old provenance and event pages add one R2 GET. Risk: medium, see S2 |
| `projectHostedDecisions`, `projectHostedDecisionMaintainers`, `projectHostedFriction`, `projectHostedFrictionHints` | Owner decisions and friction | RT yes; Tx yes | Not written by a landing | **Stay** | None; small product data |
| `projectHostedStates`, `projectHostedSaves`, `projectHostedSavePages`, `projectHostedSyncs`, `projectHostedSeeds`, `projectHostedSeedPages` | Saves, syncs and their paged inputs | RT for the Lane head; Tx yes | — / 735 B. Dev: 3,054 saves, mean 3.1 KB | States and save receipts **stay**. Input pages and completed protocol copies: **expire** into the Lane's capsule at close (S2) | 0.03 to 0.16 GB modelled. Risk: low |
| `projectSourceSteps`, `projectSourceTasks`, `projectSourceBatches`, `projectSourcePools` | Source-job cursor, fan-out and pool | RT no; Tx yes | — / 1,193 B. Tasks and batches already expire after 7 days | **Stay** with the Convex provider. Under a Worker provider (S8) tasks, batches and pools are unused: **move with the compute** | 240 KB of I/O per source commit today (measured, one dev window); S5 removes most of it |
| `projectHostedCheckRuns`, `projectHostedCheckShards`, `projectHostedCheckCallbacks`, `projectHostedCheckWorkers`, `projectHostedCheckSettings`, `projectHostedCheckSettingVersions`, `projectHostedTestTimings`, `projectHostedActionsExports`, `projectHostedActionsResults`, `projectCheckRequests`, `projectCheckRunners` | Job 1: check runs, results, settings | Status RT; Tx yes | 5,456 immediate and 4,520 retained / 577,020 immediate and 9,096 retained B. Runs: 9 indexes, dev mean 27 KB, 2.01 GB on the dashboard | Run header, callback receipts, settings, timings, runners **stay**. Report detail and result pages: **pointer plus R2 at write time** (S3): the runner already uploads results to R2, so stop copying them into rows | Removes about 570 KB written and later expired per dogfood-shaped landing (two large checks). Detail views add one server action and one R2 GET. Risk: verdict reuse and shard restore read detail inside mutations today; [S3 report transport](#s3-report-transport) settles both |
| `projectHostedOutputStreams`, `projectHostedOutputChunks`, `projectHostedOutputHeads`, `projectHostedOutputSummaries`, `projectCheckLogCleanups`, `projectCheckLogCleanupPages`, `projectCheckLogRetentions`, `projectCheckLogSourcePins` | Live check output and log cleanup | Chunks RT while a run is live; Tx no | 326 / 990 B (source pins only) | Logs are in R2. Chunk rows **expire** when the run ends; the rest **stay** | Small. No change for Actions runs, which write no chunks |
| `projectHostedOverlapLanes`, `projectHostedOverlapMain`, `projectHostedOverlapMainLog`, `projectHostedStackDependents`, `projectHostedConflictNotices`, `projectHostedPresence`, `projectLaneSnapshots`, `projectBoardClaims` | Job 2: who is touching what | RT yes; Tx yes for the trial merge | 525 / 97,122 B. Almost all of it is one `projectHostedOverlapMain` row per project, rewritten in place, not growth per landing | **Stay** | None proposed. Interning paths was modelled at 0.03 to 0.12 GB; not worth a slice |
| `projectBoardMessages`, `projectBoardInboxes`, `projectBoardSenders`, `projectBoardProjects`, `boardAccounts`, `boardSwitches`, `boardAudit`, `boardEvidence` | Job 2: the agent board | RT yes; Tx yes | Not written by a landing; bounded at 14 days and 5,000 notes per project | **Stay** | None. This is the cheapest job in the system |
| `projectCoordinationClaims`, `projectCoordinationEvents`, `projectCoordinationReceipts`, `projectCoordinationSessions` | Job 2: advisory live coordination | RT yes; Tx no | Not written by a landing. Retention of events is **unknown** | **Stay.** Whether events get a bounded window like the board is an owner decision | Unknown until sized |
| `projectWorkRecords`, `projectPlanningRecords`, `projectWorkGenerations`, `projectWorkHeads`, `projectWorkEvents`, `projectReturnPages`, `projectReturnSupersessions`, `projectWorkDetailMigrations` | Job 3: the Work and planning read model | RT yes; Tx yes | Fixture landing adds 0 B. Dev after the split: core 25,745 rows / 39.5 MB, planning 7,002 rows / 16.4 MB (measured) | **Stay.** `projectWorkDetailMigrations` goes when no migration is retained | None; the split already cut copies per write from 19 to 11 and 17 |
| `projectWorkDataRecords` | Per-file projections: `viewFiles`, source rows, payload pages | RT no; Tx no | Dev: about 136,000 rows in the frozen dogfood generation, 361.9 MB of documents after the split, 6 indexes: about 3.3 GB at one copy per index (measured bytes, modelled copies) | **Derive on demand or one R2 object per Candidate** (S4) for file lists; the table itself stays ([S4 remaining writers](#s4-remaining-writers)) | The largest remaining table. A Candidate's file list becomes one R2 GET instead of a paged subscription. Risk: generic record pages and source-return snapshots read these collections |
| `projectObjects`, `projectObjectCatalog`, `projectObjectReceipts`, `projectSourcePacks`, `projectUploadCleanup` | Where each stored object lives | RT no; Tx yes for pending uploads | 738 / 2,873 B. Dev: 119,617 object rows with 7 indexes, 0.84 GB on the dashboard before the catalog move | Pending uploads, States, packs and receipts **stay**. Blob descriptors: **State-bound manifest in R2** (S5) | Cold 29k-file CI job: 2.1 MB to under 0.1 MB of reads; removes most source-worker lookups. Risk: medium; needs a trusted incremental writer |
| `projectHistory`, `projectHistoryPacks`, `projectGitMainCommits`, `projectGitLaneCommits`, `gitWorkerUsage` | Git history pins and serving | RT no; Tx yes | Not written by a landing; one row per pack or built commit | **Stay** | None |
| `projectGithubImports`, `projectGithubImportInventory`, `projectGithubBindings`, `projectGithubMirrors`, `projectGithubMirrorJobs`, `githubBindingInstallations`, `githubBindingOperations`, `githubBindingRemovals`, `githubBindingWebhookReceipts`, `githubDeliveries`, `githubRunnerGrants`, `githubRepositoryVisibility` | GitHub import, mirror and App state | RT for import status; Tx yes | Not in the fixture landing (no mirror). Mirror jobs are one immutable row per accepted State | **Stay.** Finished mirror jobs can join the landing capsule later; not sized | Unknown, expected small |
| `projectPublications`, `projectPublicationAttempts`, `projectPublicationPages`, `projectBackups`, `projectProposals`, `projectRecoveryConnections` | Publication, backup and proposal rows from the retired exchange path | RT no; Tx yes | Not written by a landing | **Stay** until the legacy storage cleanup (Issue 40dad5e0) finishes; then check each for a live reader and remove the rest | Unknown; one backup listing function read 140 MB in a day (measured, Issue 70a9bd2f) |
| `projectSelfMetricReceipts`, `projectSelfMetricBills` | Self-metrics receipts and recorded bills | RT no; Tx no | Not written by a landing | **Stay.** After S1 metrics read the capsule pointer's numbers, not history rows | The metrics page read 0.59 GB in one day (measured, owner dashboard) |
| `hostedProjects`, `projectSlugs`, `projectContributors`, `projectInvites`, `projectReaders`, `projectReaderOperations`, `projectAccessOperations`, `projectActorNames`, `projectPolicyChanges`, `projectInterests`, `projectBriefingSources`, `projectSourceAuthorityTransitions`, `projectSourceCutovers` | Project identity, access, policy | RT yes; Tx yes | Fixed per project | **Stay** | None |
| `projectReadBudgets`, `projectStorageUsage`, `accountStorageUsage` | Abuse-limit counters | RT no; Tx yes | Fixed per scope | **Stay** | None |
| `forgeAccounts`, `accountHandles`, `accountItems`, `accountOperations`, `handleOperations`, `cliCredentials`, `deviceCodes`, `deviceAttempts`, `agentGrants`, `agentEvents`, `agentUserSettings`, `agentGuidanceOperations`, `agentGuidanceMaintainerOperations`, `teams`, `teamMembers`, `savedViews`, `interestChanges`, `clientErrors` | Accounts, credentials, grants, settings | RT some; Tx yes | Fixed per account, except the `agentEvents` and `clientErrors` logs, whose growth is **unknown** | **Stay** | None |
| `imports`, `importArtifacts`, `importReaders`, `importRemovalOperations`, `teamImports`, `sourceZones`, `zoneChanges`, `zoneReaders`, `derivedArtifacts`, `artifactBlobs` | Indexed public imports and Zones | RT for status; Tx yes | Per import; bytes already in R2 | **Stay** | None |
| `secretObjects`, `secretVersions`, `secretGrants`, `secretEvents`, `secretDeletions` | Secret Objects | RT no; Tx yes | Fixed | **Stay** | None |
| `legacyStorageCleanupPages`, `legacyStorageCleanupWindows` | Maintenance receipts | RT no; Tx yes | 1,368 / 3,176 B retained per landing: the expiry receipts outweigh the callback stubs they leave | **Stay.** After S1 the capsule pointer is the receipt for the rows it replaces | About 3 KB per landing |

## Every R2 use

| R2 use | Role | Per landing | Verdict |
| --- | --- | --- | --- |
| Project objects `v1/p/<project>/o/<sha256>`: file contents | Source bytes | Changed files only, uploaded by the client | **Stay** |
| State manifests and recipe leaves | Source identity | 0.74 MB per State at 12k to 29k files after the recipe fix (measured, fixture); several States per landing | **Stay.** A smaller chunk target would cut it further; decide after S0 shows what the bytes are |
| Source-job progress, results and cursors (`r2source:`) | Durable compute state | Part of the smoke's 14.6 MB of egress per landing; the split is **unknown** | **Stay** with the Convex provider. A Worker step that finishes in one invocation writes none |
| Import upload packs, CI source packs | Bulk source delivery | One pack GET plus the delta for a warm CI job | **Stay.** This is the model for rule 2 |
| Check logs and the CI result inbox | Evidence and transport | 38 Class A requests per twelve-shard batch (measured, fixture); about 1 MB of logs (modelled) | **Stay**, and batch: one object per shard (S7). Results stay here instead of being copied into rows (S3) |
| Lane snapshot packs `v1/p/<project>/s/<lane>/` | Unsaved-work snapshots | One PUT per snapshot, 14-day expiry | **Stay** |
| Git history chunks, tree indexes, Lane packs, Forge main packs, framed copies | Git serving | None on the landing path; built on the first Git read | **Stay** |
| Backup and proposal archives | Recovery | Weekly | **Stay**; after S1 and S2 the archive lists capsule pins instead of copying their rows |
| Indexed import artifacts and derivatives (`v1/i/…`, `v1/d/…`) | Public analysis | None | **Stay** |
| **New: landing capsules and journal segments** | History (rule 3) | One Class A request per landing, about 0.05 to 0.1 MB compressed (modelled) | **Add** (S1, S2) |
| **New: State-bound physical manifest** | Descriptors (rule 2) | Changed entries only; shares the State's recipe chunks | **Add** (S5) |
| **New: Candidate file lists** | Per-file projection (rule 2) | One small object per Candidate | **Add** only if deriving in the client is too slow (S4) |
| Convex file storage | Legacy copies | Nothing new | **Remove** under Issue 40dad5e0, as planned |

## The brief's test questions

**Is the source worker in the right place?** For correctness, yes: it is fixed Forge code under one authority. For cost and speed, no: it rents 512 MiB to wait on a network hop, and pays egress to send States to the bucket next door. Three moves were weighed.

- *Client builds the State, server verifies.* It removes egress only for plain saves; compose and sync have no client. After the recipe fix the gain is small. Not recommended as its own slice.
- *One source job per landing attempt.* `land --save` runs save, sync and compose as separate jobs, each with its own action, reads and uploads. One fused job would read the base once and upload once. Unmeasured; S0 reads the per-kind step split first (S6).
- *Compute beside R2.* A Worker with an R2 binding pays for CPU time only, has no egress and sits beside the bucket. The stack already runs one: the Git large-pack Worker (`src/git-byte-worker.ts`, [Git serving](../git-serving.md#large-packs)). The limit is 128 MB per isolate against 512 MiB today, so a spike must prove 29k-file compose fits (S8). Cloudflare Containers have the memory but cold-start in seconds and add an image pipeline; not recommended.

**Should the landing queue live in a per-project Durable Object?** No. The serializer is not where the money is: its rows are a few hundred bytes and Convex does not bill mutation compute. A Durable Object beside Convex makes two owners for one fact (constraint 3), needs an outbox for every projection, and adds a hop to every transition. The most it could save is what finish steps cost today: about $0.3 to $0.5 per 1,000 landings if a landing takes 10 to 20 steps at the measured 121 KB each (modelled), and most of that returns as projection writes. Convex is the right serializer; the problem is what we write into it. A Durable Object queue only makes sense inside Option C.

**Is there an append-only journal in R2 with compact hot heads in Convex?** Yes, and it is the centre of the recommendation (S1, S2). It removes retained rows in the observation, attempt, finish-read, acceptance-page, record-version, record-body and operation-body classes, and it stops the weekly export from growing with history. One constraint shapes it: queries and mutations cannot read R2, so the pointer row must carry every number a transactional reader needs (verdict, timings, runner seconds, counts), and history readers fetch the object from the client, as the code view already does.

**Which rows are written for a reader that could derive them, and which indexes are paid on every write but read rarely?**

- Derivable: observation versions (from the request, attempt and run), display records (from record bodies), `viewFiles` and source rows (from two State manifests), finish read rows after terminal.
- Indexes: the inventory found a reader for every index, so none is dead. The waste is breadth times row size: 24 indexes on a 7.7 KB row, 9 on a 27 KB row. Moving the body off the indexed row keeps every reader and shrinks every copy.

**What is idle and per-project fixed cost?** Zero calls in every option. An idle 10,000-file project holds about $0.004 a month of storage today (modelled, [cost to serve](../operations/cost-to-serve.md#idle-storage-and-an-active-month)), about half of it Convex rows. How much of that S5 removes is unknown. The fixed platform fee is $25 a month for A, $30 for B, $5 for C.

**Should descriptors be dense catalog pages or single rows?** The catalog work referred this to the review. Neither shape serves both readers. A bulk reader wants pages: a cold 29k-file CI job reads 2.1 MB from 256-entry pages against 10.2 MB from rows (measured, fixture). A point reader wants rows: one lookup reads about 470 bytes from a row and 6.8 to 48.9 KB from a page, with two seeks instead of one (measured, synthetic guard in `tests/object-catalog.test.mjs`). A digest that is not stored yet pays for a page too, because the lookup reads the page that would hold it (`convex/projectObjectFind.ts`); every new file in a save is such a lookup. The verdict is to stop asking Convex the bulk question at all. S5 gives bulk readers a manifest in R2; the rows left in Convex then answer point lookups only and can be shaped for them, as slim rows with the three receipt indexes or as small pages. Until S5 lands, keep the dense pages and do not change the page size: the bulk saving is the larger measured effect, and moving the same rows twice costs more than either shape saves. The billed cost of point lookups on a large repository is **unknown**; the guard's fixtures hold 35 to 1,387 descriptors.

## Whole-system options

The planning vector is one landing on the smoke's 28,900-file repository. "Before" reproduces the measured $8.94; its split between classes is modelled. Everything else is modelled. Usage outside landings (extra saves, planning, sessions) adds about 10 to 15% in the serving model and is not included.

| Per landing | Calls | DB I/O | Action GB-s | Egress | R2 A / B | Retained in Convex |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Before the fixes (smoke) | 670 | 17.5 MB | 28 | 14.6 MB | 240 / 820 | 2.0 MB |
| Today, after the landed fixes | 620 | 10.4 MB | 26 | 6 MB | 240 / 820 | 2.0 MB |
| A | 450 | 6 MB | 18 | 3 MB | 80 / 600 | 0.15 MB |
| B | 430 | 5 MB | 3 | 0.3 MB | 80 / 600 | 0.15 MB |

| | Today | A: Convex plus R2, tidied | B: A plus a byte plane beside R2 | C: consolidate on Cloudflare |
| --- | --- | --- | --- | --- |
| What changes | Nothing | History, per-file metadata and per-file projections leave Convex; hot rows become headers; R2 writes are batched | A, and source steps run in a Worker with an R2 binding. The Convex action stays as the portable provider | Durable Objects with SQLite per project, D1 for accounts and search, Workers, Queues. Convex goes |
| Convex $ per 1,000 | 6.21 | 3.96 | 2.15 | 0 |
| R2 operations $ per 1,000 | 1.38 | 0.58 | 0.58 | 0.58 |
| Other compute $ per 1,000 | 0 | 0 | 0.06 (Worker) | 0.33 (Workers, Durable Objects, Queues) |
| **Operations $ per 1,000 and % of the $2 target** | **7.58, 379%** | **4.54, 227%** | **2.79, 140%** | **0.91, 46%** |
| Retained storage $ per 1,000 landings, per month kept | 0.41 | 0.04 | 0.04 | 0.06 |
| Operations plus 12 months of retention, $ per 1,000 | 12.44 | 4.98 | 3.23 | 1.63 |
| Fixed monthly cost, idle | $25 | $25 | $30 | $5 |
| Monthly at 3,000 landings (today's order) | $25 | $25 | $30 | $5 |
| Monthly at 30,000 (10x), first-year average | $195 | $66 | $62 | $27 |
| Monthly at 300,000 (100x), first-year average | $2,930 | $1,299 | $777 | $329 |
| Maintenance, recurring | Weekly export 1.31 GB of I/O and growing with history; expiry about $0.03 per 1,000 (modelled from the pilot's two pages) | Export covers open work and pointers only, and stops growing. Capsule writing reads and deletes the rows once: about 0.1 to 1.9 MB of I/O per landing, inside the 6 MB above | As A | No export meter; SQLite backups to R2 |
| Maintenance, one-off | None | Backfill history into capsules and move data records: about 2 to 3 GB of I/O (modelled; the Work split measured 1.43 GB) | As A, plus Worker deploy | Full data migration with a dual-run period |
| Realtime | As now | As now. History and file-list views fetch one R2 object, about 0.1 to 0.2 s (measured GET medians, [R2 plan](../r2-storage-plan.md#spike-findings)) | As A | Rebuilt on WebSocket hibernation; web and iOS need a new sync layer in place of the Convex SDK |
| Time to main and check wall | Baseline | Unchanged on the hot path; a fused source job may save seconds (unmeasured) | Expected faster: R2 from a Worker instead of about 230 ms per round trip from Convex (unmeasured; the spike's job) | Unknown |
| Notification latency | Baseline | Unchanged | Unchanged | Unknown |
| Migration effort | — | 8 slices, each about 2 to 5 builder-days | A plus a spike (2 days) and one provider slice (about 5 days) | 40 to 80 working days for the landing authority alone by the earlier estimate, more with views and planning, and every correctness proof again |
| Main risk | Storage and export grow without bound | A reader that needs history inside a transaction; each slice lists its readers first | A second runtime to keep in step; 128 MB isolate limit | The core claim (never lose accepted work) is re-proved on a new store |
| Vendor lock and self-host (constraint 12) | Convex plus any S3-compatible bucket | Same | Worker is optional: a deployment without Cloudflare keeps the Convex provider and any S3-compatible bucket | Durable Objects and D1 have no production self-host; the existing Convex self-host tooling is lost |

### Reading the table

- **A is worth doing at any volume.** Its largest effect is not in the operations line: it stops a cost that recurs monthly and compounds. At 300,000 landings a month the today column holds about 7,200 GB of Convex rows after a year; A holds about 540 GB (modelled).
- **B does not pay for itself in dollars until action compute passes the plan's 250 GB-hours**, about 35,000 to 50,000 landings a month at 18 to 26 GB-seconds each. Below that it costs $5 more. Its case today is speed and the removal of the 512 MiB ceiling's cost, so it must be decided on the spike's timing numbers, not on this table.
- **C is the cheapest and the wrong trade now.** At 100x it saves about $450 a month over B and costs a rebuild of every reactive read, the queue, receipts and auth, with the product's main promise at stake. Revisit if any of these becomes true: the Convex serving bill passes about $2,000 a month after A and B; Convex changes price or a concurrency limit binds; a second client platform makes the Convex SDK irrelevant.
- **Alternatives rejected.** A managed realtime broker ($25 a month and a bridge) costs more than the Convex subscriptions it would replace. Self-hosted Convex on one machine breaks the rule that the product never depends on one machine; a redundant fleet costs more than the bill it replaces at today's volume. Both are sized in [cost architecture options](../operations/cost-architecture-options.md).

### The floor placement cannot move

A flat State makes each landing O(files) in bytes, CPU and memory. On the 28,900-file repository action compute alone is about $1.5 per 1,000 landings under A ($2.2 today). B makes that floor about 30 times cheaper; only a State identity that names a tree root removes it, and that was tried and dropped for stated reasons ([decisions](../decisions.md#trees-in-packs-issue-676efbc2)). The $2 target should be read as a target for small and mid-size repositories until that changes.

## Proposed slices

Every open candidate in [data placement](../data-placement.md#open-placement-candidates) maps to a slice: observations, attempts and finish read rows to S1; record bodies, records, operations and saves to S2; landing requests and Actions results to S3. Record heads stay as they are. Overlap path interning is not pursued (0.03 to 0.12 GB modelled, no reader gains), and Work payload or actor interning is superseded by S4, which removes those rows.

Sized for one builder each. None is filed. Every slice keeps idle at zero calls, adds no user step and no product limit, and names what it removes. Order: S0 first; then S1, S3 and S7 in parallel; then S2 and S4; then S5 and S6; S8 only on the owner's decision.

### S0. Measure what this review could not

Done when, posted on Issue 298f9675 and in cost to serve:

- Billed read and write bytes for a patch of a document of 1, 8 and 27 KB with 1, 9 and 24 indexes (ten writes each on dev; under 5 MB of I/O).
- From the post-fix re-smoke's existing `forge-source-step` log lines and step timing: steps per landing by kind (save, sync, compose, registration, fan-out child), put bytes by state, progress and result, and wall time split into R2 wait, nested calls and compute. No new run.
- R2 requests per landing by class and by caller from the existing request counters, reconciled once against the bucket's operation metrics.
- Calls and I/O per landing by function family for the 24% of the smoke that has no name.

Guards: docs and numbers only; no runtime change. Removes: the modelled planning vector in this page, replaced by measured values.

### S1. Landing capsule

At a one-shot wake after a landing's terminal transition, scheduled the way operational expiry is today, pack its immutable rows (observations, attempts, finish read rows, acceptance events, pages, plans and snapshots, compose pages, callback digest receipts but never the reuse aliases) into one compressed, content-addressed R2 object. Verify it, write a pointer with digest, size, per-table counts and the numbers readers need, then delete the rows in bounded pages.

Done when:

- Retained Convex JSON per landing in `tests/fixtures/landing-storage-budget.json` ratchets from 50,417 to at most 15,000 B (fresh) and from 360,486 to at most 60,000 B (dogfood-shaped), together with S2.
- A byte-exact round trip: rows rebuilt from a capsule hash to the per-table digests in its pointer.
- `landing`, `observe`, provenance, metrics and the recovery export return the same answers for a capsuled landing; the recovery drill restores from capsules.
- Hot path: zero added calls. At terminal plus grace: one action and at most two mutations per page, one Class A request, under 100 KB of egress. Replay of an unknown outcome returns the original pointer.
- Live observation versions are no longer stored: the current snapshot is one row and each transition a compact entry.

Risk: a mutation that reads history. List every reader of these tables first and keep whatever a transaction needs on the pointer. Removes: retained rows in nine tables; the per-landing expiry receipt.

### S2. Journal segments for superseded Work records

Per project, move superseded record versions with their bodies, closed-Lane save pages and operation bodies past terminal into append-only R2 segments by revision range, with one small index row per segment. Current versions and heads stay.

Done when: the same storage ratchets as S1 hold; event pages and provenance for old revisions read segments from the client with one signed read per segment; a retry of an operation inside 90 days reconciles from its compact receipt alone; the weekly export's document bytes stop growing with closed work (measured on two consecutive exports). Depends on S1's writer. Risk: medium; the Work event feed and recovery export both walk these rows. Removes: superseded rows in `projectHostedRecords` and `projectHostedRecordBodies`; `projectHostedDisplayRecords`; the three snapshot tables if the segment index replaces them (growth guard: minus up to four tables).

### S3. Hot rows become headers

Split `projectHostedLandingRequests` into an indexed ticket and an unindexed body. Keep `projectHostedCheckRuns` as a header (verdict, pins, counts, timings) and leave report detail in the R2 objects the runner already uploads, with a pointer, instead of `projectHostedActionsResults` pages and inline reports.

Done when: bytes written per phase transition and per check callback fall as S0's fit predicts, guarded in `tests/landing-cost-guard.test.mjs`; all 24 and 9 index readers pass unchanged, except that the check status query returns the run header under the contract below; calls per landing do not rise on the healthy path; verdict reuse works from the header and shard restore from one collector fold. Removes: about 570 KB written then expired per dogfood-shaped landing; the 30-day detail expiry for new runs; `projectHostedActionsResults` once old rows expire (minus one table).

#### S3 report transport

Implemented for Issue 324f1d97 behind the default-off server setting `FORGE_CHECK_REPORTS_R2=1`, after the detail readers deployed. New runs pin this choice at enqueue; existing runs retain their protocol. New-mode collectors replace row replay with a single folded R2 object. Legacy report rows and replay remain until the compatibility removal in Issue 589601f7.

**Decision: the summary lives in Convex, the reports live in one R2 object, and report bytes never become rows.** A run's per-file reports are written once, by the party that already holds them, as one immutable object pinned by digest in the run header. A mutation gets what it needs as arguments; no transaction reads report bytes from the database. The raw result slots are not that object: they embed log bytes, and reading them needs the fold, which would freeze today's fold rules into every client and every later release.

**What stays in Convex per run**, bounded whatever the file count and however many files fail:

- verdict, pins, counts, timings, pool-pending names and `reportFlakes`, as today;
- `testFiles`: exact `total`, `failed` and `flaky` counts, and the failed and flaky lists in stable order with today's clipped first errors, shortened until `testFiles` is at most 8 KiB, the unlisted remainder counted;
- the five slowest files, so the `summary` query needs no reports;
- pass or fail and duration for each test the run's own semantic plan names: no more entries than the plan already holds;
- the pointer: the report digest (the same `checkPin` of the folded reports as today's `reportDigest`), byte size and file count. No key and no URL.

Guards execute the 20,000-file all-pass and all-fail cases: the whole run row stays under 12 KiB with exact counts and bounded lists. Collector retained heap at I/O boundaries is guarded at 64 MiB; this does not measure the transient allocation peak.

**What the status query returns.** `projectHostedCheckRead:status` returns the header: today's run without `contractReports`, plus the pointer. It stays one reactive read of one row, so web, CLI waits and a future iOS client keep realtime status, and each update carries the header instead of every report. `summary` keeps its reply and its 8 KB bound.

**How full detail is read, and by whom.** One server action, reached as `status {runId, reports}` from the CLI and MCP and called by the web or iOS detail view when it opens. It reads the object with server credentials, checks the digest against the header, checks current project access exactly as `status` does, applies the same public-identity mapping and returns reports in today's `contractReports` shape, at most 256 KiB per reply:

- `failed`: every failed and flaky file with its capped excerpt. One call covers any ordinary failure; `nextCursor` appears only when more files fail than one reply holds.
- `files`: up to 256 named files.
- No selector: every file, paged.

The object is server-only, as S1 decided for capsules. First-error excerpts are runner output, a signed URL can neither re-check access nor be mapped, and one policy path is easier to keep correct than two. The same action serves older runs from their inline or paged rows, so clients have one detail path. A missing or differing object fails the detail read alone (`SOURCE_UNAVAILABLE`, `EVIDENCE_CHANGED`); verdict and summary do not depend on it. An agent gets the failing files and clipped errors with the landing receipt, with no extra read, and the full excerpts in one action call.

**Who writes the object.**

- *Sharded runs (GitHub Actions).* The collector action already reads every result slot. It folds them in shard order with the shared fold, PUTs the folded reports once under a content address (a retry writes the same bytes), then calls one mutation with the per-shard receipts and the bounded fields above. The inbox is deleted as today. A settlement covering fewer shards than the header records is ignored; a different digest on a terminal run is refused, as today.
- *Single-callback runs (machine runner, worker).* The runner PUTs the reports it is about to send into a fenced immutable slot, with a target returned in a reply it already receives, then sends its callback as today. The mutation hashes the reports in its arguments, derives the header and stores the pointer. No call is added.
- Any server action that hands reports to a callback mutation (the callback API, reconcile) writes the object before that mutation.

The object lives as long as the run's check logs and is removed by the same cleanup; no new retention rule.

Uploader, completed webhook and verdict confirmation share collection admission in their existing
mutation. One fenced execution owns ingestion; a concurrent provider event records its conclusion
for that owner to consume at settlement. Scheduled ownership retains the function's system id.
A later real event reads its state
inside that same mutation and immediately reclaims a failed, canceled or succeeded-without-fold
holder; pending and in-progress holders are never stolen. Non-scheduled HTTP collectors use
the V8 action's maximum execution window only as a backstop. No timer or poll is scheduled.
An already pinned fold
reuses its header and performs no ingestion. Provider verdicts settle from that header; only
unfinished timing pages or final output are repaired from the retained object. Identical settled
replays rewrite no run or timing rows and perform no object I/O. The landing cost guard covers
all six ingress orders and replays with eighteen ingestions for eighteen checks in a ten-landing
fixture; these request counts do not establish a live billed saving.

**Restore and reuse.**

- *Verdict reuse* reads the header only: `verdictKey` and the reuse alias, as now.
- *Shard restore.* A run that ends by cancel, watchdog or provider conclusion keeps the reports its shards sent: the collector that terminal already schedules folds the slots present, attaches pointer and summary in one mutation, then cleans the inbox. No mutation replays report rows.
- *Semantic verdict, failure diagnosis, culprit failures, proof and the gate* read header fields.
- *Test timings* take durations as an argument of the settling mutation (paged above 768 KiB), which replaces the scheduled `record` mutation and its re-read. A run that waits for the provider's conclusion records timings only after that conclusion, under a generation and sequence stamp the header keeps for the gate's comparison. Cancelled runs never contribute timing samples.
- *Culprit bisection* is the one transaction that asks another run about files that passed. On that red-main path one action reads the object and passes the named files (at most the red run's listed failures) as arguments, with the digest as a compare-and-set.

**Budget, modelled until built.** Healthy path per check run: no added call (one settling mutation; the scheduled timing mutation goes); no report bytes written to or read from Convex rows; one more Class A request, which S7's ratchet counts, and about 0.1 MB of egress per 1,000 reported files. Collector memory becomes proportional to the run's reports, a few MB at 20,000 files; assert it. A detail read is one action and one Class B request, on demand. Idle is zero.

**Migration: expand, then contract.**

1. *Readers.* Header fields are written for every run from the reports its transaction already holds, and internal readers move to them. The detail action lands, serving all three stored shapes. CLI, MCP and web send a `check-report-detail` feature on `status` and read detail through the action.
2. *Writer*, behind a server setting, default off, enabled on dev once step 1 is deployed. Actions runs need no runner change: the slots are the same. A machine runner declares the feature to get its slot.
3. *Contract.* A client without the feature that reads a run whose reports are in R2 gets `CLI_UPGRADE_REQUIRED`, never a silently thinner answer; runs without reports are unaffected. The per-shard direct result entry and inline-report callbacks from older runners get the same error. Once the older rows have expired (30 days), `projectHostedActionsResults`, the replay and hydrate code and the detail compaction go (minus one table).

**Contract tests that change, and their replacement guards.**

- `tests/hosted-actions-result-growth.test.mjs`, "batched reports: 20,000 files". The status assertion of 20,000 inline reports and the paged-row assertions (`reportParts > 1`, each document under 300 KiB, compact against legacy bytes) change because the decision removes both. Replacement in the same test: no `projectHostedActionsResults` row for the run, one report object whose digest equals the header pointer, the detail action pages all 20,000 reports equal to the fold, and `status` carries no `contractReports`. Kept: head under 12 KiB, webhook reads and writes under 24 KiB, the flaky metric projection. Added: the all-fail case.
- `tests/hosted-checks.test.mjs`, exact reports after one failed shard. The `testFiles` assertions stay on `status`; the exact-report equality moves to the detail action.
- Shard-restore tests. New runs assert the collector's fold of the slots present at cancel, watchdog and conclusion; row-replay cases stay for older rows until step 3.
- New negative tests: no feature on a run with R2 reports gives `CLI_UPGRADE_REQUIRED`; a viewer without access gets the same refusal from the action as from `status`; no reply contains an object key or URL.
- `tests/landing-cost-guard.test.mjs` and the storage fixture: new runs write 0 B to `projectHostedActionsResults`, and bytes per check callback follow S0's fit (write is about document bytes + 181 + 128 per index) on the measured header.

### S4. Per-file projections leave Convex

Stop writing `viewFiles`, source and payload rows. The web app and CLI derive a Candidate's file list from its two State manifests, which they already fetch from R2; if that is too slow for large States, the source step that builds the Candidate writes one file-list object.

Done when: a landing writes zero rows to `projectWorkDataRecords`; the Candidate page shows its file list within the current time on the 4k and 29k fixtures; generic record pages and source-return snapshots that named these collections have a stated replacement. Removes: `projectWorkDataRecords` after a bounded migration (minus one table, about 3.3 GB modelled on dev).

S4 readers negotiate `candidate-source-files` using the existing contract-feature
mechanism. Canonical web Candidates do not require a legacy Work generation;
legacy indexed Views remain readable. Every compose producer now publishes one
source-only file listing unconditionally. Small-compose, fixed-worker and stepped
paths pin the exact final base/head and all selected input identities. Batch
intermediates do not each publish a listing. Existing recovery includes the server metadata pin. There is
no new settings table or user step. Old indexed Candidate readers receive
`CLI_UPGRADE_REQUIRED` when the selected Candidate uses this protocol.

This does not yet remove legacy data-projection writes. Their active writer
families remain generation publication (`projectWorkIndexStore`), paged Work
rebuild (`projectWorkIndexBuildStore`), indexed command projection (`projectWork`),
GitHub import publication/fallback, native bootstrap, Work-store migration
fingerprints/comparisons and explicit record-partition migration. Routing also
includes planning payload collections, not just source and View data. Do not
suppress those rows before their exact attributes, mutation-critical overlays,
identity mapping and recovery replacements are implemented. Canonical compose
already wrote zero data rows before this change; it does not prove all-path
elimination or the modelled storage saving.

The canonical Intent conversion preserves hydrated imported `payload`,
`payloadKey` and `payloadParts` fields inside its existing `journal` object.
The projection header's transport metadata must not erase similarly named source
attributes. Selected commands still read the legacy payload chunks, even after a
canonical copy exists; the canonical body's current reader is still Convex.
Moving those bytes needs a command/read architecture that preserves the existing
single-mutation call budget, not only a different physical table router.
The bounded follow-up and full rendered-page fixture method are described in
[data placement](../data-placement.md#candidate-and-projection-retirement-follow-up).

The remaining data-projection readers have these replacement boundaries. These
are the migration contract, not a claim that the writer has switched:

| Existing collection/read | Replacement |
| --- | --- |
| `viewFiles` | Exact Candidate State comparison, or its one trusted R2 file-list object; canonical Lane-version history remains the provenance source. |
| `sourceBlobs` | Existing project object catalog/download descriptors, verified by digest and size under current access. |
| `sourcePins` | Canonical Channel, Lane and Candidate selectors; historical checkpoint membership comes from that exact checkpoint's R2 manifest. |
| `sourceTrees`, `sourceTreePaths` | The selected immutable State's R2 file manifest. |
| Source parent/ancestry collections | Registered source metadata and verified State parents; the trusted source step retains ancestry proof at its existing publication boundary. |
| `*:payload` | Selected canonical Work records and exact R2 Work-record leaves, with mutable header overlays and current server-side identity mapping preserved. |
| `_workStore*` | Canonical record digests and the existing migration comparison, without another raw projection copy. |
| Source-return snapshot entries | Source return is already retired with `CLI_UPGRADE_REQUIRED`; portable checkpoints and canonical recovery/export preserve source and Work, rather than treating disposable index rows as canonical history. Existing retained snapshot reads remain until their callers migrate. |

Existing rows are not deleted in S4. The follow-up migration must pin a project
and generation, inventory in pages of at most 100 rows and 500 KiB, verify every
replacement's digest/size and full attribute/provenance coverage, and exercise
export/restore before removing a verified projection copy. Keep a resumable,
retry-safe cursor and the original canonical source/Work/audit history. No
maintenance runs implicitly, and no table is dropped until old generations,
generic readers, selected lookups and snapshot readers have all moved. Removal
and billed savings for legacy projections remain unverified while their writers remain.

#### S4 remaining writers

**Verdict: close S4 on the Candidate file list. Do not move the remaining writer families to R2, and do not build a Work-leaf reference with overlays.** A landing writes nothing to `projectWorkDataRecords`. What still writes is either the Work read model, where a Convex row is the cheapest form and the only one that keeps a command in one mutation, or a one-time onboarding cost that is removed by writing less, not by a new stored format. The table stays: the "minus one table" and the 3.3 GB removal in the slice text above do not come from S4.

Row counts and bytes are serialized row JSON from the built projection code, on paths shaped like this repository's (32 bytes per path on average), from a read-only probe (**measured, fixture**). Write I/O applies S0's fit, document bytes + 181 + 128 per custom index, with this table's six indexes (**modelled**). Retained storage is given from documents only to the nine-copy sensitivity in [data placement](../data-placement.md#work-projection-index-domains). No deployment was read or written.

| Writer | Runs | Rows and bytes | Cost at list price | Verdict |
| --- | --- | --- | --- | --- |
| Hosted landing: save, compose, check, accept | Every landing | 0 rows and 0 reads (measured, six-landing fixture). `tests/landing-cost-guard.test.mjs` fails the build on any access | $0 per 1,000 landings | Done |
| Work commands (`projectWork.appendWork`): Intent, note, status, planning put and comment | Per command; not per landing and not per file | One `intents:payload` chunk set for each Intent the command changes, replacing the previous set: the Intent's attributes, at most 32,000 characters a chunk. A planning item or version writes chunks only above 32,000 characters | About 3P + 1 KB of I/O for a payload of P bytes (read it, write it, retire the old one): $0.0000014 at 2 KB, $0.00002 at 32 KB. At three such commands a landing, $0.004 to $0.06 per 1,000 landings, 0.2% to 3% of the $2 target (modelled; payload sizes on dev are unknown) | **Stay.** This is the Work read model (job 3), sized by the record and not by the repository |
| GitHub import, archive path (`projectGithubImportPublication.stage`) | Once per imported project whose GitHub listing is complete | Six fixed source rows plus one `sourceTreePaths` row per 500 files: 14 rows and 0.15 MB at 4k files, 64 rows and 1.21 MB at 29k. No row per blob | Write $0.00003 and $0.00025 per project. Retained $0.00003 to $0.0003 and $0.0002 to $0.002 a month | Cheap. The path rows go in the onboarding slice below |
| GitHub import, paged path | Once per project whose listing GitHub truncates (over 100,000 entries or 7 MB) | As above, plus one `sourceBlobs` row of 317 B per blob: 31.7 MB at 100,000 files | Write $0.025 per project; retained $0.006 to $0.06 a month | Rare. Same slice |
| Index generation and rebuild (`projectWorkIndexStore.batch`, `projectWorkIndexBuildStore.step`) | `nforge host` of an existing directory, once per project; an operator's `rebuild-index` | One `sourceBlobs` row per stored object and one `sourceTreePaths` row per 100 files: 4,044 rows and 1.42 MB at 4k, 29,294 rows and 10.5 MB at 29k, where the blob rows alone take about 58 paged build steps (500 pins a step). `viewFiles` rows only for Views recorded in an imported Work journal; a project born hosted has none | Write $0.001 and $0.008 per project. Retained $0.0003 to $0.003 and $0.002 to $0.019 a month | The only writer of a row per file on a healthy path. Same slice |
| New empty project (`projectBootstrapStore.publish`) | Once per project | 6 rows, 2.2 KB, fixed | Negligible | Stay |
| Work-store fingerprints (`projectWorkStoreFingerprintWrites`) | Only while a project sits between Work store modes | One row of about 250 B per Intent or compared record, updated in place. None on a project that never enabled the store, none once all four writers are primary | Negligible. Whether dev is in this state is **unknown**; it was not read | Stay; it ends with the migration |
| `projectWorkRecordMigration` | Operator maintenance, complete on dev | Copies existing rows | Not on a healthy path | Stay |
| `projectGithubImportStore.publish` | Never; nothing calls it | None | None | Delete in the onboarding slice |

**Why Work payloads stay in Convex.** A mutation can neither read nor write R2, so a payload in R2 turns the one-mutation command into an action, a query and a mutation at best (seven calls on the existing indexed route, measured in a fixture). A reference with overlays removes the read but not the write: every command that changes an Intent produces a new leaf, which only an action can store, or leaves overlays to pile up for a later job to fold. Both break the budget. It would also cost more at every size below the chunk cap: one R2 write is $0.0000045 and needs an action call ($0.000002), against $0.0000006 for a 2 KB chunk in Convex and $0.0000066 at the 32,000-character cap. R2's cheaper storage does not offset it; a 2 KB chunk retained at nine copies costs $0.000000004 a month. These rows do grow by one chunk set per Intent ever filed. That is the Work read model's own growth, and archiving closed Work belongs to S2, which already owns superseded records.

**Candidate file-list cutover.** New clean Candidates carry one listing
unconditionally; the rollout setting has been removed. The prerequisite dev check
confirmed one listing pin per new Candidate and unchanged Convex writes per
landing attempt. Candidates composed before listings existed remain readable
through the two-manifest comparison. Readers of both forms and
`CLI_UPGRADE_REQUIRED` for old indexed readers are already deployed.

With the listing, the full page shows a paired median difference of -0.2 ms at
4k files (95% interval -0.7 to -0.1) and about 0 ms at 29k (-0.8 to +0.1) on
33 ms medians, eleven pairs each: faster at 4k and not distinguishable from no
change at 29k, which is what "within the current time" asks. The legacy fallback
reads both State manifests, 0.9 MB at 4k and 6.6 MB at 29k where the legacy
indexed page read a few kilobytes (measured, fixture).

The listing adds 0.67 R2 Class A and 0.67 Class B requests per landing in the fixture mix (642 B for one changed file): $0.003 per 1,000 landings, 0.16% of the target, and no Convex call.

**Onboarding slice (proposed, its own Issue; not a condition of S4).** Onboarding is the last healthy path where rows scale with files. The money is small; the reasons to spend about one builder-day are that it breaks rule 2 for every hosted repository and that a 29k-file `nforge host` spends about 58 steps writing rows that duplicate object descriptors. Nothing is moved to R2 and no existing row is migrated:

1. Readers first. `sourceBlobs` lookups already fall back to the project's object descriptors when a generation is marked `objectCatalog` (`readRecord` in `convex/projectWorkIndexStore.ts`); archive imports rely on it. Confirm every `sourceBlobs` reader goes through it, and that none uses the row to prove that a checkpoint, rather than the project, holds the blob; one that does reads that checkpoint's R2 manifest. The Code tab already falls back to the exact source reader when a head has no tree row, as it does for every project after its first landing; make it fall back as well when the tree row says its paths are not stored. Measure the Code tab's first open on fresh 4k and 29k projects both ways before the writer changes.
2. Writer, behind the existing default-off server setting: host, rebuild and paged-import generations are marked `objectCatalog` and write no `sourceBlobs` rows; host, rebuild and import write no `sourceTreePaths` rows. Counts stay in generation metadata.
3. Bound and guard: onboarding writes at most eight rows to this table at any file count, asserted at 4k and 29k for host and import. Calls per host fall by the blob phase (about 58 steps at 29k) and the tree action; calls per import do not rise.

It removes per-file rows from onboarding, two build phases and the uncalled `projectGithubImportStore.publish`.

**Existing rows.** Dev holds 361.9 MB of documents in this table, 103,355 of the frozen generation's rows being `viewFiles` from the dogfood project's native-owner history. That is $0.07 to $0.65 a month at list and nothing today, inside the plan's included 50 GB. No project born hosted accumulates them. A bounded migration to R2 would need new readers for legacy Views and migration I/O of the order the table split billed (1.37 GB), to save cents on one deployment, so it is not planned. The rows leave when the owner retires that legacy generation, a deletion that is the owner's decision; the [migration contract](../data-placement.md#candidate-and-projection-retirement-follow-up) stands for anyone who takes it up.

**Unknown.** Payload sizes and Work-store mode on dev; row counts from a live `nforge host` (the probe ran the projection code, not a hosted run); the Code tab's first-open time without path rows; billed usage with the listing on.

### S5. State-bound physical manifest

The source step that writes a State also writes its physical manifest: digest to binding (raw key, pack range or recipe), stored as a recipe that shares unchanged chunks with the parent's manifest. The source worker reads it directly instead of descriptor windows. CI and clones read the source pack, and every grant outside it is signed from the manifest ([bulk read grants](#s5-bulk-read-grants)).

Done when: a 29k-file CI job on a fresh runner reads under 100 KB from Convex and receives under 100 KB of grants in at most 3 resolver calls, both with a source pack and up to 300 changed paths, and with no source pack on a State stored in compact packs of at most about 130 runs (2,105,060 B read, 15,951,085 B of reply and 11 calls today without a pack); an all-raw or fragmented packed State takes the one-time windowed path, says so, its check run publishes the pack and the following job takes the source-pack path; no content grant covers a byte outside the selected State, and a metadata grant stays inside the selected State's own manifest lineage (asserted, with refusal tests); source-worker descriptor calls per landing fall from about 41 to at most 5; no State write scans descriptors (reads are O(changed files), asserted); every object is still verified by hash and size; a missing or invalid manifest falls back to the catalog and says so; a point lookup of one digest, stored or not, reads at most about 1 KB on the guard's 402- and 1,387-descriptor fixtures once bulk readers use the manifest. Removes: descriptor rows for new blobs; the dense catalog pages for manifest-bound projects later. Risk: medium; this is the trusted incremental writer Issue 298f9675 left open.

The design review amended the first line and added the authority line. The original first line asked for under 100 KB on any cold job. 29,002 separately signed objects need at least 928 KB of signatures, so the line now names the two shapes a bulk reader meets after this slice and bounds the reply as well as the database read. The layout review then split the authority line into file contents (exact, unchanged) and manifest metadata ([S5 metadata layout](#s5-metadata-layout)).

#### S5 delivery boundary: bindings and download authority

The existing bulk source readers still use the catalog. Moving the bindings to R2
is only part of this slice: CI and clone clients also need authority to download
the referenced bodies. `convex/r2.ts:presignGet` signs one exact object path through
`src/r2-presign.ts`. A manifest GET signature cannot be reused for its raw objects,
packed objects or recipe leaves. The existing presigner guard checks that changing
the key changes the signature. Recipe closures reduce descriptor rounds by signing
each leaf in the enclosing reply; they do not provide a multi-key grant.

The registered cold-job fixture in `tests/hosted-actions-direct.test.mjs` accounts
for both State descriptors and every unique raw blob, without a source pack. Its
logical reply counters include the returned GET URLs but exclude the Convex/HTTP
encoding envelope. These are synthetic serialized DB/read-reply sizes and issued
grants, **not billed usage, executed GETs or a latency benchmark**.

| Files | Catalog DB read B | Resolver calls | Issued GET grants | URL B | Parsed reply B |
| --- | ---: | ---: | ---: | ---: | ---: |
| 4,000 | 301,280 | 3 | 4,002 | 1,652,798 | 2,201,077 |
| 6,000 | 437,952 | 3 | 6,002 | 2,478,798 | 3,301,077 |
| 29,000 | 2,105,060 | 11 | 29,002 | 11,977,798 | 15,951,085 |

At 29k, raw descriptor rows instead read 10,226,466 DB B in the same 11 calls;
compaction does not remove the key-specific GET grants. The largest catalog reply
is 1,760,001 parsed bytes. Even removing descriptor DB reads cannot fit the current
15,951,085-byte reply into three existing 4 MiB reply windows (12,582,912 bytes).
This is a bound on the **current reply representation**, not proof that another
approved grant design cannot meet S5. Increasing a batch size alone does not solve
it. Putting expiring GET URLs in the retained immutable State manifest would also
leave old States with expired authority after the current five-minute GET window.

The fresh-action source observations below use accepted State
`8f1deae132369ae9396c6853371d1479352128f32eebc54417134f46b3c875da`,
before subsequent source-worker changes were synced into this diagnostic Lane.
They come from `tests/convex-source-scale.test.mjs`:

| 29k operation | Samples | Convex function calls / operation | Peak action RSS B | R2 PUT body B / operation |
| --- | ---: | ---: | ---: | ---: |
| Sequential one-file save | 10 | 6 | 189,104,128 maximum | at most 737,549 |
| Sibling compose | 1 | 8 | 293,896,192 | 737,706 |
| Sync | 1 | 6 | 245,137,408 | 737,622 |

These function counts are whole source-job counts, not descriptor-only counts or
a complete landing. The save fixture shares one original blob across 29k paths,
whereas the cold CI fixture has distinct blobs; neither substitutes for the
other's memory or descriptor shape. The ten save observations have 380.5–579.1 ms
fixture wall; compose and sync have 580.1 and 534.3 ms. There is no before/after
runtime change, paired timing comparison or new memory-saving claim. Existing
sparse packed-descriptor guards still read 48,542/48,919 B for a stored full-page
lookup at 402/1,387 descriptors, against raw rows of 470/471 B. The S5 sparse target
is therefore still unmet; dense pages must remain until bulk-reader cutover.

The diagnostic landing merged grant and reply accounting into the existing CI cost
guard and changed no runtime path. The trusted source action already has signing
authority and needs only the bindings; external readers need the decision below.

#### S5 bulk read grants

**Decision.** Bulk reads are pack reads, and the five-minute exact-key GET stays the
only read authority. Forge adds no credential type, proxy, service or job object. A
runner or clone reads the project's [source pack](../operations/github-actions-checks.md#forge-source-packs)
and then only the files the pack lacks. Every grant outside the pack is signed from the
State's physical manifest as a **run**: one signed byte range over objects of that State
that sit back to back in one stored pack, or one whole raw object. Imports and client
uploads already store small files in packs of at most 1,000 files or 8 MiB, so a
29,000-file State with no source pack needs about 30 to 60 runs where it gets 29,002
grants today (modelled from those window sizes).

**Why the other candidates fail.**

- _Compact grants (one signature over a key list)._ R2 checks one signature per request,
  and a signature is 32 bytes. 29,002 separately signed objects need at least 928 KB in
  any encoding, so under 100 KB needs fewer physical reads, a wider credential or a
  verifier in front of R2.
- _Anything that keeps one read per file._ 29,002 Class B reads cost $0.0104 a job, five
  times the $0.002 landing target, at zero Convex bytes. This rules out the next three
  on cost before authority is considered.
- _R2 temporary credentials._ Cloudflare documents them as bearer credentials for one
  bucket, limited to key prefixes or exact keys and optionally to named actions, issued
  by API or by a locally signed token, and revoked only with their parent key (read on
  11 November 2026, not tested). Objects are content-addressed under one
  `v1/p/<project>/o/` prefix shared by every State, Lane and history pack. A prefix is
  the whole project store, and a State is a set of keys, never a prefix. Rejected: wider
  than one State, R2-only, and a bearer key on a machine that runs project code.
- _The Git byte Worker with a manifest-bound token._ The Worker is optional, holds no
  secret and is built to fit Workers Free. It would need a verification key or a backend call
  for each plan of at most 900 objects (33 calls at 29k, more than the 11 today).
  Rejected; it stays a Git transport.
- _A per-job signed bundle in R2._ It moves the 12 MB of URLs and the O(files) signing
  into an action without removing either. Rejected.

**Authority.** Today `projectHostedActionsSource:resolve` signs any stored digest of the
project once the session passes; it does not check that the digest belongs to the run's
States. The manifest signer is narrower. It takes one State the caller may read (for a
runner: the run's Candidate, base, recheck and pack States; for a client: a State that
current access allows) with a digest list or `all`, signs only members of that State's
manifest, and refuses any other digest with `SOURCE_UNAVAILABLE`. A run holds exactly
its members' bytes and never a neighbour's (the rule `packRuns` already applies for
clients). The source pack grant covers one object whose inventory readers check against
the hash-verified State. The source worker signs for itself and reads the manifest
directly, so it needs no grant. Grants stay five-minute exact-key SigV4 GETs with the
range signed; the presigner guard is unchanged. This exactness is about file contents. Grants on
the manifest's own packs follow the [metadata layout](#s5-metadata-layout).

**What Convex returns.** The session reply carries the pack pin and one URL, as now. One
resolver call returns the State bodies and, for a reader with no pack, the manifest's
chunk grants. One more returns run grants: per-digest descriptors for a delta, runs only
for `all`, because the reader maps files to runs from the manifest it fetched and checked
against its pin. Convex reads the State rows and manifest pins, never one descriptor per
file. The HTTP action fetches the manifest chunks it needs from R2 before signing.

| 29k-file job, fresh runner                                | Resolver calls | DB read | Grants | Reply and Convex egress        | R2 reads                     |
| --------------------------------------------------------- | -------------: | ------: | -----: | ------------------------------ | ---------------------------- |
| Today, no pack (measured, fixture)                        |             11 | 2.11 MB | 29,002 | 15.95 MB, $0.0019              | 29,002, $0.0104              |
| After, pack and 20 changed blobs (modelled)               |              2 | < 10 KB |   ~ 30 | ~ 17 KB, $0.000002             | ~ 30                         |
| After, no pack, State stored in packs (modelled)          |              2 | < 10 KB |  ≤ 130 | ~ 50 to 60 KB, $0.000007       | ≤ 130                        |
| After, no pack and every object raw: windowed, one time   |             11 | 2.11 MB | 29,002 | 15.95 MB, $0.0019              | 29,002, $0.0104              |

Today's job costs about $0.0128 at list prices ($0.12 per GB of egress, $0.20 per GB
read, $0.36 per million Class B), 6.4 times the landing target; the reply is 15% of it
and the R2 reads 82%. The last row is today's path kept as the named fallback: that check
run publishes the pack, so the next job takes the second row. The modelled DB reads
assume a State row and its manifest pin read at about 1 KB; on dense pages one State
lookup reads up to 48.9 KB, so the pins must sit in a slim row. Reply bytes exclude the
HTTP envelope. No row is a billed reading.

The guards-only rollout also records the current resolver on pack-shaped fixtures.
The stored-pack shape has 29 packs, each containing 1,000 neighbouring small
objects; the source-pack shapes select 20 or 300 raw changed blobs in digest order.
The latter is permitted even when normal small client uploads use packs: large
files and trusted merge outputs can retain raw bindings. Both State descriptors
are included. Source-pack rows include its one signed grant and slim-row read;
the existing session itself is outside the resolver-call count, as in the raw guard.

| Current 29k shape | Resolver calls | Serialized DB read B | GET grants | URL B | Parsed reply B |
| --- | ---: | ---: | ---: | ---: | ---: |
| No source pack, blobs in stored packs | 11 | 5,650,580 | 29,002 | 12,209,798 | 17,299,106 |
| Source pack plus 20 raw changes | 2 | 25,031 | 23 | 9,404 | 12,670 |
| Source pack plus 300 raw changes | 2 | 42,517 | 303 | 125,044 | 166,670 |

These are baseline ratchets in the existing cold-job guard, with no runtime change.
They count issued grants, not executed GETs or billed usage. The 300-change
current reply exceeds 100 KB even though its descriptor reads already fit: moving
bindings alone cannot fix that reply. Run signing helps packed deltas; raw deltas
also need a compact representation of the existing independent signatures if they
are to meet the same budget. This does not prove a bound on all encodings and does
not change the selected five-minute exact-key authority or the acceptance target.

The negotiated CI run reader now uses the same range/member verifier as clones.
It groups a complete signed window before splitting download work; State and
recipe metadata keep individual grants, avoiding a re-sign call for a partial
metadata run. A 1,001-member materialization guard crosses the old 400-member
worker boundary with one ranged body GET and two source resolver calls. Corrupt
members, wrong ranges, expiry, partial runs and the legacy failure/drain path are
guarded. This step changes no stored format or State writer.

There is a remaining **packed-State coverage boundary**. A valid State can retain
one live blob from each of 29,000 different small-upload packs; each pack can also
contain a historical neighbour that is absent from that State. A pack's maximum
capacity does not bound how many packs its live members occupy. The guard now
constructs this State with all 29,000 file entries and resolves it with run signing
enabled. It still needs 29,002 grants including the two States, 11 resolver calls,
5,454,276 serialized DB B and 17,111,093 parsed reply B. The signature fields alone
are 928,064 B: 29,000 independent 32-byte blob signatures plus two State signatures.
Even signing the entire State at once cannot group different object keys.
Granting whole packs would include the non-State neighbour bytes. A physical
manifest can remove the descriptor reads, but cannot remove this signature floor.
These are synthetic resolver/signing observations, not executed body GETs or bills.

The lead accepted fragmented packed States alongside all-raw States in the named
one-time windowed fallback. Its check run publishes a source pack and the following
job takes that pack. The 100 KB / three-call target holds for compact packed States
(at most about 130 runs) and source-pack deltas of up to 300 changed paths. This
uses the existing source-pack publication; it adds no credential, service, repack
job, setting or user step.

The trusted source transport accepts an optional `statePhysical` pin beside the
State's generation and parents. It verifies the recipe root against its hash,
size and exact State, then verifies the requested digest-bucket chunks before
using any binding. Fixed digest buckets make a lookup of k distinct digests read
at most k + 1 chunks (including the root). Entries retain raw, pack-range and
recipe bindings in a compact binary encoding. Missing, corrupt or unavailable
manifests explicitly name the catalog fallback for the same requested digests;
ordinary body hash, size and exact-range checks still apply. The cache belongs to
one authorized action. This reader-first stage writes no manifest; catalogs and
legacy external readers remain until the later writer and signer rollout.
It merges the new lookup into the existing worker transport without a new RPC,
table, public error, agent action or CLI command. Codec exports are shared with
the subsequent writer and the format guards; no parallel source protocol is added.

`tests/hosted-actions-runs-scale.test.mjs` measures the shared run signer in fresh
Node processes at 29k and 100k files (one sample per shape). It includes the whole
State-sized descriptor and packed-member arrays; it excludes future manifest
fetching, State parsing and access checks. It is core memory evidence only, not a
measurement of the unimplemented State/manifest signer or a peak-memory gain.
The fixture asserts 29/100 grants for 29k/100k members in 1,000-member packs, and
29,000 grants for the fragmented 29k shape; no body bytes or live requests run.
Full signer memory, imported-project run counts, billing and byte placement remain
unverified, and no writer setting is enabled.

**Fetch and verify.** Unchanged in substance. Each State is hashed against its pin; the
manifest is hashed against the pin stored beside the State before the signer or a reader
uses it; every object is hashed and sized against the State, whichever pack, run or raw
key supplied it; a ranged reply must carry the exact `content-range`
(`verifyPackRange`); the final tree is hashed file by file. A wrong binding can therefore
never supply different source. It could widen a run, which is why only the trusted
source step writes manifests and the signer checks the chunk hashes first.

**Legacy seeding.** A State write extends the manifest of an input that has one: the
parent for a save, main's side for a sync or compose. With no such input it writes no
manifest and never scans (asserted O(changed files)); readers of that State use the
catalog and say so. The first manifest of a project is a separate **seed step** inside
the first compose that meets a main without one. It reads the catalog once in digest
order, the bulk pass dense pages are good at (2.1 MB in 11 windows at 29k, measured on
the fixture), writes the manifest and pins it on that main State. The output is
deterministic and keyed by the State pin, so racing composes agree and a retry
reconciles. Every later accepted State descends from a compose that extended it, so the
step runs once per project and not on ordinary State writes: this is the slice's one
budgeted one-shot. It needs no user step, covers imports, client seeds and existing
projects alike, and costs nothing while a project is idle. An open Lane picks the
manifest up at its next sync.

**Size bounds.** The encoding must meet three budgets at 29k files, each a ratchet in the
guard: a reader fetches a whole manifest with at most 64 grants; a State write that
changes up to 8 files uploads at most 150 KB of manifest in at most 4 PUTs; a lookup of
k digests reads at most k + 1 chunks. The [metadata layout](#s5-metadata-layout) makes all
three hold after any history and restates the upload budget above 29k files. The PUTs count
against the S7 Class A ratchet of 80 a landing. The signer streams verified buckets into physical interval groups for `all`.
A paired fresh-process fixture including identical fixture construction, current
run authorization, R2 manifest fetch and signing observes peak RSS of 386,236,416 B
versus 600,375,296 B for the catalog path at 29k files, and 534,364,160 B versus
796,999,680 B at 100k (one sample per path). This is a full handler/process guard,
not isolated deployed action memory or billed usage; those remain unmeasured.
The `source.state` and `source-state` capabilities advertise these readers; negotiated
State bootstrap descriptors carry the trusted physical root pin. The writer remains
default-off, and catalog retirement and old-client enforcement remain open. Run
count grows with the files changed since they were packed, at worst one per file, and
the source pack is the compaction that resets it. Trees over the pack bounds (300 MiB
packed, 1 GiB, 32 MiB a file) have no pack and read by runs alone; a segmented pack for
them is outside S5.

**Long-history qualification.** The compact-parent writer fixture does not prove
these bounds for an arbitrary metadata history. A 29k-file parent with 1,024
independent metadata packs has a 107,305 B FPR1 root. Eight replacements across
16 buckets read 16 chunks and eight new descriptors, but upload 154,126 B in two
PUTs (106,821 B child root), exceeding 150,000 B. The same probe compares two
reader-first candidates:

| Root candidate | Parent root B | Child root B | Changed pack + root B | Child metadata grants, including root |
| --- | ---: | ---: | ---: | ---: |
| Optional fingerprints (FPR2) | 76,585 | 76,086 | 123,391 | 1,010 |
| FPR1 gzip envelope (four-byte tag + gzip) | 100,976 | 100,400 | 147,705 | 1,010 |

The optional-fingerprint reader is implemented; its greater byte headroom avoids
a compression dependency. Readers verify every exact chunk hash/size without
requiring a membership fingerprint. A future writer must use verified parent-State
membership to decide which buckets can be shared, preserving O(changed) reads.
Runtime writers still emit FPR1, so the 150 KB writer qualification is **unmet**.
FPM2 readers also represent raw/pack maintenance nonces and retain the exact key
through signing, downloads and cache selection; no arbitrary object key is accepted.

Neither root candidate changes the 1,009 remaining metadata keys after the edit.
With the current immutable-chunk copy primitive, packing enough old keys into one
to reach 64 whole-plan grants requires moving at least 946 chunks / 1,870,911 B
before the 47,305 B changed pack or root. This is evidence against root-only and
one-write repack fixes, not an impossibility proof for a redesigned layout.
`physical-manifest-v2.test.mjs` guards all 1,024 chunks, k+1 point reads and the
unchanged refusal to produce an oversized grant plan. It does **not** count that
refusal as satisfying the whole-plan or writer bounds. The continuation chosen at
this point (FPR2, a one-time fragmented-metadata rebuild at compose, and size-tiered
packs merged only at compose) failed for the reason below. FPR2 stays; the rebuild and
the merges are replaced by the [metadata layout](#s5-metadata-layout).
These are synthetic body/signing measurements, not billed usage or live latency.
The full runtime still keeps complete descriptor fallback and the writer off.

**Ranges versus keys between composes.** Limiting metadata keys does not limit
exact grants. Replacing a bucket leaves a hole in its old immutable pack; runs on
either side must remain separate to exclude obsolete buckets. A 29k-file fixture
starts with all 1,024 buckets in one compact pack (two grants including the root).
Four consecutive eight-file saves, without compose, produce:

| Save | Metadata keys | Exact grants including root | FPR2 candidate upload B |
| --- | ---: | ---: | ---: |
| 1 | 2 | 18 | 72,894 |
| 2 | 3 | 35 | 74,648 |
| 3 | 4 | 50 | 75,898 |
| 4 | 5 | 66 | 76,491 |

`physical-manifest-history.test.mjs` reproduces the range counts through the
existing writer, emits equivalent fingerprint-free FPR2 roots, and exercises the
real signer. It verifies all 29k current members, absence of removed members,
all 1,024 buckets and refusal of the fourth plan. That refusal is a correctness
guard, **not** satisfaction of the 64-grant writer target.

A separate 2,000-save exploratory FPR2 candidate compares supplied parent-State
membership, reads only changed buckets and adds one metadata pack per write.
It starts from the 29k / 1,024-pack shape, rebuilds verified metadata once into
one pack (2,125,616 B including root, two PUTs, zero catalog reads), and then
allows no compose merges during the ordinary-save chain. Maximum ordinary
upload is 87,259 B / two PUTs, eight descriptor reads and 16 bucket reads;
maximum grants are 587 from at most 236 keys. The first failure is the fourth
save above. Rebuild bytes are counted separately; merge bytes are zero because
no compose occurs. This is a local prototype, not the runtime writer or billed
qualification. Peak process RSS is 459,259,904 B for that single exploratory run.

Compose-only tier merges cannot repair an allowed save-only chain, even when
the fourth new pack fills a tier. No layout can: a save replaces buckets chosen by
content hash, so every eight-file save leaves 16 new holes wherever the old buckets
sit. The [metadata layout](#s5-metadata-layout) settles which of the three demands
gives way (exact metadata ranges) and why.

**Rollout order.** Expand, then contract, one landing each.

1. Guards only: add a pack-shaped 29k fixture and a pack-present 29k fixture to the cold
   job guard, and record today's calls, DB bytes, grants and reply bytes for both.
2. Readers: runners use the run reader clones already have; the CI resolver signs runs
   for runners that advertise the capability (the existing Actions capability list).
   This alone cuts grants on packed States, with no stored format change.
3. Readers accept a pinned manifest or the catalog, and log which one served them.
4. Metadata plan: the signer grants one covering range per metadata key
   ([metadata layout](#s5-metadata-layout), builder lines 1 to 3). Readers already on main
   accept it unchanged. Then the writer behind its default-off project setting: the seed
   step, then capped-pack writes (builder lines 4 to 9). Two landings, plan first.
5. Signer reads the manifest for pinned States; a missing or invalid one falls back to
   the catalog and says so. The lead enables it on dev and reads billed usage and byte
   placement.
6. Contract: manifest-bound projects stop writing descriptor rows for new blobs, point
   rows are reshaped for the 1 KB lookup, and runners and clients without the capability
   get `CLI_UPGRADE_REQUIRED`. The same contract closes the runner's any-digest resolver
   (a security condition of the metadata layout) and keeps every metadata pack that a
   retained State root names.

**Guards that change.** The cold job guard in `tests/hosted-actions-direct.test.mjs`
keeps today's raw fixture as the named one-time fallback ratchet and gains the two
shapes with the 100 KB and 3-call bounds. New: a refusal test for a digest outside the
selected State; an O(changed files) descriptor-read assertion on save, sync and compose
with the seed step counted apart and at most once per State; the three manifest budgets.
Unchanged: the presigner key and header binding, the source pack reservation bounds,
hash and size checks, idle zero. No table, public error code, agent action or CLI
command is added: the pin lives in a slim row beside the State's generation and parents,
and the setting and capability reuse the existing mechanisms. **Merges:** the CI resolver's
per-member signing into the run signer clients already use. **Removes,** at step 6: the
O(files) grant reply for packed States and descriptor rows for new blobs.
The metadata layout changes two guards and adds one: `physical-manifest-history.test.mjs`
stops refusing the fourth save's plan and expects 6 grants; `physical-manifest-v2.test.mjs`
keeps refusing the 1,024-key root; a new 2,000-save chain guard asserts builder line 10.

#### S5 metadata layout

**Decision.** Two rules, and no stored-format change: FPR2 roots and FPM1/FPM2 buckets stay as the readers on main parse them.

1. **Writer: capped packs.** A State's manifest names at most 63 metadata packs. A write puts its changed buckets into one new pack, as today. When the parent's surviving packs plus the new one would exceed 63, the pack that holds the fewest live bytes moves its live buckets, byte for byte, into the new pack and leaves the root. Among 63 packs the emptiest holds at most one 63rd of the manifest, so the carry is bounded on every write. There is no rebuild, no merge step and no dependence on compose: a save-only chain of any length stays inside the bounds.
2. **Grants: one range per pack.** A whole read gets the root plus one signed range per metadata pack, from its first live bucket to its last: at most 64 grants after any history. Such a range can include superseded buckets that lie between live ones. File contents keep exact ranges.

**Why one demand had to give.** Buckets are chosen by content hash, so an eight-file save replaces 16 buckets spread evenly over the manifest and leaves 16 holes wherever the old ones sit. Exact ranges, at most 64 grants and writes in proportion to the change cannot all hold on immutable objects:

- Exact ranges and 64 grants: the manifest must be rewritten every fourth save (measured: 18, 35, 50, 66 grants). That is about 590 KB a save at 29k files with a 2.1 MB write every fourth save (modelled from the measured 2,125,616 B rebuild and 75 KB ordinary write).
- Exact ranges and small writes: 476 exact grants on the ordinary chain below and 535 on the stress mix (measured), 1,025 at worst. At 273 B a grant that is 130 to 280 KB of reply, over the 100 KB reply bound, and one R2 read each.
- Small writes and 64 grants: this decision. The price is that a reader of a State also receives superseded bucket lists of that State's own ancestors.

**The bounds after this decision.**

| Bound | Verdict | Basis |
| --- | --- | --- |
| No content grant covers a byte outside the selected State | Kept, unchanged | It is the security line. File bodies are what must not leak. |
| Exact ranges for manifest metadata | Replaced: a metadata grant stays inside the packs named by the selected root, between the first and last live bucket of each | See the security verdict. A bucket holds digests, sizes and storage positions, never a path or a content byte. |
| At most 64 grants for a whole read | Kept, now by construction (63 packs and the root) | A grant is about 273 B of reply and one Class B read: 64 are about 17.5 KB and $0.000023. |
| At most 150 KB uploaded for an 8-file save | Kept at 29k files for every write. Above that it becomes a formula: root, plus the changed buckets, plus one 63rd of the manifest | The cost is Convex egress on the PUT ($0.12 per GB; R2 ingress is free): 150 KB is $0.000018. With 1,024 buckets no layout meets 150 KB at 100k files: 16 buckets and the root alone are 155,086 B (measured mean with no carry). |
| At most 4 PUTs a State write | Kept | 2 measured; one more only per 16 MiB of new pack. |
| k + 1 chunk reads for k digests | Kept | The format is unchanged. |
| Writes read O(changed files), no descriptor scan | Kept | Carried buckets are copied from hash-checked parent chunks: 8 descriptor reads for 8 new files (measured). |
| At most 5 descriptor calls a landing; cold job under 100 KB in at most 3 calls; Convex grows only with open work | Kept, untouched | No Convex call, row or read is added; idle stays zero. |

**Measured.** A private prototype of the writer runs on the accepted codecs, and every 100th State is read back whole through the accepted client reader (`downloadPhysicalManifest`) with one covering grant per pack: every member present, removed members absent. Fixtures are synthetic and the object store is in memory. These are body and count measurements, not billed usage or latency.

| Chain | Writes | Grants, every write | Upload per 8-file save | Carry | Whole read | Exact ranges would need |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 29k files from a seed, 8-file saves, no compose | 2,000 | at most 64 | max 100,592 B, mean 93,482 B, 2 PUTs | mean 17,059 B, max 20,916 B | at most 64 reads; 3.1 MB steady, 5.0 MB at peak | up to 476 |
| 29k files from the 1,024-pack shape | 2,000 | at most 64 from write 43 | max 138,918 B | max 33,041 B | 3.4 MB at peak | 984 at the start |
| 29k files, stress mix (1 to 29,000 files a write; adds, deletes, renames) | 2,000 | at most 63 | max 79,391 B (8-file saves) | none needed | 9.5 MB at peak | up to 535 |
| 29k files, nonce bindings in every bucket | 400 | at most 64 | max 94,401 B | max 18,430 B | 4.5 MB at peak | up to 476 |
| 100k files from a seed, 8-file saves | 2,000 | at most 64 | max 234,473 B, mean 214,964 B, 2 PUTs | mean 59,303 B, max 73,762 B | 11.1 MB mean, 17.0 MB at peak | up to 475 |
| 100k files, stress mix | 1,000 | at most 58 | mean 155,086 B, max 163,853 B | none needed | 33.0 MB at peak | up to 492 |

- Seed (the existing one-shot): 2,125,616 B at 29k and 7,215,275 B at 100k, 2 PUTs.
- No write exceeded root plus changed buckets plus one 63rd of the parent manifest, in any chain.
- Per save the writer reads the root, 16 changed buckets and at most 11 carried ones: at most 18 R2 reads. With today's whole-key reads that is 0.97 MB a save on average at 29k (2.9 MB at most) and 3.2 MB at 100k (10.0 MB at most); with ranged reads it would be 0.24 MB and 0.72 MB. R2 does not charge for these bytes.
- The whole-read peak is the seed pack draining: it is 2.4 times the live manifest until the seed pack empties (about save 300 at 29k), then about 1.5 times. The stress mix reached 4.5 times. This multiple has no hard cap; see unverified.
- The 1,024-pack shape exists only as output of the earlier default-off writer. It converges with the same rule and budget, with no rebuild. Until write 43 its plans are refused and take the named fallback, as today. Its worst single write, the earlier probe's 16 largest buckets, uploads 155,243 B once (a 76,585 B parent root); every other write in that chain is under 150,000 B.

**Cost (modelled at list prices, three State writes a landing: save, sync, compose).**

| | 29k files | 100k files |
| --- | ---: | ---: |
| Upload per State write (measured mean) | 93,482 B | 214,964 B |
| Convex egress per landing | $0.000034, 1.7% of the $0.002 target | $0.000077, 3.9% |
| Of which the carry | $0.000006 | $0.000021 |
| R2 per State write | 2 Class A ($0.000009), at most 18 Class B ($0.0000065) | the same |
| R2 storage added per 1,000 landings | 0.28 GB, $0.0042 a month | 0.64 GB, $0.0097 a month |
| Cold whole read (no source pack) | at most 64 Class B ($0.000023), about 17.5 KB of grants, 3.1 to 5.0 MB from R2 | the same counts, 11 to 17 MB from R2 |

Convex calls, rows and DB reads added on the healthy landing path: zero. Idle: zero.

**Security verdict: acceptable, with five conditions.**

What a superseded bucket holds: for about 28 files at 29k, the SHA-256 of each file's content, its size and where its bytes are stored (pack digest and offset, recipe hash, maintenance nonce). No path and no content.

Whose buckets: only those of States in the selected State's own manifest lineage, the chain of manifests it was extended from. The writer reuses or copies only chunks of the one parent root it extends, after checking their hashes. Sync and compose extend main's side, so a Lane's intermediate saves never enter the lineage of an accepted State.

Who receives them: readers who are already granted the whole selected State. A client with project access can already read every registered State and sign any committed digest of the project (`signDownloads`), so it learns nothing new. A runner is limited to its run's States, so it does learn something new: digests, sizes and positions of files that main held earlier and the run's States no longer hold. The State-bound signer still refuses to sign those digests. This is narrower than Git hosting practice, where any reader can fetch any reachable object and a pack carries unrelated history.

Per-path trust (Issue 7f085ec9) is a landing-gate score per path and actor, not a read permission, so it adds no reader who sees part of a State. If path-scoped reading ever exists, that reader cannot be given the manifest at all, with or without superseded buckets: the live buckets already list every file's digest and size.

Conditions, each asserted by a test:

1. Content grants stay exact (the existing refusal test, unchanged).
2. A metadata plan names only keys in the selected root, one range per key, never starting before the first live bucket or ending after the last, and is refused above 64 grants.
3. Lineage: a file saved in a Lane and removed before landing appears in no pack reachable from an accepted State.
4. Readers parse only root-listed chunks, each checked against its hash; bytes between them are never decoded (existing behaviour).
5. A reader not entitled to the whole selected State receives no metadata plan; it is served per digest by the server.

The security assessment (Issue a31ea521) must check:

- The runner's any-digest resolver (`projectHostedActionsSource:resolve`). While it exists, a runner that learns an old digest can fetch that file. Stage 6 closes it; until then the exposure is the resolver's, not the layout's, but the layout supplies digests.
- Purge, redaction or expiry. Whenever an ancestor State or a file becomes unreadable to readers of its descendants, the metadata packs written for it must be rewritten or retired too, superseded buckets included.
- A content digest as a guessing oracle for low-entropy files that were removed.
- Lineage isolation across Lanes, Candidates and imports; and on public projects, that nothing member-only sits in a public State's lineage.
- That a storage position or nonce in a bucket grants nothing without a signature.
- Bucket stuffing: a writer can choose file contents whose digests fall in chosen buckets and make those buckets, and so that project's own writes, large (measured: up to 936,695 B a save after 2,000 aimed saves). It cannot raise the grant count.

If the assessment wants no readable superseded byte at all, the upgrade is to encrypt each bucket under a key derived from its content and carried in the root. The layout and the grant count stay as decided; it needs a new format version and readers first.

**Rejected.**

- Exact metadata ranges with a rewrite when ranges pass 64: about 590 KB a save at 29k, six times this design, with a 2.1 MB write every fourth save (modelled).
- Exact metadata ranges with a higher grant bound: 476 to 1,025 grants, 130 to 280 KB of reply and as many R2 reads.
- Size-tiered packs merged only at compose (the earlier continuation): fails on the fourth save of a save-only chain (measured).
- Fold everything every 62 writes, as Delta Lake checkpoints do: about 34 KB a save on average against 17 KB here, and a 2.1 MB write at 29k or 7.2 MB at 100k on every 62nd save (modelled).
- Size-tiered merges on every write, factor 4: about 13 keys, but about 88 KB of merge bytes a save against 17 KB here (modelled).
- A rolling sweep by pack age: needs the age in the root, so a new format and a reader stage, and carries the full 33 KB on every write.
- A cap of 32 packs: 121,990 B a save on average against 93,482 B (measured); it buys fewer reads on a rare path with more bytes on every write.
- A second writer rule that also evacuates packs by dead bytes: 2.25 against 2.40 times at peak for a 112,044 B worst write (measured). Not worth a second rule.
- Prolly trees, Merkle search trees, HAMTs: O(log n) node writes, but a whole read is one grant per node and a lookup is one read per level; new format.
- One exact per-State snapshot object written on a cold read: a write on a read path, 2.1 MB (29k) or 7.2 MB (100k) of Convex egress per cold State, and a new object class to clean up.
- The whole manifest rewritten on every save: one exact object and one grant, at 2.1 MB a save at 29k, 22 times the bytes.
- Server-side compaction by multipart copy: parts must be megabytes; buckets are 2 to 7 KB (documented S3 limit, not tested on R2).
- Scoped credentials, a Worker in front of R2 or signed cookies: rejected in [bulk read grants](#s5-bulk-read-grants); nothing here changes that.

**Builder lines.** No design choice is left open.

1. Constants: at most 63 metadata keys in a root; a metadata pack is at most 16 MiB (`packRunMaxBytes`).
2. Plan, first landing. In `stateSourceReader.plan`, replace `physicalRuns(reader.root.chunks)` with covering runs: group the root's chunks by exact key (`physicalKey` of the pack digest and nonce, or of the chunk itself when it is its own object); emit one run per key from the lowest chunk offset to the highest chunk end, with the key's total size; a chunk that is its own object stays a raw run. Keep the refusal when runs plus the root exceed 64. Body runs still come from `physicalRuns` and stay exact. No client, runner, format or capability change: `downloadPhysicalManifest` already accepts these runs.
3. Plan tests. `physical-manifest-history.test.mjs` expects 3, 4, 5 and 6 grants for its four saves and reads all members through `downloadPhysicalManifest`. `physical-manifest-v2.test.mjs` keeps refusing the 1,024-key root. Add security conditions 2 and 5 as refusal tests.
4. Writer, second landing, behind the existing default-off setting. Inputs are the verified parent-State membership and the new membership. A bucket is changed when its sorted member digests differ; every other bucket reuses the parent's chunk pin as it is. Roots carry no membership fingerprints (FPR2). An FPR1 parent is extended the same way.
5. Changed buckets are built as today: parent bindings for surviving members, descriptors only for digests the parent lacks, and a missing descriptor skips the writer as today.
6. Carry. Group the unchanged parent chunks by exact key; a key's live bytes are the sum of its chunk sizes. The budget is the sum of all parent chunk sizes divided by 63, rounded up. While the remaining parent keys plus one exceed 63 (the one is the new pack; it counts when the write has a changed bucket or the parent already has more than 63 keys): take the key with the fewest live bytes, ties by smaller key string; stop if the carried bytes plus its live bytes exceed the budget; otherwise read its live chunks, check each hash, add them unchanged to the new pack and drop the key from the root.
7. New pack: changed and carried chunks concatenated in bucket order, split only at 16 MiB. A write with no changed bucket and a parent within the cap writes the root alone.
8. Seed: no parent, every bucket, the same pack rule. A parent with more than 63 keys uses the same loop and budget; it needs no rebuild step and no compose.
9. Determinism: the output depends only on the parent root, the two memberships and the bindings, so a retry or a racing compose writes identical bytes.
10. Guard, build-failing, one file. 2,000 eight-file saves at 29k from a seed with no compose: every write at most 64 grants under line 2, at most 150,000 B, 2 PUTs and 8 descriptor reads; every 100th State read whole through the client reader, every member present, removed members absent. The 1,024-key parent: at most 64 grants from write 43, and every write within root plus changed buckets plus the budget. 300 saves at 100k: at most 64 grants, every write within the same formula. Security condition 3 as its own case.
11. Stage 5 is unchanged: the setting stays off until the lead enables it on dev and reads billed egress, R2 operations by class and byte placement.
12. Stage 6 keeps its inventory and adds three lines: close or State-bind the runner's any-digest resolver; treat a metadata pack as live while any retained State root names it, in cleanup, export and restore, and copy it whole; drop the rebuild, the merge cap and the amortized merge budget from the qualification list.

**Removes.** The compose rebuild, the size-tiered merges and their cap (decided earlier, never built); exact-range planning for metadata and its refusal on ordinary chains.

**Unverified.** Billed egress, R2 operations and latency; action memory in a deployed isolate; a hard cap on whole-read bytes (measured 2.4 times live on ordinary chains and 4.5 on the stress mix; if one is wanted it is a writer-only rule with no format or reader change); metadata packs stored under nonce keys (the prototype covers nonce bindings inside buckets, not nonce-keyed metadata packs); real imported projects; the multipart-copy limit on R2.

### S6. One source job per landing attempt

Only if S0 shows save, sync and compose run as separate Node actions for most landings. Fuse them into one job that reads the base once and uploads each new chunk once.

Done when: Node actions per landing fall to at most 3 on the smoke shape; the three States are bit-identical to the three-job path on every existing source fixture; time to main is not worse. Removes: two action cold starts, their repeated manifest reads and progress uploads per landing.

### S7. R2 operation budget

Add Class A and Class B requests per landing to the cost ledger and the smoke report, with a ratchet. Batch the CI result inbox to one object per shard.

Done when: the ledger's Class A per landing is at most 80 on the smoke shape and a check fails if it rises; a twelve-shard batch makes at most 14 Class A requests (38 today). The lead amended the original 13-request assumption to retain one election marker and early required-job completion (Issue comment f0582383); discovery uses HEAD rather than LIST. Removes: about two thirds of the CI inbox writes.

### S8. Byte plane beside R2 (owner decision; adds $5 a month)

**S8a result: the kill stands; Option B is closed with no retry.** The [local spike](workers-source-step-spike.md) ran the unchanged source step in workerd on one 29k sibling compose and read 102.74 MB of used isolate memory at a checkpoint (measured; gate 100 MB; output pin equal). No provider or service is enabled; timing and billed cost stay unmeasured.

- **Why a cleaner measurement would not change it.** The reading was taken under the inspector with no forced collection, so it may overstate live memory; it is also a lower bound on the peak, on a short-path fixture. The job added about 69 MB to the 34 MB held at the first checkpoint, seven times the bytes it read, because every State is parsed and rebuilt whole. Scaled by bytes read, a 29k State with deep paths (4.70 MB against this fixture's 3.31 MB) needs about 132 MB and a 29k conflict sync about 230 MB (modelled), and the 128 MB limit is per isolate, shared by concurrent requests. Only a streaming State reader and writer closes that gap. That is a rewrite of the trusted merge core, and done for the Worker alone it forks the one module both providers must run identically.
- **The upload bytes are not the reason.** The spike adapter wrote raw States (3.31 MB) where the provider writes the bounded recipe encoding (0.74 MB). A Worker pays no egress, but kept forever the raw form costs more than all of A's retained storage (modelled), so any future provider must match the provider's physical encoding.
- **Reopen when both are true.** (1) The shared source step handles a 29k State in memory proportional to the change, shown on the Convex provider's own scale harness for save, sync, conflict sync and compose. (2) Measured source-step action compute passes 150 GB-hours in a month (60% of the plan's included 250), or S0 attributes most of the step's wall time to R2 round trips that S6 cannot remove. Then S8a reruns with the same kill rule plus the deep-path, conflict and two-concurrent-job 29k shapes. Option C's Worker compute depends on the same first condition.
- **What carries over to A.** S0's wall-time split of the source step now decides the action-compute line B was modelled to cut (about 6 s billed against a 0.35 to 0.66 s handler). S6 must not raise peak memory when it fuses jobs.

The slice as proposed:

- **S8a, spike, no production path.** Run the existing source step in the Workers runtime with an R2 binding on the 4k, 12k and 29k fixtures and one larger synthetic tree. Report peak memory against 128 MB, CPU milliseconds, wall time and R2 requests, and prove output pins equal the Convex provider's. Kill rule: any 29k fixture over 100 MB, or any differing pin, ends the option.
- **S8b, provider.** An optional source provider beside the Convex one. A Convex action sends a signed grant naming exact input pins; the Worker reads and writes content-addressed objects and returns pins; the same commit reducer publishes. The job records its provider; an over-limit job runs on the Convex provider under a recorded reason, never silently. One contract suite runs both providers.

Done when: egress per landing is at most 0.5 MB and action compute at most 4 GB-seconds on the smoke shape; time to main is no worse and the measured gain is stated; a deployment without the Worker passes the same suite. Removes: source progress objects and the fan-out pool on the Worker path; nothing on self-hosted deployments.

## Decisions needed from the owner

1. **The rule.** Adopt "Convex grows with open work, never with repository size or history length" (rules 2 to 4), with history moved to verified R2 objects and nothing deleted.
2. **The option.** A now; B's spike after S0; C not now, with the three triggers above.
3. **Grace before a landing's rows are packed.** Seven days after terminal, matching the callback window, or sooner.
4. **$5 a month for Workers Paid** if the spike passes and B goes ahead. It is a new paid service on the hosted deployment only.
5. **What the $2 target includes.** Proposed: Convex operations, R2 operations and amortized recurring maintenance per 1,000 landings, with retained storage reported beside it as dollars per 1,000 landings per month kept.
6. **Advisory logs.** Whether `projectCoordinationEvents`, `agentEvents` and `clientErrors` get a bounded window like the board. Retention is the owner's call; this review did not size them.
7. **S0's two live reads.** A write test of under 5 MB on dev, and one reading of the bucket's request metrics by class, which only the account dashboard shows.

## Measured, modelled, unknown

**Measured, from the repo docs and Issues**

- Pre-fix smoke: $8.94 per 1,000 landings at list; source step 70 calls, 146 MB egress, 0.062 GB-hours; CI resolver 549 calls, 90 MB; source-object lookups 414 calls, 14.5 MB.
- Dashboard storage 21.47 GB before cleanup; three exports read 3.94 GB.
- Storage fixture per table, fresh and dogfood-shaped; dev inventory counts and sample means.
- Fixture effects of the landed fixes (State upload 3.31 to 0.74 MB; cold CI reads 10.23 to 2.11 MB).
- R2: 1,060 requests per landing in one dev window, whole bucket.
- I/O per source commit (240 KB) and per finish step (121 KB) in one dev window.
- Published prices and limits.

**Modelled, in this review**

- The class split of the smoke's $8.94, and every "today", A, B and C vector.
- One storage copy per index applied to fixture bytes; all monthly bills; all savings.
- R2 Class A and B split; the 80 and 600 targets.
- Capsule and segment sizes, backfill I/O and writer cost.
- Option C, built on the earlier estimate in cost architecture options plus source compute.

**Unknown**

- The post-fix billed smoke and its per-function split.
- Billed bytes per patch of an indexed document.
- Billed bytes of descriptor point lookups, stored and absent, on a catalog-backed repository of 29k files.
- Source steps per landing by kind; how the egress divides between State, progress and result bodies.
- R2 requests by class and caller; whether backup generation is also billed as egress.
- The post-cleanup dashboard; why the dashboard is about twice the one-copy-per-index model.
- Source-step memory, CPU and wall time in a Worker; R2 latency from a Worker.
- Client-side file-list derivation time at 29k files.
- Cost per landing at 4k files after the fixes.
- Retention and size of coordination events, agent events and client errors.

## Pricing sources

- Convex: [pricing](https://www.convex.dev/pricing) and [limits](https://docs.convex.dev/production/state/limits) (plan inclusions, overage rates, index storage, action memory).
- Cloudflare R2: [pricing](https://developers.cloudflare.com/r2/pricing/) ($0.015 per GB-month, $4.50 per million Class A, $0.36 per million Class B, free egress and deletes; a refused PUT is still a Class A request).
- Cloudflare Workers: [pricing](https://developers.cloudflare.com/workers/platform/pricing/) and [limits](https://developers.cloudflare.com/workers/platform/limits/) ($5 a month with 10 million requests and 30 million CPU-ms; then $0.30 per million requests and $0.02 per million CPU-ms; no egress or duration charge; 128 MB per isolate).
- Cloudflare Durable Objects: [pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) ($0.15 per million requests, $12.50 per million GB-seconds, SQLite rows $0.001 per million read and $1 per million written, $0.20 per GB-month).
- Cloudflare Queues: [pricing](https://developers.cloudflare.com/queues/platform/pricing/) ($0.40 per million operations, about three per message).
- Cloudflare Containers: [pricing](https://developers.cloudflare.com/containers/pricing/) (memory $0.0000025 per GiB-second, CPU $0.00002 per vCPU-second, egress $0.025 per GB after 1 TB).

Evidence Issues: storage [8c4f126b](https://nanthai-forge-dev.netlify.app/?project=mh7aafndrxmj8c2q0931zbjk2n8h4ffs&projectTab=planning&planningItem=8c4f126b-0c04-492e-a66a-aabc6acd4981), cost [298f9675](https://nanthai-forge-dev.netlify.app/?project=mh7aafndrxmj8c2q0931zbjk2n8h4ffs&projectTab=planning&planningItem=298f9675-b8ad-49d6-96c3-07d94e5f9ebd), main-race waste [1018d0f8](https://nanthai-forge-dev.netlify.app/?project=mh7aafndrxmj8c2q0931zbjk2n8h4ffs&projectTab=planning&planningItem=1018d0f8-7745-447b-8e83-b2b502bc25fc) and the cross-repository suite [70a9bd2f](https://nanthai-forge-dev.netlify.app/?project=mh7aafndrxmj8c2q0931zbjk2n8h4ffs&projectTab=planning&planningItem=70a9bd2f-f741-4d26-8ae5-7bb11148a17c). Table inventory: [data placement](../data-placement.md).
