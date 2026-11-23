# Speed budgets

A regression is a P0 with a landing's name on it (the idea comes from Exact's "speed is king"). The budgets
live in one file, [`src/speed-budgets.json`](../../src/speed-budgets.json); each entry states its number, the data
it was set from and why. Change a number there, with the new data, and nowhere else.

| Budget | Judged by | Value today |
| --- | --- | --- |
| Landing to main, p50 and p90 (submit to commit) | every landing | 16.1 / 36.9 min over 491 landings, 2026-11-03 to 11-09; budget 25 / 60 |
| Hosted check, p50 and p90 (check reserved to ended) | every landing | 8.3 / 10.7 min over 45 sampled runs; budget 10 / 14 |
| Check result to commit, p90 (`ciEndedAt` to `committedAt`) | every landing | 8.5 s live after fix caa934a7 (300 s before it); budget 30 s |
| Queue health: first passed check to commit, p90 (Item 42200ce4) | every landing | 2 to 13 s on the accepted bench 8c9b84fc; 2026-11-17 dogfood held-only lower bound broke it at 09:42Z (incident 5e3c3a3c); budget 20 min. Review and dependency holds give no sample. While broken, the lead starts no new builders ([queue health alarm](lead.md#queue-health-alarm)) |
| CLI cold start (CPU time of `--version`) | `perf-harness --cli-cold-start` | 90 ms median at load 35 (320 ms before 381c62df); budget 250 ms. `--version` and `--help` read no release and load 28 modules; the idle turn-end hook loads 16 |
| Agent `status`, `planning`, `save`, `land --save`: CPU before the first network call (land: before the hand-off to its detached submitter) | `perf-harness --cli-cold-start` | Median 415 / 246 / 182 / 400 ms at load 8-13 (713 / 385 / 312 / 597 ms before the bundled CLI entry, Issue 7b2ae8d8); 151-158 modules instead of about 700; budget 500 ms each, p90 under 700 |
| CLI/MCP installed weight and startup | [Agent weight guard](agent-weight.md), existing package smoke and synthetic command fixtures | Recorded accepted-main baseline; zero byte/module/call noise, CPU judged at reference speed by a same-job calibration; no production/idle calls |
| Web first paint: Now, Work, Lane first diff | `perf-harness --live` | Now and Work unrun without the QA bot and a dev origin. Lane review first highlighted hunk, isolated reader on a dogfood Lane (method in [web diff path](../research/web-diff-path.md#lane-review-screen-read-path)): p50 829 ms, p95 1,381 ms with an open connection, **fails** the 1 s p95 budget; budgets 1.5 s, 1.5 s, 1 s |
| Web eager JavaScript (gzip) | `perf-harness --bundle` | 246 KB; budget 270 KB |
| Unsaved-work snapshot added to a command: no changed file / one or fifty changed files (p90) | `perf-harness --snapshot-lane` | 5.9 ms / 16.2 ms (the walk and uploads run in a detached worker; before, in the command: 144 ms / 1,818 ms); budget 50 / 300 ms |
| Idle Convex calls | the build (`check-idle-queries`, landing tests) | 0; budget 0 |
| Attempts and landing-state writes per landing, mean (cost drift, Issue 3e3f9fe6) | every landing | attempts 1.6 over the 36 landings of 2026-11-10 (2.3 over 285 landings 11-08 to 11-10; worst 20-landing window 3.55); writes 11.1 live (8, 12, 20 to 22 for one, two, three attempts); budget 4 / 22 |
| R2 request dollars and bytes put by a landing's composes, mean (Issue 3e3f9fe6) | every recomposed landing | Latest 20 jointly stamped dev landings at 2026-11-12 23:20Z: 2.55 A / 1.00 B, or $0.000011835 per landing; request budget $0.000018 (about 1.5x, rounded up to a microdollar, absolute floor $0.000010). Separate bytes budget remains 1.35 MB; missing stamps are skipped |
| GitHub runner minutes of a landing's checks, mean: accepted / audit (Issue 3e3f9fe6) | every landing | 54.4 / 18.8 shard minutes over the 36 landings of 2026-11-10 (rolling 20-landing means 49 to 57 / 13 to 23); budget 70 / 32 min |
| Discarded checks (checks a landing's attempts threw away), sum over the last 20 landings (Issue 1018d0f8, owner 2026-11-23) | every landing | 3 discarded runs in the 36 landings of 2026-11-10 (1.7 in 20); budget 4 checks. Counts queue waste only: check length has its own budgets. Runner minutes of the same checks (4.7 a landing then) stay beside it in the report and the alert, secondary, never judged ([below](#discarded-checks-budget)) |
| Runner minutes per full check, p50 (shard execution of the accepted run when it ran in full) | every landing with a full check | 76.4 min over the first 8 full checks after d5de1c98 (121.6 over 34 before it); budget 92 min |
| Cancelled or discarded runner minutes per UTC day (Item a217b83e) | the Stats day close, once per closed day | live 2026-11-11 to 11-19: 0 to 1,620 on ordinary days, 6,613 on the 11-17 incident day, 7,945 on 11-19; budget 2,100 min ([below](#daily-waste-tripwire)) |
| Save / preflight, p90 | every landing with a recorded duration | initial budgets 30 / 120 s; sources and calibration below |
| Cold read of a packed landing's history, p90 (marker query plus capsule history action) | `perf-harness --capsule-cold-read`, re-run after each packer or reader change | 2026-11-18, 46 cold reads through the Node history action: p50 749 ms, p90 1,024 ms (an earlier run's max 3.7 s was an isolate cold start); budget 2 s |

## How a budget breaks

A landing-judged budget is the statistic (p50, p90, the mean for cost counts, or the sum for a count over the window) over the **last 20 landings** that know the value, so one outlier
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

Preflight already returns a local receipt with `durationMs` (planning is excluded). A static-only
receipt is excluded from `preflightMs`, so advisory static work does not dilute the test preflight budget. The landing's existing
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

Cancelled checks retain their original submission IDs on the existing run record at dispatch.
The existing provider run ID binds completion to those submissions, including replacements.
Receipts show discarded minutes as pending until the authenticated completion event supplies
all final job intervals. That event applies one atomic correction per run to landing counters,
retained budget samples and already-closed UTC days; days receive additive deltas and keep their
original queue replay and distributions. Daily Stats price only landings with both accepted
and discarded usage known; a correction adds or removes that landing’s complete priced
contribution. Pending or permanently unknown landings stay outside both runner sums. Missing or incomplete completion remains unknown. Final cancelled-job
intervals include job setup and plan/static jobs; accepted and audit baselines retain their
existing recorded shard seconds.
This replaces zero-minute cancellation accounting; admission, ordering, cancellation and waits
are unchanged. Cancellation accounting flushes after the existing handler writes in the same
mutation, so an earlier queue snapshot cannot overwrite it. Existing sample repair leaves pending
usage unknown. No polling, new timer or pass-path reads/calls are added. Private attribution and
closed-day contribution metadata reuse existing records, with one indexed supersession root
on each landing request/desired table.


## Runner minutes per full check

`check-runner-full-p50` judges the shard execution minutes of the accepted check, only for landings whose
accepted run selected the whole test set: no gate (no configured contract gate, BYOCI) or gate effective
`full`, and not a scoped recheck (the whole-run predicate of `projectHostedScopedRecheck`). Parallel shards
hid coverage collection from check wall time: Issue d5de1c98 cut the slowest shard by about 256 s but shard
runner-minutes by a third. The accepted-run seconds are already on the landing (`counts.runnerSeconds`);
`counts.runnerFull` marks a full run, and the sample keeps the value in one more `counts` slot. A batch
member's share, a stale earlier run and a scoped check leave it null, so the window is the last 20 full
checks among the 40 retained landings. When fewer than half the landings are full checks the row cannot fill
the window: the budget sends one "not enough data" message (no Issue) and `nforge metrics` notes it on the
row; it clears silently once it can be judged. It fires only once full-check stamps reach the oldest quarter
of the row, so a row written before the stamp existed never reads as short and no extra field is stored. The landings reply's `costs.runnerFull` gives the same minutes.

### Naming the landing behind a shift

A whole-check shift is judged on full checks reserved after a landing landed, never on the check that first saw
it: the hosted executor runs from main, so a landing's own check still runs the old code. When the newest 3 to 5
full checks (non-batch, accepted, whole) all sit beyond the band of the 8 to 10 before them, in the same
direction (band = max(3 × 1.4826 × MAD of the earlier log minutes, 15%)), the landings committed between the last
check reserved before the split and the first check reserved after it are named, oldest first, in one owner
message: "adds about X runner minutes to every full check" for a slowdown, "Credit, not a fault" for a speedup.
It opens no Issue; the budget's own break does that. One slow runner or a slow creep names nobody, and the
same shift is never named twice (the row keeps the split's reservation time and its last landing, about 35
bytes, only after a shift). Precision is bounded by full-check spacing: the live replay
(`tests/speed-budget-shift-waste.test.mjs`) names 9 landings for d5de1c98's shift, including the right one,
never the one whose check saw it. Contract-selected checks cannot localize it: they carry no coverage and
their seconds per file are the same on both sides.

### Daily waste tripwire

`runner-waste-daily` sums each landed change's discarded runner seconds (checks of earlier attempts that were
replaced, failed, cancelled or went stale) per closed UTC day. The Stats day close judges it once per day from
the receipts and landing rows it already reads, and keeps its state (open break, ratchet, note) on that day's
Stats row: nothing on the landing path, no new call or table, about 150 bytes per closed day. It uses the same
alert and P0 Issue path as the other budgets and the [ratchet](#ratchet) rules with one closed day per held
day. A day where more than half the landings have no discarded-minutes stamp yet (usage pending, or past the
close's read cap) cannot be compared with a line set from whole days: it sends one "not enough data" note and is
not judged. Late usage that arrives after a day closed corrects Stats, not the judged day. Checks of work that
never landed (withdrawn) are on Stats' discarded tally, not here. The file max (2,100 min, about $17 a day at list
price) is the per-landing discarded budget as first set (12 min, now counted in checks) × the busiest day's 171 landings. `nforge metrics` takes the
automatic line and the held days left from the newest Stats day row (one indexed read on the first metrics page;
the landing row never holds them) and says which closed day that state is from. Only the file max fails the row,
the same as the close: a day over a tightened line but under the file max undoes the ratchet with a message, and
the row says so.

## Check time per landing

When a whole check run's per-file timings join the planner's timing history (`projectHostedTestTimings`, the
same mutation that already reads and writes that row), the run keeps a small `checkTime` record
([`src/check-time-added.ts`](../../src/check-time-added.ts)): its speed against history (the median log ratio of
each established file's seconds to its history EWMA), the per-file spread around it (1.4826 × MAD), up to 12
test files new to the history with the seconds each takes after dividing out the run's speed, and up to 12
files the history has but the run no longer ran (deleted or renamed), most recently timed first.

Only new test files are named. Acceptance already holds the run and the change's paths. When the change's new
test files, net of the test files it deletes or renames, move the check by more than three standard
deviations of their timing noise and by more than three typical files' noise, the receipt and the land reply
carry `checkTime`:
`CHECK TIME: this landing adds about 90 runner seconds to every check (tests/new.test.mjs +90 s), noise ±5 s.`
It never blocks. A rename or a split of the same total names nothing; a change that only deletes tests names
nothing. Edited files are never named: with 30 or 100 edited files some are always the run's random
outliers (the review simulated a 44% false-name rate at 30 files with a contention tail; the fixture's 200
seeded runs at 30 and 100 edited files name 0). A file the history has timed in fewer than 4 runs still counts
as new (the history entry carries `n` until then), so the change's own failed or discarded attempts, which
also feed the history, do not hide it.

Whole runs and contract-selected runs of Forge's own check recipe (`isStandardForgeCheck`) are judged. A
contract-selected run skips files on purpose, so it cannot tell a deleted file from an unselected one: it names
new test files only, never files it no longer ran. Nothing is lost: with Forge's own recipe a deleted or renamed
path selects the whole run (`classifyCheckPath` returns no scope for it), and a changed test file is always in
the selection, so the files that could offset a new one are judged on a whole run. A configured (BYO CI) command
that declares `selection: changed-paths` scopes without that rule, so a rename would read as an added file: its
selected runs record nothing, and its whole runs are judged like any other. A selected run needs 20 established
timed files (a whole run 5) before its speed and spread are trusted, because its matched files are mostly the
change's own impacted tests. A net that rounds to 0 s is never named. Of 60 replayed landings, 22 were
contract-selected and named nothing before. A main-race scoped recheck
and a scoped plan are never judged. A batch's shared run names the stacked change on main's (last) receipt. Timings that
arrive in several argument pages, or through the scheduled legacy timing path, leave the run without the
record. The seconds are runner seconds summed over shards, the unit of the budget above; wall time is about
that divided by the shard count. A docs-only change is never named.

A whole-check shift is not named at landing. The hosted executor runs from main's control checkout, so a change
to it shows first in checks dispatched after it lands: the replay over 60 landing receipts on Item a217b83e found
receipt 378ab39b's own check still collected coverage (14,468 file-seconds), and the first check dispatched after
it 9,111. Blaming the landing whose check saw a shift would name the wrong landing. The runner-minutes-per-full-check
budget catches that class.

Cost: no new call, read or write. The run record grows by at most about 1.5 KB (24 paths), the timing history
by a few bytes per young file, and the receipt and landing state by a few hundred bytes for a named landing only.

## Discarded checks budget

`landing-runner-discarded-mean` (Issue 1018d0f8, owner 2026-11-23) counts **checks**, not minutes: the sum over the
last 20 landings of the checks each landing's attempts threw away, at most **4**. That is the original intent of the
first 12-minute line (one full check was about 3 minutes of the mean, 12 was four of them), kept at four whatever a
check costs (86 runner-min by 2026-11-22). Check length has its own budgets (runner minutes per full check, check
minutes), so this one measures queue waste only. The id keeps its old name so the one P0 Issue and its history stay
one record.

- **Per landing**, from stamps the landing sample already holds, no new stamp, call or read: no discarded runner
  seconds is nothing thrown away (a reused check is kept); known seconds mean `max(1, attempts - 1)` checks (each
  attempt after the first replaced a check; a batch member's share of a failed cohort run is one). It is an
  estimate: it runs high when an attempt reused its check beside a discard, and low when resubmissions carried
  discarded seconds but restarted the attempt ordinal (a later submission landing on its first attempt counts one).
  An exact per-landing stamp is a follow-up. Unknown seconds (usage still pending, or a row from before the stamp)
  stay unknown and are excluded, never counted as zero: the sum then reaches back to the newest 20 landings that
  know it, and the alert says so and names discarded runner seconds as the missing stamp. This is a count over a
  window, not a percentile: one landing estimated at five discards breaks it, which is the intent (four in 20 is
  the line).
- **Secondary number**: the same window's mean discarded runner minutes per landing is shown beside the count in
  the `metrics` row note and in the break and recovery messages. It judges nothing.
- A count never ratchets. `src/landing-speed-alerts.ts` (`discardedChecks`, stat `sum`) judges it; tests
  `tests/landing-speed-alerts.test.mjs` ("Item 1018d0f8") cover the unit, the break at the fifth check in the
  window, the single quiet repeat, and the recovery at four.
- Baseline: 3 discarded runs in the 36 landings of 2026-11-10 to 08:31Z (1.7 per 20). The Item's cause fix (hold a
  plain change's Lane check while a spent order-sensitive holder is checking) is built separately; this line only
  changes what the budget counts.

## Ratchet

The landing-judged percentile budgets (time to main, check, check to commit, save, preflight and runner
minutes per full check) tighten by themselves; cost means and the discarded-check count keep the cost ledger's own ratchet or none
([`src/landing-speed-alerts.ts`](../../src/landing-speed-alerts.ts)). The rule, judged inside the landing that
already writes the budget row:

| Part | Setting |
| --- | --- |
| Signal | the worst window value of the budget on each UTC day with landings |
| Formula | after 7 closed days, every one at or under the line: max(worst day, the value judged now, median + band), rounded up to two significant figures; band = max(3 × 1.4826 × MAD of the 7 days, 15% of the line) |
| Bounds | never above the file `max`; never below the worst held day or the value judged now |
| Undo | a window over a ratcheted line but at or under the file `max` undoes the ratchet (back to the line before it, or the file `max`) with a reason and one message; only the file `max` opens the P0 Issue |
| Override | `"ratchet": false` pins a budget to its file `max` and drops any ratcheted line; editing its `max` in `src/speed-budgets.json`, with data and reason, drops the ratcheted line and restarts the hold |
| Record | the row keeps the line, the file `max` it tightened, the line before it, the landing, the time and a one-line reason; the stall-alert channels get one message; no Issue opens. Each undo also keeps its flow record (the last 4 per budget): the day, the tightened line, the line it went back to, the landings that landed while the tighter line held, and how many of their outcomes it changed. A speed line only sends alerts, so that is 0; a future reader that gates or holds on a line must count what it changed (the reader list in `tests/speed-budget-shift-waste.test.mjs` fails until it does) |
| Report | `nforge metrics` prints `value / file max (automatic line)`, the date it ratcheted, the held days left before the next ratchet check, and for a pinned budget what the automatic rule would pick |

The band floor exists because the signal is a smoothed rolling percentile: on a quiet week its day-to-day MAD
is near 0 and a pure MAD band would set a line a normal day breaks. Check time and runner minutes also grow
with every test added, so the undo keeps ordinary growth from turning a tight line into a standing P0. A closed
day over the line restarts the hold, so a line moves at most once a week. The row gains about 200 bytes per
percentile budget (about 1.6 KB with full holds), read and written by the landing that already reads and
writes it: about 3 KB more DB I/O per landing, about $0.0006 per 1,000 landings at $0.20/GB. `nforge metrics`
reads it once per metrics call (one indexed read of a few KB, on the first acceptances page).

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
previously needed two at 29k. `source-legacy-recipe-sync-actions` applies the same
one-action ceiling to a legacy recipe base without a trusted closure projection;
its control-call ceiling is ten, including legacy recipe descriptor pages.
`source-recipe-retained-extra-bytes` allows at most 64 KiB of retained physical
metadata beyond the assembled logical body at every source manifest-byte envelope.
Verified leaves share the logical allocation. `source-recovery-output-bytes` guards
a real 29k save plus resolve at 1 MiB of new output bodies, with no extra control
RPCs and at most twelve PUT bodies. These thresholds select runtime work, not user
capability. The 16 MiB inline input bound is unchanged. They count source actions, not complete CLI operations;
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

`source-sync-metadata-merges` permits one exact metadata merge per calculation round, shared by
composition, docs handling, drafting and conflict details. `source-chain-control-calls` permits fourteen function executions after preparation.
`source-chain-node-actions` permits one Node action for a bounded 29k save plus resolve. `source-chain-extra-read-bytes` permits
128 KiB beyond the save's one draft-State read across that cycle; the resolve reuses its saved
and draft States. The isolated real-handler fixture exercises a fresh action process, counts
actual synthetic R2 bodies and checks authority changes, marker rejection and retry safety.
The 16 MiB retained-input routing allowance, source envelopes and 512 MiB action allocation are
unchanged. Independent-chain fallback remains available; these guards add no source restriction.

The admission default guard drives the production queue and audit controllers with
three clean, mixed-arrival timelines. Central `admissionQueueOnly*` budgets cap
checks, rounded CI minutes, audits, transactions, document I/O and maximum
submit-to-land time relative to check service. Explicit full-admission incident
fixtures keep their existing assertions. Red-change sensitivity is measured
separately: the clean-wave caps do not claim queue-only admission is cheaper when
changes frequently fail. See [the decision](../pre-queue-checks.md).

## Exact-conflict early-resolution guard

`tests/hosted-early-resolution-speed.test.mjs` replays a synthetic conflict trio
through the production queue, source and acceptance machinery under a fake clock.
The central `earlyResolveLateTaskToMainMs` ceiling is the 360-second remaining
predecessor wait: `max(360, 75 + 180)`. Deferred resolution takes 615 seconds,
requires two author resolutions and uses the same three checks. Restoring the
accepted-main advice implementation makes this guard fail. Paired disjoint
controls assert identical calls, document reads/writes and checks, including
1,150 retained receipts; conflict controls assert no history-sized I/O. This
replaces idle exact-conflict advice without raising existing latency or cost
budgets. The numbers are modeled relative times, not a service measurement.

First checks, preflight, standard scoped selection and scoped rechecks classify JSON data
through import/file paths, conservative basename readers, directory loaders, computed filenames
joined to JSON folders and matching globs, including transitive helpers. A recursive listing of
the repository root reaches JSON files across the inventory. A literal filename suffix
filter limits coverage when the reader uses those filenames directly. Each unproven read
keeps conservative coverage. A non-Markdown,
non-JS/config reader naming the JSON retains full coverage when present in the supplied inventory;
the standard inventory includes package files but excludes shell, YAML and workflow files.
Unknown or unobserved data stays broad. JSON reach stops at static tools reached through a
non-import edge: those tools run on every Candidate. JSON imports retain pipeline coverage.
The verify orchestration boundary applies only to document JSON; non-JSON packagers keep
their previous pipeline coverage.
Selections still include shared readers, own tests, Intent contracts and fixed smoke, with
remaining full-suite recheck tests recorded as main-audit debt. This changes test selection only;
queue admission, ordering, cancellation, waits and pass-reuse rules are unchanged.
