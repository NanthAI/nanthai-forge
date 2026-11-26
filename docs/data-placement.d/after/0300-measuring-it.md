## Measuring it

The read-only storage inventory (`scripts/storage-inventory.mjs`, [storage inventory](../../operations/storage-inventory.md)) pages every table and `_storage` through reviewed named queries, reports physical bytes separately from document JSON sizes and reads no file bytes.

Deployment administrators can measure **bytes by location** through the internal `projectBytePlacement:convexWritten` query. It reads the deployment-wide `_storage` table newest first, in pages of 64, and stops at the requested window. The expected count is zero. Hosted project self-metrics report Convex placement as unknown.

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
