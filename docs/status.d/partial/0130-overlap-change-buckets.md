A Lane's saved change entries live in 64 path-hash buckets (`projectHostedOverlapChanges`, Item 411727ba) instead of one
row field. The Lane row stays slim (about 1.5 KB) and carries the saved-path summary and a symbol-facts flag, so the first-write
hook's peer read loads one bucket per peer instead of every peer's whole list (151 KB to 9 KB in the sweep-size fixture;
about 621 KB on the dogfood deployment before). Default reads load only the buckets of the paths the caller saved, and the
whole list only when both sides carry cross-file symbol facts; scope and detail reads load whole lists as before. The Lane
record write stores only the bucketed form: a same-head write touches no bucket, a save of one path rewrites one bucket, and a
row that still holds its list inline is converted by its next record write or by the one-off
`projectHostedOverlapBackfill:run` (docs/operations.md). Readers still accept the inline form until that backfill has run on
every deployment; the inline branch and field then go. Measuring the hook read on the dogfood deployment stays open.
