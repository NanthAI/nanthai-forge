A Lane's saved change entries live in 64 path-hash buckets (`projectHostedOverlapChanges`, Item 411727ba) instead of one
row field. The Lane row stays slim (about 1.5 KB) and carries the saved-path summary and a symbol-facts flag, so the first-write
hook's peer read loads one bucket per peer instead of every peer's whole list (151 KB to 9 KB in the sweep-size fixture;
about 621 KB on the dogfood deployment before). Default reads load only the buckets of the paths the caller saved, and the
whole list only when both sides carry cross-file symbol facts; scope and detail reads load whole lists as before. The Lane
record write stores only the bucketed form: a same-head write touches no bucket and a save of one path rewrites one bucket.
The inline form is gone from the schema and every reader (docs/operations.md says how an older deployment converts first).
Reads that need whole lists (Now, detail, scope) read one bucket range per peer instead of one row each.
