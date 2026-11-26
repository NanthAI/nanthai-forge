# Legacy Item shapes (Item c0af6cfa, families F7 and F8)

An Item's Lanes, Intents and landings each had two shapes. Both are now one.

| Family | Old shape | One shape |
| --- | --- | --- |
| F7 Item and Lane membership | a walk over derived successor IDs from the Item's own ID, a same-ID Intent with no binding counted as the Item's, and an unbound Lane list paged by offset | the Item is written on every Intent and Lane head; every reader pages `by_project_and_kind_and_item` and nothing else |
| F8 Item landing history | a scan of each Lane's overlap row for a landing stamp, merged after the landing notes | landing notes only; the stamp stays on the overlap row for overlap logic and is no longer a history source. Item Work reads one note by the receipt the stamp names for a Lane older than its Intent's newest 50 notes |

What the change removed: the Intent chain walk (`itemIntentChain`), the legacy open-Lane head choice, the offset Lane page and its cursor form, the stamp scan and its history cursor (the landing history list shows the notes, and a landing's `revertedBy` is stored on its own landing note), the successor-ID walk in planned start, the derived-ID chain map of the public Plan, the legacy purge key snapshot, and the `items` phase of the Plan Lane-mark backfill. A planned start, a purge and every reader now name only bound heads.

Writers: a start and a Lane open already wrote the binding. The Work store now binds an Item's own same-ID Intent when the projection that creates the Item writes it (`storeIntent`), and project creation no longer stamps a membership marker (the `itemLaneMembership` field is deleted).

## P8 prod runbook

The job `convex/legacyItemShapes.ts` is not on main. It lives in the pinned in-between release, main State `9cc84530174a3af239bc8055ff1096535992c287c59f2b980a3a1001a8ffebd5` (landing receipt 6e0575fe), the commit the dev run used. Deploy that State to prod before main, run the steps, then deploy main. That State already reads only bound Intents and Lanes, so between its deploy and step 3 an unconverted Item shows no Lanes (nothing else is affected). Every call names the deployment it means to convert in `deployment` (the subdomain of its own URL); a mismatch refuses before any read. Name the target on every `convex run`: `--prod`, or `--deployment NAME` on dev; read the printed deployment name before an apply, and run prod only with the owner's go.

1. Nothing to run first: the job binds roots, successors and Lanes itself, whatever membership marker a project carries.
2. Dry run, read-only: `npx convex run legacyItemShapes:run '{"deployment":"NAME","apply":false,"budgetBytes":100000000}'`. It prints the live project count, the bytes read (every page and the census counted, 4 MiB reserved per page) and a count per conversion: `rootsBound`, `successorsBound`, `lanesUnmarked`, `stamps`, `itemStamps`, `landedNotesMissing`, `revertedNotesMissing`, `stampsProved`, `stampsUnproved`, `markerFound`, and the `blocked` ids. A stop prints `stopped: "budget …"`; raise the budget. Lane and landing counts are exact only after the Intents are bound: apply `"families":["intents"]` first, then dry-run `"families":["lanes","landings"]`.
3. Apply in order: `"families":["intents"]`, `["lanes"]`, `["landings"]`, `["projects"]`. A landing note is written (or the Lane merged into the existing note) only for an Item-bound Intent whose stamp has no note naming that Lane and whose receipt still exists; a revert note takes its commit and revision from the revert's own receipt. A stamp with no receipt, or whose archived note lacks the Lane, is listed in `blocked` and stops the release until the owner decides.
4. Verify: rerun every family with `"apply":false`. Every `*Bound`, `*NotesMissing`, `stampsUnproved` and `marker*` count must be 0 with `stopped: null` and an empty `blocked`; `stampsProved` equals `itemStamps` plus the revert stamps. `lanesUnmarked` may stay above 0: those are Lanes of Intents that belong to no Item.
5. Deploy main. The deploy validates every stored row against the tightened schema (`hostedProjects.itemLaneMembership` is gone); a refusal names the table and field the job missed. Rerun step 3 for that family; do not edit the schema.

Landing notes the conversion writes are new rows, but every reader selects, pages and shows a note by its landing time (`at`, indexed as `by_project_and_intent_and_at`), never by its row's creation time, so a converted landing sits among the comments and landings of its day, not at the newest end, and a page of the discussion, the landing history or the Item audit never fills with late-written old landings. A landing note names the revert that took it out (`revertedBy`, written when the revert is accepted), so the link shows on any page without a read per page.

## Landing note Item links

Current main requires an Item ID on every hot or archived note. Convex validates existing rows
during deployment. On an unconverted deployment, use the optional-field Stage A source pinned
at State `bd1b4e2f03fb12965905bc368937e7d7e7d8c1970ee879b7114082d47fa6593b`
(receipt `69dc50e4`) for the one-off migration. Complete the markerless-Intent and orphan
censuses before applying the fill. The migration is available in that pinned source.
Before the one-off dev fill, run `node scripts/landing-note-cutover.mjs NAME`. The census walks every
`hostedProjects` row, including deleted and purging projects, and reports missing hot and archived links
by project. Post the counts before changing data. For each reported active project, page
`projectIntentLandingNoteFill:count` with `projectId` and `cursor` starting at null. Post the recoverable
and orphan counts with receipt samples before applying. Stop if any project has over 500 orphans or if
orphans exceed 10% of its notes. The deployment's billed I/O ceiling is twice the summed estimate,
capped at 100 MB. For an owner-confirmed deletion, resume the recorded purge and let it remove the
notes. If the purge is blocked, an approved targeted cleanup can remove its identified notes. Resolve any
missing links on a restorable project before tightening the schema.

Start each `fill` page with the id from `remaining`. Supply the census's orphan row ids as
`deleteOrphans` and use `maxRows` to shorten the default 64-row page when only a smaller page fits the
remaining budget. A lost reply can retry the same first-row pin. The fill recovers a surviving Item through
the receipt's Candidate or its attributed Lanes and follows duplicate links. It removes an unrecoverable
orphan's note row, which also holds the archived reference when present. The acceptance receipt and the
shared capsule are retained. A census mismatch or ambiguous or unavailable evidence stops the page before
writes. Both Stage A count and fill accept a smaller `maxRows` on the original cursor or first-row pin if
provenance reads exceed the transaction budget. Verify `remaining` returns null for every active project
that needed filling and record the provider-billed read and write bytes against the census. Run
`node scripts/landing-note-cutover.mjs NAME --verify` before deploying. It exits unsuccessfully if any
project still has missing links. Complete and verify Plan Lane-mark coverage for legacy Lane heads
before switching the roll-up to indexed Item membership.

### Landing note links and times (second job)

The in-between release that holds the marker job (`legacyWorkMarkerRows`, [legacy work layout](legacy-work-layout.md#p8-prod-order) step 6), main State `b4fc6b6fa19a6bd23f9bfa2537d552a4620fd2e70e74bd44b1af0d546a591712` (landing receipt 60fce116), also holds `convex/legacyLandingNotes.ts`; neither job is on main. Notes written before it carry no `revertedBy`, and a note archived to a capsule before it carries no `at`. The job sets both from rows that already exist: a `reverted` note names itself on its original `landed` note (one indexed read each), and an archived note takes its receipt's time (one receipt read each; a note whose receipt is gone is listed in `blocked` and stops the release until the owner decides). It must run after the F7 steps above and before main, because main makes `at` required on archived notes and the deploy then validates every stored row.

1. Dry run, read-only: `npx convex run legacyLandingNotes:notesRun '{"deployment":"NAME","apply":false,"budgetBytes":50000000}'`. It prints `notes` (read), `revertedMissing` and `atMissing` (what apply would set), `readBytes`, `stopped` and `blocked`. Every read is capped by the bytes the page has left (4 MiB a page, plus at most the one document that ends a read past it; a page starts only when 5 MiB still fit the budget). `stopped` is `budget` (no room for another page: raise the budget), `page` (one page needs more than its allowance: stop and report) or `over` (the reads passed the budget: stop and report); `null` is a complete run.
2. Apply with `"apply":true`, then rerun it: `revertedMissing` and `atMissing` must be 0, `blocked` empty, `stopped: null`.

## Dev conversion (2026-11-25)

Eleven live projects. Dry run, apply and replay on dev: intents 2,916 heads, 6 same-id roots bound, 0 successors; 2,642 Lane heads, 0 bound (the 415 unmarked Lanes belong to Intents of no Item); 2,615 overlap rows with 1,935 stamps, 1,874 on Item-bound Intents, 948 without a note that names the Lane: 948 landing notes written, 0 blocked; 11 markers plus 1 on a removed project unset. Every `stampsProved` (1,875, the 1,874 landings and one revert) matches its note's Lane, commit and time. The replay printed 0 for every `*Bound`, `*NotesMissing`, `marker*` and `stampsUnproved`. Reads: 4.0 + 1.7 + 12.7 + 0.7 MB for the apply, 14.5 MB for the full replay, each run under the 100 MB budget with `stopped: null`.

Dev conversion of landing note links (2026-11-25): the dry run read 0.87 MB (budget 50 MB) over 1,673 notes and found 1 landing without its `revertedBy` and 0 archived notes without `at`, none blocked; apply set that 1 link and the replay found 0 (`stopped: null` on each).
