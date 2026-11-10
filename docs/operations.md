# Operations

## Backup and recovery

An export holds the full retained source States, Work, check results, failure summaries, compact test evidence and links to the CI provider’s logs. Full GitHub Actions logs stay with the provider. Local logs are included only when explicitly enabled for the project and within finite retention.

Hosted projects keep their backups on the server; see [hosted backup recovery](#hosted-backup-recovery) and [project retention and restore](#project-retention-and-restore). Forge runs hosted projects only, so there is no local Work export.

### Hosting and Work index progress

`nforge host ROOT --new --json --wait` emits `host-progress` JSON lines while
building the hosted Work index. `indexBuild` gives `buildPhase`, the current
`field` when applicable, committed records `done` / `total`, durable `step` and
`stepsPerSecond`; the top-level object counters mirror those record counts.
For parent traversal and summaries, totals come from the generation's
`metadata.counts`; initial record totals come from the pinned record catalog.
Parent totals can grow as retained ancestors are discovered. Cleanup counts
collections. ETA covers the current phase/field, uses newly observed progress
and resets on a phase/field change or command restart. It is unknown until a
second advancing sample, rather than timing previously saved work as fresh work.
Only fixed labels and counters appear in progress. No progress-only Convex call
is made. Hosted reads, briefs and source-return index refreshes also consume
continuations and report the same counters; exchange transports report them as
`host-progress` events on stderr alongside their existing progress callbacks.
`host --status` retains the latest index counters when hosting is interrupted.

Hosted native record checkpoints above 2 MiB build their disposable Work index
from server-held record pages. Each step reads up to 50 records (a 256 KiB target,
with one indivisible record when larger), or a 2 MiB window of parent States in a
separate source action. Summary steps share
up to ten records, stopping after a 500-row / 500 KB output target or one second
of projection work. One unusually large record remains indivisible. Rows and
the next cursor commit together, and that mutation returns the committed
generation instead of querying it again. Staged RPC pages contain at most 500
rows / a 500 KB target. A killed command resumes the saved phase/field/record;
only its uncommitted in-flight step may repeat. Publication checks the original
backup and current Work revision and requires a completed cursor. Smaller and
legacy checkpoints retain their existing projection layout. `host` follows
pending ensure results before recording its binding and retains server error
codes/messages if indexing fails. The build and its staged-page cleanup install
no timer, scheduler or poller: only an in-flight command advances the cursor.
Existing post-publication retirement of obsolete derived generations remains
separate from the build.

During a reseed, transient platform/storage read errors retry in the current
call (three total attempts, with 50 ms then 100 ms backoff). If storage is still
unavailable, ensure returns a pending continuation with `retryable: true` in its
progress JSON. The generation stays building at its last committed cursor;
the running command's next ensure resumes it. Restarting the command uses that
same saved position. An uncommitted summary step repeats instead of publishing
incomplete provenance. Validation, access and digest errors keep their existing
handling. Backoff exists only inside an active call; idle builds schedule nothing.

Summary projection batches the common Lane/Intent record context and first
submission/acceptance pages for up to ten records. Context queries return a
complete prefix within a 500 KB target; remaining pages retain the ordinary
paged reader. Changed-file comparison resolves unique before/after pins together
in windows of at most 50 files, 100 pins and 2 MiB of eligible blob bytes. Blobs
above the existing 1 MiB exact-count threshold remain unknown. State reads use
100-pin / 2 MiB target windows (an indivisible State may exceed the target).
View provenance shares its first State window with the base/head comparison and
reuses that changed-tree result for diffstats within the same summary step.
Unavailable optional save States still fall back to incomplete provenance while
preserving an available base/head diff. Every actual batch retains the source
reader's before/after current-access and availability checks; projection caches
end with the step and publication rechecks current authority. There is no cursor
format change: an in-flight build resumes at its existing phase/field/record.

`tests/projectWorkIndex-calls.test.mjs` exercises the actual summary, ancestry,
source reader and diffstat handlers against generated local storage: 555 Lanes,
2,167 Views, 1,471 runs, 2,789 saves, 2,494 source States, 3,000 files per tree and
40 changed paths. It retains eager line counts and file provenance. The measured
summary-path function calls fell from 488,819 to 20,051 (24.4×): per Lane
168.61 → 6.71, per View 181.98 → 7.13, per run 0.60 → 0.60. Object resolutions
fell from 467,918 to 12,380. Local wall time was 54.57 → 35.76 s, with other
builders sharing the Mac; it excludes hosted latency and outer generation
load/commit calls. The largest source window was 1,040,969 bytes / 41 pins.
Applying those per-record rates to 150 remaining Lanes, 2,167 Views and 1,471
runs estimates about 17,335 summary-path calls, plus outer load/commit and any
remaining non-summary phases. This estimates metric 5.8's hosted-call cost;
it is not a billed dollar measurement. The resumable build retains its existing
zero idle work and publication guards (metrics 5.2/5.7); no live deployment or
landing measurement is implied.

The local synthetic benchmark in `tests/projectWorkIndex-progress.test.mjs`
uses 625 Intents, 555 Lanes, 2,789 saves, 2,167 Views, 1,471 runs, 2,001 actions,
572 landing entries and 2,495 empty-file source States. Its measured baseline
was 7,451 durable steps in 373 action calls and 11.05 s; bounded pages reduced
that to 959 steps in 48 calls and 3.73 s. Runs retain 2,580 payload chunks. The fake database observed
360,579 → 60,170 document reads and 75,632 → 68,496 writes, with
147,053 → 40,477 internal calls (19.7 → 42.2 calls per larger step). The longest
measured action was 157 ms; the 128 MB fixture stayed below 449 MB RSS. Its source/ancestry
calls use local fakes, so these figures measure projection and continuation
overhead, not hosted network latency or a production build duration. The
separate 128 MB record fixture checks the action memory and RPC page budgets.


Copy the whole export outside the project. It holds private history and check evidence, including opted-in local logs within retention, so treat it as private. Restore always writes to a new, unused directory. It validates every file against the manifest and recreates Lanes and Candidates. Unfinished commands are marked interrupted and never restart. The original owner is untouched, so keep it until you have checked the copy.

Not included: uncheckpointed edits, ignored credentials, dependency caches and disposable workspaces. Checkpoint what you want first. To move between machines, restore on the target.

A release export (source only, empty Work) is much narrower and is not a backup of Work.

An older CLI refuses an owner it cannot preserve. Upgrade by installing the new package in a separate directory and pointing it at a backed-up owner. To roll back, restore the backup with the old tools. Never let an older writer rewrite an upgraded owner.

### Source exclusions

Native capture and hosted checkout saves read nested `.gitignore` and
`.forgeignore` files without Git. In each directory, `.forgeignore` follows
`.gitignore`, with the same patterns, anchored paths, directory rules and `!`
negation. A Forge negation can re-include a Git-ignored path; excluded parent
directories must first be re-included.

A tracked file is source and is published, like on GitHub, whatever its name:
saves keep it and the GitHub mirror pushes it byte-identical. Publication leaves
out only VCS and Forge metadata (`.git`, `.forge`) and Forge's `private-artifacts`.

Built-in rules apply to new, untracked files, the same for every language: VCS
and Forge metadata, dependency installs (`node_modules`) and credential stores
(`.ssh`, `.aws`, `.azure`, `.gnupg`) are never saved. A credential-looking name
(`.env*` except exact templates, `.npmrc`, `.netrc`, `*.pem`, `*.key`, `*.p12`,
`*.pfx`, `*.keystore`, and `credentials*`/`secrets*` files that are not code) only
prompts a content check: the file's bytes go through the landing secret scan's
patterns, and a file without a credential (a test or public certificate, a
token-free `.npmrc`, `.env.development` defaults) is saved. A file with a private
key or a known token format is held (`secret-content`). Local credential files
(`.env`, `.env.local`, `.env.*.local`, `.netrc`) and files that cannot be checked
as text (binary keystores, over 1 MiB) are held by name (`sensitive-name`). To
save another held file on purpose, add an exact `.forgeignore` negation
(`!fixtures/key.pem`; a wildcard negation never re-includes it); the landing
secret scan still checks it. Local credential files are never re-included. Code modules named `credentials.*` or
`secrets.*` in any common language (`internal/auth/credentials.go`,
`src/Secrets.cs`) are source, and a `secrets/` or `credentials/` folder keeps its
code files. Build folders such as `build/`, `dist/` or `coverage/` are excluded
only when `.gitignore` or `.forgeignore` names them, so a Go `cmd/build/` package
is saved. A save receipt's `notSaved` lists up to 20 new paths that a built-in
rule left out although no ignore rule names them, with the total `count` and the
one-line `include` hint. `.forgeignore` itself is an ordinary source file. Local Git-worktree and GitHub source analysis
use the same nested rules; Git-worktree analysis also preserves local Git
info/exclude settings.

Ignored files are never stored, backed up or shared by a new capture. Ignore is
not privacy or access control: historical States and imported history keep their
original bytes. Already retained Git-ignored paths keep their existing capture
behavior; explicit `.forgeignore` exclusions also remove them from subsequent
captures. Source materialization, exports and hosted exchange use the resulting
immutable States, rather than re-reading ignored working files.

`nforge status ROOT` reports local ignored-path counts for `.gitignore`,
`.forgeignore` and built-in rules. `--ignored` lists the excluded paths and matching
rule/file/line, without reading their contents. JSON includes `ignored.counts` and,
when requested, `ignored.paths`; MCP pending status accepts `ignored:true`.
These are filesystem-rule counts: a pruned directory counts once, its children
are not traversed, and historical retained-path exceptions are not included in
this local inventory. Built-in counts include protected metadata/build directories.
Status makes no hosted calls.

### Flake evidence and quarantine

Native checks and GitHub Actions/BYOCI shards use the same test verdict
assessment. The file supervisor waits for the initial files to settle, then
retries each failed file once, sequentially in the same workspace and environment.
The default budget is three files (`FORGE_TEST_MAX_RETRIES` overrides it). If more
files fail, none are retried. This budget belongs to one supervisor invocation;
separate hosted shard jobs do not share it. Each attempt keeps the existing
600-second per-file timeout (`FORGE_TEST_FILE_TIMEOUT_MS` overrides it).

Fail then pass records a `flake`, including its first error (up to 2,048 UTF-8 bytes)
and both attempt durations. This same-execution evidence uses unchanged Candidate
bytes, including when the Candidate changed test dependencies from its base.
Two supported flakes within seven days feed the existing quarantine ledger for
the exact `file :: test name`; a recovered import or timeout uses the file execution
identity. A persistent failure stays `failed`.

Hosted `contractReports` retain every named failure, including incomplete files;
only complete files contribute contract timings. `testFiles` in run and landing
receipts separates failed and flaky file lists and their counts. The existing
`counts` field still counts shards. Clean summarized files remain represented even
when their passing test names have been removed. All file evidence travels in the
existing result writes; a clean check adds no Convex calls.

#### Weekly flaky list and the same-day Issue

`nforge metrics ROOT` (default window: the last 7 days) ends with a flaky-files
section: each file that failed once and passed its single retry, with the number of
runs, the latest run ids (up to five), attempt durations, the latest first error
(up to 512 characters) and the execution id. A file that stayed failed is a failure
and is never listed as a flake; a recovered file is never counted as a clean pass.
The list is built from the check run rows the runs page already returns
(`projectSelfMetrics:page`, runs stream): a metrics read makes no extra call and a
check makes none either. A run lists at most eight flaky files (its true total is
kept) and the list shows the 50 most frequent. A deployment without this projection
shows the list as partial instead of empty.

Each listed file carries the same-day step: search planning for the file name
(`planning {"search":"FILE.test.mjs","status":"all"}`), comment the run ids on a
match, otherwise file an Issue with the file, first error and run ids. With
`--flake-issues`, `metrics` runs that search itself (one planning search per listed
file, at most ten, opt-in; the default read makes none) and prints only the flake
list, each file with its matching Issue, a look-alike to check before filing, or
"no Issue found: file one today". It reads only the check runs stream (about one call per
100 runs in the window, one day of context, no bills, placement or input hydration) instead
of all eight metrics streams. It cannot combine with `--limit` or `--compare`.

`metrics` replies are boundable: `--limit N` (`limit` in `nforge agent ROOT metrics`,
1 to 200) pages every row list in the window totals (waste, landings by path, authority
lag) by one shared offset, and `page.nextCursor` continues the same `from`/`to`.
Counts and totals are whole on every page; the per-day sections keep their counts and
report `rowsOmitted` instead of rows (a one-day window returns them). Paging bounds the
reply, not the read: each page recomputes the report from the same hosted pages.
The whole `metrics` action, capability discovery included, ends within 100 s (under an
agent shell's two-minute limit). The window bounds the read, and so does the context horizon:
besides the window, each of the eight streams reads `contextDays` of earlier history (default 2,
`--context-days N` or `contextDays` up to 30) to classify landings by retries, fixers and Lane
inputs. The streams are read side by side, so the wall time is that of the slowest stream (check
runs, whose pages are byte-limited). Measured on the dogfood project (35 landings in the 5 h window):
the page reads for a 5 h window with a one-day horizon were 78 calls and 24 s one after another;
the whole action with `contextDays: 1` (streams side by side, bills, placement and input
hydration included) took 24 s and returned exit 0, where the fixed 30-day horizon read about
366 pages and timed out for a 2 h window. Landings whose Lane history is older than the horizon
show path `unknown` rather than a wrong class, and the coverage
gap names the horizon actually read. A deploy older than this change reads 30 days unless `contextDays` is 1;
the coverage gap then says so. A window that still does not fit ends with `METRICS_TIMEOUT`, changes
nothing and names a command for the later half of the window with a one-day horizon.

Read bound (Convex calls and documents per call). Every `projectSelfMetrics:page` call reads at
most 100 rows and 512 KB (`maximumRowsRead` 100): the lanes and saves streams also get one body
per row (at most 200 documents), the first acceptances page adds at most 100 main-audit events,
and the first receipts page adds three point reads. A window reads about
`ceil(rows / 100)` pages per stream over the window plus its `contextDays` horizon, eight streams
side by side, then one bills page (`projectSelfMetricBills:page`), one placement query
(`projectBytePlacement:convexWritten`), two start-up queries (channel, capabilities) and
`projectObjectDownloads:signDownloads` calls that hydrate Lane inputs from R2 (at most 8 objects and
1 MiB per call). Measured on the dogfood project during a 7-builder wave (default `contextDays` 2,
installed CLI, dev): a 6 h window took 39.5 s with 132 page calls and 43 sign calls; a 24 h window
took 47.5 s with 145 page calls and 49 sign calls, exit 0, a 342 KB reply. The context horizon,
not the window, is most of the pages, so 24 h costs only about 10% more than 6 h. Writes are zero and
an idle project makes no call. Any window that does not finish inside the 100 s deadline ends with
the structured `METRICS_TIMEOUT` (nothing changed) whose next step is the printed command for the
later half of the window with `contextDays: 1`; `--limit` pages the reply, not the read.

Waste counts a main race by what it cost. When the replacement attempt adopts the superseded
attempt's passing run (a reuse, no new check run), that run is not a re-check run, the raced
row's elapsed time is the race-to-acceptance gap with no runner minutes
(`reusedAfterRace: true` on the row), the landing's path in 5.1 is `reused-after-race`, and 5.6
counts the reuse once. A replacement that starts its own run is a re-check run with its runner minutes.

How `metrics` reads landings (5.1, 5.6 and finish-to-main). The path of a landing comes from the Lanes it
carried: a batch landing is classed by its member Lanes (the stacked Candidate itself carries none), and a
landing that resolves no Lane is `unresolved`, counted in `totals['5.1'].unresolved` with a named gap, not
folded into `unknown`. `first-try`: no earlier submission of the Intent failed, was interrupted or was
cancelled, and no earlier run of the head failed; earlier submissions that landed are earlier work.
`after-fixer`: a failed submission ended before the head was saved by a builder (sync writes no save record,
so a head made by sync after a failure is an `after-retry`). `after-retry`: a retry row, or a failed,
interrupted or non-race superseded attempt of the same head. `after-recompose`: Forge's own recompose after
main moved, not a builder retry. An attempt replaced in the instant it was created is an internal handoff and
counts as neither. `reused-after-race` is as above. First-try mostly means main did not move under the
landing, so read it with the moved-main share, not as builder quality. `totals['5.1'].firstAttemptLandRate`
is the Lane-level rate: Lanes whose first-ever land entry in the window was accepted.

5.6 `checkMinutes` and `checkMinutesPerLanding` (the old `wall*` keys stay one release) sum request-to-end
minutes of every started, non-reused run, so overlapping runs add; they measure work, not latency, and the
run record keeps its request time, not a start time. `runsPerLanding` and `discardedMainRaceRuns` (runs a
moved main made useless) show what drives them. Finish-to-main reports `p50Minutes`, `p90Minutes`,
`meanMinutes` and `admissionRunShare` (admitted landings that landed on their admission check): the p50 alone
flips on a two-humped distribution (main did not move versus moved). `heldAfterCheck` and the 60 s floor on its
waits are a floor: shorter order waits are in `orderWaits` without a duration. The builder's own measurement-hold
wait is client-side before submission, so no server timestamp includes it.

#### Fallback reasons

Each time Forge takes a slower path than its fast one, the decision records a stable
reason code on the write it already makes (no extra Convex call), and `metrics` counts
them per stage and reason in `totals.fallbacks` (`byReason`, `limitations`, `warning`).
The list of codes and their kind lives in `src/fallback-reasons.ts`:

| Stage | Recorded on | Codes |
| --- | --- | --- |
| `first-check` | receipt `firstCheck.reason` (an admitted landing that rechecked) | reuse codes below |
| `main-race` | landing attempt `recheckReason` (main moved; the attempt rechecked) | reuse codes below |
| `scoped-recheck` | landing attempt `scopedFallback` | `scoped-no-evidence` |
| `contract-gate` | the run's server gate (`gate.reason` when the contract gate went full) | `contract-supervised`, `contract-actor`, `contract-protected-paths`, `contract-trust`, `contract-none`, `main-red`, `audit-debt`, `contract-other` |
| `selection` | check run `fallback`, from the runner's pinned selection | `contract-full`, `docs-paths-undeclared`, `test-runner-unavailable`, `scoped-base-unavailable`, `scoped-root-config`, `scoped-unclassified`, `graph-full` (a [package-graph first check](workflows.md#check-command-scope) ran full: majority, unplaced path, flags Forge cannot place or nothing to run; the run's `fallbackReason` says which) |

Reuse codes: `not-eligible`, `not-tried`, `cohort`, `reuse-policy`, `main-red`,
`audit-debt`, `text-conflict`, `check-evidence`, `audit-baseline`, `path-overlap`,
`tested-doc`, `global-risk`, `order-sensitive` (global risk that the
[fast landing mode](pre-queue-checks.md#landing-modes) never relaxes), `composition-not-exact`, `unsupported-mode`,
`checked-not-full`, `audit-not-full`, `source-unavailable`, `analysis-expired`.

A **limitation** is a fallback where Forge could not use its fast path for this repository
or change shape (for example `unsupported-mode`: a changed symlink or submodule;
`docs-paths-undeclared`: a Markdown-only change ran an opaque command whole because its
check declares no `docsPaths`). A **genuine** fallback is the right outcome: a real
conflict or risk (`path-overlap`, `global-risk`, `text-conflict`, red main), or the
project's own policy (`reuse-policy`, supervised acceptance). An unknown code counts as a
limitation. Text output flags each limitation reason (`⚑ limitation`); the status metrics
headline shows one `fallbackWarning` line naming them, computed on that read and never
polled. Each main-race row in `totals.waste.rows` carries the `recheckReason` of the attempt
that replaced it. The exit bench copies the counts into each Forge cell's `result.json`
(`forgeFallbacks`).

`totals.secondChecks` counts every entry that did not land on its own first check, by reason
class and by what became of it, failed entries included (the request page carries each entry's
`firstCheckRecheck`). A failed check is joined to the next landing of the same Lane from rows the
metric pages already return: the same head landed later is `flaky` (a later pass vouches for it),
a different head is `real`, no later landing is `unknown` (not retried). `sharedBatch` counts the
members of cohorts whose shared check failed and how many then passed alone; before, a cohort
failure that every member survived left no failed entry. `byModel` splits second checks and
failures by the agent client each landing declared (`not recorded` when none). The
[landing mode](pre-queue-checks.md#landing-modes) advice rests on these numbers.

`landings {from,to,limit?,cursor?}` (`nforge agent ROOT landings`) is the cheap read for
replays and cost capture: accepted landings in the UTC window [from,to) by commit time,
oldest first, at most 30 per page (default 20) and under 64 KB, read in one query per page
from stored rows (the receipt index, then about four indexed rows per landing; a page also
ends at 800 KB read) with no writes and no idle work. Each row carries `receiptId`,
`submissionId`, `laneId`, `intentId`, `kind`, `submittedAt`, `admittedAt` (the end of the
pre-queue Lane check, null when the change queued unadmitted), `committedAt`,
`admissionBase` (the first landing attempt's main) and `landedBase` (main the receipt
moved), `mainMoved` (they differ), the receipt's `firstCheck` and `check.skipped` (as
`checkSkipped`, null when every selected part ran), `landedHead`,
`checkRunIds` (the admission Lane run, each attempt's run, the accepting run; at most 8),
`followingAudit` (`{runId,verdict,sequence}` of the first stored main-audit event at or after
the landing: `passed`, `failed` or `stalled`; null when none is stored yet),
`recomposeCount` (distinct Candidates composed, minus one; a check binding is not a
recompose), `firstComposeStartedAt` (the first attempt's compose start; the submission's own
`timing.composeStartedAt` is the latest attempt's), `heldAfterCheck` (each attempt whose passed
check waited at least a minute before it settled: `attempt`, `from`, `to`, `seconds`,
`outcome` and the stored `reason`, such as an older submission taking main first),
`agentRun` and `agentClient` (the submitting agent run and the client it declared: the harness
and, when its launcher set `FORGE_AGENT_MODEL`, the model; null for people and older receipts),
`sharedBatch` (`{runId,individualPassed,likelyCulprit}` when a shared cohort check failed before
this member landed on its own check; else null) and
`conflictPaths`. Text-conflict paths of an earlier generation live only
in retained compose results (R2), so `conflictPaths` is null today. Follow `nextCursor`
until it is null. Nothing in it depends on GitHub.

Paging rule for time-window reads (`landings`, `overlap-answers`): a page returns every row up to its limit or byte budget, or a `nextCursor` naming the next row; it is never silently short. The cursor is `TIME` or `TIME:SKIP`, so rows sharing one stored instant (a batch) neither repeat nor stall a page, and a window of any length pages to every row once. `metrics` pages follow the platform `isDone`/`continueCursor` pair instead.

`status {runId,summary:true}` (`projectHostedCheckRead:summary`) is the bounded read of one
check run: the same single run-row read as `status`, but the reply is counts, failed and
flaky file names (failed ones with a clipped first error, at most 40 each, the rest counted
under `more`), timings (wall, execution, shards, five slowest files) and the selection scope
(gate mode, requested tests, reported files, planned tests, shards), under 8 KB instead of
the full run (about 80 KB).

`lane-history {laneId?}` is the matching per-Lane read: one query, six indexed reads
(Lane head and record, its first version, the overlap row), a few hundred bytes, no
writes. It gives `openedAt`, `startBase` and `lastSyncedBase` (main at start and main now),
and `landing` (receipt, commit, saved head, time) for open, landed and abandoned Lanes.
`diff {laneId,summary:true}` reports per changed path whether current main is `equal`,
`absent` or `different`, from the base, saved-head and main State manifests only: no hunks and
no blob reads. A friction id given to `comment-planning-item` fails with a pointer: friction
records take no comments, so comment on the Issue the record was triaged to (one indexed read,
only on that failure).

`overlap-answers {laneId?,from?,to?,limit?,cursor?}` reads stored overlap answers by Lane or
by the window [from,to) of the time they were stored: one query per page from creation-time
indexes, at most 50 rows (default 20), 56 KB of reply and 800 KB read a page, no writes. They are
kept 90 days (owner decision 2026-11-06; the named value `OVERLAP_ANSWER_RETENTION_MS` beside the
other overlap limits in `src/hosted-overlap.ts`). Cleanup rides on the existing answer write: after
it stores a new answer it deletes up to 10 older-than-90-days answers and 10 answer batch records
through the creation-time index (two small indexed reads, no cron, nothing on idle or on the landing
path). The read never returns expired rows, so the bound holds before cleanup reaches them. A
notice whose answer expired on a Lane still open after 90 days is shown again.

Quarantined tests continue to run. A check passes with quarantine only when all
remaining failures are named, quarantined and unrelated, and every non-test step
passed. Run details name each ignored test; landing receipts retain
`backend.verdict: quarantined` and `backend.ignoredTests`, alongside the actual
exit code. Test evidence pins the Candidate head and both attempt identities.
Reconciliation reuses the recorded assessment instead of changing an old verdict.
Build, typecheck, lint, format, documentation and package smoke failures always
block. More than ten quarantined tests fails the assessment with “Too many flaky
tests”.

`status` with `detail: true` reports the current `quarantine.needsYou` list;
existing run records retain quarantine snapshots and verdict evidence. Each new
quarantine captures a friction item for a fix slice. Twenty consecutive passing
observations release the test automatically; the existing `fixQuarantinedTest`
operation explicitly releases one exact test and is safe to replay. Later flakes
count anew.

Clean checks within the quarantine limit perform no quarantine-history read or extra write.
If the limit is already exceeded, clean observations still advance release toward
twenty passes through their existing receipts; the excess continues to fail until
the active list returns to ten or fewer. Their named
passes travel in the existing receipt. Failure assessment advances a local ledger
projection, hydrates one run detail at a time, and retains pending runs so late
completion is observed. Initial reconstruction reads recent test observations
and older quarantine snapshots. There are no extra Convex calls, jobs, timers or
idle work; the only extra execution is the eligible failing-file retry.

### Check logs and retention

Forge uses your CI provider’s log storage and retention. Status, exit code, timing,
provider run/execution IDs, bounded failure summaries (4096 characters), failing
names, compact per-file test counts/timings and evidence hashes, and reuse evidence remain in Forge. Full per-run CI test reports (`test-reports.json`) are discarded after extraction and never exported, seeded, exchanged or uploaded. The compact `test-evidence.json` retains completion, counts, failing names, file durations, bounded diagnostics and a hash of each original report; passing test inventories and coverage traces are omitted. Full
GitHub Actions output does not enter Work exports, hosting seeds or
exchange. The Run view, native agent `log` and hosted `observe {runId}` return the provider link instead; hosted `log` is unavailable.
Older archives with full logs still restore; deliberately omitted provider logs
are provider-held, not missing check evidence. Results and source validation stay
strict, and removing log bytes does not change a passed run’s evidence hash.

Local logs stay on the machine for seven days. A machine that runs a hosted Mac worker keeps its local pipe files under `FORGE_LOCAL_CHECK_LOG_DIR` (by default, the private `forge-mac-check-logs` directory in the machine’s temp directory), outside disposable source/runtime copies. Dogfood checks no longer run on a Mac: the Mac check worker was stopped on 2026-10-29 and checks run on GitHub-hosted Actions runners, whose logs stay with GitHub. Actual check starts and explicit
cleanup enforce that bound; completed logs and stale logs whose collector exited are pruned on a later check start. Active collectors keep their current files. There is no idle timer. Upload is off until an owner
explicitly enables it. The enabling command is the opt-in step:

```sh
nforge set-policy ROOT '{"checkLogs":{"uploadLocal":true,"retentionDays":90}}'
# To stop uploading:
nforge set-policy ROOT '{"checkLogs":{"uploadLocal":false}}'
```

Uploaded local logs expire through existing check/exchange lifecycle events, with an indexed expiry wake only when an expiry is already due; idle schedules no timer or poller. Concurrent wakes share one durable project sweep, and a project starts at most one automatic sweep per day, so deletion can trail expiry by up to a day after the next check or exchange. That sweep advances the resumable cleanup planner and drains its due receipts in bounded pages under the original cutoff, without rescanning for each receipt page. Uploaded local logs default to 90 days; `retentionDays` must be an integer from
1 through 400. `never`, unlimited and larger values are rejected. Retention is
based on the recorded run time, not refreshed by another export or exchange.
The local seven-day lifetime can make a later export omit logs even while a
previous opted-in hosted copy remains within its upload retention. Results,
failure summaries, compact test evidence, source recipes and selected build outputs remain retained. Local full test reports follow the same opt-in and finite uploaded retention as local logs.

Generated `coverage/test-impact.json` digest manifests (often `artifacts/artifact-0.bin`) are rebuildable local caches, distinct from selected build outputs. They never enter export, seed, exchange or recovery closures. The cache keeps at most the newest three files and 16 MiB total, for up to seven days; check/coverage activity enforces the bound without an idle timer. This keeps recent comparison evidence available with a fixed local byte bound. Missing, evicted or corrupt manifests use the existing static/full selection; verdicts, check reuse and original evidence hashes do not depend on them. Old archives restore with or without these disposable files; source, results and actual build-output validation remain strict.

One-off migration removes existing provider logs, full CI reports, generated digest caches and expired/unapproved uploaded local logs. Local plans include the exact report/cache paths and hashes; hosted plans identify generated caches from run artifact provenance, preserving ordinary build outputs even when named `artifact-0.bin`. First inspect a dry-run plan, then apply that exact selection. Add
`--hosted` to include the project’s existing hosted binding and R2 objects:

```sh
nforge maintenance check-logs ROOT --dry-run --plan /private/path/check-logs.json --hosted
nforge maintenance check-logs ROOT --apply --plan /private/path/check-logs.json --hosted
```

Omit `--hosted` for owner-only cleanup. The plan and retry UUID remain private;
apply keeps results, summaries, provider links and exact evidence hashes. Shared
source/artifact hashes and recipe chunks are protected. Native archive copies
are converted through the existing exact-manifest migration before retiring the
old compressed container. Hosted inventory and apply advance in finite action windows with persisted cursors,
protection closures and reviewed pages. Object-backed snapshots read only the
selected runs for each fifty-file page.
Catalog and manifest chunks share current-authority lookups in batches of up to
100 pins and 2 MiB, with every chunk and complete metadata digest verified.
The CLI continues requested pending work; there is no idle timer or poller. The
private plan file saves its UUID before the first action. Rerun an interrupted
dry-run with the same file to resume it, then
apply that file. Apply reads the retained server plan instead of recalculating a
new deletion scope. If source changes, retain the receipt and prepare a fresh
plan file. Structured server error codes and messages are shown by the CLI.
A lost deletion reply resumes the same recorded operation; R2 keys rotate before deletion so replay cannot delete a replacement
upload.

### Hosted backup recovery

Hosted source and Work recover from verified deployment snapshots and retained R2
objects. [Hosted durability](operations/hosted-durability.md) describes Route A,
manifest validation and snapshot retention. Forge runs hosted projects only: there is no local owner to recover or reconnect.

### Restore drill

One command restores the newest weekly backup into a fresh local self-hosted
deployment and checks one project byte for byte. It is the gate before any change
that moves real data switches its readers (flips 2 and 5): run it on a backup
taken after the new writes start, and switch only when it exits 0.

```sh
npm run build:core
node --env-file="$PRIVATE_R2_ENV" scripts/restore-drill.mjs \
  --project PROJECT_ID --dir NEW_PRIVATE_DIR [--backup NAME] [--reserve-gib N]
```

`PRIVATE_R2_ENV` holds the backup bucket's `R2_*` names (as for the weekly job).
The drill reads the backup and the project's `v1/p/PROJECT_ID/` prefix with LIST
and GET only, and writes only inside `NEW_PRIVATE_DIR`: it never calls the source
deployment and never runs a deploy against it. Steps, each timed in the report:

1. Pick the newest (or named) backup manifest, download its ZIP and check size and
   SHA-256 against the manifest.
2. Create a fresh instance with `scripts/selfhost.mjs` (pinned backend, checked
   SHA-256) and import the ZIP into it. The CLI's progress watcher can time out on
   a busy machine while the import continues; the import's own state row decides.
3. Export the restored instance before any code runs and compare it with the
   backup: every table's full rows (IDs and creation times included), every
   stored file and each project's selected Work main. Then compare every row that
   names the project, one by one. Differences name the table and row, never contents.
4. Copy the project's R2 prefix into a local in-memory bucket. Every key a backup
   row names must exist, and every `o/<sha256>` object must hash to its name.
5. Deploy the current source to the scratch instance only (synthetic Secret Object
   keyring; imported rows have no indexes until this push builds them), then read
   main and every stored object of the project through the restored app's own
   download path into an empty cache, parse each State and fetch every file of
   every State. The cache rejects bytes that differ from their SHA-256 pin.
6. Stop the backend and delete the directory (keep it with `--keep`).

The import holds only the project's rows (every row that names it), every row
without a `projectId` (accounts, settings, project shells) and all table metadata
and stored files. Importing the whole snapshot works too, but the schema push then
rebuilds all indexes over every row: on the 780,263-document weekly backup a full
import took 14 min and the export 37 min (every table, file and Work main equal
under `hosted-durability.mjs verify --left-export --right-export`), and the index
build had not finished after 30 min.

Measured on the 328 MB weekly backup, a GitHub-imported project with one landed
Lane (166 rows in 57 tables, 2 States, 58 files, 20 R2 objects / 1.3 MB): 2–5.5 min
wall time on a loaded Mac, mostly the scratch deploy (48–111 s), the two passes over
the backup (filter and read, 45–105 s) and the import (8–47 s). Cost: 2 LIST and 22
GET requests on the existing R2 account (the backup plus the project's objects,
about 329 MB of free egress) and no Convex calls; peak disk is the backup, a
project-sized instance and the pinned backend (about 0.6 GB, freed at teardown).

Exit 0 means restored and equal, 2 a difference (the report names it), 1 a failed
step (`failed.step`, `failed.code`; the private `drill.log` stays only with
`--keep`). Not covered: real auth configuration and Secret Object values (synthetic
keyring), and projects whose R2 prefix was purged after the backup: their rows
restore but their bytes are gone, so choose a project that still exists.

### Route B: recover a runner and cache from hosted

On a clean machine, install the compatible Forge package and sign in with the
existing owner account. Restore the existing runner configuration and private
collector credential references through the normal worker setup. Recovery never
changes project runner settings. Write `{operationId,url,projectId}` to
`recovery.json`, using one UUID for all retries, then run:

```sh
nforge recover "$NEW_CACHE" --command-file recovery.json > recovery-result.json
# The result names configuration.machineId. Start execution separately:
nforge worker "$DEPLOYMENT_URL" "$PROJECT_ID" "$MACHINE_ID"
```

The recovered directory contains selected main source, `.forge/hosted-main.json`
and `.forge/recovery-runner.json`. Immutable hosted recovery pages retain the
original queue outcomes, pending completion cursors, source-return supersessions
and acceptance/snapshot receipt identities; they are cache data, never a local
acceptance ledger. Saved Lane source remains hosted and can be opened through
the ordinary hosted agent commands. No native `accept`, owner listener, exchange
push or reconnect step is part of Route B. Acceptance continues through hosted
CAS. An explicit higher-epoch rollback is the separate procedure below.

Retry the original request and destination after interruption, including a lost
registration reply. Current access is checked again before cached results are
returned. Completed retries preserve subsequent local edits; changed recovery
pins before capture completes retain staging and report `WORK_STALE`. Keep the
private staging path from the result until recovery is checked. Existing
unrelated destinations remain untouched.

The credential-free synthetic drill is `node tests/recovery-runner-drill.mjs`
after `npm run build:core`. It starts with a clean destination, recovers work
accepted only in fake hosted tables, runs the check selected by an actual hosted
landing request through the hosted Mac executor, and verifies the recovered cache has no native acceptance
path. Step times below are local fixture observations, not production RTO/RPO.
One local synthetic run measured the following steps (milliseconds). Fixture
creation was 8,526 ms; end-to-end recovery was 7,387 ms. The per-phase readings
omit small journal/orchestration gaps and are not additive RTO estimates.

| Step | Measured ms |
| --- | ---: |
| Select hosted pins and configured runner | 2 |
| Checkout selected hosted main | 621 |
| Fold hosted tables and source closure | 5,914 |
| Revalidate receipts and cached objects | 487 |
| Register runner | 2 |
| Publish cache | 20 |
| Prove native Work construction cannot accept | 13 |
| Enqueue deliberate hosted landing and its check | 8 |
| Execute check and deliver its hosted result | 322 |

The fixture retained two landing requests (one accepted, one pending), one exact
acceptance/completion receipt and hosted-only source. Dropped accepted receipts:
0; pending landing/completion rows missing after recovery: 0. The path produces no
owner marker or accepting Work store. No live before/after dropped-landing rate is claimed.

The pending landing and partial completion receipts are compared byte for byte;
metric 5.3's live dropped-landings count remains unmeasured by this fixture.

See the [recovery drill](operations/recovery-drill.md) for Route A's weekly
Convex ZIP restore, configuration inputs and reporting.

For whole-deployment Convex snapshots, fresh-target restore and offline/live
comparison tooling, see [hosted deployment durability](operations/hosted-durability.md).
This complements project archives; the [restore drill](#restore-drill) runs it end to end.

Hosted projects store the same archives. In the browser, "Stored checkpoints" lists them: upload a source and Work archive exported from Forge, "Download source and Work" to fetch one, or "Reconcile original upload" after an unknown reply. To work on hosted Intents locally, download the pinned archive and the current journal together, then run `nforge restore-native ARCHIVE NEW_DIR --journal HOSTED_WORK.json`. There is no way to return that local copy to the hosted project: push and source return were removed, and their old RPC addresses only answer `CLI_UPGRADE_REQUIRED`. Hosted work continues through hosted Lanes and landing.

### Work format and recovery

New native, Git and hosted Work stores use the current unified format (24, including
packed evidence). Ordinary reads and writes of older stores return
`WORK_UPGRADE_REQUIRED` before loading collection pages or changing bytes.
Original journal commands,
request hashes, source pins, aliases, conversion receipts and legacy facts remain
retained. Current-format stores have no invented conversion receipt.

The completed local and hosted Intent migration commands are removed. The
historical journal reader remains until journal compaction; it converts exactly
at the recorded migration revision, never by rewriting old events.

### Hosting progress and recovery

`nforge host ROOT --json --wait` emits progress and result JSON lines; ordinary progress uses stderr.
`nforge host ROOT --status`, or `nforge host ROOT --json` with no action, reads the local
binding and last saved progress without network calls, writes or worker wakeups.
A pending operation resumes only with `--resume`. During native backfill it reports `historyBackfilling: true`, the last phase/counts/rate/ETA,
an observation timestamp and any recorded interruption code. The hosted backup also carries
`historyBackfilling` until complete-manifest validation succeeds. Its full manifest is pinned from
the start; incomplete history is never described as a complete recovery copy.

A detached backfill inherits the current process environment and existing saved authentication.
It executes only Forge's transfer code, never repository scripts. If the machine stops, the
connection fails or login expires, retain the entire local Work directory (including
`hosted-binding.json` and `exchange-UUID`). Reauthenticate to the original account if necessary,
then run `nforge host ROOT --resume --wait`. Existing missing-content negotiation and nonce reconciliation
reuse completed uploads after unknown replies. No retained source or history is deleted. A completed
backfill changes its completion marker only; a concurrent source push or hosted note stays intact.

Hosting uses pages of at most 100 pins, up to four byte-bounded source pages, 16 POSTs per active
upload window, and a 16 MiB window budget per uploader. Hosting prepares its negotiated missing
pins directly, avoiding redundant discovery calls; ordinary concurrent exchanges retain fresh-first
discovery. Server metadata/ancestry reads batch up to
100 pins/2 MiB, reuse the action-local verified-byte reader and recheck current authority. Large
objects retain the existing ranged/chunked path. Publication validates selected pins in batches. First-host completion instead scans the
new project's content index once in 100-row pages and checks the full required set, so it does not
repeat thousands of individual indexed lookups. These are internal scheduling bounds, not retained-data limits.

Offline qualification: `npm run build:core`, then `node scripts/measure-host.mjs`. It generates
3,000 file blobs (~220 MB), 500 linked native States and 2,100 Work records, exercises the actual
host/exchange/backend handlers with fixture storage, and reports phase times and RPC counts.
`HOST_BENCH_RTT_MS` selects simulated RPC/storage latency (default 20 ms). An optional
`HOST_BENCH_FIXTURE` directory caches a generated synthetic owner for repeated comparisons; each run
uses a fresh independent copy. Setup is excluded from
hosting elapsed time. This measures a synthetic local transport, not deployed Convex throughput.

At 80 ms simulated RTT, the same cached 3,501-object owner (220.4 MB of native objects;
2,100 Work records) took **211.9 s before / 28.6 s after (7.4×)**. Both runs uploaded exactly
3,748 physical objects / 221,729,371 bytes, including 1.31 MB of metadata trees. Current source
and Work were usable at 12.6 s. The final run spent 1.9 s preparing/segmenting metadata, 1.7 s
negotiating across both phases, 1.6 s seeding current files/Work/State ancestry, 1.2 s initializing
Work, 5.7 s in the index action (previously 89.1 s), 9.0 s backfilling, and 6.7 s validating current
and complete history. Times overlap at RPC level and are not independent per-call sums. Discovery
plus preparation/completion changed from 38 missing + 487 discovery + 487 prepare + 487 complete
calls to 46 missing + 44 prepare + 44 complete calls; the extra missing pages seed current data
first. Source objects in this fixture are below the large-file threshold, so large-file chunking
is not benchmarked. A 20 ms earlier intermediate build measured 96.2 s → 23.5 s; performance depends
on latency and shared-machine load. These results do not establish a deployed-provider speedup.


Release needs the rebuilt CLI and updated Convex schema/functions together (`historyBackfilling`,
current-first publication, larger upload batches, batched ancestry and `completeHistory`). An
old CLI's pending full-host operation retains its original behavior. The CLI does not deploy.
After the lead deploys, qualify a large native owner and a Git owner against the real provider,
including credential expiry and restart, before claiming a live-host speedup.

### Permanently delete a hosted project

An owner signed in with `nforge login DEPLOYMENT_URL` (CLI scope) can use the same
public `projectLifecycle:permanentlyDelete` mutation as the browser:

```sh
nforge host ROOT --delete-project PROJECT_ID --confirm PROJECT_SLUG
nforge host ROOT --delete-project PROJECT_ID --confirm PROJECT_SLUG --deployment https://DEPLOYMENT.convex.cloud
```

`--confirm` must exactly match the current project slug, the last segment of its project URL. `nforge clone` prints
it as `slug`; a second import of the same name gets a suffixed slug such as `name-2`, and a mismatched `--confirm`
refusal names the current slug. ROOT can be an unbound
local Forge owner, a local owner bound to another project, an `nforge clone` or Lane checkout of any project
(no Git needed; the journal lives in its client cache), or any other directory when `--deployment` addresses the
deployment (the journal then lives beside the saved login). The project ID and
current owner authentication select the hosted project. Deployment selection uses
`--deployment`, then ROOT's binding or pending hosting deployment, `FORGE_DEPLOYMENT_URL`, then the saved login's
default deployment. To delete the project ROOT itself is bound to, explicitly add
`--allow-bound-project`. The check compares both deployment and project ID.

The command reads the owner's project metadata, retains the operation UUID and
expected revision privately under ROOT's Work directory (a clone's client cache, or the config directory for an address) before submitting, prints
progress, and waits for up to ten observations, backing off from two seconds to
ten seconds between reads. Completion
prints `purgeComplete: true` and the observed tombstone (`removal: "deleted"`,
`name: ""`, `currentBackup: null`). `--json` emits progress and result JSON lines.
A pending purge exits with `HOST_DELETE_PENDING`; an interrupted request or poll
can be retried with the exact same command and ROOT to reuse its saved pins.
The entire network observation window is bounded to ninety seconds, including slow
requests. Owner/authentication and server concurrency errors remain explicit. An
explicit retry refreshes pins after a definite `WORK_STALE` rejection, or when a
newer active project revision proves the earlier deletion could not have committed.
Unknown outcomes retain the original operation and revision.

Projects with R2 data remain `deleting` until every prefix DELETE succeeds. The
prefix purge never needs `FORGE_R2_MAINTENANCE`: it deletes only under the
project's own prefix, with a grant that exists only for an owner-confirmed or
expired day-90 purge (`convex/projectPurgeAuthority.ts`). Without that grant the
purge records `R2_PURGE_UNAUTHORIZED` and schedules nothing further; retrying the
same command confirms it and resumes the saved page. Each page is one query, one
LIST, at most 100 DELETEs and one mutation; the purge receipt counts `r2Objects`
and `r2Bytes`.
Transient R2 errors retry the saved page up to eight attempts, with delays doubling
from one minute to a fifteen-minute cap. Exhaustion records
`R2_PURGE_RETRY_EXHAUSTED`; resolve the storage error and retry the command. Retries
reuse one tracked chain per project, and completed tombstones schedule no purge.

Permanent removal deletes every project-owned record, Convex file and R2 object
through the scheduled purge. Only a nameless tombstone remains (owner, key,
`removal: "deleted"` and the purge progress); the slug and all cleanup receipts are
removed. Deletion is permanent; local recovery copies remain
separate. The command retains the local owner, source and hosting binding. When the confirmed
tombstone matches a pending hosting operation's project **and deployment**, it
clears that pending resume state under the binding lock and retains its original
pins and deletion-operation receipt. A pending operation for another project or
deployment remains intact.

### Project retention and restore

Deleting a project from Settings (or `projectLifecycle:trash`) tombstones it at
once. Everyone loses access, the owner included: reads, writes, Lanes, landings,
runners and tokens stop, and reader, contributor, invitation, maintainer, runner
and worker grants are revoked in 100-row pages. The slug stays reserved. Deletion
schedules exactly one expiry at `removedAt + 90 days` (no polling cron) and a
bounded size count: live objects, backups and proposals, 1,000 rows per call.
Settings shows the deleted date, the restore deadline and the retained size.

The owner can restore the project until the deadline. Restore brings back source,
Work and settings but **not** grants, invitations, runners or tokens; re-share
and re-register them. Restore is refused after the deadline and while revocation
is still paging. Restore on a project that is not deleted, and delete on one that
is already deleted, change nothing and do not bump the revision, so a stale second
tab cannot fail other holders.

Settings, Home's removed-projects list and `nforge host --delete` name the project's
phase from one derive (`src/project-phase.ts`): active, deleted and restorable,
deleted with restore unavailable (revocation finishing or the window ended),
purging, purge stopped (each stop code has a reason sentence and a next step),
permanently deleted, and deleted with the purge not confirmed. A tombstone with no
completion receipt (older purges, Issue 4bf603cc) never reads "permanently deleted":
it says its records and stored objects may remain. The delete command's JSON gains a
`phase` field.

At the deadline, or when the owner chooses **Delete permanently now** and types the
project slug (`confirm` on `projectLifecycle:permanentlyDelete`; `nforge host
--delete` sends it), the project moves to `deleting`. The purge first waits for
signed uploads issued before deletion to expire (R2 PUT expiry plus five
minutes), then runs bounded pages: special stages (imports, backups, proposals,
exchange objects), then every project-owned table in the
`convex/projectPurgeInventory.ts` inventory, then the R2 prefix. A row page stops at
1,000 rows or 4 MiB read and also removes the rows' exclusive Convex files and
cancels their pending scheduled functions. Progress (operation id, rows, bytes,
pages) is visible in Settings. A build test fails when a schema table with a
`projectId` is missing from the inventory.

Projects deleted before the retention window existed have no expiry. The lead arms
them with the internal `projectRetention:armLegacyTrash` (one owner, 50 projects
per page); projects removed more than 90 days earlier purge immediately.

Older purges left `deleted` tombstones (name cleared, slug kept, no `purge`
receipt) that still hold project rows and R2 objects. With owner approval the lead
runs `projectRetention:repurgeLegacyTombstone '{"projectId":"ID","operationId":"UUID","confirm":"SLUG"}'`.
It refuses anything except such a tombstone, re-enters the inventory-guarded purge
as an owner-confirmed delete and ends at the normal tombstone; a replay of the same
operation id is a no-op.

To discard a pending host operation without deleting a hosted project:

```sh
nforge host ROOT --status
nforge host ROOT --abandon-pending OPERATION_UUID --confirm OPERATION_UUID
```

A started seed whose server-side progress cannot finish (a bad request, a lost pin)
is discarded with `nforge host ROOT --abort-seed` (owner only). It removes the seed
row and its pages in bounded batches and refuses once the seed has selected its
source (`SEED_COMMITTED`); source bytes are content-addressed and stay. The pending
operation is kept: `nforge host ROOT --resume` then seeds the project again from
page 0, or `--abandon-pending` retires the operation.

Use the pending operation UUID shown by status. This local, replayable command
retains a receipt and the existing binding; a changed pending operation requires
its own UUID. Any half-created hosted project remains available for explicit
project deletion. An in-flight host cannot overwrite the abandoned state.

During hosting, an `EXCHANGE_UPLOAD_UNKNOWN` response reconciles the original
object window and retries missing bytes in the same invocation, with at most four
attempts and 250/500/1000 ms backoff. Stored peers are reused. Exhaustion reports
the selected object pins and attempt count; `nforge host ROOT --resume` with the original
options continues the saved operation.
After deliberately replacing the hosted project, `nforge host ROOT --new` creates
and binds a replacement.

### Hosted cockpit index format and team reset

The hosted Work index format is now **11** (`HOSTED_WORK_INDEX_FORMAT`); this section was written at format **4**, which includes Candidate Lane/head inputs and dependency counts, run timing,
exit code, a 200-character check name and the retained failure summary (at most 4096 characters),
and Lane save count plus the last save time and a 200-character message. Full records, messages,
check definitions, dependencies and logs remain in their existing payloads. Reactive summaries do
not load full checkpoint arrays or check environments. The 32,000-character payload chunks and
100-entry/500,000-byte RPC batches are unchanged.

Older formats are no longer selected. The existing `ensure` path can rebuild the disposable index
from its source checkpoint and journal; no retained-data migration is needed. For the team's reset release, the owner has chosen to delete the old hosted
project and seed a replacement instead of migrating it. Only the lead performs these steps:

1. Use an up-to-date Lane of accepted `main` as the deployment directory. With Node 24.22.1+ (24.x) on PATH,
   install/build and deploy the backend and hosted browser. `DEPLOYMENT_ENV` is the private env
   file containing the **target deployment's** `CONVEX_DEPLOY_KEY`, `VITE_CONVEX_URL` and browser
   configuration; the deploy key and URL must refer to the same backend. `SITE_ID` is the existing
   team Netlify site. The preview script also updates that backend's worker URL.

   ```sh
   npm ci --ignore-scripts
   npm run build
   npx convex deploy --env-file "$DEPLOYMENT_ENV" --typecheck enable --yes
   node --env-file="$DEPLOYMENT_ENV" scripts/deploy-forge-preview.mjs "$SITE_ID"
   ```

2. In the deployed browser, open the old project → Settings → **Permanently delete project** →
   **Delete project permanently**. Wait for **Project removed**; use **Retry removal** if interrupted.
   The owner may instead use the [CLI deletion command](#permanently-delete-a-hosted-project).
   This is the existing owner-authorized deletion flow, scoped to that project. It removes hosted
   source, Work, backups, grants, prepared briefing sources, project guidance (including its operation
   history and maintainer assignments) and autonomy policy history. The project tombstone clears its
   name, hosting request, guidance and policy; only existing retry/cleanup identities and receipts
   remain. Personal guidance and other projects are unaffected. Keep the canonical local owner. No code migration, table-wide wipe or local-owner deletion is involved.

3. Rebuild/install the CLI from accepted `main`, sign in, then host the canonical owner directly:

   ```sh
   OWNER="$FORGE_OWNER"
   nforge login https://DEPLOYMENT.convex.cloud
   nforge host "$OWNER"
   nforge host "$OWNER" --status
   nforge hosted-work "$OWNER" '{"action":"workspace"}'
   ```

   `host` creates the replacement, transfers missing source/Work objects, initializes hosted Work
   and builds/selects the current index in one command. It prints the project URL and records the
   binding locally. No export, archive upload, bootstrap IDs or `forge-push.json` is needed. If the
   owner is already bound to a previous hosted project, use `nforge host "$OWNER" --new` explicitly.
   Re-running after interruption resumes the original creation/upload/index operation, including
   an interrupted `--new`. Native hosting becomes ready after current source, Work and the index;
   older content continues in a resumable local background process. `host --status` reports
   **history backfilling** until the full pinned closure is validated. Use `host --wait` to follow
   completion before testing full recovery. The initial seed eventually uploads the complete closure.
   `nforge exchange "$OWNER" push` no longer exists (it returns `CLI_UPGRADE_REQUIRED`); later changes
   reach the hosted project through hosted Lanes and landing. Recreate any desired contributor grants on the replacement explicitly.
   Also re-grant service readers such as the UI bot on the replacement project: run `node scripts/ui-bot-setup.mjs --deployment CONVEX_URL --project NEW_PROJECT_ID --convex-cwd "$FORGE_OWNER" --grant-reader`. Reader grants belong to one project and do not follow a new project id; without the re-grant, `ui-shots` and `perf-harness` report that the bot has no reader grant and print this command.

   Inspect the new format's summaries, then open the printed URL and inspect Now, a Lane and Intents:

   ```sh
   nforge hosted-work "$OWNER" '{"action":"records","collection":"lanes"}'
   nforge hosted-work "$OWNER" '{"action":"records","collection":"views"}'
   nforge hosted-work "$OWNER" '{"action":"records","collection":"runs"}'
   ```

   Confirm save counters/timestamps, Candidate inputs and run names/timing. Exported history may contain
   runs predating durable failure summaries; those summaries stay absent and local logs remain
   authoritative. Only the lead deploys the Convex schema/functions, hosted browser and rebuilt CLI;
   hosting itself deploys no source or executable.

## Hosted authority and local presence

Hosted main and the hosted landing queue own acceptance. Local `serve` no longer
starts an acceptance listener. The former `ownerAcceptance`, `ownerLifecycle`,
`projectOwnerSync:publish` and `projectWorkActions:acceptChannel` RPCs return
`CLI_UPGRADE_REQUIRED` with the matching release and original-operation recovery
instructions. The old `host --listen`, `--sync-agent` and auto-sync switches return
the same error. The request/machine tables are gone from the schema.

Local activity updates presence only; it starts no hosted metadata sender, retry
timer or owner subscription. Hosted CLI/MCP source and lifecycle operations use
their authoritative server APIs. Explicit coordination activity remains available.
GitHub mirror status uses its separate `projectGithubStatus:publish` endpoint and
preserves original payload identities when retrying a lost response.

Owner-derived backup display projection is retained: source/Work index rebuilds
and historical read fallback still consume its ancestry, diffstat, View provenance
and Code-tree pages. Removing it requires parity evidence for all of those pages.

## Runner selection

Checks support local and [GitHub Actions](operations/github-actions-checks.md)
runners, or the project's own CI file through the [CI status provider](operations/ci-status-checks.md)
(its provider's signed run record decides; the contract test covers a second adapter). Actions
`runsOn` takes any label; the dogfood project uses free GitHub-hosted runners.
Blacksmith use ended on 2026-10-25; Blacksmith labels are still priced below so old
receipts and any label you set stay readable. Existing Modal policies and receipts remain readable; new Modal runner
selections are refused with instructions to select a supported runner. The
`checks.fallback` field remains readable for policy compatibility; Actions does
not automatically repeat unknown remote work locally.

The existing owner-only project policy is the single runner setting. CLI-created
owners default to the own machine. Show it with `nforge policy OWNER` or
`nforge agent OWNER status`; edit with a fresh operation UUID (replay that UUID
and payload after an unknown reply):

```sh
nforge set-policy OWNER '{"operationId":"UUID","checks":{"runner":"local"}}'
nforge set-policy OWNER '{"operationId":"UUID","checks":{"runner":"github-actions","repo":"OWNER/REPO","runsOn":"ubuntu-latest","shards":4}}'
```

`policy` and `set-policy` also work on a hosted project (`nforge policy ROOT`,
`nforge set-policy ROOT JSON`, or `nforge x ROOT set-policy`). They read and write the
hosted policy; a repeated operation UUID replays the recorded change.

Every new terminal check receipt has `backend.cost`: the runner/label, estimated
billed seconds/minutes, estimated USD, per-execution quantities and the basis.
Unavailable quantities are `null`, never an inferred zero. Local provider usage
and charge are zero; hardware and electricity are outside the estimate.
Actions estimates use each job's `started_at`/`completed_at`, rounded up separately
to minutes, including retained retry attempts. GitHub's timing API is retained in
`backend.billableMinutes` for compatibility but is not the USD basis: Blacksmith
jobs can report zero there. Built-in standard x64 rates are Linux $0.006,
Windows $0.010 and macOS $0.062 per minute ([GitHub pricing](https://docs.github.com/en/billing/reference/actions-runner-pricing)).
Blacksmith Ubuntu x64 labels use vCPU/2 × $0.004/job-minute; the 3,000 free
2-vCPU minutes/month are noted, not deducted because account-wide consumption is
unknown ([Blacksmith pricing](https://www.blacksmith.sh/pricing)). Set or override
any label's estimate with `checks.ratesUsdPerMinute`, for example
`{"blacksmith-4vcpu-ubuntu-2404":0.008}`. Unknown labels retain usage with unknown USD
until configured. The journal pins the selected rate for adoption.

`status.checkCosts.months` groups all retained months (UTC run start) by runner
and label, deduplicates remote execution identities and reports unknown/legacy
run counts. Totals sum available estimates before allowances, credits and billing
adjustments; provider invoices remain authoritative. Saved legacy costs and
aggregate estimates remain readable; missing usage stays unknown. The retired
Modal price model and `modalCost` status summary have been removed. No backfill
or document migration is performed.

## Local check reliability

### Filesystem event health

`node scripts/filesystem-event-health.mjs TARGET_DIRECTORY` performs a finite local
watcher diagnostic on macOS and Linux. It creates and removes private temporary
directories under the target, opens `fs.watch`, writes a signal and measures the
first matching event after the write. Three isolated child processes bound native
watcher open/close hangs. No network calls or idle work are added.

The diagnostic fails when two of three attempts miss a 1,000 ms event deadline
(allocation errors and hung native calls also fail an attempt). The default
standalone and benchmark probe keeps its existing two-second process envelope for native open/close hangs. Ordinary agent preflight and
`nforge doctor` additionally require close acknowledgement within the shared
watcher’s existing 250 ms bound; slow, missing or failed acknowledgement is
local environment evidence and does not block landing. The standalone flag
`--watcher-close-health` requests this extended diagnostic explicitly. Benchmark
preflight and cell refusal policy remain unchanged. Healthy delivery
is normally milliseconds; one second allows headroom above observed healthy
delivery of 10–213 ms, while the majority rule tolerates one transient delay.
The result includes `ok`, median observed `latencyMs` (null when none arrived),
`fseventsdRssMb`, `fseventsdCpuPercent`, `reason` and per-attempt evidence. macOS
process metrics use only `ps` RSS, CPU percentage and executable name; unavailable
metrics are null and do not decide health. Linux has no fseventsd metrics.

Bench preflight and every cell gate refuse unhealthy event delivery with
`ENVIRONMENT FILESYSTEM_EVENTS_UNHEALTHY`. On macOS the refusal names fseventsd
and the operator remedy `sudo killall fseventsd`; rerun the diagnostic afterwards.
The diagnostic never restarts services itself. Linux operators should check local
watcher resources and event delivery.

`nforge doctor ROOT` also runs this finite target-volume diagnostic and returns
`filesystemEvents` with the health evidence and an exact diagnostic next command.
Ordinary diagnostics create their transient pulses under the target’s existing
private `.forge` metadata namespace on the same volume, so concurrent source
capture cannot save a probe signal; no new source exclusion is added.
Ordinary agent preflight always runs its local tests (they use the saved file
list, not file events) and probes only after a failed test process. Unhealthy
delivery then records an `environment` receipt with
category `ENVIRONMENT`, code `FILESYSTEM_EVENTS_UNHEALTHY`, the fseventsd remedy
and a next action: land the same saved source again. `passed` remains false and
`exitCode` retains the failed run's exit status. This local
environment receipt is advisory at landing, bound to the same source tree/head
as an ordinary preflight receipt. The hosted check still verifies the Candidate;
no tests, assertions or hosted acceptance checks are disabled. A healthy local
environment with failing tests still receives `PREFLIGHT_REQUIRED` when the
project declared its runner; a runner Forge inferred only advises. A program the
run needs that is not installed here (not on `PATH`, exit 127, `ENOENT`) records
`ENVIRONMENT / TOOLCHAIN_MISSING` the same advisory way, naming the `missing`
programs. A failed test file whose declared dependency is not installed in the Lane, or a runner that
cannot start for a missing package (`npx --no-install`: "npx canceled due to missing packages";
pnpm/yarn "Command not found"), records `ENVIRONMENT / DEPENDENCIES_MISSING` the same way, naming
the `missing` packages and the install command to run in the Lane. No service
restart happens automatically.

Measurement-hold waits use the isolated helper and a one-second local removal check only while a hold exists. Degraded hints report `ENVIRONMENT` and `nforge doctor .`; an active hold remains in force. No hold means no watcher, timer or server call.

The shared watcher's close acknowledgement is flushed before removing its
private probe directory. Removal runs asynchronously so target events and close
acknowledgements continue while deletion is pending. Directory cleanup cannot consume the
250 ms native-close deadline or falsely degrade the remaining subscribers.
A missing close acknowledgement still degrades and terminates the helper;
only a later explicit consumer probe can recover it under the existing backoff.
Heavy-slot and checkout admission hints also use the isolated helper. Their
existing thirty-second and one-second fallback timers still make progress when
native startup, event delivery or close fails; no new retry timer is installed.

Measured checkout churn is far too small to explain the multi-day fseventsd wedge,
whose cause remains unknown. Two bounded
synthetic runs on the local APFS volume probed delivery and daemon RSS around each
tree: three 2,500-file trees (all twelve probes healthy, RSS 9.55 to 10.08 MiB), and
five 29,000-file trees, 145,000 files created and removed in 21.3 s (all eleven
probes healthy, median delivery 11.4-12.7 ms, RSS 9.33 to 10.36 MiB, about 7 KiB per
thousand files). At that rate the observed 2.4-7 GB would need hundreds of millions
of churned files. After the daemon restart, about 56 hours of concurrent multi-builder
Lane and bench churn left it at 9.6 MiB. No indexing exclusion, tree reuse or daemon
policy change is warranted; the health probe, ordinary ENVIRONMENT classification
and `nforge doctor` remain the containment, with `sudo killall fseventsd` as the remedy.
Bench preflight continues to refuse unhealthy cells before timing.

### Check environment contract

Checks, Playbook steps and event automations use the same clean local runner.
The command receives a fresh materialized Candidate and private HOME/USERPROFILE,
XDG and temporary directories. Ambient Forge/cloud tokens, SSH agent settings,
credential-file overrides, `NODE_OPTIONS` and npm configuration are omitted.
Only the runtime allowlist and generated check metadata described in
[security](security.md#clean-check-environments) are supplied by default.
The dedicated shared npm content cache remains under the runner's home, so its
path is visible; this is environment hygiene, not home-path secrecy or an OS sandbox.

For an existing check, include `env: ["NAME"]` or `credentials: ["TOKEN_NAME"]`
in its local `define-check` command. Each list names exact parent-process variables;
there is no prefix expansion. Missing values remain absent. The lists are pinned
in the check definition and receipts; their transient values are not recorded there.
For example, `credentials: ["AWS_SHARED_CREDENTIALS_FILE"]` exposes only that
variable in addition to the clean defaults, whereas `env: ["HOME"]` restores
all home-relative configuration discovery. Other variables keep their defaults.
Runner-generated `FORGE_CHECK_*` input/output metadata keeps its pinned values.
Command output can still expose any supplied credential.

The default command cannot discover the user's SSH, AWS, Forge or dotenv files
through inherited HOME/XDG paths. Known absolute paths remain readable with the
user's OS permissions, and retained source is not secret-scanned. Synthetic
negative and opt-in coverage lives in `tests/check-environment.test.mjs`.

### Queue and recovery

All local owners and Forge processes under one OS account share a filesystem check queue at `~/.forge/check-queue`. The default limit is `max(1, floor(logical CPUs / 4))`; set `FORGE_MAX_CONCURRENT_CHECKS` to a positive integer in every runner environment to override it. A queued run reports `queued`, can be cancelled, and waits before workspace materialization or command execution; command timeouts start only when the command starts. `observe` shows its original run id. `finish` normally waits through the queue; optional `waitMs` returns a bounded receipt (including `queued`, `terminal:false`) and replaying the same operation resumes the original finish. `FORGE_CHECK_QUEUE_DIR` selects an alternative shared directory; use the same directory for every production runner. Forge must be able to write `~/.forge` (or the `FORGE_CHECK_QUEUE_DIR` directory); in a sandbox or container that blocks it, `finish` fails with `SYSTEM_EPERM`/`SYSTEM_EACCES`, the path and a hint. Allow the write or point `FORGE_CHECK_QUEUE_DIR` at a writable directory shared by every runner on the machine. There is deliberately no automatic owner-local fallback: separate queues would let each owner run its own full set of checks and exceed the machine-wide limit. System failures and unexpected errors write the full stack to `~/.forge/logs/diagnostics.log` (else the temp directory; 3 files of up to 256 KB), never inside an owner or checkout root, so `nforge pull` never meets it and the error names that file.

Use `nforge queue list` to see operations, Lanes, phases, ages and holders.
`nforge queue prioritize OPERATION` advances a waiter; `nforge queue cancel OPERATION`
cancels its finish and check process group, including children. MCP exposes the
same actions through `forge_queue`. Prioritization preserves active non-audit
holders. Main audits yield to foreground checks and coalesce onto the newest
accepted main; GitHub push drains pending main audits first.

Queue holders and runs record PID plus process start identity. Status, observe, run, finish and clean apply reconcile a dead local runner as `interrupted`, retaining its output and original operation id without rerunning the command. A surviving detached process group keeps its queue capacity and workspace until it exits. Legacy records without a start identity remain conservatively PID-based; remote-host liveness is unknown.

Before Lane/check materialization and check execution, Forge probes free space on the owner's filesystem. At ≤5 GB free, receipts include a warning; below 2 GB, preparation refuses with `DISK_LOW` and points to `nforge agent ROOT clean` (dry run). A drop while queued produces a failed run with a structured `error` rather than executing. Configure decimal-GB thresholds with `FORGE_DISK_WARN_GB` and `FORGE_DISK_BLOCK_GB` (non-negative; `0` disables that threshold). Forge never deletes files because of low disk space.

### Agent sandboxes

`nforge` works inside agent sandboxes such as macOS `sandbox-exec` (Codex, Claude Code
sandbox mode). Every lock, queue ticket and landing worker records
its PID plus the kernel process start time, so a reused PID never counts as the old
owner. On macOS that start time comes from setuid `/bin/ps`, which sandboxes refuse to
exec. When `ps` is refused, Forge reads the same kernel record (`sysctl kern.proc`)
through `/usr/bin/perl`, which needs no setuid, and formats it exactly like `ps`, so
identities recorded inside and outside a sandbox compare equal. Linux reads
`/proc/PID/stat`, which namespace sandboxes normally leave readable. If neither source works, the command fails with
`PROCESS_IDENTITY_UNAVAILABLE` rather than guessing.

A sandbox profile must allow: exec of `/usr/bin/perl` and `sysctl-read` (macOS), outbound
network to the hosted service, and writes to the Lane folder, its `ROOT.forge-client`
folder, `~/.forge` (or `FORGE_CHECK_QUEUE_DIR`), `~/.cache/forge`, the temp directory and
the CLI installation folder (the launcher takes `runtime.lock` there on every command).
`tests/sandbox-process-identity.test.mjs` runs the identity paths under a minimal
`sandbox-exec` profile on macOS.

### Landing lifecycle drill

Run the Q4 drill from a prepared checkout (Node 24.22.1+, dependencies installed
with `npm ci --ignore-scripts`, then `npm run build:core`):

```sh
node --import ./tests/check-runtime.mjs --test --test-concurrency=2 \
  tests/landing-lifecycle.test.mjs \
  tests/hosted-machine-lifecycle.test.mjs \
  tests/landing-check-recovery.test.mjs \
  tests/hosted-mac-runner.test.mjs
```

The restart cases create disposable native owners and real gated check processes.
They seed keyed passed checks, stop the owner controller with SIGTERM or SIGKILL
mid-check, and start a replacement controller. Both solo admission and combined
checks must land the original entries without resubmission. A dead local
controller or a service-stop signal retains the old run and reserves one
deterministic replacement operation for its unfinished check. Its diagnosis and
entry `infrastructureRetries` record the original run. Passed content-keyed evidence
is tried first. Explicit cancellation, failed source checks and preparation errors
retain their normal outcomes. A surviving orphan process group keeps its check
capacity until it exits. Cancel the original landing entry to stop its recovery.
Standalone `run` operations still retain their original interrupted outcome.

The hosted cases use in-memory backend transactions, a fake provider and fake R2
objects. They keep one remote check running across a 30-minute client clock jump
or a 10-minute transport outage, then deliver its retained signed completion.
Previously passed shard records, the run and the landing handle must retain their
identities; the original submission must reach `landed`. The Mac-runner tests also
exercise lease expiry, fencing, the existing one-requeue behavior, late callbacks,
and terminal delivery when no runner returns. These are deterministic simulations;
they do not sleep the test Mac, disable Wi-Fi or contact a live service.

Each lifecycle case prints JSON with simulated outage duration, elapsed wall time,
passed-check re-runs, stranded entries and recovery mutations. The initial restart
replay ended one in-flight entry as `cancelled` (SIGTERM) or `interrupted` (SIGKILL),
requiring resubmission to continue. The measured recovery cases all landed with
zero re-runs of passed checks, zero stranded entries and zero requester mutations
to settle:

| Case | Simulated outage | Measured wall time |
| --- | --- | --- |
| Solo check, SIGTERM restart | Service stop/start | 20.018 s |
| Solo check, SIGKILL restart | Service stop/start | 19.426 s |
| Combined check, SIGTERM restart | Service stop/start | 18.651 s |
| Combined check, SIGKILL restart | Service stop/start | 16.061 s |
| Hosted remote check, sleep | 30 minutes | 0.485 s |
| Hosted remote check, network loss | 10 minutes | 0.489 s |

These are synthetic drill times, not production latency or
runner-billing measurements; fault injection and starting the replacement service
are excluded from recovery-mutation counts. Repeat output gives current timings.

For Phase 5 metrics, this qualifies metric 5's recovery path without a manual retry
and metric 6's preservation of passed work; production interventions per landing,
check minutes and reuse rate remain unmeasured by this drill. Metric 3 is checked
by requiring every original submission to settle, with no pending queue work.

### Stalled and dropped landings

A hosted landing entry with no progress for 15 minutes raises a `LANDING_STALLED`
alarm (`stall` in its observation). For a queued entry, a second deadline 60 minutes
after its last progress re-drives it; if nothing is left to drive it, Forge ends it
as `terminal-failed` with `LANDING_STALLED` and a stated reason, through the
cancellation path, so the requester gets an outcome and batch peers are re-selected.
Nothing lands in that case; finish the same Lane again to retry. While a live owner
(the queue, its own finish attempt, a batch or a batch peer) still drives the entry,
Forge never ends it: the deadline re-arms at 2, 4, 8 and 16 hours and then stops.
Entries waiting for review or a dependency are not ended. Settled and idle queues
schedule no recurring wake. See [agent workflow](agents/workflow.md) for the receipt fields.

## Local cleanup

`nforge agent ROOT clean` (MCP `forge_task` action `clean`) reclaims regenerable local disk. It is a dry run unless you send `{"apply":true}`; the dry run lists candidates grouped by kind with bytes and the reason each is safe, plus totals and every skipped item with its reason. Apply recomputes the set under the owner lock and re-validates each item (pass `items` ids from a dry run to limit it; anything that changed is skipped). `kinds` filters:

- `check-retention`: remove eligible terminal remote source copies immediately; after strictly more than seven days, remove unpinned terminal runs’ remaining source/runtime and shard work copies and remove expired combined and shard log bytes while keeping compact test evidence. Terminal receipts (including failure summaries), compact test reports, selection, changes, plans, provider state and selected artifacts stay. Running/queued/preparing runs, explicit release build-run/export pins, resumable or unknown remote executions and in-use directories stay. Acceptance and open-Lane references retain evidence without protecting old bulk; recent shard work and logs remain untouched. Both the run end and the individual remaining copy/log must be older than seven days.
- `check-workspaces`: finished check runs’ `workspace/`, `runtime/`, `modal-source/` and `github-actions-source/` copies, without an age gate. Remote source copies require a matching terminal receipt, no resumable backend, release/export pin, unresolved remote execution or process blocker. `result.json`, logs, selection, plans and artifacts stay. Missing receipts, archived-interrupted-only receipts, receipt mismatches and unresolved remote executions have specific skip reasons. An interrupted run with a matching archived receipt and a recorded supersession by a later retained Candidate in the same Intent/Lane family may release only its remote source copies; its evidence stays untouched. Ambiguous interruption or supersession retains all copies.
- `lane-deps`: `node_modules`, `dist` and similar build directories inside completed or abandoned Lanes. Other ecosystems' folders (`target`, `.venv`, `venv`, `__pycache__`, `.gradle`, `.pytest_cache`, `.mypy_cache`, and `bin`/`obj` beside a `.csproj`, `.fsproj` or `.vbproj`) count only when `.gitignore` or `.forgeignore` ignores them; a folder that is not ignored is never reclaimed.
- `lanes`: the whole directory of a completed or abandoned Lane, only when a capture of it equals the Lane head State; otherwise it is skipped as uncaptured edits. Gitignored files (such as `.env`) are not in State and are deleted with it. `reopen`, `checkpoint`, `sync` and `finish` re-materialize a removed Lane from its head State.
- `exchange-staging`: unreferenced exchange staging older than seven days. Pending operations, old baseline hints that still depend on staging, and retained export references keep their directories. Pending or explicitly retained export manifests pin only the exact check-file bytes they reference; completed preparation baselines retain staging metadata without pinning owner log prefixes. Unreferenced staging, including staging younger than seven days, does not pin old check files. A log pin does not protect its run’s source or shard work copies.
- `auto-snapshots`: remove automatic snapshot pointers and caches of completed or abandoned Lanes after strictly more than seven days from both the snapshot and latest Lane closure. Open Lanes are protected regardless of snapshot age; reopening within the window keeps their source protected. Dry-run `disk.kinds` reports the current footprint of all snapshots, including protected open Lanes, with shared State/blob objects counted once. Candidate `bytes` counts pointer/cache bytes; `snapshotBytes` separately reports the referenced State/blob footprint, including shared objects (per-snapshot sums can overlap). Removing a pointer does not delete source objects: `objects` can reclaim only those unreachable from every other retained root. Saved checkpoints are unaffected.
- `objects` (only when named): wraps `inspect-native-objects` and `collect-native-objects`.

Active and paused Lanes, Work records, referenced objects and anything outside ROOT are never touched. Repeating is safe.

The client also keeps its own machine files bounded without a daemon: nested Lane copies in `ROOT.forge-client/lanes` (size and age caps, [defaults](parallel-work-defaults.md#clientcachemaxgb-and-clientcachemaxagehours)), idle Lane roots without unsaved edits (`autoPruneHours` for finished Lanes, `activeLanePruneHours` for open ones; every removal is logged to `lane-prune.jsonl`), the peers cache in the temp directory (entries older than a day, swept at most hourly on write) and dead `nforge-wake-*` channel directories (swept when a driver opens its own). Unix sockets (the wake channel, the shared watcher) live in a short directory: under `$TMPDIR` when the socket path stays under 100 bytes, else under `/tmp`, because macOS refuses longer paths; the CLI's clean preflight environment nests `$TMPDIR` deeper than that. Local changes an explicit `recover-apply` set aside are not cache: they stay in `ROOT.forge-client/kept-apply/` (changed files and a receipt only, listed by `status` as `keptApply`) until seven days after the apply is confirmed, and Lane pruning leaves that folder in place. Test runs create their directories under per-run prefixes, remove them on exit and on `SIGTERM`, and sweep earlier runs' `forge-test-*` directories older than two hours. Forge's own temp output goes under `$TMPDIR/forge-tmp`, swept from CLI start (entries unwritten for two hours, at most hourly, never one whose process is alive); the client directories carry an empty `.metadata_never_index` file so Spotlight skips them ([local disk](parallel-work-defaults.md#local-disk)).

A hosted Lane the owner pinned (`nforge x ROOT pin '{"laneId":"LANE_ID"}'`, `pinned:false` to undo) is skipped by `prune` and the client cache GC, and by complete-merged, `completeOnAccept` and Intent cascades on the server. An explicit complete or abandon of it fails with `LANE_PINNED` until it is unpinned.

With `lifecycle.cleanRegenerableCopies:true`, terminal checks immediately remove eligible remote source copies and Lane lifecycle events also sweep these copies and the seven-day retention kinds. Retention is automatic only under that existing opt-in; there is no background daemon. It removes old log prefixes and expired closed-Lane auto-snapshot pointers/caches permanently and records that fact; rerunning a check reconstructs its source copy, not its original output. A resumed run gets a separate cleanup action for its new terminal end time; repeating the same completion returns its recorded cleanup result. Dry runs do not reconcile or rewrite run records.

With `lifecycle.cleanRegenerableCopies:true`, Lane completion and abandonment automatically apply the shared cleanup validator under the owner lock; accepted-work completion also sweeps eligible older copies. Preset defaults are unchanged: Autonomous opts in, while other presets and migrated owners retain their existing setting. Automatic whole-Lane cleanup preserves excluded local settings and arbitrary ignored files outside recognized build directories. Dirty, active, pending, in-use or unverifiable copies stay, with reasons recorded alongside removed paths and `reopen`/rebuild instructions in automatic-action receipts. Terminal native checks retain immediate workspace/runtime cleanup across presets after validating and flushing terminal receipts, logs and selected artifacts; run details report removals or skipped copies. Retained source and evidence stay readable. Retrying a completed finish does not re-materialize its removed closed Lane.

## Account data

Account, then "Your Forge data", then "Refresh inventory" lists everything you own across seven families. "Download metadata" saves the inventory with hashes. It holds no source, raw Work, secret values or credentials. Use project archives, import snapshot controls and Secret Object export for those.

You can select owned items for removal. Projects and imports use their normal final-deletion paths, agent grants are revoked, teams are cleaned up and personal saved items are removed. "Leave incoming access" removes only your own rows in things shared with you. Other people's grants and records are untouched. An interrupted request resumes from "Retained original requests". Receipts, downloaded copies and Clerk and GitHub identities remain.

## Client error reports

Signed-in hosted browsers record failures in the Convex `clientErrors` table (see [architecture](architecture.md#client-error-capture)). Each row holds the reporting account's auth subject, kind (`error`, `unhandledrejection`, `render`, `mutation`, `action`), scrubbed message and stack, route path, build hash, and when known the Convex function name, error code and project. Rows never hold source contents, URL query strings or recognized tokens.

To read a project's reports, call `clientErrors:recent` with `{projectId, paginationOpts}` as the project owner; anyone else receives `PROJECT_UNAVAILABLE`. There is no browser view yet. Operators can also inspect the table in the Convex dashboard. Match `build` against the hashed `assets/index-<hash>.js` of a deployment to find the build that failed.

Reports are kept until removed by hand: there is no automatic retention, and they are not yet part of "Your Forge data" inventory or project and account deletion.

## Secret Object recovery

Keep the exact `FORGE_SECRET_KEYS` keyring, a JSON object with an `active` key ID and a `keys` map of base64 32-byte keys. Back it up apart from the database. To rotate the encryption key, add a new key and mark it active. Never remove an old one while any export or snapshot may need it. Rotating the credential and rotating the key are different things.

Open Secret Objects, choose an object, then "Export or delete object". "Download encrypted object" saves every version, grant and audit event, plus its SHA-256. If the object changes mid-download, retry. The file has no key material. In a private Node process, decrypt it with `recoverSecretArchive(text, keyring)` from `@nanthai/forge`. The result is plaintext in memory, and grants are historical only. Create a replacement through `secretActions.create` with a new operation UUID and re-grant access explicitly.

To restore live IDs, grants and audit together, restore a whole-instance snapshot with the original keys (see below).

"Permanently delete object" removes encrypted values, grants and audit rows and leaves a minimal receipt. Reconcile an interrupted deletion from "Deletion receipts". Existing downloads and the GitHub credential itself are unaffected, so revoke the credential at GitHub as well.

## R2 object storage

Every byte goes to Cloudflare R2: project objects, import uploads, source-job outputs and cursors, check logs, backups, proposals, packs and indexed artifacts. There is no per-project opt-in and no deployment flag; new projects write R2 from their first byte. Convex holds records only. [Data placement](data-placement.md) lists every table and byte store; the guard in `tests/hot-storage-invariant.test.mjs` fails verify on any new Convex file-storage write.

### Convex environment

Read only inside Convex functions and never sent to clients.

| Name | Meaning |
| --- | --- |
| `R2_ACCOUNT_ID` | Cloudflare account id; the endpoint is `https://<account>.r2.cloudflarestorage.com/<bucket>/<key>`. |
| `R2_ENDPOINT` | Optional. Another S3-compatible origin, for example a self-hosted bucket: `https://…`, or `http://` on loopback only. |
| `R2_BUCKET` | Private bucket name, for example `forge-blobs-dev`. |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | S3 credentials for an R2 API token with Object Read & Write on that one bucket. |

A missing variable fails the write with `R2_NOT_CONFIGURED`; Forge never falls back to Convex file storage. `FORGE_BLOBS` and `projectObjectCommit:setR2Writes` no longer exist. The `r2Writes` column on older project and import rows is kept but ignored.

### Behaviour to know

- Upload URLs expire after 15 minutes. Objects are never overwritten; a repeated upload of the same content is accepted as already stored.
- Download URLs expire after 5 minutes; readers sign again once on expiry.
- A corrupt or tampered object is rejected with `BLOB_DIGEST_MISMATCH` and never written.
- A checkout missing 500 or more objects downloads the project's latest source pack (one gzip in R2, at most 300 MiB and 100,000 files, `projectSourcePacks`) in one signed GET instead of per-object pages. A pack is a cache, not a limit: below 500 objects, or for anything the pack lacks, objects still come one by one, each verified by digest.
- Otherwise clones and Lane opens read signed pages of up to 500 objects (`describe`/`lanePage` with `runs`). Requested objects that sit back to back in one stored upload pack (a GitHub import window, or a save's upload pack) form a run: the server signs one byte range covering exactly those objects, never a gap, and the client reads it with one ranged GET, eight at a time, checking each object's digest as it completes. Other objects keep their own signed range or URL. A run whose signature expired, or one only partly needed, falls back to per-object reads; an older server without `runs` keeps 100-object pages. Both functions read a page's object rows concurrently (`findObjects`), resolving catalog entries in digest order so each catalog row is read at most once per call.
- Rows written to Convex file storage before R2 was the only path stay readable there. `nforge maintenance r2-backfill ROOT --dry-run` reports what is left to move and which Convex copies cleanup could delete ([R2 backfill](operations/r2-backfill.md)). Deleting them is a separate owner-approved step.

### State trees (dual-write)

Off by default, per project. Operators use internal functions on the deployment (development first):

```sh
npx convex run projectStateTrees:configure '{"projectId":"PROJECT_ID","write":true}'
npx convex run projectStateTreeConvert:convert '{"projectId":"PROJECT_ID"}'   # main's head; safe to repeat
npx convex run projectStateTrees:status '{"projectId":"PROJECT_ID"}'
```

`convert` reads every file of the State once (one query per 100 files, at most 20,000 files) and reports files, bytes read, segment bytes and calls. After it, each save and merge on a State with a pointer writes one more R2 object and makes no extra Convex call. `status` shows the flags, main's head and its pointer, and `refused` when a State's tree form failed its read-back check: that State was saved flat and nothing was lost, but its descendants stay flat until a `convert`. Find the cause from the `forge-state-tree` error line (State id and code), then acknowledge with `configure {"projectId":"…","clearRefused":true}`. `write:false` stops new tree writes at once; existing pointers and segments stay.

## Self-host

The same Convex schema runs on the pinned official local Convex backend (SQLite and local files). The launcher supports macOS arm64 and Linux x64. It is a loopback development setup with no TLS, public ingress or production guarantee.

```sh
npm ci --ignore-scripts
node scripts/selfhost.mjs init DIR BACKEND.zip PORT   # verifies the pinned SHA-256 first
node scripts/selfhost.mjs start DIR                   # foreground; Ctrl-C stops it
```

Download the backend zip for your platform from the pinned `get-convex/convex-backend` release. The pins and hashes live in `scripts/selfhost.mjs`. A pin cannot be swapped in place. `init` refuses an existing directory.

Always pass `--env-file DIR/deployment.env` to every `npx convex` command so you never touch the cloud dev project. Keep `deployment.env` private since it holds the admin key. For a new anonymous instance:

```sh
npx convex env set CLERK_JWT_ISSUER_DOMAIN '' --env-file DIR/deployment.env
npx convex env set FORGE_CLI_ISSUER '' --env-file DIR/deployment.env
npx convex deploy --env-file DIR/deployment.env --typecheck enable --yes
```

Convex rejects reads of unset auth-config variables even inside an optional guard. Set both issuer variables explicitly; an empty string keeps that provider disabled.

Build the browser with `VITE_CLERK_PUBLISHABLE_KEY=''` and `node --env-file=DIR/deployment.env ... vite build web --mode hosted`. For private access, set the Clerk and GitHub App variables from [development](development.md) on the instance. They are not part of snapshots, so set them again on a restored instance.

**Backup:** `npx convex export --include-file-storage --path DIR/backup.zip --env-file DIR/deployment.env`. A snapshot holds documents and files. It does not hold deployed code, backend environment, instance config or local Work stores. Save the Forge commit and lockfile with it.

**Restore:** start a fresh instance, import first, then deploy: `npx convex import backup.zip --env-file ...` and then `npx convex deploy`. Deploying a newer schema first can clash table IDs. A restored snapshot can bring back older grants, so recheck current access.

**Backend upgrade:** create a fresh instance with the new pin and restore a snapshot into it. Keep the old instance until you accept the result. Rollback restores a snapshot into a fresh instance on the old pin.

**Storage:** a self-hosted instance stores bytes in R2 like every deployment; there is no Convex byte mode. Set the `R2_*` settings, or `R2_ENDPOINT` for another S3-compatible bucket. Without them, every byte write fails with `R2_NOT_CONFIGURED`. File-inclusive snapshots hold only legacy copies, not the bucket. The launcher accepts an optional private dotenv file as a third `start` argument. It sets native S3 storage with five buckets (`S3_STORAGE_EXPORTS_BUCKET`, `_SNAPSHOT_IMPORTS_`, `_MODULES_`, `_FILES_`, `_SEARCH_`) and `AWS_*` credentials. Changing the argument on an existing database does not move its files. Restore a snapshot into a fresh instance instead.

`node scripts/selfhost-smoke.mjs` runs the repeatable check against the pinned public repo `sindresorhus/is-plain-obj`. It needs a read-only `GITHUB_TOKEN`. It starts a local S3-compatible bucket and points each fresh or restored instance at it through `R2_ENDPOINT`. On failure it reports the stage, a command label with private arguments withheld, exit status and a bounded, secret-redacted diagnostic tail, including the import job error when acquisition fails. Raw diagnostics remain in the invocation’s private temporary directory; deployment environment contents are never printed.

**Licenses:** Forge's server is AGPL-3.0-only and the launcher and client are Apache-2.0 (see [LICENSE.md](../LICENSE.md)). The downloaded Convex backend has its own FSL-1.1-Apache-2.0 terms. Inventories: [npm](dependency-licenses.md) and [native backend](native-dependency-licenses.md). The native one is partial and not an SBOM.

## Preview environments

In local Work, "Preview environments" selects a retained Netlify draft under a name. "Roll back to this preview" selects an earlier draft and appends a new move. This changes a local pointer only. It uploads nothing, promotes nothing and checks no health. Use the `select-preview-environment` action with `expectedPrevious` set to the current selection UUID. Back up the Work store, because Convex snapshots do not include it.

### Backfill coordination activity timestamps

After deploying the additive coordination activity index, run
`npx convex run coordinationBackfill:activity '{"cursor":null}'` against the
intended deployment (`--prod` for production). Repeat with the returned cursor
until `isDone` is true. The internal mutation requests 100-row pages with a
500,000-byte read budget and derives optional timestamps from retained Lane/run
summaries. Any page may be replayed, or the process restarted at null. New index
writes populate the same field. Imported-history activity counts are incomplete
until the backfill finishes; source and retained Work history remain intact.

Lossless hosted source acquisition uses the [GitHub project import](operations/github-project-import.md) API, separate from the derived analysis tour. An import needs no Mac: it becomes an agent-writable hosted project once ready. The t3code import (about 29,000 files) takes 2 min 31 s and 2 min 37 s in two runs, until the project is agent-writable, within the 5-minute goal ([status](status.md)). Archive-style imports store a sorted object catalog instead of one `projectObjects` row per object (`convex/projectGithubImportCatalog.ts`).

## Import benchmark guard

The [scheduled import benchmark guard](operations/import-benchmark-guard.md)
counts observed project executions, cancels scheduled import/index work on the
approved benchmark stop conditions, runs temporary-project deletion and proves
a quiet window without idle function polling.


## State generation pass

New fixed-worker States and bootstrap/Git/GitHub snapshot roots write topological
levels on the existing object metadata records. Older States remain readable
through the same BFS ancestry path. The finite dev operator pass populates their
missing levels; it is not an automatically scheduled migration. Run it only on
the explicitly selected dev deployment and existing project. The implementation
builder does not run this command against hosted data.

From an installed, reviewed checkout with the usual Convex operator credentials,
preview first (no State bodies, source writes, R2 writes or background work):

```sh
node scripts/backfill-state-generations.mjs --deployment DEV_NAME --project PROJECT_ID --actor OWNER_ID --cursor PRIVATE_PREVIEW_FILE
```

The output gives scanned State candidates, missing levels and total logical
manifest bytes. Publication records are scanned in creation order; the pinned
imported `sourceStateParents` index supplies additional candidate identities.
Those derived rows supply no parent facts or generation proof. The selected main
is included for older projects without a complete import index. A preview can
count an identity twice across the two header sources; it is an upper estimate
for those headers, not proof of complete source coverage. Missing intermediate
parents are discovered and verified by apply. No index repair is triggered.

Apply with a separate private continuation file:

```sh
node scripts/backfill-state-generations.mjs --deployment DEV_NAME --project PROJECT_ID --actor OWNER_ID --cursor PRIVATE_APPLY_FILE --apply
```

The command calls `projectStateGenerationActions:step` through the installed
Convex operator CLI. Each step handles at most 100 State identities and normally
2 MiB of logical State bodies (one larger State is handled alone). It verifies
hashes/recipes and parses the actual parent lists, then derives levels from
persisted parent levels and the authenticated page, parents-first. Discovery
retains unresolved dependency identities instead of repeatedly reading their
bodies. After discovery, those untrusted hints order a second verification pass;
each committed level still comes from exact authenticated State bytes and current
server parent levels. Only internal fixed actions can submit those parent
summaries. Cached size hints skip redundant discovery queries, but the source
reader still checks exact bindings and current access before and after every
body acquisition. Current project ownership is
checked on every read and commit. Cycles, changed bindings and unavailable bytes
surface structured errors instead of guessed levels. Stored levels never change.

An interruption retains the exact operation id, scan, pending ids and compressed
dependency/size hints. No source bodies or authoritative levels enter that private
continuation. Rerun the
same command/file: an unknown committed page reconciles from existing levels,
without duplicate records or source changes. Completion stops the process; idle
cost is zero. The output reports confirmed assignments and source bodies verified; a lost response can leave an already committed assignment outside the local confirmed-write counter. This only adds
recomputable metadata; ignoring it restores BFS. It changes no State hash, parent,
file, retained history, Work selection, source authority or R2 encoding.

Cost planning (estimates, not observed billing): one double is 8 bytes per State,
20/40 kB for 2,500/5,000 States, plus the field name/record encoding and a sparse
catalog index where needed. No healthy save/accept/import function call or R2
object is added. A synthetic 2,500/5,000-State metadata pass uses 26/51 scan pages,
2,500/5,000 existing-row writes and about 7,600/15,200 document reads before
optional replay checks; source-byte verification is separate. Complete
source-verified synthetic chain measurements at 2,500 States are:

| Candidate discovery | Action quanta | Function executions | Document reads | Existing-row writes | R2 GETs | Logical body bytes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Creation-ordered headers | 26 | 151 | 12,650 | 2,500 | 2,500 | 446,324 |
| Child-before-parent headers | 2,451 | 9,780 | 27,253 | 2,500 | 4,999 | 892,538 |
| Only the tip header; intermediate headers absent | 2,526 | 10,128 | 22,627 | 2,500 | 4,999 | 892,538 |

All three paths make zero R2 writes. The unordered paths read each body at most
twice (once for discovery, once for parent-ordered assignment), rather than
re-downloading unresolved dependants on every quantum. Already assignable pages
need only one read. Transport retries and unknown replies can repeat in-flight reads; recipe trees
add their own physical reads and resolution calls. Each action retains at most
100 State bodies / normally 2 MiB (17,900 bytes in these small-manifest fixtures).
The continuation grows with dependency identities, not file bodies or whole Work.
Fake-network timings are not live wall-time estimates. A chain without parent
headers necessarily reveals one new parent per discovery quantum; the
creation-ordered page count is not an order-independent function-cost estimate.

Preview counts only visible headers; it cannot estimate undiscovered parents.
For 2,500 unique States averaging 300 kB, uninterrupted logical source reads are
about 750 MB when already parent-ordered and at most about 1.5 GB with discovery
and re-verification. Verification alone needs roughly 360–420 byte pages;
missing-header discovery can additionally need 2,500 sequential quanta. Budget
from the actual candidate ordering, sizes, fan-in and recipe placement. A 5 MB
average instead means about 12.5–25 GB of logical source reads and at least
2,500 verification byte pages. At the benchmark's assumed $2.20/million calls,
151 / 10,128 executions cost about $0.00033 / $0.0223 for calls alone, before
DB I/O, R2 operations and action compute. At $0.30/GB-hour, each cumulative minute
of 0.5 GiB action compute adds $0.0025; the lead must measure runtime rather than
assuming a 5–15 minute pass from header bytes.
No current invoice, live migration wall time or deployed byte-placement delta is
claimed. The lead owns deployment, the dev pass and billed-usage qualification.
