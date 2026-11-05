# Is Forge's test suite earning its CI minutes?

Status: **read-only research, measured on historical data (2026-10-02 to 2026-10-25).** It is input to speed, test-selector and suite-health work. It is **not a safe deletion list**: nothing here recommends deleting, quarantining or skipping a test, and no policy changed. Prices and the runner plan it models are **obsolete** (see [Cost caveats](#cost-and-scenarios)). Only read-only analysis ran; no suite, focused test, `verify`, benchmark, remote check, deployment or account request was run for it.

Labels used throughout: **M** = measured, **E** = estimated, **U** = unrun.

The raw measurements (full file and test rankings, individual failure episodes, source and retry links, selections, log hashes and the estimate formulas) and the extraction inputs are kept privately. This page carries the method and every number behind its findings; nothing here requires access to them.

## Findings

| Finding | Evidence |
| --- | --- |
| Data coverage | **M:** frozen Work revision 24,715; 1,261 runs; 163,051 verdicts in 102 nonempty runs. 1,272 actual check directories (one controller directory is excluded). 11 newer directories contribute only to the separate selection inventory. |
| Runtime | **M:** 5,787 summed process-minutes, 77,027 timings in 191 GitHub checks across 499 files, Oct 23–25. The top ten files consume 22.3%. Parallel process time is not billed job time. |
| Never failed, expensive | **M:** 374 of 500 observed files never failed; they account for 46.7% of timed process seconds. The three costliest are `source-return-prepare-memory.test.mjs`, `land-command.test.mjs` and `source-return-prepare.test.mjs`, with medians of 65.1, 38.5 and 36.2 seconds. |
| Selection | **M:** 891 frozen runs have selections; the non-doc median is 288 files (range 5–498). A separate 902-artifact inventory includes 197 deliberate full `main` audits. 27 identical source, environment and selection success repeats are **not** automatically removable: Candidate pins and audit policy still matter. |
| Failure history | **M:** 204 of 339 failed checks carry file alarms; 135 lack attribution. Of 508 file/run episodes: 16 unchanged-source retry passes, 5 legacy flake labels, 2 prior identical-source passes, 315 changed-code same-Lane landings and 170 unresolved. Changed-code association is a real-failure proxy, not causation. |
| Co-failure and precision | **M:** `account-portability` and `contributor-runtime` co-failed on the same nine runs; together they are only 0.04% of timed process cost. In 118 real-proxy failed runs there were 315 failing file executions out of 41,328 selected. **E:** a hindsight selection 99.24% narrower retains every recorded alarm in that cohort. **U:** predictive safety, and the failures with no attributed file alarm. |
| Budget | **M:** 430 checks retain job timestamps. **E:** 168 accepted checks average 20.82 rounded 4-vCPU job-minutes; at 30 landings a day for 30 days that implies 18,739 job-minutes a month. **Obsolete, assumed prices:** that was modeled as 37,479 2-vCPU allowance minutes, $150 gross at an assumed rate, with an assumed 3,000-minute free allowance covering 8.0%. Separate audits and retries add cost. Pricing and invoices were never verified. |

## Candidate next steps (not decisions)

1. **Optimize the ten costliest fixture and harness paths.** Reuse immutable fixture setup through private copies where valid; preserve assertions, workloads and the fresh-process memory tests. **E:** a 50% runtime reduction targets about 1,476 job-minutes a month. **U:** the speedup.
2. **Fix unchanged-source restart, wait and process-lifecycle failures.** Synchronize readiness and exit; keep the tests and timeouts. **M:** 11 matched pairs, 10 distinct passing retries. **E:** 226 rounded retry minutes extrapolate to about 1,211 job-minutes a month. **U:** the fixes, and exclusive cause attribution.
3. **Share pinned build outputs between shards.** **M:** 276 successful checks average 18.6 repeated build-startup seconds. **E:** about 280 job-minutes a month before transfer overhead. **U:** the implementation and net billing effect.
4. **Compare narrower selectors in shadow mode.** Keep full audits and unknown-dependency fallbacks. **E:** zero immediate minutes saved; the hindsight ceiling is not deployable. Never-failed and co-failure rankings alone do not justify removal.

**E:** savings assume 900 landings a month and two file workers; the estimates overlap (do not add them) and omit rounding and static floors. **U:** tests, `verify`, selector replay, benchmarks and product changes.

## Method

### Evidence boundary and denominators

- Measured frozen Work revision 24,715. 1,261 runs span Oct 2–25. Of 109 runs retaining test verdicts, 102 are nonempty; they hold 163,051 entries (163,022 passed, 22 failed, 7 legacy flake labels). Logs supply much more failure history than this partial verdict window.
- Eleven post-snapshot directories are excluded from the runtime, failure and cost results but included in the separately reported 902-artifact selection denominator. Frozen selection evidence covers 891 runs (including 12 docs-only selections). Every file percentage names its denominator.
- When the frozen snapshot and an artifact disagree on a final status (this happened for one run: interrupted in the snapshot, failed in its artifact), the frozen status wins. Logs with alarms in passed, interrupted or cancelled runs remain observations; they are reported separately and are not called failed checks or real defects.
- Explicit file timings cover only Oct 23–25: 77,027 samples in 191 frozen checks, all on GitHub Actions, across 499 test paths. Older logs without a duration get no invented timing. Empty timing cohorts have null totals and medians; zero samples is not zero cost. The 509 historical paths include renamed, removed and artifact-only files; this is not a claim that today's suite has 509 files. 500 paths have an execution or failure observation.

### Runtime and failures

- File `durationMs` is elapsed process time, including startup and teardown. Sums include retained attempts and overlap across two file workers. The share of summed process time is measured. The share of total check execution time is **estimated** as process seconds divided by two workers divided by summed job seconds, using matched timing cohorts; it does not allocate builds, static work or minute rounding.
- Per-test duration attribution requires a leaf test name unique within that shard's reported identities, with an immediately adjacent `duration_ms`. Ambiguous samples are discarded and counted. Parent and suite timings can overlap child timings, so named-test totals must not be added to file totals. Old named-test costs can differ substantially from current ones; a separate statistic isolates the newer file-timed window.
- A **file failure** is a non-passed backend verdict, a named failed event, or an explicit file-process or timeout failure marker. A file counts once per run however many cases fail. Selection is not execution: an admission, build or static failure can stop a selected file from running. Backend runtime and environment fingerprint must match when using cross-run flake evidence.
- An **unchanged-source passing retry** must follow the failure, share the State head or an identical complete source manifest (paths, blob digests, modes), the same check definition, runtime, environment and backend, and pass every failed named identity. A prior identical-source pass is classified separately. Legacy `flake` labels are not elevated to independently verified retries.
- A **code-change-before-landing** episode is a real-failure proxy only: a failed check, a later passing accepted `main` Candidate from the same Lane at a changed input head, the failed identities passing, and changed code or config bytes verified from complete manifests. It shows temporal association, not that those edits caused the recovery. Missing manifests, unlanded work, test removal, incomparable runtimes and missing results stay **unresolved**; unknown is never recoded as flaky or real.
- **Co-failure** is directed containment of nonempty failure-run sets. Pairwise correlation, especially from a single shared failure, is not assertion equivalence. The nine-run equal-set pair is cheap and may share a common regression.
- **Hindsight selection** uses known failures from the same run. Preserving all 315 code-change-associated failing-file executions out of 41,328 selected would retain every recorded file alarm in that cohort. The smaller one-alarm oracle and greedy set cover retain only one alarm per run and can omit independent defects; both are labeled. None proves an implementable selector's precision, future recall, or safety for the 135 failed checks with no attributed alarm. **No test is recommended for deletion or quarantine.**

### Cost and scenarios

- Provider timestamps are measured retained evidence, not an invoice. The per-job `ceil(seconds / 60)` model, the configured rate, the assumed free allowance, the monthly extrapolations and every saving are **estimates**. Job ids are deduplicated in aggregate usage. No live provider price or account was checked.
- All timed cost records used one 4-vCPU Linux runner label of a third-party paid runner service, so one job-minute was modeled as two 2-vCPU allowance minutes. That service trial has since ended and its prices are not current; treat every dollar figure as history, not a forecast. Free GitHub-hosted runners are the current default for the project's own checks.
- The accepted-check-only monthly scenario uses 168 timestamped accepted Candidates, averaging 20.82 rounded job-minutes, times an assumed 900 landings a month. It excludes separate `main` audits, failed attempts and other check traffic. The all-checks to accepted-Candidate ratio recorded in the raw data is historical mixed activity, not a forecast of mandatory retries.
- Runtime savings assume a 50% reduction in top-ten process runtime, two workers, perfect scheduling and no rounding or static floor: mean successful timed process seconds in those files × 0.5 ÷ 2 ÷ 60 × 900. This is a target, not an observed speedup. Keep the size and memory qualification workloads intact.
- Flake savings count distinct **passing retry** job minutes, not the cost of both failed and passing checks; a pair sharing a passing retry is counted once. For 10 distinct retries: 226 modeled minutes ÷ 168 accepted Candidates × 900 ≈ 1,210.7 job-minutes a month. Static failures known to the parser exclude a pair, but unattributed simultaneous failures could reduce the saving.
- Build-sharing savings retain one measured build interval per check, remove the others, and extrapolate the mean across successful multi-shard checks. Artifact transfer and changed critical paths are unmeasured. Do not add the three saving estimates.
- Removing the never-failed top-ten files is a **non-recommended cost ceiling**, shown only for scale. Documented full `main` audits are retained, and repeated verification at different Candidate or input pins is not asserted to be safely removable.

## Reproducing it

The analysis is a set of read-only scripts that decode retained Work records (verifying SHA-256 and reconstructing fragments), extract run, check and landing records and test events, compute per-file metrics, source-matched retry evidence, co-failure sets, hindsight selection and monthly scenarios, measure build-phase intervals from log prefixes, and validate arithmetic and cross-record invariants. Product code is read as text, never imported or executed. Intermediate data is sanitized analysis input outside any repository; it holds private test identities and source digests but no source bytes or raw logs. The scripts, raw measurements and inputs remain private (class C) and nothing in the repository depends on them; to repeat the work, re-derive the same denominators above from a project's own retained check records.

The next work is a focused implementation and benchmark of the top-ranked optimization and failure causes, measured by the [improvement loop](../agents/improvement-loop.md), not an automatic selector or policy change.
