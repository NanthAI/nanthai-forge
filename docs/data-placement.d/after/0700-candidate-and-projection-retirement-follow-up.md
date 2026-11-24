### Candidate and projection retirement follow-up

The Candidate page reads its file list once on opening; per-file provenance is
read when a file is expanded. The local browser harness that timed the old
Candidate page over HTTP (4k/29k fixtures) was removed with the old app shell;
no time assertion is used as a build gate.

The remaining projection cutover is separate from Candidate listing publication.
Revision-free Work mutations still require selected payload attributes in their
transaction, and canonical `hostedRecordBody` still reads Convex bodies. A
canonical copy therefore does not yet replace those reads with R2. Imported
Intent fields named `payload`, `payloadKey` and `payloadParts` are source data
after hydration and must survive in the canonical record's `journal`; they must
never be mistaken for disposable header metadata. Notes and lifecycle retain
their existing separate records.

No existing rows are removed here. An R2 projection migration is not planned
([verdict](../../research/placement-review.md#s4-remaining-writers)); if one is taken up, this is its contract:

1. Pin project id, physical record generation, checkpoint digest and source/Work
   revision. Inventory each collection with a durable operation id and cursor;
   retrying the same page reconciles the original outcome. Never substitute a
   current generation or newer canonical version for the pinned one.
2. Commit or transfer at most 100 rows and 500 KiB per page. Count whole rows
   and report provider read bytes separately, including any final-row overshoot.
   Stage an oversized row's exact bytes in R2 with a bounded manifest descriptor
   rather than truncating it or increasing the page target.
   Preserve collection/key/parent/position, actor/status/planning metadata, all
   unknown attributes, current mutable overlays and historical provenance.
3. Before switching any reader, verify replacement digest and byte length,
   source membership and State-parent coverage, server-side identity mapping,
   selected-command behavior, generic pages and retained snapshot reads.
   Independent source/target comparisons must continue detecting failed dual
   writes; hashing both sides with a lossy codec is insufficient.
4. Exercise portable export/restore against the pinned source and Work, including
   attributes whose names collide with transport fields. Publish readers first,
   then capture the existing default-off server setting for retry-stable writers;
   use the existing contract feature/`CLI_UPGRADE_REQUIRED` boundary for old clients.
   Calls and database I/O for imports/rebuilds may not increase.
5. Keep existing projection rows and canonical source/Work/audit history. Any
   later projection cleanup needs its own authorized operation, exact verified
   row identities and a resumable receipt; the normal writer never launches it.
   Do not drop the data table while any generation, patch writer, generic reader,
   comparison or retained snapshot still depends on it.

The index reader map (repository-relative paths):

| Index | Collections / reader |
| --- | --- |
| `by_generation_and_collection_and_activityAt` | `lanes`, `runs`; `convex/coordinationCounts.ts:95` |
| `by_generation_and_actor` | Any collection with imported `actor` metadata; `convex/projectActorNames.ts:67`; retained on all three tables |
| `by_generation_and_collection_and_key` | Every collection; `convex/projectWorkRecordTables.ts:40` selected lookup; planning id resolution in `convex/projectHostedPlanning.ts` |
| `by_generation_and_collection_and_position` | Every collection, including source/payload/comparison pages; `convex/projectWorkIndex.ts:170`, `convex/projectWorkIndexBuildStore.ts:50`, `convex/projectWorkStoreDigests.ts:161` |
| `by_generation_and_collection_and_parent_and_position` | Payload chunks, `viewAcceptances`, `runs`, `notes`, planning history and other parent-selected collections; `convex/hostedRecordValue.ts:27`, `convex/projectWorkIndex.ts:175` |
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
