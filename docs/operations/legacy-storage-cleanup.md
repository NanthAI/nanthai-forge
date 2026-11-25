# Legacy storage retirement

New bytes go to R2 on every deployment ([data placement](../data-placement.md)). Convex file storage held the
old copies; dev is retired and its machinery is deleted (Item c0af6cfa, family F6): the read-through, the write
pause, the cleanup windows, the audit, verify, class-4 and bench scripts, and their tests. Prod gets the same
conversions in the P8 prod release. This page is that release's runbook. It states what must hold before each
step; stop and report on any miss.

## Release order

Three pinned States, in this order. Each deploy must succeed and each step's proof must hold before the next
State goes out. Dev ran them as main receipts 1e9f7e21 (A), c202d960 (B) and the field-removal landing (C).

1. **State A, converters.** Has `storagePointerRetire`, `storagePointerProof` and the old pointer readers.
   Run [pointer retirement](#pointer-retirement-one-shape) here.
2. **State B, read-through and pause gone.** Has `storageTombstoneRetire`; the pointer readers are still
   there but read R2 first. Run [tombstone copies](#tombstone-copies) here.
3. **State C, main.** The tables, the `storageId` fields and indexes, the native pointer readers, the R2
   backfill and both one-off modules are gone. Before it goes out, a read-only check finds no row with a
   `storageId` and no tombstone, window or retired receipt row (a deploy that removes a field or table still
   holding data fails schema validation and changes nothing).

## Pointer retirement (one shape)

Rows whose bytes already read from a committed R2 object can still carry an old
`storageId`. Byte readers pick R2 first for those rows (`isR2Object`,
`archiveDownload`), so the pointer is unused. `storagePointerRetire:run` clears
it on live `projectObjects` rows, on `projectBackups` and on a backup's
`archiveReceipt`: `{"apply":false}` is the dry run, `{"apply":true}` writes. It
never clears a removed, purged or native-only row, a backup or receipt without
a committed R2 copy, or an object a saved source continuation names (its
ownership proof). Those come back as `blocked` with up to 20 ids per table. A
cleared backup no longer resolves its old id as an archive alias (lead decision
d5850d3d: there are no outside links; it reads through its R2 record).

Dev ran it from main at State A (the two landings of Lane 79793887) before the
pointer readers were deleted: 47,135 object pointers and the one backup pointer
cleared, replays 0, proofs byte-equal. Prod (Item c0af6cfa, sign-off point 4)
runs it at State A. Every gate below must hold, in order; stop and report on any
miss.

1. **Release.** Name State A and confirm
   `convex/storagePointerRetire.ts` and `convex/storagePointerProof.ts` exist at
   it (`nforge agent . show` with that `state` and `path`). Confirm the deploy
   at that State succeeded and that the deployment answers
   `storagePointerRetire:run`. Commands target one deployment explicitly: dev
   with `--deployment <name>` on `npx convex run`, prod with `--prod`, and prod
   only with the owner's go for that run. Remove `.env.local` after any CLI use.
2. **Writers stopped.** At that State, pointer writers refuse with
   `R2_REQUIRED` (source output, finish, derived artifacts, backups, proposals,
   imports, bootstrap, seed, archive migration). Do not run against a release
   that still writes pointers.
3. **Inventory.** Read-only, under a stated read budget: count rows with a set
   `storageId` (or `archiveReceipt.storageId`) in all six families
   (`projectObjects`, `projectBackups`, `projectProposals`, `projectSourceSteps`,
   `projectDerivedArtifacts`, `projectWorkGenerations`), and count native
   `_storage` files. Only `projectObjects` and `projectBackups` may hold
   pointers; any other family or any native file stops the run. Keep ids private.
4. **Proof before.** Choose the proof ids privately: a sample of pointer
   objects spread over projects, every backup with a pointer, and every object
   a continuation names. `storagePointerProof:read` takes at most 64 rows and
   64 MiB of objects per call (split larger selections; a single larger object
   is refused). It refuses a missing or repeated id and any byte or size
   mismatch, and reports `alias` (continuation ownership for objects, archive
   alias resolution for backups). Keep the output.
5. **Dry run.** `run {"apply":false}` reads every pointer row once plus every
   continuation row (dev scale: about 19 MB of continuations, 28 MB of
   pointers). The blocked rows must be exactly the expected set
   (continuation-named objects; none on dev); any removed, purged,
   native-only or R2-less blocker stops the run. More than 1,000 continuation
   refs refuses: settle those jobs first.
6. **Apply.** `run {"apply":true}` writes one mutation per page (256 rows or
   1 MiB) and ends with a rescan that clears nothing; `WORK_STALE` means a
   writer still sets pointers: stop and find it. A partial run (timeout, error)
   is safe to rerun: cleared rows have left the index, so the rerun resumes.
7. **Replay.** A second `run {"apply":true}` must clear 0 and block the same
   rows.
8. **Proof after.** The same ids give the same `sha256` and `size`, `pointer`
   false for every cleared row, and an unchanged `alias` for blocked ones.
   Only then may State B go out; State C deletes the pointer readers, the
   schema field and these two modules, after the tombstone copies.

## Tombstone copies

Owner decision 2026-11-24 (relayed by the lead on Item c0af6cfa, comment 7ac252f6): the R2 copies held only by
legacy tombstones are not kept until a calendar date. `storageTombstoneRetire:run` at State B does it:
`{"apply":false}` is the dry run, `{"apply":true}` writes.

1. **Release.** Confirm the deploy at State B succeeded and the deployment answers
   `storageTombstoneRetire:run`. Name the deployment (`--deployment <name>` on dev, `--prod` only with the
   owner's go for that run); remove `.env.local` after any CLI use.
2. **Inventory and continuations.** Read-only. Count `_storage` files (must be 0), tombstone rows and
   cleanup-window rows. State B has no read-through, so a saved source continuation that still names a
   retired id would fail on resume: run `storagePointerRetire:run {"apply":false}` at State A and require
   `continuationRefs` 0 (settle or finish those jobs first; dev reads 0). Run the job in a quiet window: it
   rechecks each copy right before its delete, and a same-content upload in the milliseconds between the
   recheck and the DELETE is the one residual race, so no landing or import should be running for that
   project.
3. **Dry run.** It pages the tombstones (50 per read), checks for each one whether a live row still names its
   key (an object, a retained source key, a backup, an archive receipt or a proposal), and sends one HEAD per
   copy. It writes nothing. The result is counts and bytes only, never keys: `tombstones`, `shared` (copy kept),
   `copies` (to delete) and their bytes, `missing`, `mismatched` (HEAD size differs from the pin: kept and
   reported, stop and look), `windows`, and `receipts` and `receiptBytes` (the retired endpoints' receipts
   in the shared receipt table).
4. **Apply.** For each copy held only by a tombstone: HEAD must match the pinned size, DELETE, HEAD must be
   missing. Then it drops the settled tombstone rows (deleted, missing and shared), every cleanup-window row and
   the retired endpoints' receipts (parts `delete-N`, `bench-N`, `cursors`, `online-retirement`). A partial
   run is safe to rerun; one action covers every page, so rerun on a time-out.
5. **After.** A dry run again: `tombstones` equals the `mismatched` count (0 on dev), `windows` 0. Record the
   key count and bytes before and after on the Item, never the keys or contents.

The receipt table (`legacyStorageCleanupPages`) stays: operational expiry and the landing capsule keep their
receipts in it, so it is a live store with an old name. Only the retired endpoints' rows go.

## F6 leftovers (second converter, State A2)

After the pointer and tombstone work, rows still carried the R2 backfill markers (`r2BackfilledAt`,
`r2BackfillOperationId`, `r2ConvexPurged`), a `location` of `convex`, and project-deletion fields for the
retired native sweep (`hostedProjects.exchangeCleanupCursor`, `exchangeCleanupDone`, `r2BackfillRevision`;
`projectUploadCleanup` `cursor`, `pending`, `task`). State A2 is the release that has
`convex/legacyFieldRetire.ts` (main receipt 19347fd0); the field removal is the next main State.

1. Deploy State A2. Confirm the deployment answers `legacyFieldRetire:run`.
2. Dry run: `npx convex run --deployment NAME legacyFieldRetire:run '{"apply":false,"budgetBytes":50000000,"untilMs":T}'`
   (`--prod` only with the owner's go). `T` is a creation time after the last backfill write. It prints a
   total per family (`rows`, `bytes`, `changed`, `blocked`, `stopped`), `nativeRefs` and the artifact owner
   counts. Dev read 26.0 MB for 47,616 objects, 0.34 MB for projects and 27 KB for backups.
3. Gates: `blocked` 0 everywhere; `nativeRefs` 0 (an import, import artifact, agent grant, source zone,
   pre-protocol import cursor or non-removed derived row with an id that is not `r2blob:` makes the apply
   refuse, because the reader no longer opens it). `stopped` `budget` means rerun with more budget. The
   objects scan ends at `cutoff`: that is not proof, the deploy of the tightened schema validates the rest.
4. Apply: the same call with `"apply":true`. It clears the markers, turns a committed `convex` location into
   `r2`, clears the retired project fields, and deletes removed derived rows whose original was a native id.
   Replay must print `changed` 0.
5. Proof: sample object, backup and project rows before and after; every field except the cleared ones is equal.
   Then deploy main; a refusal names the table and field the job missed.

Dev (2026-11-25): 47,135 object rows, 1 backup, 328 projects cleared and 26 spent derived rows deleted
(the apply read 26.4 MB of documents and patched each changed row once); replay 0; 259 sampled object rows and 355 backup and
project rows equal before and after.
