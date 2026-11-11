# Placement review: Convex, R2 and a third stack

Independent architecture review for Issue [4c8dfe6a](https://nanthai-forge-dev.netlify.app/?project=mh7aafndrxmj8c2q0931zbjk2n8h4ffs&projectTab=planning&planningItem=4c8dfe6a-3511-4d01-a36b-1158c4e42c69), 11 November 2026. The owner's yardstick: Convex should (1) orchestrate CI and landing, (2) be the realtime message board for agents and (3) power the web app and a future iOS app. Is it doing more, and should it?

This page proposes; it decides nothing, except where a section says a contract is decided ([S3 report transport](#s3-report-transport), the [S8a result](#s8-byte-plane-beside-r2-owner-decision-adds-5-a-month)). No slice below was filed, approved or built when the review was written. It changes no retention rule, plan, service or product limit.

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
| `projectWorkDataRecords` | Per-file projections: `viewFiles`, source rows, payload pages | RT no; Tx no | Dev: about 136,000 rows in the frozen dogfood generation, 361.9 MB of documents after the split, 6 indexes: about 3.3 GB at one copy per index (measured bytes, modelled copies) | **Derive on demand or one R2 object per Candidate** (S4) | The largest remaining table. A Candidate's file list becomes one R2 GET instead of a paged subscription. Risk: generic record pages and source-return snapshots read these collections |
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

Decided for Issue 324f1d97; not built. The slice left one contract open: the status query returns every per-file report, queries and mutations cannot read R2, and shard restore replays report rows inside a mutation.

**Decision: the summary lives in Convex, the reports live in one R2 object, and report bytes never become rows.** A run's per-file reports are written once, by the party that already holds them, as one immutable object pinned by digest in the run header. A mutation gets what it needs as arguments; no transaction reads report bytes from the database. The raw result slots are not that object: they embed log bytes, and reading them needs the fold, which would freeze today's fold rules into every client and every later release.

**What stays in Convex per run**, bounded whatever the file count and however many files fail:

- verdict, pins, counts, timings, pool-pending names and `reportFlakes`, as today;
- `testFiles`: exact `total`, `failed` and `flaky` counts, and the failed and flaky lists in stable order with today's clipped first errors, shortened until `testFiles` is at most 8 KiB, the unlisted remainder counted;
- the five slowest files, so the `summary` query needs no reports;
- pass or fail and duration for each test the run's own semantic plan names: no more entries than the plan already holds;
- the pointer: the report digest (the same `checkPin` of the folded reports as today's `reportDigest`), byte size and file count. No key and no URL.

Guard: on the 20,000-file fixture the run row stays under 12 KiB when every file passes and when every file fails. The all-fail case is new. Read from the code, not run: today's unbounded `testFiles.failed` would take that row past the 1 MiB document limit.

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

**Restore and reuse.**

- *Verdict reuse* reads the header only: `verdictKey` and the reuse alias, as now.
- *Shard restore.* A run that ends by cancel, watchdog or provider conclusion keeps the reports its shards sent: the collector that terminal already schedules folds the slots present, attaches pointer and summary in one mutation, then cleans the inbox. No mutation replays report rows.
- *Semantic verdict, failure diagnosis, culprit failures, proof and the gate* read header fields.
- *Test timings* take durations as an argument of the settling mutation (paged above 768 KiB), which replaces the scheduled `record` mutation and its re-read. A run that waits for the provider's conclusion records timings at collection, under a stamp the header keeps for the gate's comparison.
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
legacy indexed Views remain readable. The planned writer uses a default-off
server environment setting, like S1's capsule writer, after the readers deploy.
There is no new settings table or user step.

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
and billed savings remain unverified while the old writer or flag remains.

### S5. State-bound physical manifest

The source step that writes a State also writes its physical manifest: digest to binding (raw key, pack range or recipe), stored as a recipe that shares unchanged chunks with the parent's manifest. CI, clones and the source worker read it with one signed grant instead of descriptor windows.

Done when: a cold 29k-file CI job reads under 100 KB from Convex in at most 3 calls (2,105,060 B and 11 today); source-worker descriptor calls per landing fall from about 41 to at most 5; no State write scans descriptors (reads are O(changed files), asserted); every object is still verified by hash and size; a missing or invalid manifest falls back to the catalog and says so; a point lookup of one digest, stored or not, reads at most about 1 KB on the guard's 402- and 1,387-descriptor fixtures once bulk readers use the manifest. Removes: descriptor rows for new blobs; the dense catalog pages for manifest-bound projects later. Risk: medium; this is the trusted incremental writer Issue 298f9675 left open.

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
