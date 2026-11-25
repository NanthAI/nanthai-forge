# Work record layout and older clients (Item c0af6cfa, families F5 and F13)

Two old shapes are gone from main. Prod gets the same conversion in the P8 prod release. This page is that release's runbook. It states what must hold before each step; stop and report on any miss.

## F5: one table for Item history and Work events

`planningItems`, `planningVersions`, `planningComments` and `events` live in `projectWorkDataRecords` on every partition. `splitRecordTable` routes by collection alone. The partition layout marker (`_workStoreLayout`: `legacy`, `copying`, `cleaning`, `moved`), the mirroring writer, the layout-aware purge wait, the source-return layout pin and the module `projectWorkRecordMigration` are deleted.

Dev was converted earlier (every partition `moved`). On 2026-11-25 `projectWorkRecordMigration:pending '{"cursor":null}'` on dev returned no partition and no further page before the code was deleted.

### P8 prod order

Main no longer holds the converter, so prod converts first from the main State this change was cut from, `48bb9671288bcdef3bb298a1408261a331c69aace78e7fd60c1c82a59f54b05c`, which still has `projectWorkRecordMigration`.

1. Deploy that State to prod. Confirm the deploy succeeded and the deployment answers `projectWorkRecordMigration:pending`.
2. List what is left: `npx convex run --prod projectWorkRecordMigration:pending '{"cursor":null}'`. Follow `nextCursor`. Every partition it lists is still `legacy`, `copying` or `cleaning`. Name the count on the Item.
3. Convert each listed partition: `npx convex run --prod projectWorkRecordMigration:run '{"generationId":"…","operationId":"<fresh uuid>","cursor":null,"budgetBytes":1}'`. Resume with the returned `cursor` and `cleanup` and the same `operationId`. Budget and checks: [storage inventory](storage-inventory.md#history-and-capsule-pin-moves). A partition that cut over fails its open list and search cursors with `WORK_STALE` once.
4. Verify: `pending` lists nothing and prints `nextCursor: null`. A listing that stopped at a cursor is not a pass.
5. Verify no stray copy remains: the moved collections have no row in `projectWorkRecords` or `projectPlanningRecords` (an indexed `take(1)` per partition and collection, read-only). Comment purge still refuses while a core-table copy of the comment exists, and source return skips any history row outside the data table.
6. Prerequisite, enforced by Convex itself: the F7 conversion ran and its verification passed ([legacy Item shapes](legacy-item-shapes.md#p8-prod-runbook), steps 1 to 4 with every count 0, then its deploy of main). The State below is cut from main after F7 removed `hostedProjects.itemLaneMembership`, and the F5 conversion above does not clear that field: a project that still carries it makes Convex reject this State's deploy during schema validation, before any job here can run. Delete the unread marker rows (`collection: '_workStoreLayout'`, one per partition, about 200 B each) from the pinned in-between release, main State `b4fc6b6fa19a6bd23f9bfa2537d552a4620fd2e70e74bd44b1af0d546a591712` (landing receipt 60fce116), which holds the one-off job `convex/legacyWorkMarkerRows.ts`; the job is not on main. Deploy that State to prod first. Dry run, read-only: `npx convex run --prod legacyWorkMarkerRows:markerRowsRun '{"deployment":"NAME","apply":false,"budgetBytes":50000000}'`. It prints `projects`, `partitions`, `found`, `deleted` (what apply would delete), the bytes read and `blocked`. `NAME` is the subdomain of the deployment URL; a mismatch refuses before any read. Only a `moved` marker is deleted: a marker of any other layout, or a leftover `_workStoreLayoutProgress` row, is listed in `blocked` and means step 4 did not pass; go back to step 3. Apply with `"apply":true`, then rerun it: `found` must be 0 with `stopped: null`. Every read is capped by the bytes the page has left, so the stated budget controls the run: a page starts only when 5 MiB still fit it. A stop prints `stopped`: `budget` (no room for another page: raise the budget), `page` (one project needs more than one page's 4 MiB allowance) or `over` (the reads passed the budget); the last two mean stop and report. Then run the landing note job of the same State ([legacy Item shapes](legacy-item-shapes.md#landing-note-links-and-times-second-job)).
7. Deploy main. The deploy validates every stored row against the tightened schema (an archived landing note must carry `at`); a refusal names the table and field the landing note job missed: rerun it, do not edit the schema.

Dev: on 2026-11-25 the dry run read 0.37 MB (budget 50 MB), found 13 `moved` markers in 14 partitions of 342 projects and none blocked; apply deleted 13 and the replay found 0 (`stopped: null` on each).

Every `convex run` names its target: `--prod` for prod, `--deployment NAME` for dev. Read the printed deployment name before an apply. Prod only with the owner's go. Remove `.env.local` after any Convex CLI use.

## F13: older clients

The minimum CLI is now 0.3.2 (`CUTOVER_CLI_VERSION`). Every hosted capability read of a server-authority project refuses a client below it with `CLI_UPGRADE_REQUIRED`; every build of main at or after this landing reports 0.3.2. Deleted with it:

- Owner-derived View rows other than `viewAcceptances` (`viewDetails`, `viewFiles`, `laneViews` and their payloads) are no longer accepted and dropped: the server refuses them as `view-collection-invalid`. The CLI's owner-derived cache moved to cache schema 4, so an older cache is rebuilt once instead of filtered.
- The `stamp` argument of `projectHostedDormant:abandon` and the `indexed` field of dormant Lane replies.
- The legacy sign-out receipt hash in `deviceOperation` (the pre-`action` request shape). A stored receipt of that shape would reject an exact retry of its own operation with `AUTH_OPERATION_CHANGED`. Dev holds none: `authLinkEvents` has one row, of kind `legacy-passkey`, and no `device` receipt. Prod: before the server deploys, read its `device` receipts read-only and confirm none carries a request hash equal to the digest of `{credentialId}` alone; a hit is converted by rewriting that hash, never by restoring the fallback.
- The CLI's readers for `.forge/cache-use.json` inside a checkout and for a misplaced `.forge-client` or `..forge-client` read cache inside a checkout (`hosted-legacy-cache.ts`, the `localRecovery` field of checkout results). Such a file is now unknown metadata: it is preserved and blocks eviction or replacement like any other. On the owner's machine no Lane held one (1,089 Lanes checked).

### P8 prod order

1. Release the CLI first. The main-channel updater installs 0.3.2 as soon as main moves; a stable-channel installation, a pinned CI installation, a self-hosted runner and a Mac runner need an explicit update. Check the registered machines' builds and update them before the server deploys.
2. Deploy the server. A client still on 0.3.1 gets `CLI_UPGRADE_REQUIRED` on its next capability read; `nforge update` recovers it.
3. When a protocol or schema break needs the advertised floor too, set `FORGE_MINIMUM_CLI_VERSION` to 0.3.2 through the approved route ([CLI update](cli-update.md)). This landing does not change any deployment setting.

### Kept, with reasons

- The reply-version handshake (`noticeVersion`, `openLanesVersion`, `presenceVersion` and the others on the capability read) and the landing message default in `projectHostedFinishStore.ts`: they shape replies between a CLI and a server of a different deploy minute, and the stored landing requests; the landing part is a core queue path and goes with F14.
- `sourceManifestVersion`: a per-project source protocol flag that needs a physical root; four dev projects have none. It needs its own conversion with the source readers.
- The local-store branch of `agent-peers.ts` (`store.readRecords()` against `store.load()`) and the legacy-user inspection of `pruneCliBuilds`: they handle local stores and running processes, not an older request shape the floor retires.
- `workRecordTable` in `projectWorkRecordTables.ts`: a one-line wrapper kept for `projectHostedCheckImport.ts` alone, a core queue path whose edit needs a queue proof; F14 deletes it with that file's other legacy readers.
