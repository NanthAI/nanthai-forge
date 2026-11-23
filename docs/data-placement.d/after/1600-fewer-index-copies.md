## Fewer index copies for Item history and capsule pins

Item 411727ba (Fable verdict d8f7f6a9, rows 3 and 5) keeps these rows in Convex. Item words
must stay purgeable and searchable, and replay reads capsule pins inside mutations. They
move to tables with fewer index copies instead. A copy is the document plus one entry per
custom index and two built-in entries.

- **Row 3, Item history and Work events.** `planningItems`, `planningVersions`,
  `planningComments` and Work `events` need only the generic key, position, parent and
  actor indexes. In a moved partition they live in `projectWorkDataRecords` (8 copies)
  instead of `projectPlanningRecords` (16) or `projectWorkRecords` (now 10, since the
  finished split migration's `by_generation` index is gone).
  - Each partition has one `_workStoreLayout` marker row, about 200 bytes
    (`convex/projectWorkRecordLayout.ts`).
  - A partition born after this change starts `moved`.
  - Older partitions move through `projectWorkRecordMigration` in three steps:
    - `copying`: reads stay on the legacy tables, and the work writer mirrors every insert,
      patch, replace and delete.
    - `cleaning`: reads move to the data table, and a fresh public generation makes open
      cursors fail WORK_STALE once.
    - `moved`: done.
  - While a partition moves, purges refuse with a retry message, because they bypass the
    mirroring writer.
  - Source return reads only the copy its layout names.
  - Routing a moved collection costs one marker read per transaction and partition. Other
    collections still route with no I/O.
- **Row 5, capsule pins.** A capsule pointer's terminal `attempt` and acceptance `plan` are
  read only on replay. They move from the 11-copy `projectFinishReadRows` pointer to one
  unindexed `projectHostedLandingBodies` row (3 copies), owned by the pointer
  (`convex/projectLandingCapsulePins.ts`).
  - `removalDone`, `attemptPin` and the compact `evidence` chain stay on the pointer, so
    classification and landing history read nothing extra.
  - Project purge and orphan cleanup delete the body together with its pointer.
  - `projectLandingCapsulePinsMove` slims existing pointers.

The fixture ratchets are in `tests/work-index-cost.test.mjs` and
`tests/landing-storage-budget.d/` (projectFinishReadRows -3,270 B fresh, projectHostedLandingBodies
+2,840 B). The operator runs and their I/O budgets are in
[storage inventory](../../operations/storage-inventory.md#history-and-capsule-pin-moves).
