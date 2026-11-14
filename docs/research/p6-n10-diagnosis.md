# N=10: conflict tail, measurement errors and a repeatable diagnosis

This is read-only research for Issue 8c9b84fc, using the three accepted scored
N=10 pairs on harness `f290bb0e` / CLI State `bc0691cd`, with N=5 and the retained
`daeeeebc` before-run as controls. No new cell, deployment, setting or product fix
was run. The frozen [exit plan](p6-exit-bench-plan.md) remains unchanged. This note
is a diagnostic follow-up, not a replacement score or an exit-bar pass.

Forge's median task lands earlier, with fewer CI minutes and tokens. Its cell
wall time is controlled by the same preview task's two conflict recoveries in all
three N=10 reps. The reported rework excess contains both genuine recovery cost
and remaining classifier errors. Three pairs cannot establish a small wall-time
advantage or regression.

The lead-priority [full t27456 response trace](p6-n10-tail-trace.md) names its
two overlapping peers and accounts for every response, reply and elapsed segment.

## Rework audit

Turns below are one-based model-response indices from `sessionTurns`, including
responses containing tool calls and the final response. Tokens are request usage,
not the size of the quoted reply. Cached input is part of total input; uncached
input and output are separate. All 98 reported turns are accounted for in the
adjacent [turn ledger](p6-n10-rework.md). Raw transcripts, prompts, identities and
local paths are deliberately excluded.

| Arm / rep | Reported turns | Advisory waiting miscounted | Help miscounted | Active conflict recovery | Waiting within real recovery | Real recovery including its waits |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Forge 1 | 23 | 5 | 0 | 8 | 10 | 18 |
| Forge 2 | 25 | 10 | 1 | 8 | 6 | 14 |
| Forge 3 | 26 | 9 | 0 | 8 | 9 | 17 |
| GitHub 1 | 11 | 0 | 0 | 11 | 0 | 11 |
| GitHub 2 | 5 | 0 | 0 | 5 | 0 | 5 |
| GitHub 3 | 8 | 0 | 0 | 6 | 2 | 8 |

The GitHub rep order is **11, 5, 8**, not 5, 8, 11. File identities and `rep`
fields agree with `CELL START` in the driver log. All cells landed ten tasks.

| Cause / observed reply | Forge turns; cached / uncached / output tokens | GitHub turns; cached / uncached / output tokens | Interpretation |
| --- | --- | --- | --- |
| Terminal conflict at land: `COMPOSITION_CONFLICT`; then `sync`, edit materialized conflicts and `resolve` | 24; 1,972,736 / 42,792 / 4,082 | 22; 2,017,664 / 22,233 / 4,574 | Real active recovery; GitHub responds to `CONFLICT (content): Merge conflict in …` or `mergeStateStatus: DIRTY` |
| Wait/read of a running recovery command or test | 25; 2,099,712 / 7,042 / 1,340 | 2; 217,728 / 679 / 148 | Coordination caused by real recovery, included by today's rework window |
| Queued advisory: `Advisory COMPOSITION_CONFLICT … This entry stays queued; Forge will reevaluate … No agent action is needed.` | 24; 1,758,464 / 12,737 / 2,003 | 0 | Counting error: these turns just continue the existing wait |
| Help: `A failed check` / `CHECK_FAILED: the landing check failed; nothing landed.` | 1; 83,840 / 920 / 173 | 0 | Counting error: check help and successful `LANDED` arrived together |
| Rejected CI check, stale head/re-pin, rejected push, queue removal as a genuine trigger | 0 | 0 | None explains the counted N=10 turns |
| Wrong command / own mistake / other as a distinct rework episode | 0 | 0 | Incidental mistakes occur inside recovery, but no independent episode |

The incidental mistakes include GitHub rep 2 preview recovery guessing a
nonexistent workflow filename (turn 47), and GitHub rep 1 Codex recovery running a
broad changed-check command whose lint, dependency and type checks failed (turns
51–52). These costs are included in their conflict windows, not counted twice.
No Forge conflict recovery in these cells repaired an agent's broken code or a
rejected CI check. All six Forge conflict episodes belong to `t27456`.

Exact ranges and costs:

| Arm / rep / task | Cause | Turns | Cached | Uncached | Output |
| --- | --- | --- | ---: | ---: | ---: |
| Forge 1 / t27456 | Advisory wait | 41–45 | 417,920 | 2,445 | 595 |
| Forge 1 / t27456 | Active conflict recovery | 46,51–53,61,64–66 | 764,416 | 15,467 | 1,521 |
| Forge 1 / t27456 | Recovery wait | 47–50,54–55,62–63,67–68 | 953,472 | 2,507 | 516 |
| Forge 2 / t27456 | Advisory wait | 26–30,42–46 | 717,440 | 5,447 | 749 |
| Forge 2 / t27456 | Active conflict recovery | 31,34–36,47,49–51 | 611,456 | 13,736 | 1,251 |
| Forge 2 / t27456 | Recovery wait | 32–33,37–38,48,52 | 455,296 | 1,774 | 339 |
| Forge 2 / t23938 | Help false positive, final response after acceptance | 47 | 83,840 | 920 | 173 |
| Forge 3 / t27456 | Advisory wait | 26–30,43–46 | 623,104 | 4,845 | 659 |
| Forge 3 / t27456 | Active conflict recovery | 31,34–36,47,50–51,53 | 596,864 | 13,589 | 1,310 |
| Forge 3 / t27456 | Recovery wait | 32–33,37–38,48–49,52,54–55 | 690,944 | 2,761 | 485 |
| GitHub 1 / t27456 | Conflict recovery | 47–50,67–68 | 530,304 | 5,421 | 1,101 |
| GitHub 1 / t23938 | Conflict recovery | 48–52 | 411,648 | 6,199 | 934 |
| GitHub 2 / t19456 | Conflict recovery | 45–47 | 372,352 | 2,874 | 650 |
| GitHub 2 / t23938 | Conflict recovery | 46–47 | 151,552 | 2,884 | 592 |
| GitHub 3 / t19456 | Active recovery | 36,38–39 | 322,688 | 2,897 | 585 |
| GitHub 3 / t19456 | Recovery wait | 37,40 | 217,728 | 679 | 148 |
| GitHub 3 / t23938 | Conflict recovery | 43–45 | 229,120 | 1,958 | 712 |

`phases.mjs` still has three problems:

1. `TRIGGERS` matches `COMPOSITION_CONFLICT` anywhere, including nested
   `wouldConflict.predecessor` advice and its flattened text. The earlier fix only
   tightened Git's bare `CONFLICT` match. Ignore speculative queued advice as a
   rework trigger, preserving actual terminal errors in the same output.
2. `callKinds` recognizes `docs` and `--help` but not `nforge agent . help check`.
   Deferred help output is attached to the originating call, so it remains a false
   failure even beside a real successful receipt. Attribute each child command's
   output separately; a blanket exclusion of a mixed help/land call would hide a
   real failure. Acceptance must not lose to quoted documentation.
3. Waiting is recognized only in the `landing` state. Recovery waits remain
   labelled rework. That is the published phase-window definition, but it does
   not mean every response edited or fixed anything. Report both the causal
   recovery window and its active/wait split.

Removing only the proven false positives gives Forge 18/14/17 turns and
1,717,888 / 1,066,752 / 1,287,808 cached tokens, versus GitHub 11/5/8 and
941,952 / 523,904 / 769,536. This does **not** repair the Forge rework bar.
Active-only turns are Forge 8/8/8 versus GitHub 11/5/6; they are a diagnostic,
not a substituted headline statistic. Initial failure, retry submission and CI
waiting turns are classified elsewhere, so none of these totals alone measures
all conflict overhead. The per-task median remains zero in every N=10 cell;
sparse-tail sums/means must be published beside it.

At N=5, Forge's 21/6/5 also misleads: rep 1 has real preview conflicts and queued
advice, while rep 2 (`t27069`) and rep 3 (`t27456`) are triggered solely by check
help. Their six and five reported turns are not evidence of rejected checks.

## Critical paths

Seconds are relative to the measured cell's start, including workspace prep.
These are wall-time paths, not sums of overlapping task times.

| Rep | Forge last task / accepted | GitHub last task / merged | Forge minus GitHub |
| --- | --- | --- | ---: |
| 1 | t27456 / 932.297 | t27456 / 1165.559 | −233.262 |
| 2 | t27456 / 1024.291 | t19456 / 943.317 | +80.974 |
| 3 | t27456 / 1001.644 | t19456 / 967.524 | +34.120 |

The Forge tail follows the same shape each time:

| Rep | Initial prep | First land call → terminal conflict | Sync + resolve command time, both cycles | Second land call → terminal conflict | Last land call → accepted | Last check reservation → CI end → acceptance |
| --- | ---: | --- | ---: | --- | --- | --- |
| 1 | 14.246 | 239.79 → 475.50 | 86.97 | 554.89 → 664.19 | 741.96 → 932.30 | 767.13 → 930.00 → 932.30 |
| 2 | 36.531 | 248.67 → 467.07 | 82.88 | 530.14 → 741.16 | 811.97 → 1024.29 | 834.16 → 1021.31 → 1024.29 |
| 3 | 38.580 | 242.13 → 472.16 | 87.32 | 544.63 → 727.61 | 804.82 → 1001.64 | 829.57 → 999.21 → 1001.64 |

Each final successful operation is mostly an ordinary check (163/187/170 s from
reservation to CI end). Settlement then takes 2.3/3.0/2.4 s. The long tail is
before that check: two serialized conflict discoveries and two materialize/edit/
resolve cycles. First conflicts follow the earlier preview change's acceptance
at 430.64/446.36/448.65; the second follow `t19456` at
641.04/715.76/702.38. The terminal CLI reply follows those predecessor acceptances
by about 21–45 s, including compose, publication and delivery. It is not all
agent thinking and it is not a long runner-capacity queue.

The first land calls last 236/218/230 s, and the second 109/211/183 s. These wait
on speculative predecessors and then expose a real conflict. Do not claim all
of this could be removed: an unaccepted predecessor may fail or change. The
repeatable cost worth fixing is cheap retained-conflict delivery, cheap conflict
materialization, and carrying an already-resolved edit across subsequent clean
main changes without restarting a full recovery. The data do not authorize
silently resolving a semantic conflict or accepting an unchecked head.

GitHub rep 1 also has two preview recoveries: pulls around +569 and +836 s,
updated pushes around +598 and +857 s, three PR checks plus the merge-group
check. Its last merge-group run starts about +1035 s and concludes about +1134 s;
merge occurs at +1166 s. GitHub reps 2–3 instead merge `t27456` early and recover
`t19456` once: updated push at about +620/+627 s, a PR check, then a merge-group
check ending about +911/+934 s and merge at +943/+968 s. Which member of the
preview triple loses depends on edits and submission timing. GitHub does not
perform Forge's two `sync` plus two `resolve` round trips; it pays repeated
PR/merge-group checks and more model status reads.

### Queue timing and check groups

For each final accepted Forge operation: `submittedAt → selectedAt` is queue
selection, `selectedAt → checkReservedAt` includes group source preparation, and
`checkReservedAt → committedAt` includes CI and settlement. They are not all
provider queue time. Compose timestamps can precede or overlap submission;
adding them all would double count.

| Rep | Task | Submit → select | Select → check | Check → commit |
| --- | --- | ---: | ---: | ---: |
| 1 | t26563 | 1.3 | 26.8 | 168.5 |
| 1 | t26770 | 22.6 | 53.5 | 180.7 |
| 1 | t27069 | 1.2 | 0.2 | 168.3 |
| 1 | t27456 | 6.7 | 0.2 | 165.2 |
| 1 | t22302 | 18.2 | 53.5 | 180.7 |
| 1 | t19456 | 21.5 | 27.6 | 143.1 |
| 1 | t23938 | 32.6 | 44.0 | 158.5 |
| 1 | t23766 | 1.3 | 26.9 | 188.7 |
| 1 | t27514 | 2.0 | 38.7 | 140.5 |
| 1 | t27521 | 15.7 | 53.5 | 180.7 |
| 2 | t27069 | 1.8 | 0.2 | 130.6 |
| 2 | t26770 | 17.1 | 26.8 | 141.3 |
| 2 | t22302 | 15.1 | 54.5 | 176.1 |
| 2 | t19456 | 17.0 | 27.0 | 166.8 |
| 2 | t27456 | 7.3 | 0.5 | 190.1 |
| 2 | t23766 | 3.1 | 26.2 | 176.5 |
| 2 | t23938 | 12.2 | 31.3 | 193.2 |
| 2 | t26563 | 1.4 | 22.5 | 165.0 |
| 2 | t27514 | 9.2 | 54.5 | 176.1 |
| 2 | t27521 | 1.4 | 23.7 | 146.0 |
| 3 | t26563 | 1.4 | 28.9 | 183.8 |
| 3 | t27521 | 7.0 | 35.7 | 173.9 |
| 3 | t27514 | 2.6 | 35.8 | 135.6 |
| 3 | t27069 | 1.3 | 0.2 | 130.7 |
| 3 | t26770 | 4.1 | 25.5 | 157.8 |
| 3 | t27456 | 6.9 | 0.2 | 172.1 |
| 3 | t19456 | 22.8 | 0.2 | 147.9 |
| 3 | t22302 | 34.3 | 29.7 | 182.2 |
| 3 | t23938 | 42.3 | 32.9 | 164.4 |
| 3 | t23766 | 1.4 | 35.7 | 173.9 |

Failed operations have empty `timing` objects in the retained result. Their call
intervals above are measured; a queue/compose/check decomposition for those
operations is unavailable. This is an observability gap, not zero queue time.

Forge has 8/9/9 check groups: rep 1 combines `t26770,t22302,t27521`, rep 2 combines
`t22302,t27514`, rep 3 combines `t27521,t23766`; the rest are singles. These
shared reservation/acceptance timestamps correspond to 8/9/9 provider runs,
24/27/26 rounded CI minutes. GitHub has 31/28/31 runs and 79/66/73 minutes:
13/11/11 PR checks, ten merge-group checks each, and 8/7/10 main-push runs.
Summed provider job queue time is only 15/18/16 s for Forge and 59/47/55 s for
GitHub. It cannot explain a several-minute conflict tail.

The retained waste table reports two conflicts each, about 42/42/46 s of
conflict-attempt elapsed, and 10/10/9 main-race transitions. Its
`mainRaceRecheckRuns=6/7/6` and 9.69/12.36/10.25 runner minutes are not additional
jobs to add to CI: every observed Forge job is already matched to a final check
group. Aggregate attempt attribution is partial and not a critical-path clock.
No failed/flaky check explains these cells. Main-race activity stays server-side;
there is no model-triggered stale-head/re-pin recovery here.

## Workspace prep

| Statistic (seconds) | Before N=10 r1 | New r1 | New r2 | New r3 |
| --- | ---: | ---: | ---: | ---: |
| Forge prep median | 18.092 | 21.463 | 22.579 | 23.262 |
| GitHub prep median | — | 17.343 | 17.180 | 17.742 |
| Forge open-command median | 15.649 | 19.014 | 20.018 | 20.433 |
| Initial open write-pass wait median | 10.741 | 12.184 | 13.643 | 14.448 |
| Initial open copy/hash median | 2.333 | 2.731 | 2.805 | 2.761 |
| Initial open startup median | 0.389 | 0.351 | 0.404 | 1.251 |

Initial opens are matched by the records' original Lane ids, excluding resolution
opens. Each materializes 28,881 files, downloads **zero bytes**, and makes three
recorded checkout RPCs. Start itself remains about 2.2–2.4 s. Late open write-pass
wait reaches 26.016/27.483/28.388 s; the ten local passes serialize on the device.
`src/checkout-materialization.ts` explicitly implements a single write pass;
previous qualification found overlapping passes slower. Removing that lease is
not an evidence-backed fix. A roughly 0.4 s slower copy pass amplifies across ten
opens; rep 3 also has slower startup/current-channel reads. Exact physical CPU/
filesystem causes of that per-pass increase are unmeasured. One before-run
cannot prove a code regression; the exact prior implementation was not compared
because its revision was unavailable in the local mirror.
Prep precedes model dispatch, so its direct token cost is zero. It can indirectly
change which overlapping task reaches the queue first.

## Variance and flaw versus noise

Sample SD uses three independent cell summaries, not thirty pseudo-independent
tasks. Values are rep 1/2/3; CV is SD / mean.

| N | Arm | Metric | Rep values | Sample SD | CV |
| --- | --- | --- | --- | ---: | ---: |
| 10 | Forge | Wall s | 932.3 / 1024.3 / 1001.6 | 47.9 | 4.9% |
| 10 | GitHub | Wall s | 1165.6 / 943.3 / 967.5 | 121.9 | 11.9% |
| 10 | Forge | Median task TTM s | 401.6 / 373.7 / 360.2 | 21.1 | 5.6% |
| 10 | GitHub | Median task TTM s | 494.7 / 524.6 / 506.3 | 15.1 | 3.0% |
| 10 | Forge | Prep median s | 21.46 / 22.58 / 23.26 | 0.91 | 4.0% |
| 10 | GitHub | Prep median s | 17.34 / 17.18 / 17.74 | 0.29 | 1.7% |
| 10 | Forge | CI minutes | 24 / 27 / 26 | 1.53 | 6.0% |
| 10 | GitHub | CI minutes | 79 / 66 / 73 | 6.51 | 9.0% |
| 10 | Forge | CI jobs | 8 / 9 / 9 | 0.58 | 6.7% |
| 10 | GitHub | CI jobs | 31 / 28 / 31 | 1.73 | 5.8% |
| 10 | Forge | Cached input M | 21.752 / 22.595 / 18.282 | 2.286 | 11.0% |
| 10 | GitHub | Cached input M | 37.870 / 33.243 / 35.636 | 2.314 | 6.5% |
| 10 | Forge | Uncached input k | 665.081 / 684.604 / 611.500 | 37.851 | 5.8% |
| 10 | GitHub | Uncached input k | 744.296 / 737.071 / 793.926 | 30.951 | 4.1% |
| 10 | Forge | Agent-seconds summed | 4631.8 / 4619.5 / 4491.5 | 77.7 | 1.7% |
| 10 | GitHub | Agent-seconds summed | 6378.9 / 5825.9 / 5784.2 | 332.0 | 5.5% |
| 10 | Forge | Corrected recovery turns | 18 / 14 / 17 | 2.08 | 12.7% |
| 10 | Forge | Corrected recovery cached M | 1.718 / 1.067 / 1.288 | 0.331 | 24.4% |
| 10 | Forge | Output k | 74.532 / 78.400 / 67.401 | 5.580 | 7.6% |
| 10 | GitHub | Output k | 111.241 / 103.604 / 105.912 | 3.917 | 3.7% |
| 10 | Forge | All model turns | 335 / 348 / 319 | 14.53 | 4.3% |
| 10 | GitHub | All model turns | 563 / 486 / 532 | 38.74 | 7.4% |
| 10 | Forge | Reported rework turns | 23 / 25 / 26 | 1.53 | 6.2% |
| 10 | GitHub | Reported rework turns | 11 / 5 / 8 | 3.00 | 37.5% |
| 10 | Forge | Reported rework cached M | 2.136 / 1.868 / 1.911 | 0.144 | 7.3% |
| 10 | GitHub | Reported rework cached M | 0.942 / 0.524 / 0.770 | 0.210 | 28.2% |
| 10 | Forge | Landing waiting turns | 150 / 149 / 142 | 4.36 | 3.0% |
| 10 | GitHub | Landing waiting turns | 287 / 228 / 250 | 29.82 | 11.7% |
| 5 | Forge | Wall s | 1085.4 / 1081.6 / 1150.2 | 38.5 | 3.5% |
| 5 | GitHub | Wall s | 1422.2 / 1596.9 / 1967.8 | 278.6 | 16.8% |
| 5 | Forge | Reported rework turns | 21 / 6 / 5 | 8.96 | 84.0% |
| 5 | GitHub | Reported rework turns | 8 / 5 / 11 | 3.00 | 37.5% |

Correctness is stable across these reps: Forge strict successes 7/6/6 of ten,
lenient scores 0.76333/0.75727/0.75727 (SD 0.00350); GitHub strict 6/6/6 and
lenient 0.75727 in all three (SD 0). Existing suites are green for both arms.
Forge strict SD is 0.577 tasks; all arms land 10/10 (SD 0). Repeated hidden-test
failures are a separate correctness question; this note does not equate acceptance
with passing the hidden oracle. The Forge measured Convex subtotal is
$0.051446/$0.051340/$0.052272 (SD $0.000511, CV 0.99%); GitHub has no Convex
arm cost. Full invoice/retention cost is unavailable, not zero.

The paired wall difference has mean −39.4 s, SD 169.5 s and an illustrative
Student-t 95% interval [−460.5, +381.7] s (df=2; normality unverified). The median
of cell walls instead says Forge +34.1 s. This disagreement is itself a warning
against choosing an aggregation after seeing three tails.

Task orders from the actual start log are:

- Rep 1: 26563,26770,27069,27456,22302,19456,23938,23766,27514,27521.
- Rep 2: 27069,26770,22302,19456,27456,23766,23938,26563,27514,27521.
- Rep 3: 26563,27521,27514,27069,26770,27456,19456,22302,23938,23766.

Each number has prefix `t`. Forge real recovery is `t27456` in every rep. GitHub
real recovery is `t23938` in every rep, plus `t27456` in rep 1 and `t19456` in
reps 2–3. Dispatch groups remain together but prep finishes out of order. N=5
has two waves, allowing overlap and submission order to change; its Forge
rework variance is not comparable until the help errors are removed.

| Finding | Verdict | Confidence / limit |
| --- | --- | --- |
| Advisory and help rework matches | Systematic harness bugs | High: exact replies and all affected turns inspected |
| Two expensive Forge preview recovery cycles | Systematic observed protocol cost, agent/workload-sensitive exposure | High on cost and repetition; medium on a generic optimization's achievable gain |
| Forge batching/one-check path reduces CI versus PR + merge-group + push | Systematic observed behavior | High for these pins/workload; 3 pairs are not universal proof |
| Forge copy-pass queue and prep disadvantage | Systematic implementation behavior | High from local open receipts; why each copy slowed vs before-run remains uncertain |
| N=10 wall +4% as a regression | Unresolved, compatible with agent/tail noise | Low evidence for its sign; wide paired interval |
| Preview conflict loser and number of model reads | Agent choices, edits and scheduling interact with product behavior | Medium/high; fixed-action replay needed to isolate them |
| Small cell-to-cell check-duration changes | Shared runner/load noise plus source selection | Medium; no causal runner experiment |

## Repeatable benchmark design

All following runs are **proposals**, require a new frozen diagnostic plan and
lead scheduling, and were not started. They do not modify the existing scored
series. The owner funds model use; public-runner minutes below are measured
billed-equivalent minutes, not a new claim about paid invoices. Convex and R2
remain real service costs; complete invoices and storage are not measured here.

### Repeated live N=10 pairs

`drive.mjs --only n10-r1` already runs one paired batch, increments its attempt,
and retains both arms. It does not register an arbitrary repeat series:
`run-cell.mjs` obtains schedules from the fixed plan, which contains only reps
1–3 (and registered extras). `--reps 25` does not create 25 scored reps, and
`--only n10-r4` fails plan lookup. Repeating an existing `--only` key reuses its
seed/order as a new attempt; it is not permission to treat selected attempts as
new scored observations. Build a separate plan with explicit pair ids, fixed
orders/seeds, alternating arm order, all-attempt reporting and no result-based
stopping. Block/stratify by order, cache condition and runner allocation.

A planning approximation for two-sided 5%, 80% power is
`pairs ≈ ceil((2.8 × 169.5 / detectable_seconds)^2)`. It assumes paired normal
mean differences and a stable SD estimated from only three pairs. It is not a
power calculation for the median or a noninferiority claim. Detecting 150 s
needs about 11 pairs asymptotically; pre-register 13 for a small-sample margin.
100 s needs about 23; use 25. A 34 s difference needs roughly 195 pairs, 30 s
about 251. Re-estimate precision in an independent fixed pilot before committing
to a large spend; do not add scored reps based on the desired sign.

One observed pair costs 51–55 min including reset/settlement/grading, 93–103 CI
minutes, 53.9–59.6M cached input, 1.405–1.422M uncached input, 173–186k output,
and 834–898 model turns. The measured Forge cell subtotal is about $0.051–0.052,
excluding reset and uncovered services. Thirteen pairs are approximately
11.5 h, 1,278 CI minutes, 734M cached / 18.4M uncached / 2.35M output tokens;
25 are 22 h, 2,458 CI minutes, 1.412B cached / 35.3M uncached / 4.51M output.
The 195-pair small-effect experiment is about 172 h, 19,175 CI minutes and
11.0B cached input. These extrapolations exclude usage waits and invalid runs.
Live repeats establish the distribution of end-to-end AI experience; they do
not isolate a scheduler flaw from different edits and command choices.

### Recorded deterministic replay

Record each arm's actual edits with before/after content hashes, argv without
secrets, operation identity, response identity, relative time, and dependencies
on replies. Replace live ids/roots with typed placeholders. Replay edits exactly
and permit a command only when its pinned precondition holds; divergent reply
state is an explicit divergence, never silently select another revision. Capture
edit bytes privately, with synthetic public fixtures only. Compare each arm
against itself across product revisions; different arm traces do not hold edits
or workflows equal across arms. A cross-arm experiment needs common semantic
actions and arm-specific protocol adapters, not the same shell commands.

Literal historical timing can schedule commands before a slower real service
finishes. Preserve reply dependencies and record schedule slip; separately test
fixed release times for independent submissions. An alternative is a captured
open-loop offered load, but it cannot prove interactive recovery quality.

Budget initially 45–60 min / 90–110 CI minutes per pair, zero model tokens, plus
recording/translation/validation effort. Five pairs: up to 5 h / 550 CI minutes,
zero model tokens. These are conservative planning estimates from the live
cells, not measured replay results. Replay isolates service regression for one
fixed trace, but cannot estimate model decisions, correctness on unseen tasks,
or the population frequency of that trace.

### Recommended: scripted conflict-heavy N=10, then live validation

Use a synthetic fixture with the same overlap topology: three independent
writers, two pairs, and one triple. Run a clean control and a conflict variant;
all ten workspaces begin on an exact base, all preparation completes before the
release clock starts, and fixed offsets release edits/submissions. Include both
burst and late-third-writer schedules so the same scenario can exercise repeated
recovery. Alternate arm order. Run five fixed pairs per scenario as an initial
diagnostic, reporting every pair; cost up to 5 h / 550 CI minutes / zero tokens
per scenario before calibration, excluding resets/cleanup beyond the estimate.
Five pairs diagnose a repeatable protocol path; they are not a powered claim
about a 3% population latency difference.

The saved `scripts/bench-t3code/replay-schedule.mjs` is an **offline runner-core
draft**, with synthetic behavioral tests. It generates ten task edits and
release schedules, stages every prepared workspace before the clock starts,
releases without awaiting earlier landings, drains all started work on failure,
and verifies every unique contribution in one pinned final accepted source read. It never
imports a cell driver, contacts a service or creates workspaces by itself.
It is **not a runnable real-service benchmark yet**. Remaining integration is
specified below; no product code was changed to make this experiment pass.

Real-service integration contract:

1. Add a separate diagnostic entry point and manifest; do not reuse scored cell
   ids or alter the hash-pinned exit plan. Reuse existing version/authority/hold,
   disk, runner and cost instrumentation; explicit roots/config select services.
2. Prepare ten contexts through `forgeArm.startLane` or `github.workspace`, all
   pinned to the same fixture tree. `prepare(task)` returns only after checkout
   completion; stage deterministic synthetic text files using `stage(task,ctx)`.
   The core's release clock starts after every stage finishes. Prep is reported
   separately and remains a real measured cost.
3. `land(task,ctx)` runs the real Forge `driveForge` protocol, including receipt
   continuations and retries of the original operation id after unknown outcomes.
   For GitHub, use branch commit/push, PR, actual required checks and merge queue;
   follow the existing baseline read cadence, logging each read. No local merge
   simulator, no skipped checks and no counterfactual acceptance.
4. On a conflict, resolve only the synthetic contribution file by set union,
   retaining all unique lines. Support both diff3 and two-way markers; do not use
   the current generic `keepBoth` blindly on diff3 base hunks. Verify exact final
   file contents and each accepted receipt. Any unexpected file or response is a
   diagnostic divergence, not a new product denial.
5. `readMain(paths)` returns one exact accepted head and a map of file bytes using
   the existing arm's canonical source reader, with metadata/byte reads batched by
   page. Record source/CLI/deployment/harness/runner pins at
   both ends, per-operation phase times including failures, checks/groups,
   provider queue, source calls/bytes, recovery operations, slip and final oracle.
6. Keep records and raw paths private. Public fixtures contain only synthetic
   contributions and relative timing. Zero model tokens; service calls per
   operation follow the existing adapters, no added idle caller or per-item
   Convex observer. Final verification batches distinct files under one pinned head.

This isolates generic source/queue/recovery behavior under fixed offered work.
It cannot establish real-agent correctness or token savings. After a generic
fix passes the diagnostic on both arms, use the pre-registered live series to
measure whether agents actually benefit. The existing `--dry` is not this mode:
its timestamped Markdown append workload, independent prep completion and
Markdown conflict handling do not fix edits/release timing or exercise this
non-Markdown conflict topology.

## Generic fixes to investigate (not implemented)

| Change | Files / responsibility | Expected effect and evidence limit |
| --- | --- | --- |
| Attribute structured outcomes to their originating child commands; exclude queued predecessor advice and help while retaining actual mixed-output failures | `scripts/bench-t3code/phases.mjs`, `transcripts.mjs`, phase/rework behavioral fixtures | Measurement correction only: remove 25 false turns, 1,842,304 cached / 13,657 uncached / 2,176 output tokens across these cells; saves zero actual seconds or tokens |
| Reduce conflict materialize/resolve round trips; retain exact conflict/main identities and apply current-main clean deltas without repeating already-completed work | `src/hosted-sync-client.ts`, `hosted-sync-retained.ts`, `hosted-resolve-chain.ts`, `convex/projectHostedLandingBatchConflict.ts`, `projectHostedLandingSpeculativeConflict.ts` | The observed sync+resolve command budget is 83–87 s per two-cycle tail. A candidate target is 40–60 s less per tail and several fewer waiting turns (each currently ~70–100k cached input). It is an unmeasured target, not a promised gain; never auto-merge a semantic conflict |
| Make the accepted-predecessor conflict path reuse retained merge evidence rather than reconstructing it late; preserve failure timing in terminal receipts | `convex/projectHostedLandingBatchCompose.ts`, `projectHostedLandingBatchConflict.ts`, `projectHostedLandingStore.ts`, `projectHostedFinishObserve.ts` | Investigate the 21–45 s acceptance-to-conflict-reply interval. Potential tens of seconds per conflict, unknown removable share; may overlap the prior target and must not be added to it. Preserve all accepted work and exact checks |
| Reuse verified local tree preparation and shorten each editing copy pass, preserving the measured device lease and per-path integrity | `src/hosted-lane-checkout.ts`, `hosted-checkout-cache.ts`, `hosted-checkout-files.ts`, `checkout-materialization.ts` | Restoring the earlier ~2.33 s/pass instead of ~2.76 s is about 2 s median / 4 s last-opener wait at ten opens, before other overhead. Direct model turns/tokens saved = 0; network bytes already zero. Physical cause and attainable improvement unproven |
| Keep original agent writes separate from the final sync-integrated Lane diff | `scripts/bench-t3code/hunks.mjs`, `run-cell.mjs` | Measurement correction: prevents accepted peer changes being attributed to the resolving task. Zero actual seconds/turns/tokens saved; preserve both source snapshots for distinct provenance and final-source checks |
| Reduce repeated source preparation between selection and check reservation using retained exact inputs | `convex/projectHostedLandingBatchCompose.ts`, `projectHostedLandingBatchCheck.ts`, `projectHostedLandingControl.ts` | 22–55 s appears repeatedly even when provider queue is ~1–2 s/job. Measure source phases before attributing all of it or claiming a gain; no new check policy or weaker gate proposed |

All these proposals preserve user capability. No quota, new required step,
policy, timeout increase, new paid service or automatic semantic resolution is
part of this research. Runtime/DB/R2/idle delta of the saved research and offline
core is zero. Its synthetic ten-task runner holds O(10 tasks + edited bytes),
reads final files in a batch, and creates no background process. No runtime
billing improvement is claimed. The new note consolidates the diagnosis and
removes no source module because no product fix was authorized here.

## Forge versus git

Forge retains exact accepted source/check/Issue links and batches 2–3 tasks into
one check; GitHub's baseline repeats PR, merge-group and main-push CI. Forge's
retained receipts made this diagnosis possible. Forge also has additional
conflict materialize/resolve and checkout-write-queue costs that Git does not.
The full trace also shows an ownership-measurement caveat: `captureChanges`
compares a resolution Lane to the cell base, so its diff includes accepted peer
changes incorporated by sync. For coordination attribution, retain the original
write footprint separately (`scripts/bench-t3code/hunks.mjs`, `run-cell.mjs`); do
not treat all files in the final resolution diff as independently edited by that
task. No repair was applied here.

This task needed 37 exact comment-detail reads after paging 87 summaries because
planning detail exposed only 50 comments without continuation. A legacy
`hosted-work` read refused `HOST_NOT_BOUND` on this root, while current agent
records worked; a records-schema correction was read-only. No comparative
speed measurement was made for this research task. A useful improvement is
bounded, directly usable comment continuation, already tracked by f0d0fdd6.

## Implementation follow-up

The classifier now recognizes `agent help`, preserves structured queued advice,
and attributes separate code-mode child results, including deferred session/cell
reads, to their originating commands. It drops only speculative predecessor
advice as a trigger. Mixed calls keep real terminal errors and executed relay
outcomes. A recovery window still contributes to the published causal rework
measure; `activeRecovery` and `recoveryWaiting` report a separate split. A turn
with only status/command waits or sleeps is waiting; other turns are active.
These are deterministic command categories, not claims about model cognition.

The following offline recomputation reads the identical twelve retained scored
cells with original and revised classifiers, without writing their inputs or
rescoring correctness. Every cell has ten accepted landings. Totals are shown
because all per-landing rework medians remain zero; divide totals by ten for
means. Bootstrap or population claims are unchanged.

| N | Arm / rep | Causal turns before → after | Active / wait after | Cached before → after | Output before → after |
| ---: | --- | ---: | ---: | ---: | ---: |
| 10 | forge 1 | 23 → 18 | 8 / 10 | 2,135,808 → 1,717,888 | 2,632 → 2,037 |
| 10 | forge 2 | 25 → 14 | 8 / 6 | 1,868,032 → 1,066,752 | 2,512 → 1,590 |
| 10 | forge 3 | 26 → 17 | 8 / 9 | 1,910,912 → 1,287,808 | 2,454 → 1,795 |
| 5 | forge 1 | 21 → 23 | 12 / 11 | 1,548,800 → 1,928,064 | 2,562 → 3,435 |
| 5 | forge 2 | 6 → 0 | 0 / 0 | 276,992 → 0 | 467 → 0 |
| 5 | forge 3 | 5 → 0 | 0 / 0 | 389,120 → 0 | 272 → 0 |
| 10 | github 1 | 11 → 11 | 10 / 1 | 941,952 → 941,952 | 2,035 → 2,035 |
| 10 | github 2 | 5 → 5 | 5 / 0 | 523,904 → 523,904 | 1,242 → 1,242 |
| 10 | github 3 | 8 → 8 | 6 / 2 | 769,536 → 769,536 | 1,445 → 1,445 |
| 5 | github 1 | 8 → 8 | 8 / 0 | 647,168 → 647,168 | 2,132 → 2,132 |
| 5 | github 2 | 5 → 5 | 4 / 1 | 530,432 → 530,432 | 1,119 → 1,119 |
| 5 | github 3 | 11 → 11 | 11 / 0 | 1,102,336 → 1,102,336 | 2,884 → 2,884 |

The N=10 false-positive correction agrees with the manual audit. N=5 Forge rep 1
also **adds eight real recovery turns** previously hidden by a compound help/land
call's blanket exclusion, and removes six advisory-wait turns: 21 + 8 - 6 = 23.
The added episode is the other preview writer's terminal composition conflict,
not a check-help episode. N=5 reps 2 and 3 become zero. GitHub causal totals do
not change. Its active/wait split classifies one rep-1 N=10 sleep-only turn and
one rep-2 N=5 poll-only turn as waiting; the earlier manual labels called those
active. Measurement corrections save no actual model cost and do not establish
that Forge passes the rework bar.

The [fixed N=10 diagnostic](../../evals/bench-t3code/README.md#fixed-n10-protocol-diagnostics)
is now wired through `drive.mjs --only` and `run-cell.mjs`, with offline tested
real-service adapters, fixed five-pair registration, burst/late-third variants,
deterministic synthetic recovery, and one exact-head final oracle. The original
runner-core-draft and unbuilt-adapter statements above describe the research
snapshot; live qualification and cost measurement remain unrun. The late-third
manifest uses explicit receipt dependencies to force the two-loss tail, rather
than asserting that offsets alone guarantee it on machines with different CI
latencies. Its induced gate waits must be separated from organic queue latency.

Failure timing collection now preserves received submission timing and the
outer command interval for failed as well as successful operations, without any
new service reads. It cannot reconstruct absent product timestamps. Existing
product clocks are declared in `src/hosted-landing.ts` (`timing.submittedAt`,
`selectedAt`, `checkReservedAt`, `ciEndedAt`, `settledAt`); the landing attempt's
progress is projected in `convex/projectHostedLandingStore.ts` and the read-side
order projection in `convex/projectHostedLandingOrder.ts`. To measure predecessor
waiting directly, the product would need per-attempt
`timing.predecessorWaitStartedAt`, `timing.predecessorWaitEndedAt` and the exact
predecessor submission identity, stamped at the order wait transition and its
release in `convex/projectHostedLandingOrder.ts` / the queue selection write in
`convex/projectHostedLandingBatchStore.ts`. Exact conflict production/delivery
would need `timing.conflictDetectedAt` in the compose failure path
`convex/projectHostedFinishCompose.ts`, and `timing.conflictReplyPublishedAt`
in `convex/projectHostedLandingStore.ts`; receipt arrival stays the harness's
clock. These proposed product fields are **unbuilt**, not inferred from an
advisory's timestamp or an entire failed call's duration. No product schema or
runtime was changed by this harness work.

Removes false advice/help recovery attribution and merges diagnostic execution
into the existing arm lifecycle. No public product action, table, error code,
policy, limit, access condition or user step is added. Tests and offline reads
make zero Convex/DB/R2 calls; live diagnostic service/CI costs remain estimates.
