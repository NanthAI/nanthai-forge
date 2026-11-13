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
| R2 request dollars and bytes put by a landing's composes, mean (Issue 3e3f9fe6) | every recomposed landing | Latest 20 jointly stamped dev landings at 2026-11-12 23:20Z: 2.55 A / 1.00 B, or $0.000011835 per landing; request budget $0.000018 (about 1.5x, rounded up to a microdollar, absolute floor $0.000010). Separate bytes budget remains 1.35 MB; missing stamps are skipped |
| GitHub runner minutes of a landing's checks, mean: accepted / discarded / audit (Issue 3e3f9fe6) | every landing | 54.4 / 4.7 / 18.8 shard minutes over the 36 landings of 2026-11-10 (rolling 20-landing means 49 to 57 / 2.5 to 5.9 / 13 to 23); budget 70 / 12 / 32 min |
| Save / preflight, p90 | every landing with a recorded duration | initial budgets 30 / 120 s; sources and calibration below |

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

R2 request cost uses Standard list rates: $4.50/million Class A and $0.36/million
Class B; deletes are free. The single `landing-r2-request-usd-mean` replaces the two
operation-count alerts. It prices both counts from the same retained sample, preserving
fractional dollars; either missing count excludes that sample. Existing signatures do not
measure executed retries or every caller. The byte budget remains separate. Retired budget
ids leave the retained broken map at the next observation; no migration call is needed.

## Cost

No new polling, cron or subscription, and idle costs zero. A landing already reads and writes the row (about 3 KB,
the last 40 samples). A transition (rare: a break or a recovery, never while a budget stays broken) schedules one
alert delivery and one Issue write action (about six Convex round trips through the ordinary Work command path).

## Seeing values

- `nforge metrics ROOT --text` prints the **Speed budgets** block; `--report FILE.md` adds the same table, which a
  phase close report includes as it is. The window is the report period: the last 20 landings (and 20 passed
  check runs) in it. Rows say `pass`, `fail`, `unrun` (no data, or the measurer was not run) or `guarded`
  (the build enforces it). Cost means skip unknown stamps and require 20 known values. The report
  uses the existing landing/request and run pages, with no extra calls or DB reads. Audit shard seconds
  are attributed once to the newest landing at the audit end; the landings reply's `costs` gives
  attempts, writes, R2 counts and accepted/discarded runner minutes directly from its row.
- The `status` metrics headline carries `speedBudgetWarning`, one line naming each broken budget, or null.
- `node scripts/perf-harness.mjs --cli-cold-start --bundle DIR` measures the harness-judged budgets. `--cli-cold-start` also runs the four agent commands against an address that never resolves, under `scripts/perf/first-network-preload.mjs`, which stops the CLI at its first Convex call and reports its CPU time and loaded modules (a `land` stops at its hand-off to the detached submitter). A warm compile cache is used, as the installed launcher does. `--snapshot-lane LANE_CHECKOUT` adds the snapshot budgets; run it only in a Lane of a scratch project with policy `autoSnapshot` on.

## Save and preflight timing

The negotiated `save-preflight-timing` feature adds the CLI's elapsed save milliseconds to its existing
final submit call. The server adds submit-to-publication time on its own clock, then writes `durationMs`
on the existing save record and receipt. It excludes the final call's transit and the client's receipt
application. Replays retain the first measurement. Background saves include their server settle time.
The CLI caches that receipt locally for the exact Lane/head; no timing fetch is needed.

Preflight already returns a local receipt with `durationMs` (planning is excluded). The landing's existing
`gates` argument carries that duration and the saved duration for matching source into `timing.ms`
(the compact pair `[saveMs, preflightMs]`, with null for a missing duration). Multi-Lane landings use the longest known duration. Malformed optional timing stays unknown;
extracting a metric never adds a landing refusal or changes preflight policy. Old clients/servers,
missing receipts and a different source head leave stamps unknown. The same rolling 20-landing p90,
alerts, recovery and fixed P0 Issue ids judge both budgets, including with preflight policy off.

Initial save budget: 30 s, from the 15 s synthetic client-plus-server fixture; dogfood save 9677e70e took 4.029 s through submission (its released client did not time
background settlement). The budget source distinguishes that incomplete sample from the fixture. Initial preflight budget: 120 s, rounding twice the successful dogfood
49.779 s receipt (5 test files) up to whole minutes. These are initial regression guards, not a claim
about the population p90; revisit when 20 stamped landings exist. The bounded local calibration read
was under 1 MB and required no hosted call.

No calls, database reads/writes, tables, indexes, timers or services are added. Small numeric fields
ride existing rows and replies (about 100 bytes per save/preflight); the alert window adds at most two
numbers per retained sample. Source bytes remain in R2. The report and status use their existing
landing pages. Nothing can be removed from the source paths; this replaces the two unrecorded budgets
and shares the existing timing receipts and alert path.

Alert refreshes preserve an existing Issue body, including owner edits and every Done-when line.
A repeat break reopens that Issue and records the new crossing in a comment. Reconciliation
leaves it open while any unticked checklist line remains, including a bare `[ ]` line.

Discarded runner seconds are independent of the accepted check's execution stamp: a known
discard remains counted when the accepted run is unknown. Missing stamps stay null, are
excluded from statistics and are reported as unknown coverage in budget reports and
transition messages. The existing expiry catch-up repairs retained null samples from their
operation stamps once, one sample per page (at most 40 retained samples per project), without
new landing calls or idle timers. Missing operations or missing stamps remain unknown.

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

## Live cost reference

`costGuard.reference` in `src/speed-budgets.json` is reading-only context, separate
from the active fixture `costs` and their thresholds. The latest reference is the
[valid a6 smoke](../operations/cost-to-serve.md#final-pre-bench-smokes-n3-r1-dry-a5-and-a6),
2026-11-13: $6.942917 per 1,000 accepted task landings, by function family, using
the independent whole-batch capture and Professional list rates. Both arms have
ten task receipts. Setup, late CI and final-main export are included; this is not
an isolated steady-state price, executed R2 accounting or an invoice. The ordinary
task-period subtotal and project-attributed driver appear alongside it in the report.
The active fixture budgets, action model and weighted R2 alert are unchanged.

## Conflict recovery source guards

`source-state-manifest-probes` permits zero R2 file-manifest probes when resolving a
State descriptor. `source-selected-manifest-probes` permits three reads for a file
present in the second of two selected States (two roots and one bucket), regardless
of cached ancestry. The 60-ancestor fixture failed with 60 and 61 reads before the
fix. Catalog fallback and current-access rejection remain covered.

`source-conflict-sync-actions` and `source-resolve-actions` permit one source action
for a small conflict/edit at both 4,000 and 29,000 files. The real-handler guards
previously needed two at 29k. They count source actions, not complete CLI operations;
resolve still includes its separate save. Larger calculations, input sets beyond
re-entry's memory routing window and the existing time boundary retain durable
continuations. These are internal execution choices, not repository limits.

The build runs `tests/source-manifest-lookup-speed.test.mjs` and
`tests/sync-resolve-cost-guard.test.mjs`. Their thresholds live only in
`src/speed-budgets.json`. Existing query, byte, cost and idle guards are unchanged.
The [cost decomposition](../research/sync-resolve-costs.md) separates local paired
CPU evidence, real-handler accounting and live end-to-end observations. A source
action count is not proof of the ten-second complete-operation target.

`resolve-state-download-bytes` permits zero manifest bytes in the full resolve-chain
fixture: the verified saved file list and pinned final header rebuild to the exact
State hash. Legacy or mismatching encodings retain the download fallback. This is
an unchanged-content transfer guard, not a limit on resolving source.
