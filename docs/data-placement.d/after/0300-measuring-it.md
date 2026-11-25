## Measuring it

The read-only storage inventory (`scripts/storage-inventory.mjs`, [storage inventory](../../operations/storage-inventory.md)) pages every table and `_storage` through reviewed named queries, reports physical bytes separately from document JSON sizes and reads no file bytes.

Hosted self-metrics include **bytes by location**: every Convex file-storage write on the deployment in the window, read from the `_storage` system table newest first (`projectBytePlacement:convexWritten`, pages of 64; one call when nothing was written). It must read 0 bytes; any byte adds a warning to the headline. An older deployment without the query reports the metric as unknown, never 0.

`nforge maintenance r2-backfill ROOT --dry-run` reports, per project, the legacy rows still only in Convex storage (count, bytes, estimated move cost) and the Convex copies already moved to R2 that cleanup could delete. It reads indexed rows in pages of 100 and moves nothing. The move and the delete are separate, owner-approved steps ([R2 backfill](../../operations/r2-backfill.md)).


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
