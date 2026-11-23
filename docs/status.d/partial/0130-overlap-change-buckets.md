A Lane's saved change entries can live in 64 path-hash buckets (`projectHostedOverlapChanges`, Item 411727ba) instead of one
row field. The Lane row stays slim (about 1.5 KB) and carries the saved-path summary and a symbol-facts flag, so the first-write
hook's peer read loads one bucket per peer instead of every peer's whole list (151 KB to 9 KB in the sweep-size fixture;
about 621 KB on the dogfood deployment before). Default reads load only the buckets of the paths the caller saved, and the
whole list only when both sides carry cross-file symbol facts; scope and detail reads load whole lists as before. Readers
accept both forms at all times. The writer is default-off (`FORGE_OVERLAP_CHANGE_BUCKETS`): a Lane's next record write
stores its slim form, a same-head write touches no bucket, and switching it off stores the inline list again. Live
enablement, the budgeted backfill of closed Lanes and removal of the inline field stay open.
