# Legacy Item shapes (Item c0af6cfa, families F7 and F8)

An Item's Lanes, Intents and landings each had two shapes. Both are now one.

| Family | Old shape | One shape |
| --- | --- | --- |
| F7 Item and Lane membership | a walk over derived successor IDs from the Item's own ID, a same-ID Intent with no binding counted as the Item's, and an unbound Lane list paged by offset | the Item is written on every Intent and Lane head; every reader pages `by_project_and_kind_and_item` and nothing else |
| F8 Item landing history | a scan of each Lane's overlap row for a landing stamp, merged after the landing notes | landing notes only; the stamp stays on the overlap row for overlap logic and is no longer a history source. Item Work reads one note by the receipt the stamp names for a Lane older than its Intent's newest 50 notes |

What the change removed: the Intent chain walk (`itemIntentChain`), the legacy open-Lane head choice, the offset Lane page and its cursor form, the stamp scan and its history cursor (the landing history list shows the notes, so a converted landing no longer lists `revertedBy` there; its Lane row still does), the successor-ID walk in planned start, the derived-ID chain map of the public Plan, the legacy purge key snapshot, and the `items` phase of the Plan Lane-mark backfill. A planned start, a purge and every reader now name only bound heads.

Writers: a start and a Lane open already wrote the binding. The Work store now binds an Item's own same-ID Intent when the projection that creates the Item writes it (`storeIntent`), and project creation no longer stamps a membership marker (the `itemLaneMembership` field is deleted).

## P8 prod runbook

The job `convex/legacyItemShapes.ts` is not on main. It lives in the pinned in-between release, main State `9cc84530174a3af239bc8055ff1096535992c287c59f2b980a3a1001a8ffebd5` (landing receipt 6e0575fe), the commit the dev run used. Deploy that State to prod before main, run the steps, then deploy main. That State already reads only bound Intents and Lanes, so between its deploy and step 3 an unconverted Item shows no Lanes (nothing else is affected). Every call names the deployment it means to convert in `deployment` (the subdomain of its own URL); a mismatch refuses before any read. Name the target on every `convex run`: `--prod`, or `--deployment NAME` on dev; read the printed deployment name before an apply, and run prod only with the owner's go.

1. Nothing to run first: the job binds roots, successors and Lanes itself, whatever membership marker a project carries.
2. Dry run, read-only: `npx convex run legacyItemShapes:run '{"deployment":"NAME","apply":false,"budgetBytes":100000000}'`. It prints the live project count, the bytes read (every page and the census counted, 4 MiB reserved per page) and a count per conversion: `rootsBound`, `successorsBound`, `lanesUnmarked`, `stamps`, `itemStamps`, `landedNotesMissing`, `revertedNotesMissing`, `stampsProved`, `stampsUnproved`, `markerFound`, and the `blocked` ids. A stop prints `stopped: "budget …"`; raise the budget. Lane and landing counts are exact only after the Intents are bound: apply `"families":["intents"]` first, then dry-run `"families":["lanes","landings"]`.
3. Apply in order: `"families":["intents"]`, `["lanes"]`, `["landings"]`, `["projects"]`. A landing note is written (or the Lane merged into the existing note) only for an Item-bound Intent whose stamp has no note naming that Lane and whose receipt still exists; a revert note takes its commit and revision from the revert's own receipt. A stamp with no receipt, or whose archived note lacks the Lane, is listed in `blocked` and stops the release until the owner decides.
4. Verify: rerun every family with `"apply":false`. Every `*Bound`, `*NotesMissing`, `stampsUnproved` and `marker*` count must be 0 with `stopped: null` and an empty `blocked`; `stampsProved` equals `itemStamps` plus the revert stamps. `lanesUnmarked` may stay above 0: those are Lanes of Intents that belong to no Item.
5. Deploy main. The deploy validates every stored row against the tightened schema (`hostedProjects.itemLaneMembership` is gone); a refusal names the table and field the job missed. Rerun step 3 for that family; do not edit the schema.

Landing notes the conversion writes are new rows: an old landing appears as the newest system comment on its Item once. Remove `.env.local` after any Convex CLI use.

## Dev conversion (2026-11-25)

Eleven live projects. Dry run, apply and replay on dev: intents 2,916 heads, 6 same-id roots bound, 0 successors; 2,642 Lane heads, 0 bound (the 415 unmarked Lanes belong to Intents of no Item); 2,615 overlap rows with 1,935 stamps, 1,874 on Item-bound Intents, 948 without a note that names the Lane: 948 landing notes written, 0 blocked; 11 markers plus 1 on a removed project unset. Every `stampsProved` (1,875, the 1,874 landings and one revert) matches its note's Lane, commit and time. The replay printed 0 for every `*Bound`, `*NotesMissing`, `marker*` and `stampsUnproved`. Reads: 4.0 + 1.7 + 12.7 + 0.7 MB for the apply, 14.5 MB for the full replay, each run under the 100 MB budget with `stopped: null`.
