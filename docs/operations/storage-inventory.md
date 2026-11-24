# Database inventory and orphan rows

Inventory reads are explicit operator work. They add no subscriptions, timers or
idle calls. Predict the read budget before running them and capture provider
usage separately from document-size estimates. A database export reads the whole
database and is not an inventory shortcut.

`scripts/storage-inventory.mjs TABLE_NAMES_FILE PRIVATE_OUTPUT_DIRECTORY` runs on
the configured development deployment. Get the table names with `npx convex data
--deployment dev`. The script reads table counts from Convex's internal metadata
counter and samples one newest-first page per nonempty table, at most 128 rows
with a 256 KiB read threshold. A final document can exceed that threshold by up to
one maximum-size document. It records row kinds, serialized JSON bytes and field
sizes, excluding field contents. JSON sizes exclude database index overhead and
are estimates, not billed storage. The newest page is a sample, not a random
sample or a table-wide p95. Inspect older pages and important row kinds separately
before extrapolating. Outputs can identify internal schema fields and belong in
a private directory.

`projectStorageInventory:describe` lists indexed root ownership fields from the
schema: `projectId`, and Work-generation `generationId`/`partitionId` fields.
Nested generation references on import and receipt records are references rather
than ownership. They do not authorize removing the containing record.

`projectStorageInventory:owners` accepts `table`, `field` and `after` (initially
null). It seeks one row per distinct owner through an owner-first index, then
jumps past that owner's whole index range. Each call returns at most four owners
and rechecks each parent directly; continue with the returned `after` until
`isDone`. A page reads at most four sample documents and four parents, roughly
8 MiB at the maximum document size. The cost depends on distinct owners, not
retained payload rows. It returns sample sizes, never payloads.

Projects that still exist, including deleted tombstones with residue, use the
normal project lifecycle purge and its progress receipt. For a genuinely absent
project or Work-generation owner, `projectStorageInventory:purgeOrphans` removes
one exact page. Supply the selected ownership field, absent `ownerId`, an original
`operationId`, unique `part` and at most eight `{id, sha256}` pins. Hash the exact
JSON representation returned by a bounded readonly query; preserve its property
order. The mutation rechecks absent ownership and every row's owner and digest
before deleting anything. A changed pin refuses the transaction. Personal
guidance operations with an incidental project id remain personal data.

Orphan removal reuses the existing cleanup page receipts. Replay the entire
original request after an unknown outcome; its receipt returns the committed
counts without deleting the next page. Row deletion uses the same raw writer as
permanent project purge, cancels pending referenced tasks and removes exclusively
owned legacy files through the existing reference checks. Receipt bytes are kept;
the endpoint creates no new table or retention rule. Current project data,
reachable Git history, landing receipts, audit and planning are never selected
merely because they are old.

Confirm completion by rerunning the owner inventory and checking each affected
owner range is empty. Report actual provider read/write bytes separately from
deleted document bytes and R2 object bytes. Storage reclaimed from indexes is
not established by deleted JSON bytes.


## Index inventory and guard

`node scripts/convex-index-inventory.mjs > inventory.json` inventories every table,
its custom database/search indexes and fields, query source locations and chains,
and dynamically selected operational consumers. It parses source with TypeScript;
it never imports or executes repository modules and makes no Convex calls.
Database index prefixes are classified structurally as `prefix-redundant`; a
retained prefix carries its order-dependence reason in the report. Tables without
indexes remain in the table inventory.

The existing `tests/convex-schema-indexes.test.mjs` deployment contract runs in
landing verification. It rejects duplicate field sequences, indexes without a
query on their table, unresolved dynamic queries, and database prefixes without
an `index-order: caller: convex/file.ts#symbol; order: …` reason immediately before
their definition. The named symbol must query that table/index and the reason must
state its required creation-time ordering or time-window contract. It also checks that
the static inventory covers the entire deployed schema. There is no index-name
allowlist. New dynamic selectors need static analysis alongside their runtime
implementation; they cannot silently count a shared index name on another table.

A staged index (`.index(name, { fields, staged: true })`) backfills after the push
without blocking it and cannot be queried. The guard lists it as `staged`, accepts it
without a caller and fails any query on it. Ship a large-table index staged, then
remove the flag and add its caller in a later landing; that deploy enables the
backfilled index.

The finite selectors cover project purge registries, ownership seeks, the finish
read proxy, recovery benchmark selection and serialized sandbox queries in scripts.
Ownership and benchmark selection preserve schema declaration order. Prefix
reasons retain caller-required creation-time pagination, newest/oldest selections
and time windows. Purges, exhaustive cleanup and representative inventory samples
do not justify a prefix: their page order is incidental. They use longer indexes
with the same equality fields. Destructive scans keep their page bounds and delete
each selected row before repeating, so every nonempty iteration reduces the
remaining set; suffix order cannot strand a row. Total purge page counts may vary
with suffix order and differently sized rows; the existing row/byte bounds remain
unchanged. This one-time project-removal tradeoff does not justify an index write
on every landing. Recovery and benchmark scans
consume all pages and identify rows by identity, not by their page position. An unused index
has no consumer even through these operational paths.

The landing cost and storage fixtures count custom index entries for inserts and
updates, separately from removed entries. The ten-landing measurement extends the
existing six-landing controller mix with another batch of four, and separately
executes one real Actions export claim per check. The controller ledger still
excludes provider dispatch; export claims are reported separately rather than
silently folded into its call budget. Storage budgets also ratchet entries and
serialized JSON key payload bytes for fresh and dogfood-shaped fixtures, both
immediately and after maintenance. Key payloads include declared fields plus
creation time (normalized to zero) and document id. These are reproducible fixture
measurements, excluding system/search indexes and provider B-tree overhead; they
are not billed physical index storage. Live row counts come from the read-only
inventory above, and physical reclamation needs provider storage evidence.

### Item membership repair

New and reopened Lanes carry verified Item membership on their existing head. The explicit dev-only
repair follows verified successor IDs from each root, then fills Lane heads from their parent Intent.
It does not enable the staged index, change the selected readers or remove the start cap. Run
`projectItemLaneBackfill:run` with a project id and `after` (`null` initially), then use the returned
`next` until complete. Retrying a previously committed frontier returns the durable position. The
repair processes at most 62 steps in one transaction, with at most 192 reads, 132 ranges, 64 writes,
8 MiB read and 4 MiB patch payload. With Work metadata but no valid selected index, repair
certifies coverage only if two indexed reads in the checkpoint transaction find neither a hosted
Intent head nor a hosted Lane head. If either exists, repair refuses with `PROJECT_WORK_INDEX_MISSING`
and leaves coverage unchanged. It makes no R2 calls and schedules no idle work.

Before switching readers, drain the dev census `projectItemLaneBackfill:coverage`, passing its `next`
as `after`. Record that the sum of `covered` equals the sum of `checked` over all pages. Use returned
incomplete frontiers to resume; a partial repair does not qualify for the reader switch.

Item membership (`846c635b`) replaces the start-time Intent walk and the full Lane history's per-Intent
ranges after fill. `projectHostedRecordHeads.by_project_and_kind_and_item` adds one entry per current head,
including an undefined Item key on an unlinked head; it does not add a row per version or landing. No second
status index is needed. In isolation, the fresh retained index measure was 429 → 433 entries and 33,262 → 33,523
logical key bytes; dogfood retained was 29,314 → 29,320 and 2,189,966 → 2,190,369 bytes. Fresh and dogfood index
writes were 1,603 → 1,612 and 3,003 → 3,020. The P6 serving-I/O fixture's measured call, byte and R2 quantities
were unchanged by index enablement; modeled index key bytes are not a provider bill.

A linked Lane adds one Item key to its existing metadata, not a second document write. The explicit dev-only
membership repair verifies same-ID roots and follows deterministic successor keys, stopping at a foreign binding
or another Item's root. After repairing Intent heads it fills Lane heads from their parent, including Resolution
Lanes. `projectItemLaneBackfill:run` takes a project id and `after` (`null` initially), confirms the durable frontier,
and returns `next`; retry the same frontier after an unknown outcome. A transaction processes at most 62 steps,
with at most 192 reads, 132 ranges, 64 writes, 8 MiB read and 4 MiB patch payload. No idle jobs or R2 objects.
Before enabling index-only readers on a deployment, drain `projectItemLaneBackfill:coverage` and record every
non-removing project covered (`checked == covered` across all pages). An unfinished repair is not cutoff evidence.
In the 14-Intent fixture, start reads went from 22,134 to 5,325 bytes. A seven-Lane page over a 70-Lane Item read
21,954 bytes on the legacy reader and 11,383 after projection in the local fixture.

## Plan projection storage budget

The current partition's `_workStorePlan` collection shares `projectWorkDataRecords`; it is disposable metadata,
excluded from source-return snapshots, and covered by the existing generation/project purge inventory. There is no
new table or retention rule. [Plan budgets](../../tests/fixtures/plan-read-budget.json) cap the whole fixture's retained
page count and JSON bytes (32 pages/40 KB for 324 roots, 64 pages/80 KB for 648), independently of the read-byte budget. Both sizes cover dense positions and sparse positions shared through a generation alias.
`tests/plan-read-cost.test.mjs` checks both budgets and one final page write per transaction; these figures exclude
provider index/system storage. Canonical Item bodies, comments and history are not included in the projection.

Leaves cap at 128 rows and split sooner above 11 KB encoded payload. Indexed position ranges avoid sparse-window
fragmentation. Replacement first clears old leaves in 32-document/1 MB batches before reconstructing roots in
100-root/1 MB batches. One generation-local preparation control object (fixture budget 512 JSON bytes) holds
only ids/progress; it is removed on success, or retained as blocked until a relevant edit/retirement. Scheduled
task references follow the existing schema-derived purge inventory. No source bodies or new history are retained.

The `_workStorePlanCounts` row (one per partition, about 520 bytes plus at most 100 Initiative/parent visibility groups of 50 to 90 bytes; [data placement](../data-placement.md#planning-progress-counter))
shares the same table, purge inventory and snapshot exclusion. It adds one row per partition and no per-Item storage.

Plan authority and generation headers reuse `projectFinishReadRows`: one fixed row per active Work project, one companion per generation, with the existing project purge and generation deletion lifetime. Empty projects and removal tombstones retain no Plan project header. The Plan fixture caps their combined JSON storage at 4 KB for a project plus two generations. The landing storage ledger separates the fixed project header from per-landing growth and counts its nine index entries; no new table or retention period is added.

## History and capsule pin moves

There are two one-off operator runs for Item 411727ba. Neither has a scheduler, cron job or
idle call. Every page is one idempotent transaction. Run them on one deployment at a time,
after the code that writes the new layout is deployed. The placement record is
[fewer index copies](../data-placement.d/after/1600-fewer-index-copies.md).

**The stop rules use cumulative Convex billed I/O.** Between batches, sum
`usageStats.databaseIoReadBytes + databaseIoWriteBytes` from the deployment's
Convex Completion logs (or the [spend ledger](convex-spend.md)). Count the page
mutations, discovery reads and any retried or failed executions, once each.
Reconcile an unknown outcome before spending more. If coverage is incomplete,
pause; the function reply is not a substitute for billing data.

`budgetBytes` is a per-call estimate from selected document counters. It omits
index I/O and can cross its threshold by a final page. Start with a small batch
and use the observed billed I/O for that job to size the next batch. Reserve room
for a full final page; do not start or resume if the batch cannot fit under the
remaining billed stop. On dev, the capsule pin move reported 21.5 MB and billed
35.1 MB (1.63×); the history move reported 311 MB and billed 344.4 MB (1.11×).
These are observed ratios, not upper bounds: the now-retired overlap backfill
reported only read document bytes (20.5 MB) and billed 72.8 MB total (3.55×).

1. **Capsule pins (row 5).**
   - Stop at **0.05 GB billed** ($0.01). Start with one 32-row page, after
     confirming it fits the budget:
     `npx convex run projectLandingCapsulePinsMove:run '{"cursor":null,"pages":1,"budgetBytes":1000000}'`.
   - Resume with the returned `nextCursor` until `isDone` is true. A pointer that has
     already moved is skipped. Size later batches by `pages` and `budgetBytes`.
2. **Item history and Work events (row 3).**
   - Stop at **0.6 GB billed** ($0.12), including discovery and every partition.
   - List the partitions with `projectWorkRecordMigration:pending '{"cursor":null}'`, then
     follow `nextCursor` while the budget permits.
   - Start each partition with `npx convex run projectWorkRecordMigration:run '{"generationId":"…","operationId":"<fresh uuid>","cursor":null,"budgetBytes":1}'`.
     The positive one-byte threshold allows a nonempty page to finish but does not
     cap its I/O. The driver runs copy, then cutover, then cleanup, at most 100 pages per call.
   - To resume, pass the returned `cursor` and `cleanup` with the same `operationId`. A
     page whose reply was lost replays its stored receipt.
   - When the selected partition is cut over, its open list and search cursors fail
     WORK_STALE once.
   - Purges of a partition refuse with a retry message until its cleanup finishes.
   - Size later batches with `budgetBytes` from measured billed I/O. The reply's
     `deletedBytes` describes documents, not a separate charge to add to provider writes.

Before each run and a day after it, record:

- the dashboard sizes of `projectPlanningRecords`, `projectWorkRecords`,
  `projectWorkDataRecords`, `projectFinishReadRows` and `projectHostedLandingBodies`;
- the daily database I/O (GB read and written) and its cost at $0.20/GB;
- the cost per 1,000 landings for the same day, set against the phase baseline.

The moves are done when the sizes and the daily write I/O of those tables have dropped and the
cost per 1,000 landings has not risen.

## Item status timestamps

Record-store Item heads keep optional version-pinned `planningTimes`. The existing Item
write computes them without a history read. Planning list and detail read the pin only
when it matches the returned version. A missing or stale pin uses the bounded history
walk. Record-store list/detail queries that need this fallback log one
label-only `planning/history-fallback-missing` or `planning/history-fallback-stale` attribution
for the first fallback. No Item identifier or request data is logged: DEV query logs can reach
clients. Legacy projects and ranked search previews continue to use history; their intentional
history reads are not counted as record-store fallback.

A write that publishes or advances an Item head in record-store mode must derive a pin in the
same transaction, without a history read. A purge tombstone pins the intentional absence of
both dates. An exact-value refresh keeps a matching pin; a missing predecessor or unproved
pin leaves the write unapplied with `WORK_STALE`. Complete the backfill first, or stage
out-of-order copies in legacy/dual mode and then verify before exposing them. Switching a
staged project to record-store mode does not verify or backfill the old heads by itself;
keep the history fallback until the deployment's release verification is in place.

After deploying the writer, an authorized operator can fill older heads in one
record-store project at a time. Estimate for the dogfood project: **40 MB**;
stop at **150 MB cumulative billed reads plus writes** ($0.03), including verification
and retries. No new tables, indexes, R2 bodies, jobs or idle calls. Start with one page:

```sh
npx convex run projectPlanningTimesBackfill:run '{"projectId":"…","cursor":null,"pages":1,"budgetBytes":12582912}'
```

Each page reads up to five heads in Item-key order. A long history returns a `headCursor`
after a roughly 384 KiB window (an individual document can cross that target). The cursor
holds authenticated version references, not status timestamps or Item text. The next page resumes
at that version if the head is unchanged, or restarts the proof at its current version. If the
checkpoint is invalid or the deployment's existing R2 key rotated, omit it and restart at the
last completed Item key. The Item is
counted as scanned only after its proof finishes or its existing pin is verified. No partial
proof publishes a pin.

The driver reserves 12 MiB before starting a page and does not schedule more work. Compare
its reply with the billed completion logs before sizing another batch. Resume by passing
`nextCursor` as `cursor` and copying `headCursor` unchanged when present. Replaying a
cursor skips heads already pinned. `blocked` lists Items with a gap or unavailable snapshot
evidence, including evidence that cannot be read within the snapshot budget. Stop and
inspect those Items; don't skip the blocked key. A fresh pass from `cursor: null` must reach
`nextCursor: null` with no `headCursor`, zero `filled` and no `blocked` before considering
any removal of the fallback.

## Weekly database export cost

Convex takes a snapshot export of the dev deployment on Mondays at 03:00Z (the system job `_system_job/snapshot_export`). The export reads the whole database, so its billed read I/O follows stored document bytes, not traffic. It is not in the repo's function-log meter ([convex-spend](convex-spend.md)); the only source is the Convex dashboard usage page for the billing period. Never start an extra export for a measurement: every manual dispatch needs the lead's approval.

Record each weekly run here, with the stored size of the same day, so the ratio can be checked:

| Run | Billed read I/O | Stored size (dashboard) | I/O per stored GB | Source |
| --- | --- | --- | --- | --- |
| 2026-11-10, three manual exports | 3.94 GB in all (about 1.3 GB each) | about 6.5 GB (2026-11-13 reading) | about 0.2 | [convex-spend](convex-spend.md); Item 411727ba comment 67059b19 |
| 2026-11-16 and 2026-11-23, two weekly exports, together | 7.37 GB (about 3.7 GB each, about $0.74 at $0.20/GB) | 8.8 GB on 2026-11-23 | about 0.42 | Owner dashboard, billing period 2026-11-10 to 12-10; Item 411727ba comments 94b21a92 and 67059b19 |

The weekly pair is one dashboard total, not two records, and the export file's own size is recorded nowhere. The two ratios differ by a factor of two while stored size grew only by about a third, so I/O per run does not yet follow stored size in a way we can plan with. Fill the next row from the 2026-11-30 run: read that run's own usage line and the stored size on the same dashboard day. Until then use 0.2 to 0.4 GB of export I/O per stored GB.

What moves it: every stored GB removed lowers the next export by about 0.2 to 0.4 GB, $0.04 to $0.08 per run, so about $0.04 to $0.08 per 1,000 landings at about 1,000 landings a week. The whole export costs about $0.7 per 1,000 landings at the current 3.7 GB per run. Expiring finished check runs (the 30-day rule, first rows from 2026-11-27, about 1.0 GB) and the planning and Work row moves (about 0.4 GB) are the two reductions in motion; legacy `viewFiles` (about 1.4 GB) and finished source jobs (about 0.4 GB) are not decided. Row sizes and decisions are in Item 411727ba.
