# Storage compaction

Forge keeps source bytes in R2 and retains Git history, State ancestry, landing
receipts, audit history and planning. Compaction changes physical representation;
it does not expire these records or add client steps.

## Write-time payloads

| Table | Writer | Readers and retained contract |
| --- | --- | --- |
| `projectHostedCheckCallbacks` | `projectHostedCheckCallbacks.ts`, machine heartbeat in `projectHostedCheckWorker.ts` | Callback/heartbeat replay checks the full authenticated input digest; `projectHostedCheckRead.ts` and `projectHostedCheckVerdictReuse.ts` use separate reuse aliases unchanged. `projectHostedMainAuditState.ts` uses row timestamps. `projectRecoveryHosted.ts` exports retained receipts. Raw transport payloads are redundant with run/shard outcome and provider pins; receipts keep event identity and kind. |
| `projectHostedActionsResults` report pages | `projectHostedCheckReports.ts` | `hydrateCheckReports` restores exact per-file reports and checks the original digest. Plain passes store file/duration pairs; failures, flakes, attempts and diagnostics stay verbatim. Older pages retain their existing decoder. `projectOperationalExpiry.ts` owns the separately approved detail expiry. |
| `projectSourceTasks` | successful child completion in `projectConvexSourceFanout.ts` | `begin` only reads running inputs; `results` joins completed outputs. Completed successful children clear their input in the existing terminal write; outputs remain until whole-job cleanup. Fenced/failed tasks retain their original inputs for repair. |

These cuts add no Convex calls, R2 PUTs/GETs, timers or idle work. Existing canonical
check/run summaries and report pages remain readable. They remove duplicate
transport payloads and repeated passing-report field names.

## Immutable object catalog

`projectObjectCatalogCompact:step` is an internal, explicit maintenance mutation.
The caller supplies project, current owner, original operation id and the last
returned digest cursor. Each transaction selects at most 64 descriptors and
64 KiB of source rows. It atomically merges eligible bindings into the existing
256-entry catalog pages, retains original upload-id retry pins, removes the old
descriptor rows and records the next cursor. Replaying an unknown result with the
same operation and cursor returns the original receipt without another write.
No scheduler runs after a page or after completion.

Only committed, protected source bindings with canonical R2 keys or immutable
recipes move. Mutable State generation/parent/protection metadata, unprotected
objects, flattened recipe-closure projections, pending uploads, legacy storage
and rotated cleanup bindings remain rows.
Catalog pages preserve logical size, recipe and pack range. Source bytes never
move or download. Existing catalog ranges are merged without overlaps and the
request-local lookup cache is invalidated after publication.

`findObject` and `findObjects` continue to resolve object rows first, then catalog
pages. Writers that need a row id retain `objectRow`. A compact
`projectObjectReceipts` row keeps the original upload id, digest, size and nonce; `pendingRows`
rechecks current project access and the committed object before reconciling an old
upload id. Unknown ids still fail, and revoked access does not regain authority.
Legacy late uploads remain attributable through the exact project/nonce/digest
index and size check during the existing project purge.
The receipt table replaces seven-index descriptors with three-index retry pins; it
is included in project purge ownership. Ordinary new worker outputs retain their
proportional per-object write path: rewriting random catalog pages for a handful
of new objects would increase write I/O.

After migration, page `projectObjectCatalogCompact:verify` until `done`. It checks
every migrated digest through the normal resolver with current owner authority.
The migration receipt reports serialized bytes read, written and removed; these
exclude provider index/system overhead and are not a billed-usage measurement.
Provider usage must be reconciled separately before claiming a cost saving.

`tests/object-catalog.test.mjs` guards reachability, retained State provenance,
original-id retries, access failures, cursor replay, non-overlapping page ranges,
retained-byte reduction and proportional new source writes. Report and callback
byte ratchets live in the existing report-cap and Actions-result growth tests.

## Sparse descriptor reads

Dense pages trade point-read bytes for fewer stored descriptors and cheaper bulk
reads. `findObject` checks the raw row first. A raw hit reads that one document;
a catalog hit performs an empty raw seek and reads one whole catalog document.
Resolving more neighbours in that request reuses the covering page. The reader
does not fetch individual entries from storage or consult original-id retry pins.
Pack ranges make pages larger than plain digest/size pages.

The sparse lookup guard in `tests/object-catalog.test.mjs` uses synthetic packed
blobs at the zoo's 35 / 402 / 1,387-file scales. Each blob is 1,024 bytes; the
shared pack has the corresponding total size. Digests, row identities and nonce
widths are deterministic. The same selected binding is resolved first from a raw
row and then, after removing that row, from the catalog. These are exact UTF-8
JSON document bytes, excluding provider encoding, indexes and RPC authority/job
metadata. File count alone does not determine real catalog cardinality: imports
also retain State, recipe and physical-pack descriptors and deduplicate blobs.

| Synthetic descriptors | Raw point-read B | Full-page point-read B | Last-page point-read B |
| --- | ---: | ---: | ---: |
| 35 | 468 | 6,833 | 6,833 |
| 402 | 470 | 48,542 | 27,797 |
| 1,387 | 471 | 48,919 | 20,589 |

All point reads above return one document. A raw lookup uses one database seek;
a catalog lookup uses two, including the empty raw seek. Both fit the existing
one external resolver call, with no writes, R2 requests or idle work. The guard
ratchets each catalog byte count and checks that up to 100 neighbouring digests
read their page only once. Memory is bounded by touched pages within the request;
this comparison changes no runtime memory or wall time and claims no latency gain.
An offline source-exact comparison also ran these six catalog lookups with the
reader at `9d54040a` (immediately before storeD) and accepted `9acd7b98`. Every
query, document and byte count above was identical between readers. It isolates
the lookup code, not the missing historical source inputs or migration effects.

The [zoo report](../research/zoo-mini-report.md#db-io-and-catalog-reads) observes
History's selected-six RPC subtotal rising from 1,549,066 to 1,690,543 read bytes
per scenario (three landings). It is not table-isolated. Its `available` calls
stay at 12 / 36 documents while bytes rise by 20,265; `resolve` stays at two calls
(one cached) / five documents and rises by the same amount. Retained current
per-call `available` readings are six at 51,105 B, three at 30,840 B and three at
2,021 B. The first two modes differ by exactly 20,265 B. Replacing one larger
reading with one smaller reading reproduces the earlier 384,948 B total exactly.
This is consistent with a full-versus-partial page selection change, as the
synthetic fixture demonstrates, without an increase in document count.

That decomposition is an inference, not historical table attribution. The old
source SHA, descriptor pages and per-call trace are unavailable; the source
resolver's 80,196-byte increase also includes changing job/State metadata. Neither
the full 141,477-byte increase nor its triggering source change is causally
identified. The storeD lookup patch only adds writer cache invalidation; 256-entry
imports and raw-first lookup already existed. Sparse-read placement therefore
belongs with review Issue `4c8dfe6a-3511-4d01-a36b-1158c4e42c69`; no page-size change,
new descriptor store or live workload follows from this observation. Storage
Issue `8c4f126b` retains the unresolved causal/live comparison.

## Cold CI descriptor reads

The CI source resolver reads sorted digest windows and reuses each covering
catalog page within its transaction. The raw-row fallback still reads one full
object document per blob. The existing B2 guard in
`tests/hosted-actions-direct.test.mjs` retains its 2,120,000 / 10,300,000-byte
raw ceilings at 6k / 29k files, and also runs the same cold lookup against
catalog pages. Catalog ceilings are 450,000 / 2,120,000 bytes, including State
and current-session reads. Source calls remain three / eleven; the checks
retain exact object hashes and sizes, current authority, no writes and no idle
scheduling. This measures fixture document bytes, not provider index I/O.

The catalog measurement reads 437,952 bytes instead of 2,110,450 at 6k,
and 2,105,060 instead of 10,226,466 at 29k (about 79% less). Migration-origin
metadata has its real operation-id width in the ratchet. The raw reference keeps
B2's shorter synthetic R2 keys, so its comparison does not inflate the baseline.
Catalogs derive the canonical project R2 keys; source bytes and content-id
verification are unchanged. Imported and migrated bindings benefit; new raw rows
retain their current cost until compacted. New small worker outputs do not
rewrite unrelated catalog pages.

A State-bound descriptor manifest in R2 could remove the remaining bulk catalog
read. It must bind to the accepted State id, retain per-object content-id checks,
and reuse the trusted baseline and changed pins without adding a whole Convex
descriptor scan for each State. Its writer, R2 operations, storage and warm-job
costs need a separate comparison. This manifest is a placement-review option;
the current implementation does not introduce one.
