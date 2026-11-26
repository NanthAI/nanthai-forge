# P8 Work store cutover

Run this procedure to move an approved deployment to F2's canonical Work store.
Keep the preceding release and the corrected bridge available throughout. Record
the approved one-off read budget and the deployment name. Select that deployment
explicitly on every call and use the CLI that matches the selected release.
Wait for terminal billing before retrying any interrupted call.

## 1. Convert active legacy Work and capture baselines

On the preceding release, make sure each active project's selected generation
is ready. Complete the [source-authority cutover](source-exchange.md) for any
active native-owner project before copying its Work. Copy legacy Work and backfill
planning times for the selected generation. In the backfill, start at
`cursor: null` with `pages: 1` and at most 40,000,000 bytes of remaining budget.
Allow the 12 MiB batch reserve. Follow `nextCursor` and `headCursor` until both
are empty. Require zero blocked heads. Select the canonical mode and all four
writers for each converted project.

```sh
nforge hosted-work DEPLOYMENT PROJECT_ID '{"action":"copy-work-store"}'
nforge hosted-work DEPLOYMENT PROJECT_ID '{"action":"set-work-store","mode":"records","writers":["note","intent","intent-status","planning"]}'
```

Capture hashes and counts for the planning export, journal Work, paged records
and details, and Item audit responses. Pin the selected generation and Work
revision. Use a paged live baseline at the scale where the complete export is
unavailable, and retain the same page ranges and pins for each parity check.

## 2. Deploy the corrected bridge

Deploy Forge State `4f57682087b7bf06f74ee15270a5852499baafce2fa5317142f37fb62014ba97` directly, using its accepted
receipt `347ede71-d1db-49c1-bccb-a9c9004808e5`. This release opens F2's canonical readers
and includes the cleanup and comparison commands. Keep the selected Work pins
through the compare and parity steps.

## 3. Prove and apply cleanup on the corrected bridge

1. Dry-run `legacyWorkStoreMode:run` for `projects`, `comparison`, and
   `recordDigests`. Follow each `nextCursor` to completion and require zero
   blocked active projects. Run the read-only `issuePins` family and require
   zero active Issue heads without valid planning times. For each call, set
   `budgetBytes` to the smaller of the remaining shared budget and 67,108,864
   bytes (64 MiB). The example uses the approved production target during P8.

   ```sh
   budget_bytes=$((remaining_bytes < 67108864 ? remaining_bytes : 67108864))
   npx convex run --prod legacyWorkStoreMode:run \
     "{\"deployment\":\"NAME\",\"family\":\"comparison\",\"cursor\":null,\"apply\":false,\"budgetBytes\":${budget_bytes},\"pages\":20}"
   ```

   A cleanup page examines up to 100 rows and reserves 256 KiB plus a 1 MiB
   crossing document. The comparison scan bounds each generation to the retired
   collection range and reserves 2 MiB more for discovering partitions, including
   orphaned partitions. Subtract billed Completion reads after each batch,
   including proof and retry reads. Start a continuation only when its reserve
   fits. Budget for rereading the unaffected rows in the scanned ranges on apply
   and replay.
2. As each active Work project's owner, run `projectWorkStore:compare` with
   `digestOnly: false` and `cursor: null`. Follow the cursors for each of
   `planningVersions`, `planningComments`, `notes`, `intents`, `lifecycle`,
   `planningItems`, `issueHeads`, `readItems`, `readVersions`, `readComments`,
   `readNotes` and `readLifecycle`. Require `method: "full"` and zero missing,
   different or invalid rows. Retain the full list of `purged` keys. The bridge
   counts a purge only after validating the recorded command and request, the
   Item scope and the applicable redacted values.
3. Compare the live canonical reads to the pinned baselines from step 1 and
   require byte-equal canonical output. If a family reports `budget` or
   `blocked`, or the remaining budget cannot cover apply, replay and the
   post-apply parity reads, stop before applying.
4. Repeat the three cleanup families with `apply: true` on the same selected
   deployment. Retain the row counts and billed database read and write bytes.
5. Replay all three families from a null cursor with `apply: false`. At the end
   require `found: 0`, `changed: 0` and `stopped: null` for every family.
6. Repeat the pinned planning, journal, record and audit parity reads and
   require byte-equal canonical output.

## 4. Deploy Landing 2 and validate the schema

Deploy Landing 2 after cleanup, replay and post-apply parity pass. Confirm that
Convex schema validation succeeds. F3 retains `projectWorkEvents`, its
indexes, the event windows and the journal event identity union. F4 retains the
archived Item history fallback.

If deployment or schema validation fails, keep or restore the corrected bridge
and retain the evidence for the selected deployment. To restart a cleanup
family, use the same deployment, start with a dry run and charge all retry
reads to the shared budget.
