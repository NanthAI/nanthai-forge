# Database inventory and orphan rows

Inventory reads are explicit operator work. They add no subscriptions, timers or
idle calls. Predict the read budget before running them and capture provider
usage separately from document-size estimates. A database export reads the whole
database and is not an inventory shortcut.

`scripts/storage-inventory.mjs TABLE_NAMES_FILE PRIVATE_OUTPUT_DIRECTORY` runs on
the configured development deployment. Get the table names with `npx convex data
--deployment dev`. The script reads table counts from Convex's internal metadata
counter and samples one newest-first page per nonempty table, at most 128 rows
with a 256 KiB read threshold. A final document can exceed that threshold by up to
one maximum-size document. It records row kinds, serialized JSON bytes and field
sizes, excluding field contents. JSON sizes exclude database index overhead and
are estimates, not billed storage. The newest page is a sample, not a random
sample or a table-wide p95. Inspect older pages and important row kinds separately
before extrapolating. Outputs can identify internal schema fields and belong in
a private directory.

`projectStorageInventory:describe` lists indexed root ownership fields from the
schema: `projectId`, and Work-generation `generationId`/`partitionId` fields.
Nested generation references on import and receipt records are references rather
than ownership. They do not authorize removing the containing record.

`projectStorageInventory:owners` accepts `table`, `field` and `after` (initially
null). It seeks one row per distinct owner through an owner-first index, then
jumps past that owner's whole index range. Each call returns at most four owners
and rechecks each parent directly; continue with the returned `after` until
`isDone`. A page reads at most four sample documents and four parents, roughly
8 MiB at the maximum document size. The cost depends on distinct owners, not
retained payload rows. It returns sample sizes, never payloads.

Projects that still exist, including deleted tombstones with residue, use the
normal project lifecycle purge and its progress receipt. For a genuinely absent
project or Work-generation owner, `projectStorageInventory:purgeOrphans` removes
one exact page. Supply the selected ownership field, absent `ownerId`, an original
`operationId`, unique `part` and at most eight `{id, sha256}` pins. Hash the exact
JSON representation returned by a bounded readonly query; preserve its property
order. The mutation rechecks absent ownership and every row's owner and digest
before deleting anything. A changed pin refuses the transaction. Personal
guidance operations with an incidental project id remain personal data.

Orphan removal reuses the existing cleanup page receipts. Replay the entire
original request after an unknown outcome; its receipt returns the committed
counts without deleting the next page. Row deletion uses the same raw writer as
permanent project purge, cancels pending referenced tasks and removes exclusively
owned legacy files through the existing reference checks. Receipt bytes are kept;
the endpoint creates no new table or retention rule. Current project data,
reachable Git history, landing receipts, audit and planning are never selected
merely because they are old.

Confirm completion by rerunning the owner inventory and checking each affected
owner range is empty. Report actual provider read/write bytes separately from
deleted document bytes and R2 object bytes. Storage reclaimed from indexes is
not established by deleted JSON bytes.
