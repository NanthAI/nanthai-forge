# Small legacy shapes (Item c0af6cfa, families F9 probe, F10, F11, F12 non-secret)

Records that kept a second shape only for rows written before a change are converted once, then the fields, indexes, readers and the healer are deleted. Prod gets the same conversion in the P8 release.

| Family | What changed | Result |
| --- | --- | --- |
| F11 retired fields | `hostedProjects` `r2StorageUsed`, `r2Writes`, `stateTrees`, the boolean `planningArchiveIndexed` marker (moved into the coverage receipt); `imports` `remote`, `workerClaimed`, `r2Writes`; `users` `legacyGithubProvider`, `legacyPasskeyFlow`; `projectObjects` `stateTree`; the purge-blocked literal `R2_MAINTENANCE_DISABLED` | unset, then removed from the schema and readers |
| F12 `teamMembers.handle` | memberships with no handle take the account handle (`null` when it has none) | required |
| F10 overlap `lastActivityAt` | stamped once on every overlap row | required; the per-landing healer and the second index read per peer read are deleted |

Kept, with reasons: the v1 release signature (it covers the release number; converting needs the owner's key), `sourceManifestVersion` (a protocol gate that needs a physical root per project, goes with the minimum-CLI bump, F13), contributor and team-member `workBudget` and coordination `lastActivity` (absent means no use yet, which new rows are born with; not a second shape), the detail-migration table and `stagedDetailMigration` (a live operator migration, goes with the Work store slice).

## P8 prod runbook

The job `convex/legacyShapeSweep.ts` is not on main. It lives in the pinned in-between release, the main State named on Item c0af6cfa by the landing that added it. Deploy that State to prod, run the steps, then deploy main. Every `convex run` below names its target: add `--prod` (or `--deployment NAME` for a dev run) and read the printed deployment name before an apply; a command with no target runs on whatever the checkout points at.

1. Dry run, read-only: `npx convex run --prod legacyShapeSweep:run '{"apply":false,"budgetBytes":50000000}'`. It prints rows, bytes read and a count per retired field for `projects`, `imports`, `users`, `teamMembers` and `overlapLanes`. Every page reserves 2 MiB of the budget (its scan plus the project, Lane record, account and receipt lookups a conversion adds, all counted in `readBytes`), so the run stops at the budget minus that reserve. A stop prints `stopped: "budget"` and the cursor; continue it with `"from":{"family":"…","cursor":"…"}` and a new budget, or raise the budget. The run is only complete when every family prints `stopped: null`.
2. Objects scan (`projectObjects.stateTree`): the same call with `"families":["objects"]` and its own `budgetBytes`. It reads every object row once; state the row count and bytes on the Item before the apply. It must also finish with `stopped: null`.
3. Probes, read-only: `legacyShapeSweep:metricsProbe '{"cursor":null}'` lists check runs without a metric projection per project (10 projects a page; pass `cursor`, and `skip` when the reply names `resume`). `legacyShapeSweep:reportsEdge '{"projectId":"…","steps":24}'` finds where inline reports stop: use `r2Before` as the date from which every run holds its report in R2, and only treat the result as a cutoff when `resolved` is true and `lastRunInline` is false.
4. `purgeBlocked:R2_MAINTENANCE_DISABLED` in the dry run names projects whose removal was stopped by the retired switch. The job only reports them: run `retry` for each, then rerun the dry run. The apply gate below needs none left.
5. Apply: the same calls with `"apply":true`, every family to `stopped: null`.
6. Verify, which is not the replay alone: rerun the dry run. Every family must print `stopped: null`, `changed: 0`, an empty `counts` and no `blockedIds`. A replay that stopped at its budget also prints `changed: 0`, so a stop is never a pass.
7. Deploy main. The deploy validates every stored row against the tightened schema: a refusal names the table and the field the job missed. Rerun step 5 for that family; do not edit the schema.

Remove `.env.local` after any Convex CLI use.
