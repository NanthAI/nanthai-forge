# CI minutes: N=3 attribution

The retained post-fix dry smoke uses **56 Forge / 81 GitHub billed minutes
(0.691)**, versus **67 / 83 (0.807)** before. The matching B1.5d scored N=3
cells use **76 / 157 (0.484)**. These are workload observations, not a paired
causal estimate of a patch's saving. Issue `685774ea` owns this attribution;
[the baseline](p6-baseline.md) and [B1.5d report](b15d-report.md) retain the
registered experiment and its limitations.

## Scope and denominators

Evidence is the retained `result.json`, `forge-metrics.json`, call journals,
GitHub job timestamps/steps and available job logs. No smoke, benchmark,
check rerun or CI dispatch was started for this analysis. The private evidence
stays outside public source; the Issue comments identify the cells and receipts.

The two smokes are `n3-r1-dry-a1` (2026-11-10, runtime/harness `4b092a6c`)
and `n3-r1-dry-a2` (2026-11-11, `9a083d5e`). Their shared task-order seed is
`b15d-rerun-2026-11-01/n3/r1`. They use scripted agents making synthetic
Markdown changes: 20 scripted task executions per batch, zero model executions.
B1.5d N=3 uses real Codex agents modifying source. Its matching r1 attempts
were void; they cannot supply a scored same-seed comparison. Use the two
registered N=3 scored cells, r2 and r3 attempt 1, and disclose r3 attempt 2
separately as the owner-requested extra.

Each arm/cell records ten operational landings. All rates here divide by those
ten, including work later excluded from task scoring. B1.5d non-void task counts
are Forge/GitHub 10/7 in r2, 7/6 in r3 attempt 1 and 10/7 in the extra attempt;
both smokes are 10/10. Do not divide all incurred CI minutes by only the scored
task subset or pool the extra into the registered result.

“Billed minutes” is the harness's sum of each positive-duration job rounded up
to a minute, not an invoice or dollars charged on public runners. “Runner
minutes” sums job intervals without rounding. Skipped placeholder jobs,
including negative timestamp spans, consume neither. Signed command/shard
execution seconds in Forge waste metrics exclude provider bootstrap and must
not be added to the whole-job total again.

## Per operational landing

| Cell | Forge / GitHub billed min | Forge / GitHub runner min | Forge / GitHub workflow runs | Forge / GitHub positive-duration jobs | Ratio of billed minutes |
| --- | --- | --- | --- | --- | --- |
| B1.5d N=3 r2 | 3.00 / 7.90 | 2.580 / 6.160 | 1.10 / 3.10 | 1.10 / 3.10 | 0.380 |
| B1.5d N=3 r3 a1 | 4.60 / 7.80 | 4.023 / 5.758 | 1.60 / 2.90 | 1.60 / 2.90 | 0.590 |
| B1.5d N=3 r3 a2, extra | 3.00 / 13.40 | 2.653 / 11.290 | 1.00 / 3.40 | 1.00 / 3.40 | 0.224 |
| Smoke a1 | 6.70 / 8.30 | 5.805 / 6.737 | 1.80 / 3.40 | 2.10 / 3.40 | 0.807 |
| Smoke a2 | 5.60 / 8.10 | 4.767 / 6.177 | 1.90 / 3.10 | 1.90 / 3.10 | 0.691 |

The all-N B1.5d headline, 331/910 = 0.364, mixes N=1,3,5,10. Its N=3
registered subtotal is 76/157 = 0.484. Including the disclosed extra makes N=3
106/291 = 0.364, but changes the denominator. Neither is interchangeable with
a same-seed scored comparison. Relative to the registered N=3 mean, Forge's
whole-job time rose 2.503 runner min/landing in a1 and 1.465 in a2.

## Shards, setup and selection

All observed checks in these cells execute the configured command in one
`hosted-plan` job (Forge) or one `bench-check` job (GitHub). There are **zero
separate test-shard jobs**: matrix placeholders are skipped. Shard fanout is
therefore not the explanation for this smoke's regression. Smoke a1 additionally
ran three optional source-pack-refresh jobs, 171 s / 10 = **0.285 runner
min/landing**, rounded to four billed minutes. Every other row has none.

Setup below means positive-duration job start to configured-command step start;
it includes runner bootstrap, trusted control preparation and Forge source/plan
preparation. It excludes dependency installation inside `.bench/ci.sh` and all
command/report/teardown time. The single executing job is the shard-equivalent
unit. These are retained timestamps, not new timing samples.

| Cell/arm | Jobs with setup evidence | Setup min/job, median (range) | Setup runner min/landing | Plan step s/job, median |
| --- | --- | --- | --- | --- |
| B1.5d r2 Forge | 11/11 | 0.633 (0.483–0.783) | 0.687 | 25 |
| B1.5d r3 a1 Forge | 16/16 | 0.575 (0.500–0.717) | 0.938 | 25.5 |
| B1.5d r3 a2 extra Forge | 10/10 | 0.658 (0.550–0.750) | 0.650 | 28 |
| Smoke a1 Forge | 18/18 command jobs | 0.733 (0.583–3.933) | 2.128 | 26 |
| Smoke a2 Forge | 19/19 | 0.600 (0.517–0.917) | 1.202 | 22 |
| Smoke a1 GitHub | 34/34 | 0.233 (0.200–0.317) | 0.820 | — |
| Smoke a2 GitHub | 31/31 | 0.233 (0.200–0.283) | 0.715 | — |
| B1.5d GitHub, all three cells | 0/94 | unknown | unknown | — |

Historical GitHub job detail/log reads return unavailable; retained job intervals
and event counts still reconcile. Their missing setup and executed-test detail
are unknown, never zero or inferred from the other arm.

The full configured command selects the same six suites, **259 test files**.
Forge completed-command logs show 259 files/check throughout; B1.5d r2's
cancelled command emitted only 96 before cancellation. Observed file executions
per operational landing are Forge r2 **268.6**, r3 a1 **414.4**, extra **259**,
smoke a1 **466.2**, a2 **492.1**; GitHub smoke a1 **880.6**, a2 **802.9**.
B1.5d GitHub's declared command is the same full command, but its actual file
executions are unavailable. These are file executions, not individual test cases
or unique tests per batch. Neither arm narrows the synthetic Markdown changes:
Forge records 13 `docs-paths-undeclared` selection fallbacks in each smoke.
No docs declaration may be invented to optimize a benchmark fixture.

The exact additive Forge whole-job decomposition is:

| Runner min/landing | B1.5d scored N=3 mean | Smoke a1 | Smoke a2 |
| --- | --- | --- | --- |
| Before configured-command step | 0.8125 | 2.1283 | 1.2017 |
| Configured-command step, including its install/report | 2.3417 | 3.2267 | 3.4017 |
| Other jobs and remaining job time | 0.1475 | 0.4500 | 0.1633 |
| Total | 3.3017 | 5.8050 | 4.7667 |

For a1 the cold object-fetch phases alone sum **528.846 s**, versus **14.512 s**
in a2. Three a1 checks had no pack; the other fifteen used one. All nineteen a2
checks used packs. Total Forge plan-step time is 956 s in a1 and 449 s in a2;
median plan time is already near the 25–28 s B1.5d values. This identifies a
cold-source tail, not uniform shard setup inflation. Different source/cache
states and runtime pins prevent assigning all of the change to one fix.

## Rechecks, races and GitHub PR work

Each smoke has three recorded second checks: two `text-conflict` and one
`tested-doc`; zero failed second checks. a1 has twelve main-race transitions:
seven reused passes, three discarded passes and two zero-runner transitions.
a2 has eleven: seven reused passes, the same three discarded-pass reasons,
and one zero-runner `not-eligible` transition. A race transition is not itself
a new provider run.

| Forge race evidence | B1.5d r2 | B1.5d r3 a1 | Extra r3 a2 | Smoke a1 | Smoke a2 |
| --- | --- | --- | --- | --- | --- |
| Main-race transitions | 6 | 18 | 8 | 12 | 11 |
| Known discarded passed command min/landing | 0 | 0.92950 | 0 | 0.50245 | 0.57458 |
| Unknown runner runs in race metrics | 0 | 2 | 0 | 0 | 0 |

The smoke discarded passes split as a1 **1.97848 + 1.44933** text-conflict
minutes and **1.59670** tested-doc minutes; a2 **1.77388 + 1.99102** and
**1.98092**, respectively. Discards did not fall after the identical-path
optimization: these different-byte conflicts and tested-document changes remain
required rechecks. Historical B1.5d metrics predate the newer reason projection;
its exact second-check reason split remains incomplete.

Read-only landing receipts match all twenty retained smoke receipt IDs. Per
smoke, nine accepted receipts name one check and one names two (`tested-doc`):
eleven distinct runs among accepted operations. Two further passed admissions
were discarded in operations ending in text conflict, before replacement
operations landed; omitting these would undercount waste. Thus thirteen
admission/recheck runs cost 1.3 runs/landing in both smokes. The remaining
provider runs are five/six post-publication audits, 0.5/0.6 per landing.
Read-only status of the three otherwise-unassigned runs per smoke confirms
two full admissions plus one audit; no run was started by those reads.
Following-audit pointers on accepted receipts identify only four/five distinct
runs, so they alone do not enumerate the final audit tail. This reconciliation
uses the full provider window plus retained run purpose, not a sum of
receipt pointers. The two landing pages read 161,348 / 158,886 DB bytes, ten
rows each and no continuation; six run-status reads closed the purpose gap.

| GitHub cell | PR-event runs / 10 PRs | Merge-group runs | Main-push runs | Failed jobs | Extra PR-head checks |
| --- | --- | --- | --- | --- | --- |
| B1.5d r2 | 11 / 10 | 10 | 10 | 0 | one PR checked twice |
| B1.5d r3 a1 | 12 / 10 | 10 | 7 | 0 | two PRs checked twice |
| Extra r3 a2 | 14 / 10 | 11 | 9 | 2 | two PRs twice, one three times |
| Smoke a1 | 14 / 10 | 10 | 10 | 1 | four PRs twice |
| Smoke a2 | 13 / 10 | 10 | 8 | 0 | three PRs twice |

The smoke repeated PR-event runs have distinct head SHAs: four/three extra
new-head checks, with no same-head duplicate. B1.5d r2 has one extra new-head
check; r3 a1 has one new-head check and one same-head repeat whose trigger is
not retained. The extra r3 a2 has four extra new-head checks. Main pushes can cover several
landings, hence fewer than ten push runs. All totals include those main checks.
The two registered B1.5d N=3 GitHub cells had **zero failed CI jobs**; a1 smoke
had one despite using no model agents. Failed agent iterations therefore do not
explain the registered N=3 gap. The extra's two failures and 134 minutes must
stay separate; the all-N 910-minute headline is a different workload mix.

## Causes, ownership and guard

- Cold source preparation and three pack-refresh jobs raised a1 setup/other time.
  Issue `298f9675` owns CI-source lookup and byte-placement fixes and the separate
  billed-usage report. Issue `ca8a2ca4` owns fixed per-job preparation. The a2
  observation has no cold-pack tail or refresh job; no causal saving is claimed.
- Additional full admission/recheck/audit work raises minutes while selection
  stays 259 files. Issue `1018d0f8` owns main-race reuse and its remaining
  measurements; genuine conflict/tested-doc refusals remain. Issue `0bce207f`
  owns publication/batch-density trade-offs and is frozen pending its design
  dependencies. No batching delay, audit policy or docs exclusion is introduced.
- The existing six-landing fixture ledger now measures signed shard runner
  seconds in addition to check-run counts: five runs × two shards × 120 s / six
  landings = **3.3333 modeled runner min/landing**. A third shard or sixty extra
  setup seconds per shard fails at unchanged run count. This deterministic guard
  covers orchestration fanout/setup repetition, not real CPU duration, provider
  bootstrap, optional pack refresh, audit coalescing or billed-minute rounding.
  Existing incident fixtures guard identical-source reuse and required rechecks.

The guard adds no production calls, DB reads/writes, source bytes, idle work or
service. It extends the existing ledger rather than adding another budget system;
nothing in the runtime can be removed by this measurement-only change.

Acceptance remains partial: the post-fix ratio is observed, but historical
GitHub setup/selection details and historical recheck reasons are unavailable.
Do not mark complete attribution, or “every remaining gap explained”, as proved.
Recovering those retained logs/metadata would close the historical gaps; if they
cannot be recovered, an owner-authorized matched real-agent N=3 run with per-job
setup, source/command phases, selection, recheck reasons and audit attribution is
needed. No new run is authorized by this analysis. With one dry pair and changing
cache/runtime/workload, no confidence interval or causal performance claim is
justified under [the performance-claims rule](../agents/perf-claims.md).
