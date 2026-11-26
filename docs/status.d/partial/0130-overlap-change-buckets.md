A Lane's saved change entries live in 64 path-hash buckets (`projectHostedOverlapChanges`, Item 411727ba) instead of one
row field. The Lane row stays slim (about 1.5 KB) and carries the saved-path summary and a symbol-facts flag, so the first-write
hook's peer read loads one bucket per possible match. A path-only read on main also loads just the caller's bucket for
that path. Default reads skip disjoint peers and load only the buckets of the paths the caller saved, or the whole list
when both Lanes carry cross-file symbol facts. Scope and detail reads can use whole lists. The open-peer and active-head
windows still determine completeness, even when a peer needs no buckets. These are one-shot HTTP reads from the CLI
and first-write hook, with no subscription to rerun when a peer saves. The Lane
record write stores only the bucketed form: a same-head write touches no bucket and a save of one path rewrites one bucket.
The inline form is gone from the schema and every reader (docs/operations.md says how an older deployment converts first).
A whole-list read uses one bucket range for each peer whose list it needs.
