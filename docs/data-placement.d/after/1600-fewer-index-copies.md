## Fewer index copies for Item history and capsule pins

Item 411727ba (Fable verdict d8f7f6a9, rows 3 and 5) keeps these rows in Convex. Item words
must stay purgeable and searchable, and replay reads capsule pins inside mutations. They
move to tables with fewer index copies instead. A copy is the document plus one entry per
custom index and two built-in entries.

- **Row 3, Item history and Work events.** `planningItems`, `planningVersions`,
  `planningComments` and Work `events` need only the generic key, position, parent and
  actor indexes. Every partition keeps them in `projectWorkDataRecords` (8 copies)
  instead of `projectPlanningRecords` (16) or `projectWorkRecords` (now 10, since the
  finished split migration's `by_generation` index is gone).
  - The table follows the collection alone (`splitRecordTable` in
    `convex/projectWorkRecordTables.ts`): no marker row, no layout read and no mirroring
    writer. Dev finished the move (every partition `moved`); the `legacy`, `copying` and
    `cleaning` layouts, the marker and `projectWorkRecordMigration` are deleted (Item c0af6cfa F5).
    Prod converts in the P8 release first: [runbook](../../operations/legacy-work-layout.md).
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
