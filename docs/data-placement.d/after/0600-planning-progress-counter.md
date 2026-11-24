### Planning progress counter

One `_workStorePlanCounts` row (key `counts`, about 520 bytes) per record partition in `projectWorkDataRecords` holds
Issue and Initiative counts by status and the Issues closed on the current UTC day (Item 3fa3187d). The common Work
writer collects each search root's kind/status move and, only when a count moved, reads and patches the row once per
transaction; a title or body edit costs nothing. Fresh partitions insert the row complete at creation. Older ones are
counted by `projectPlanCounts:backfill`, 200 roots per transaction, with its cursor in the row itself: it is
idempotent, safe to re-run and rebuildable with `restart`. While it runs, a move is counted only behind the cursor.
Needs me and Plan read the row with one point read; without a complete row they read one capped page and mark every
figure as a lower bound. Version 2 rows also keep `g`: counted Issues by what decides
their public visibility besides their status (`h` for an Issue hidden itself, else its Initiative and parent ids), so
a visitor's Plan counts read the row plus the Initiatives and parents it names (at most 100, then their Initiatives)
instead of up to 1,000 Items. An Issue with none of the three is in no group, so a plain plan's row keeps its size.
`g` holds at most 100 entries of about 50 to 90 bytes (a plan with 35 Initiatives: about 2 KB more per counter read
and write); later groups go to one overflow tally `x` that a visitor never counts, so the figure is then a lower
bound. Hiding, showing or moving an Issue between Initiatives or parents also moves the row (one read, one write
in the same transaction). A version 1 row is rebuilt from the start by the backfill (run
`projectPlanCounts:backfillAll` once after deploy): until then visitors read the capped page, and while the rebuild
runs members do too. After a rollback to code that does not move `g`, rebuild every row with
`backfill {restart:true}` before rolling forward, and the same rebuild empties a large `x`. A not-exact visitor figure
shows that the plan has more than 100 groups or lookups, some possibly hidden; it names no Item.

Alongside `backfillAll`, run `projectPlanCounts:prepareScopesAll {}` once after deploy to build the exact parent
and Initiative tallies for existing partitions. It schedules 50 projects per transaction; each project task reads
at most 50 planning roots (256 KiB) per transaction and advances its own cursor before scheduling the next page.
Retry the driver safely. Check `projectPlanCounts:scopeCoverage {}` and follow `next` as `cursor` until it is null;
all selected Plan partitions must be complete, with `pending` and `blocked` both zero. Projects without a selected
Plan are reported separately. While preparation is incomplete, assigning a different parent to an existing Item
is refused; creation, clearing and ordinary updates do not need tally coverage. Guard reads are indexed points,
reuse transactional tallies including earlier writes in a batch, and add no idle work.

It shares the partition's purge, snapshot exclusion and retirement; no table, index or
retention rule is added.
