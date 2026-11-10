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
objects, flattened recipe-closure projections, pending uploads, legacy storage and rotated cleanup bindings remain rows.
Catalog pages preserve logical size, recipe and pack range. Source bytes never
move or download. Existing catalog ranges are merged without overlaps and the
request-local lookup cache is invalidated after publication.

`findObject` and `findObjects` continue to resolve object rows first, then catalog
pages. Writers that need a row id retain `objectRow`. A compact
`projectObjectReceipts` row keeps the original upload id and digest; `pendingRows`
rechecks current project access and the committed object before reconciling an old
upload id. Unknown ids still fail, and revoked access does not regain authority.
The receipt table replaces seven-index descriptors with two-index retry pins; it
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
