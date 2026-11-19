### Planning progress counter

One `_workStorePlanCounts` row (key `counts`, about 520 bytes) per record partition in `projectWorkDataRecords` holds
Issue and Initiative counts by status and the Issues closed on the current UTC day (Item 3fa3187d). The common Work
writer collects each search root's kind/status move and, only when a count moved, reads and patches the row once per
transaction; a title or body edit costs nothing. Fresh partitions insert the row complete at creation. Older ones are
counted by `projectPlanCounts:backfill`, 200 roots per transaction, with its cursor in the row itself: it is
idempotent, safe to re-run and rebuildable with `restart`. While it runs, a move is counted only behind the cursor.
Needs me and Plan read the row with one point read; without a complete row they read one capped page and mark every
figure as a lower bound. It shares the partition's purge, snapshot exclusion and retirement; no table, index or
retention rule is added.
