# Run evidence

A passing command, the tests that command reports and an agent's own verification
claim are separate facts. Forge records the command outcome against exact source.
Test-file counts, coverage and file timing from the checked code are self-reported
via CI. They are not independent measurements by Forge. CI time is reported by
the runner; the interval between Forge's recorded timestamps is observed by Forge.
Missing test reports mean **not reported**, even when an older runner retained an
empty report summary. They do not mean that zero tests ran.

On **What was checked**, shard progress uses the run’s recorded plan total when available.
The check scope, selection reason and names requested by the planner appear separately
from CI’s test-file reports. A full check selects the configured command. The file
report establishes only which files the checked code reported. The header also
summarizes the verification limits the agent declared on the selected save or landing.

Use `nforge agent . save '{"notVerified":["Windows tests were not run"]}'` to report
verification limits on an exact save. Use `nforge agent . land --save` with the
same JSON field to attach the claim to the landing request, including when the
checkout is already saved. For MCP `forge_task`, put the field in `command`
with `action:"save"` or `action:"land", mode:"save"`. Send up to 200 lines,
each up to 256 UTF-8 bytes. For check-only work, report the claim with `save`.
Read the full receipt with CLI `--detail` or MCP `replyDetail:true`.
Replay with the original claim and operation ID. For a new landing after
resolving a conflict, report verification limits on the resolved work.

Saves retain `notVerified` and any `outside` declarations on the immutable
save and its original terminal receipt,
with the authenticated author and exact source head on the save. The receipt links
to that immutable save through `saveId`. Retrying the original request
returns the same claim. They add no approval or landing block.

- Omit `notVerified` when the agent has not reported its verification limits.
- Send `notVerified: []` when the agent claims it verified everything it changed.
- Send a list of strings to describe the work it did not verify. This is an agent
  claim, separate from recorded check evidence.

`outside` contains `{kind, what, where?}` summaries. Kinds are `deploy`, `migration`
and `external-setting`. Forge records that the agent made the report; it did not
observe or authorise the external action. Summaries redact token-shaped values,
URL details, private paths and private hostnames. Do not send credential values,
private device labels or settings payloads.

The proof read returns the exact save and check source pins. A composed Candidate
can contain more than one Lane: a claim is never silently moved from its save to a
different checked head. If the association cannot be established, the page says so.

The proof page’s full-check action requests a fresh execution of the configured
command on the original Candidate and source pins, even when an older pass is
reusable. It does not land, change policy or substitute current main. If those
check or runner pins are no longer available, the existing structured error is
shown. Retries use one operation identity derived from the original run.

The check screen links to proof for its displayed run. The proof page uses the
existing receipt-based revert operation directly: it creates a new checked landing
that removes the selected change and preserves later work. A lost reply retries
the same operation; no additional review step is introduced.

The original landing request retains its own declarations without forcing a
redundant save. CLI and MCP send claims to servers advertising `save-declarations`.
The proof page gives that request's declaration precedence, binds it to the
accepted source, and links follow-up Items to the immutable landing identity.
Older requests continue to mean “not reported”. Outside summaries are sanitized
before replay identity and persistence on both paths.

Compact successful landing receipts use `selfReportedTestFiles` for the number of
test files reported by the checked code via CI. `null` means no file report, not
zero tests executed. Failed/flaky details keep their source label; `--detail`
keeps the complete original record, including zero counts.

## Stats

Stats shows a project owner what Forge measured in their project, and compares it with the same
project's own history replayed through two GitHub setups, each named by how it merges. The comparison
never applies the published benchmark's ratios to a project: a project is not the benchmark.

### Measured figures

Facts from the project's check runs and accepted landings, each with its unit:

| Figure | Unit and source |
| --- | --- |
| CI minutes per landing | Runner minutes of every check run started on the days shown, divided by the landings. Failed, cancelled and discarded runs count; main audits do not. Beside it, the landed path alone: a landing's accepted check plus the checks it discarded. |
| First try | Share of landings that landed with no resubmission and no discarded check (`src/stats-estimate.ts#firstTry`, the one rule metrics 5.1 uses too). A resubmission is an earlier submission of the same Intent that ended without landing since the Intent's previous landing, or a `supersedes` link; a failure before that landing counts against that landing only. A discarded check whose minutes are not known yet still counts as discarded. |
| Time to main | Median from "land" to on main, observed by Forge, with its stops: in queue, checking, landing. |
| Agent tokens | Shown only once an agent reported: the tokens agents reported with `land` (an optional whole number, at most 1e9, kept as one column on the landing row; never billed), per reporting landing, "measured from N of M landings". Summed by the day close from the landing rows it already reads (about 40 B more on a day row with reports, nothing on one without). Never a per-project GitHub comparison: the page links the published benchmark for that. |
| Discarded checks | Runner minutes of every run that did not land, by cause: main moved (Forge rechecked the same save), failed, cancelled, superseded (replaced or withdrawn). A run still waiting when the day closed is counted, not discarded. A run no landing attempt names (run by hand, or a pre-queue check its landing did not reuse) is counted on Forge's side as "not tied to a landing", never discarded. |

A run whose runner minutes are unknown is counted and adds nothing ("12 runs without minutes", by
cause); it is never priced as zero. A cancelled run whose minutes arrive after its day closed adds them
to that day's every-run figures, in its own cause, once (`lateRuns` on the day row). The landing's
discarded minutes are credited separately to its acceptance day. Closed-day adjustments are best
effort. If a day row is unavailable or invalid, the cancelled run and the landing still retain
the reported minutes. A later correction can use the last values the day counted if a previous
adjustment failed. A day whose runs
could not be read (closed before every run was recorded) leaves the CI figures and is counted: a
window of such days shows "not recorded" and why, never "landings to go". A day the close read only in
part (past a cap) is marked `partial`, and the page says so once, on hover over the headline's "Some days read in part" marker (never as
repeated sentences). Which reader stopped a day, and why, is recorded on the row (`stoppedBy`, from
`src/stats-runs.ts#STATS_STOP_CAUSES`: `landings`, `runs`, `unprojected`, `attempts` or `lookups`, each by its own
row `cap` or by the transaction read `meter` shared with the person days, and `instant` for a full page of rows at one
shared time). Once the meter is spent every later reader stops on it too, so the first reader in the close's order
that names the meter is the one that used the room (`convex/projectStatsRuns.ts` `pages`, `statsDayRuns`;
`convex/projectStats.ts` landings loop). Check runs left unread make
runs and CI minutes a lower bound; landings left unread make landings a lower bound, CI minutes per landing an upper
bound (every run, over fewer landings), and leave first-try rate and times covering only the landings read. The
minutes saved are an upper bound when check runs went unread (Forge's minutes are short), a lower bound when landings
did (the replays price only those read), or may go either way when both did. A month holding such a day is marked in
By month with that direction. A day whose close did not finish is not measured: it is in no figure, the per-day chart
draws it as missing (never zero), and By month counts it.

A resubmission of the same declared Lane selection carries its predecessor's latest check seconds
and earlier discarded seconds into its own discarded total. Replays and joins of a live submission
do not add them again. If the successor reuses the exact same run, those latest seconds stay accepted
usage rather than being counted a second time as waste. A predecessor that never requested a check
carries zero. An unreported execution carries the reason `superseded-check-execution-unreported`;
later passes do not turn that missing usage into zero, and Stats excludes it from CI figures.
Older resubmissions that lack a discarded-usage stamp are unknown too; their predecessor link
identifies the missing carry, rather than implying zero waste. A recorded zero remains known on reuse.
`nforge agent ROOT landings` reports accepted and discarded runner-minutes from the existing
landing record, including each batch member's share. A cancellation awaiting GitHub provider usage shows
`pending` (`runnerDiscardedPending: true` with `runnerDiscarded: null` in JSON). Missing usage
without a pending cancellation shows `unknown`, including cancelled checks on providers with no final usage collector.

On deployments with `FORGE_COMPACT_DISCARDED_CHECKS=1`, replacing a completed check inside the same
landing also carries its reported discarded usage or the reason above. This applies to solo checks,
shared checks, and a checked member whose old attempt returns to the queue. Reusing the exact check
preserves its accepted usage. The existing request and observation rows fold the reason into the
stored counts tuple. Readers expand both forms to the same public fields, including after the
switch is turned off. The transition uses the same run evidence and writes as the existing queue.

The carry uses the predecessor row already read during selection. A small server-only checkpoint
on the existing desired/request row resolves exact-run reuse when the successor binds its solo,
admission or shared check, inside that binding's existing write. It adds no function call, document
read, table, timer or idle work. It carries CI usage only; compose request counts keep their existing
scope. All carried waste is charged once to the successor's accepted UTC day, including when its
submission and predecessor checks were on the previous day. Previously closed days are not rewritten.

### By agent

The fold groups accepted landings by declared agent app and model or by Forge person. A setup whose
receipt has no model says “model not recorded.” Older day and month summaries held run names and
grouped by-hand work together, so their landings appear in Other with that reason. A normal day close or
the existing re-close uses the attribution already on the landing receipts.

The table ranks rows by landings. Other combines setups and people with fewer than five landings in the
period, older summaries, missing attribution and attribution past the existing summary bounds
(40 groups per day, 200 per closed month). It names the landing count for each reason it contains.
First-try rate uses landings with recorded attempts. The median measures time from the land request to main.
All-time medians marked approximate use weighted samples from closed months. CI minutes come from the
accepted check and discarded checks tied to each landing, including its share of a batch. Landings without
either cost figure are excluded from the CI average. A row gives its sample count when any measured figure
covers only part of its landings. A hint appears when at least five attempts were recorded and the row's
first-try rate is at least 20 percentage points below the project's.

Closing the day and rolling the month use their existing reads and writes. Opening the fold uses the existing
range or All time query. The response uses Forge's public identity mapping for each distinct displayed person.
There is no idle work.

### Own-history replay

The contract is `src/stats-estimate.ts` with `src/stats-runs.ts` (Item `a61d3c91`). It is pure and
display-only: never an input to a verdict, a queue or a bill.

- **Price of a run.** The median billed runner seconds, and the median time, of the solo full checks
  in the window: runs that checked one change, ran the whole command and passed. A batch share or a
  scoped recheck would understate a GitHub run.
- **One at a time** (like GitHub's "Require status checks to pass before merging" with "Require
  branches to be up to date before merging"). One run per change, a rerun each time another change
  reached main while it waited (from Forge's recorded times), and one run per failed check. Changes
  reach main one by one, each taking the check time; the queue carries across days. When the check
  time asked of the queue exceeds the day (the method states the load), this is a growing backlog:
  shown only as the worst case.
- **Merge queue, N at a time** (like GitHub's "Require merge queue" with "Build concurrency", the
  maximum pull requests to build, N: the project's own `checks.concurrency`, default 6, read at each day's close and
  kept on the day row as `replay.width`; days closed before it was kept replayed 5. A period whose days used
  different widths names the range) and "Maximum pull requests to merge" 1. The page labels it "Merge queue, N at a time
  (your setting)". Each change first runs
  its pull-request check (one check time), then joins the queue: up to N entries build at once, each on
  top of those ahead; an entry merges when its build passed and every entry ahead merged.
  - A change's own failed check fails its pull-request run and never joins the queue. A recheck that
    failed here because main moved after the change passed (the attempt records a main-race
    `recheckReason`, and the same submission has an earlier passed run that day) fails in the queue at its
    own time: it is ejected when its build ends (at most one check time; at once when it took none), and
    the builds behind it restart. A child attempt alone is not enough: Forge also forks one to join a
    batch, to fall back from one, or to restart a stopped check, none of which had passed.
  - Builds are counted as full-check equivalents: a build cut short by a restart counts the share of a
    check it ran, and a failing build its own failed time.
  - A backlog carries into the next day slot by slot: the last 5 merge times hold the first slots.
  - The headline uses this setup. Its median time to main is also stated with the check 10% faster
    and slower, each replay carrying its own state from day to day.
- **The same on both sides.** Checks of work that was replaced, withdrawn or stopped, and failed
  checks, at the minutes they took here. Work abandoned before it would have reached a GitHub queue
  costs GitHub nothing more than these.
- **Forge's side.** Every check run started on the same days, audits apart (a run whose gate mode is
  `audit`, whatever its state); runs without minutes are counted and named.
- **Time to main.** From "land" to on main on both sides: on GitHub the pull-request check plus the
  queue, on Forge the one check. Forge's median is over the same days as the replays.
- **Tokens.** Not shown until agents report measured usage; never a per-project estimate.
- **Left out.** Review time, and time spent before a change asks to land, on both sides. A failed
  recheck after main moved counts as a queue ejection only when every change on it had passed that day
  (a batch with one change that never passed fails that change's pull-request check on GitHub instead),
  whatever failed it, a flaky test included, as on GitHub: a run's flake record names tests that passed
  on retry, not why a run failed. Checks still running or waiting to
  land when a day closed count on Forge's side that day; GitHub's side counts their change on the day it
  lands. Days with no solo full check to price them leave the comparison, and the page says how many.

The comparison starts at 50 landings in the window (`STATS_COMPARE_MIN_LANDINGS`); until then Stats
shows only the measured figures.

### Interface

- `StatsLanding`: one accepted landing from fields its receipt and landing row already hold
  (`submittedAt`, `landedAt`, check start and end, `runnerSeconds`, `discardedRunnerSeconds`,
  `attempts`, `ranInFull`, `who`, and the agent-reported `tokens` when it sent any). `null` means unknown.
- `classifyRuns({runs, attempts, landedAttemptIds, pendingSubmissionIds, unreadSubmissionIds, partial})`:
  every run of a day by what became of it, its solo full checks (passed, the whole command or no gate,
  one change, minutes known), its rechecks that failed after main moved and its runs without minutes.
- `mergeQueueReplay(entries, wallSeconds, concurrency, tail)`: the queue replay over entries
  `{at, fails, from?, seconds?}`; `tail` is the previous day's last merge times. It returns each passing
  entry's time to main, the builds run as full-check equivalents, and this day's tail. Concurrency 1 is
  one at a time.
- `statsDay(day, landings, runs, carry)`: one closed UTC day as a `StatsDay` (`statsDaySchema`,
  schema 2): counts, sorted seconds for medians, every run by cause, the solo checks, both replays
  and what the next day starts behind, and the setup and person breakdown. A
  day past 1,000 landings (`STATS_DAY_MAX_LANDINGS`), or past the runs the close reads, is marked
  `partial`. Days closed by the
  first method (schema 1) stay readable and leave the CI figures, counted (`daysWithoutRuns`);
  `projectStats:recloseDays` rebuilds them.
- `statsWindow(days)`: what Stats shows for a window of closed days: `measured`, `comparison`
  (null under 50 landings, when a day was not recorded, or with no solo full check to price it;
  `compare.gap` names which).

Days are additive (`dayTotals`, `addTotals`, `statsFigures`), so a range's figures are the sum of its days and its
medians are exact. A closed month is also kept as one rollup row (`projectStatsMonths`, `statsMonth`): its sums, and
each distribution as at most `STATS_DIST_SAMPLES` (400) evenly spaced quantiles weighted by the values they stand for,
so a month's medians stay within one sample's share of exact.

### When it is computed and what it costs

A day closes once, when the project's first landing of a later UTC day is recorded (`convex/projectStatsClose.ts`):
one scheduled mutation per active project-day and nothing for an idle project, so the newest active day shows once the
next one starts. A day with check runs and no landing is closed first, by the next landing day's close (two one-row
probes, skipped when the previous closed day is the day before; then that day, then the landing day). Days before a
project's first closed day are not closed. Such a day is first written as not measured (`failed`, try 1), so a close
that throws leaves that mark: each later close tries it again first, up to `STATS_CLOSE_TRIES` (3), then goes past it,
and one failing day never stops the days after it. The close reads, in this order:

- the day's receipts (one range, at most 1,001);
- a person's day (docs/people.md): the Lanes and planning work since the previous closed day, each under its own caps;
- each landing's row, its own columns only, never its body pages (about three documents and 7 KB per landing with its
  receipt);
- the newest earlier submission of its Intent (one row, own columns only; up to `STATS_RESUBMIT_LOOKBACK`, 3, only
  behind a submission still running);
- the day's check runs from the compact metric rows (about 1 KB each; at most `STATS_CLOSE_RUNS`, 3,000, 200 a page)
  and the run rows not projected yet (at most 200, one a page: one can be near Convex's 1 MiB document limit with a
  shard pool's 4,096 pending paths);
- the landing attempts around the day from the compact attempt rows, or the attempt rows themselves while the
  project's compact index is being built (at most 6,000);
- one compact landing row per submission whose passed run neither landed that day nor was rechecked (at most 300).

Run rows written before their compact projection (the oldest days) are first projected, at most 8 a page and each
page in its own transaction (`projectStatsRuns.ts#projectDayRuns`, the close schedules itself with a cursor), so the day's
reading transaction finds compact rows: a full run row (about 90 KB on a busy day) used to spend the shared read meter
and leave the day partial (dev 30 Oct to 10 Nov, Item 3678767e). Cost: a page reads and patches 8 run rows (about 1 MB);
a day with no legacy rows pays one empty indexed read and no extra call, at 100 or 1,000 landings a day alike. New
runs project when written, so only a day closed from legacy rows pays this, once: with N legacy runs it takes
ceil(N/8)+1 extra scheduled calls, N run-row reads and N patches (about 0.09 MB each on a busy day; 1,000 legacy
runs is about 90 MB read and written once, about $0.04 at $0.20/GB).

Every read counts on the transaction's own meter (`ctx.meta.getTransactionMetrics`: Convex's 4,096 queries, 16 MiB
and 32,000 documents). The landings stop while 1,000 queries, 5 MiB and 1,000 documents are left
(`STATS_LANDINGS_KEEP`), so the person-day writes and the runs have room; the runs, attempts and lookups stop while 64
queries, 2 MiB and 400 documents are left (`STATS_RUNS_KEEP`), room for one more page and the close's writes: a
close reads at most 14 MiB and one page, about $0.0029 a day at $0.20 per GB. The person-day writes (one query and one write per person and day)
are on the same meter (`STATS_PEOPLE_KEEP`: they stop while 700 queries, 4 MiB, 1,000 documents read, 200 documents or
2 MiB written are left): a day with thousands of people still closes, its figures whole, the person days it had no
room for unwritten and the day marked `peoplePartial`. A close after a day left not measured reads that day's Lanes
from where the failed close would have read (its mark keeps `since`), so its people's work is kept and marked partial.
`tests/stats-close.test.mjs` drives a day with every reader at its cap through one close at Convex's own limits.
Anything past a cap or the meter is not guessed: the day is marked `partial`. The close then writes one
`projectStatsDays` row.
`projectStats:recloseDays` rebuilds closed days only (it refuses today and later).

Today counts so far (Item 580b1a1a). Opening Stats on a period that holds today calls
`projectStatsToday:refreshToday` once. That mutation reads today's row and at most one receipt.
It schedules the same close over the open UTC day only after a landing since the last such close,
at most once every `STATS_TODAY_REFRESH_MS` (60 min). The shell's feed already rules out a day with
no landing, so most opens make no call. The close writes today's row marked `provisional` with the
time it covers up to. It probes no earlier day, judges no day budget, rolls no month and keeps no
late-correction lists; it does write the same person days, which the real close replaces.
The first landing of each later UTC hour (a new day's first too) also schedules it for the end of
that hour (Item 8d21cc9e), from the landing's speed record, which already knows the previous
landing's time and so reads nothing more. Today's row then counts every landing up to the last full
active hour, whether or not anyone opened Stats: it is short by at most the current hour's
landings, and the screen states the time it counts up to ("Includes today up to 18:00 UTC."). A
provisional close runs at most once per UTC hour, whichever asks; one scheduled for the end of
23:00 runs after midnight and writes nothing, and a new day's first runs an hour after the
previous day's close. Idle projects schedule nothing.

The day's real close after midnight UTC replaces the provisional row with a fresh row. No month
rollup, late correction or Lane backfill reads a provisional row. A later close that finds an
earlier day still provisional marks it not measured (try 1) and closes it first, as for a gap day.
A refresh scheduled twice before it ran, or one that runs after midnight, writes nothing. A re-close of a day still
provisional rebuilds its figures and leaves it provisional. Metrics reads the day-budget ratchet from the newest
closed row (it reads the newest two rows).

Measured in `tests/stats-today.test.mjs` with two check runs per landing:

| Day | Open (one call) | Provisional close (one call) | DB I/O a close | Worst day, 24 closes |
| --- | --- | --- | --- | --- |
| 200 landings (dogfood) | 3 documents, 4.4 KB | 1,243 documents, 430 queries, 2 writes | 1.40 MB, $0.00028 | $0.0067 |
| 400 landings (doubled) | 3 documents, 4.4 KB | 2,445 documents, 832 queries, 2 writes | 2.72 MB, $0.00055 | $0.013 |

A close is capped at 14 MiB (about $0.0029), so 24 a day cost at most about $0.07 per project. Since
the hourly close (Item 8d21cc9e) the worst-day column is what an active day costs whether or not
Stats is open: one scheduled close per active hour, so on the dogfood day (130 landings over 19
hours, closes reading 65 landings on average) about 9 MB and $0.002 a day, about $0.014 per 1,000
landings. A day with no landing runs nothing: no cron, and no read added to the landing.
A month's rollup is written by `projectStats:rollMonth` (at most 31 day rows read, one write): scheduled by the first
close of a later month, or by a reclose that rebuilds a month's last day or the end of its run. An idle project
schedules nothing, and a month with no closed day has no row.

The Stats screen has one period picker (last 7 or 30 days, this month, last month, All time, or a custom range of at
most 92 days), kept in the address. All time (`projectStats.readAll`) reads the month rollups (at most 240) and the
newest open month's day rows (at most 92), never every day row, and draws landings per month. Opening the page makes one query (`projectStats.read`, part `head`) over the chosen
period's day rows only: the headline figures and landings per day. Where work waited, By agent and By month are folds,
shut by default; each reads its own part of the same rows only once opened, so an unopened fold costs nothing. A
range also has "Against the days before", a fold setting it beside the same number of days just before it (landings
per closed day, first try, median time to main, CI minutes per landing); opened, it reads the previous range's day
rows too (at most 184 rows for the two), and its method is on hover only. A read
re-runs only when a day inside its period closes or today's row is refreshed; it takes no clock argument.

The headline is the merge queue's CI minutes and the median time to main: "2,345 fewer CI minutes than a GitHub merge
queue would have used for these 3,000 landings, 1–22 Nov. Changes reached main 12 min sooner (median)." It names the
whole period only once every day of it is counted; until then it names the days counted ("1–22 Nov"). One at a time
stays in the chart, and replayed figures are marked as estimates there. Below a comparison the headline counts
landings over the closed days ("over 17–18 Nov 2026 (2 closed days)"). A day left not measured is not a closed day:
it is in neither the span nor the count, and a period holding one has not wholly closed. One line says how far the
figures reach: "Includes today up to 10:00 UTC." when the period holds today and today's row counts so far, otherwise
"Through Sat 21 Nov.", the newest day counted. Landings today are the live figure the top bar shows (Item 6bd1cf57: the
shell's feed Stats already has, no extra read), in the page count and today's bar; the hourly close keeps the derived
figures (first-try rate, CI minutes, medians, the comparison), which carry "as of 10:00 UTC" (or "through Sat 22 Nov"
before today's first close) beside them, and the line then reads "Landings are live; the other figures count today up
to 10:00 UTC." Every "today" in the app is the UTC project day (`sameUtcDay`, `mainToday` in src/flow-day.ts).
When today's landings are the only figures for the period, Stats leads with their live count. While the first
hourly summary is pending, it explains that opening Stats requests that summary and later active hours are
summarised as they end. Once the provisional summary arrives, Stats shows the time it counts through. The reporting
day ends at midnight UTC. A range trend becomes available when both the selected period and the same number of days
before it have summaries. Coverage labels count the provisional summary as a partial day. A range with no figures
offers a longer period. A today-only range with a reported live zero says no landings were reported today.
By agent shows agents in four first-try buckets (100%, 75–99%, 50–74%, under 50%), never a list per agent; each landing's own
time to main and stops are on its Lane page.

## The value story (Item 3678767e)

Stats opens with what the replayed merge queue at the project's own width would have cost and taken, from this
project's own history (never the public bench): "Since 28 Oct, Forge saved about $X of CI and N hours of waiting to reach
main." Dollars are the minutes saved times GitHub's list price for a standard Linux 2-core runner
(`src/stats-pricing.ts`: one dated constant with its source URL, read from GitHub's pricing page), shown for every plan
and public repositories too; a hover says free or included minutes and discounts may mean the project pays less.
The width costs two small reads per day close (the project row and its newest policy receipt), at most 50 a
project-day (24 so-far closes and the final), the same at 100 and at 1,000 landings a day; views add no call. Hours are the median seconds saved to reach main times the landings, stated in hours with no money value: that time is
productivity people and agents get back. Each card leads with its percent against the merge queue at the same width,
then the one-at-a-time worst case.
