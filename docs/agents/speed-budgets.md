# Speed budgets

A regression is a P0 with a landing's name on it (the idea comes from Exact's "speed is king"). The budgets
live in one file, [`src/speed-budgets.json`](../../src/speed-budgets.json); each entry states its number, the data
it was set from and why. Change a number there, with the new data, and nowhere else.

| Budget | Judged by | Value today |
| --- | --- | --- |
| Landing to main, p50 and p90 (submit to commit) | every landing | 16.1 / 36.9 min over 491 landings, 2026-11-03 to 11-09; budget 25 / 60 |
| Hosted check, p50 and p90 (check reserved to ended) | every landing | 8.3 / 10.7 min over 45 sampled runs; budget 10 / 14 |
| Check result to commit, p90 (`ciEndedAt` to `committedAt`) | every landing | 8.5 s live after fix caa934a7 (300 s before it); budget 30 s |
| CLI cold start (CPU time of `--version`) | `perf-harness --cli-cold-start` | 90 ms median at load 35 (320 ms before 381c62df); budget 250 ms. `--version` and `--help` read no release and load 28 modules; the idle turn-end hook loads 16 |
| Agent `status`, `planning`, `save`, `land --save`: CPU before the first network call (land: before the hand-off to its detached submitter) | `perf-harness --cli-cold-start` | Median 415 / 246 / 182 / 400 ms at load 8-13 (713 / 385 / 312 / 597 ms before the bundled CLI entry, Issue 7b2ae8d8); 151-158 modules instead of about 700; budget 500 ms each, p90 under 700 |
| Web first paint: Now, Work, Lane first diff | `perf-harness --live` | unrun without the QA bot and a dev origin; budgets 1.5 s, 1.5 s, 1 s |
| Web eager JavaScript (gzip) | `perf-harness --bundle` | 246 KB; budget 270 KB |
| Unsaved-work snapshot added to a command: no changed file / one or fifty changed files (p90) | `perf-harness --snapshot-lane` | 5.9 ms / 16.2 ms (the walk and uploads run in a detached worker; before, in the command: 144 ms / 1,818 ms); budget 50 / 300 ms |
| Idle Convex calls | the build (`check-idle-queries`, landing tests) | 0; budget 0 |
| Attempts and landing-state writes per landing, mean (cost drift, Issue 3e3f9fe6) | every landing | attempts 1.6 over the 36 landings of 2026-11-10 (2.3 over 285 landings 11-08 to 11-10; worst 20-landing window 3.55); writes 11.1 live (8, 12, 20 to 22 for one, two, three attempts); budget 4 / 22 |
| R2 requests and bytes put by a landing's composes, mean (Issue 3e3f9fe6) | every recomposed landing | class A, class B, bytes put; seeded at 10 / 36 / 3 MB from the fixture until 20 stamped landings exist (batch and given-Candidate landings carry none and are skipped) |
| GitHub runner minutes of a landing's checks, mean: accepted / discarded / audit (Issue 3e3f9fe6) | every landing | 54.4 / 4.7 / 18.8 shard minutes over the 36 landings of 2026-11-10 (rolling 20-landing means 49 to 57 / 2.5 to 5.9 / 13 to 23); budget 70 / 12 / 32 min |
| Save, preflight | nothing records them yet | unrun; see below |

## How a budget breaks

A landing-judged budget is the statistic (p50, p90, or the mean for cost counts) over the **last 20 landings** that know the value, so one outlier
never breaks it (the p90 of 20 is the second slowest). A project with fewer than 20 landings has no verdict.
The accept mutation of each landing appends its own stamps (`timing`, already on the landed state) to the one
`projectLandingSpeed` row, judges every budget, and compares with the row's `broken` map:

- **Breaks** (was within budget): one alert through the project's `stallAlerts` channels, naming the budget,
  the landing that crossed it (acceptance receipt), its longest stage (queue and compose, check, settle) and the
  next step; and one write that opens the budget's P0 Issue.
- **Stays broken**: nothing. No repeat alert, no second Issue.
- **Recovers** (back within budget): one recovery message and a comment on the Issue. The Issue stays open for
  the lead to close once the fix is verified; a later break reopens the same Issue.

Each budget has one Issue with a fixed id (a hash of project and budget id), so a retry or a repeat break finds
it instead of duplicating it. With `stallAlerts` off, samples and Issues are still written; only the channel
message is skipped.

## Cost

No new polling, cron or subscription, and idle costs zero. A landing already reads and writes the row (about 3 KB,
the last 60 samples). A transition (rare: a break or a recovery, never while a budget stays broken) schedules one
alert delivery and one Issue write action (about six Convex round trips through the ordinary Work command path).

## Seeing values

- `nforge metrics ROOT --text` prints the **Speed budgets** block; `--report FILE.md` adds the same table, which a
  phase close report includes as it is. The window is the report period: the last 20 landings (and 20 passed
  check runs) in it. Rows say `pass`, `fail`, `unrun` (no data, or the measurer was not run) or `guarded`
  (the build enforces it).
- The `status` metrics headline carries `speedBudgetWarning`, one line naming each broken budget, or null.
- `node scripts/perf-harness.mjs --cli-cold-start --bundle DIR` measures the harness-judged budgets. `--cli-cold-start` also runs the four agent commands against an address that never resolves, under `scripts/perf/first-network-preload.mjs`, which stops the CLI at its first Convex call and reports its CPU time and loaded modules (a `land` stops at its hand-off to the detached submitter). A warm compile cache is used, as the installed launcher does. `--snapshot-lane LANE_CHECKOUT` adds the snapshot budgets; run it only in a Lane of a scratch project with policy `autoSnapshot` on.

## Not recorded yet

Save and preflight have no recorded duration: the CLI keeps the save steps in its own process and prints one
stderr line (`src/land-timing.ts`), and the hosted preflight reply carries no duration. They show as `unrun`
rather than carry an invented number. Recording them is tracked on Issue b7851c44.

## Drill

On the dev deployment only, from the project folder (never `--prod`; the drill is an internal function, so only
an operator with deployment access can run it):

```sh
npx convex run projectLandingSpeed:drill '{"projectId":"PROJECT_ID","mode":"break"}'   # prints the replaced row ("original")
npx convex run projectLandingSpeed:drill '{"projectId":"PROJECT_ID","mode":"recover"}'
npx convex run projectLandingSpeed:drill '{"projectId":"PROJECT_ID","mode":"restore","original":"ROW_FROM_BREAK"}'
```

`break` pushes four slow landings among fast ones through the real landing path, so the landing-to-main p90 budget
breaks: one alert and one P0 Issue (landing ids read `drill0000`..). `recover` pushes a fast window: one recovery
message and a comment. `restore` puts the project's own window back. Close the drill Issue afterwards.
