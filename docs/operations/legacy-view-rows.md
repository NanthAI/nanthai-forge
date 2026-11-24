# Legacy View rows (Item c0af6cfa, family F1)

The old per-View detail (`viewDetails`), Lane-View (`laneViews`) and file-provenance (`viewFiles`) rows, with their `:payload` parts, are derived data. Nothing in the web app, CLI or MCP reads them (Candidate pages read `projectHostedCompose:candidate`), and the source archive can rebuild them. Their writers and readers are deleted. `viewAcceptances` stays: `projectWorkIndexSummary` reads it.

`convex/projectViewRowsRetire.ts` deletes the stored rows. It lives only in the pinned in-between release and is removed by 2026-12-31, once every deployment has run it.

## Run order (dev now, prod in the P8 release)

1. Deploy the server first, then let CLIs update. An older server rejects an acceptance-only owner projection as `view-detail-missing` and falls back to a slower server-side derivation; the new server accepts rows from older CLIs and drops the retired ones.
2. Deploy while no index build is running. A build resumed across the deploy would continue from a batch cursor that counted the retired rows.
3. Dry run, read-only: `npx convex run projectViewRowsRetire:run '{"operationId":"<fresh uuid>","apply":false}'`. It prints rows and document bytes per range, `buildingGenerations`, and stops at `budgetBytes` (default 350 MB, hard stop 400 MB).
4. Apply, only with `buildingGenerations` 0 (the run refuses otherwise): the same call with `"apply":true` and a fresh operation id. Each page deletes at most 100 rows or 500 KB. The run ends with a rescan; `isDone: true` with `remainingRanges: 0` is the proof. After a stop (`budget`, `pages`, `time`), run again with a fresh operation id: the same id replays its receipts and stops at the same place.
5. A finished apply deletes its own page receipts (`receiptsForgotten`). Copy the totals into the Item: a retry after a lost reply reports only what was left.
6. Delete the module, its test and the routing line for `viewFiles` in `convex/projectWorkRecordTables.ts`.

Remove `.env.local` after any Convex CLI use. Never run this against prod outside the P8 release.
