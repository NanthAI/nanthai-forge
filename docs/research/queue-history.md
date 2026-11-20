# Landing queue history since Phase 4

At **2.46 accepted landings/hour**, the November 18–19 window improved on the
October 29–30 baseline: **5.46 → 2.46** started checks per landing, **23.5 → 16.0
min** median finish-to-main and **67.8 → 36.0 min** p90. Main-race attempts fell
from 4,003 to 672 elapsed minutes across 59 landings. The improvement is real
as a comparison of those windows. Workload, check duration, and policy changed
with the implementation, so these figures do not isolate an intervention.

The October 31 **1.29 checks/landing, 22.4 min p90** reference came from 14
landings at **0.70/h**. The November 19–20 window reached **5.04/h** and came
in at **2.90 checks/landing, 52.9 min p90**, even as its median recovered to
**12.6 min**. November 17 had a similar **4.75/h**, **4.30 checks/landing** and
**95.8 min p90**, during the parked-head incident. There is evidence of recovery
at busy load as well as recurring tail failures. There is no sustained
high-load proof that the queue meets the October reference.
[October measurement](bet2-metrics.md) · Forge Item `45f49fb7`, comments
`267c62dd`, `c210073c`, `ae49c3b1`, `35d85e04`.

## Hosted series

The hosted authority seam is **2026-10-28 08:08:57.812 UTC**. The oldest
receipt is `1862a699` at 19:02 UTC that day. The bounded reader returned
**1,418 unique receipts over 49 pages**, with **1,415** in the analysis window
ending **November 20 at 21:45 UTC** (last receipt `e3bbad0f`). The first and
last UTC days are partial. The pre-cutover native Work is unavailable to this
checkout. The published October 14–24 owner baseline is a separate aggregate:
345 landings in 11 days (31.4/day), 118 classified first-try and 169 unknown,
3,509.6 known execution runner-minutes (896 of 1,080 runs lacked stamps), and
805.2 partially observed Forge red-main minutes. There is no native receipt
series here to interpolate. [Phase 5 baseline](../phase5-plan.md#published-baseline)

### Weekly

Weeks start Monday. The first week starts at the authority seam and the
last ends at the cutoff.

| From (UTC) | Receipts | Per 24 h | Per h | Starts/landing | First try | Submit→main p50 / p90 min | Accepted runner min/landing (n) | Discarded runner min/landing (n) | Recomposes/landing | Linked red audits |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 10-28 | 148 | 31.8 | 1.32 | 3.24 | 71/147 | 16.6 / 76.5 | — (0) | — (0) | 0.84 | 0 |
| 11-02 | 391 | 55.9 | 2.33 | 2.32 | 161/390 | 14.2 / 39.3 | — (0) | — (0) | 1.07 | 0 |
| 11-09 | 460 | 65.7 | 2.74 | 2.06 | 244/459 | 10.1 / 27.1 | 30.4 (239) | 7.5 (253) | 0.85 | 4 |
| 11-16 | 416 | 84.8 | 3.53 | 3.17 | 208/416 | 22.2 / 88.4 | 78.7 (413) | 52.1 (404) | 1.55 | 8 |

### Last 14 UTC days

| From (UTC) | Receipts | Per 24 h | Per h | Starts/landing | First try | Submit→main p50 / p90 min | Accepted runner min/landing (n) | Discarded runner min/landing (n) | Recomposes/landing | Linked red audits |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 11-07 | 83 | 83.0 | 3.46 | 1.65 | 39/83 | 12.8 / 26.7 | — (0) | — (0) | 1.10 | 0 |
| 11-08 | 95 | 95.0 | 3.96 | 2.71 | 38/94 | 17.8 / 46.7 | — (0) | — (0) | 1.31 | 0 |
| 11-09 | 130 | 130.0 | 5.42 | 2.42 | 51/130 | 16.7 / 31.7 | — (0) | — (0) | 1.25 | 0 |
| 11-10 | 171 | 171.0 | 7.12 | 2.05 | 96/171 | 7.2 / 27.8 | 26.5 (89) | 7.9 (95) | 0.92 | 3 |
| 11-11 | 84 | 84.0 | 3.50 | 1.96 | 48/83 | 8.5 / 21.0 | 44.0 (77) | 19.3 (84) | 0.69 | 1 |
| 11-12 | 26 | 26.0 | 1.08 | 1.42 | 18/26 | 10.3 / 12.6 | 66.4 (26) | 3.2 (26) | 0.04 | 0 |
| 11-13 | 16 | 16.0 | 0.67 | 1.69 | 11/16 | 11.2 / 12.4 | 88.6 (16) | 0.0 (15) | 0.25 | 0 |
| 11-14 | 5 | 5.0 | 0.21 | 1.80 | 1/5 | 11.2 / 11.7 | 92.0 (5) | 0.0 (5) | 0.00 | 0 |
| 11-15 | 28 | 28.0 | 1.17 | 1.61 | 19/28 | 11.1 / 22.5 | 76.0 (26) | 13.5 (28) | 0.36 | 0 |
| 11-16 | 35 | 35.0 | 1.46 | 2.14 | 23/35 | 12.0 / 35.8 | 86.0 (34) | 11.2 (35) | 0.54 | 1 |
| 11-17 | 114 | 114.0 | 4.75 | 4.30 | 38/114 | 37.5 / 95.8 | 79.0 (112) | 58.0 (114) | 2.09 | 1 |
| 11-18 | 45 | 45.0 | 1.88 | 2.00 | 31/45 | 15.7 / 30.3 | 96.3 (45) | 29.8 (43) | 0.98 | 0 |
| 11-19 | 120 | 120.0 | 5.00 | 3.04 | 61/120 | 44.2 / 102.1 | 75.2 (120) | 84.7 (117) | 1.90 | 3 |
| 11-20 | 102 | 112.6 | 4.69 | 2.93 | 55/102 | 10.8 / 35.1 | 72.2 (102) | 30.9 (95) | 1.15 | 3 |

**Read the denominators.** Receipt volume includes one compensating acceptance,
November 8, that the metrics denominators exclude. A shared acceptance can
produce several receipts on one main transition. Starts/landing is project
metric 5.6: unique non-reused starts, including scoped runs, failed submissions,
independent checks and audits, grouped by check-request timestamp. The
older report calls it “full checks started.” First try is current metric 5.1
classified first-try plus carry after a race over classified ordinary
acceptances. It excludes two unknowns and the compensating receipt from
the denominator across the complete series. The old charts and some Issue
comments use different classifications.

Submit→main uses the original recorded submission to atomic commit of the
successful operation. Both percentiles linearly interpolate at `(n−1)p`.
Time before the submission, prior failed or abandoned operations, local
preflight and acceptance observation after commit sit outside that clock.
A recompose counts a distinct Candidate after the first, so a fresh binding
alone is no recompose. Nineteen receipts reached the eight-attempt read cap.
Their distinct check links are partial, and a late attempt with no new
Candidate may overstate recompositions under the reader's fallback.

Accepted and discarded runner minutes divide known receipt minutes by all
acceptances in the row. Parentheses show stamped receipts. Identical accepted
stamps for the same batch and commit share one execution's cost. Discarded
stamps can include failed, stale and cancelled attempts of a landed operation.
The retained fields lack the execution identity needed to remove possible
shared discarded work and omit other Operations that never landed. These
figures describe the receipt ledger. Project-wide metric 5.6 independently
counts known execution by run/request window, with audit and non-landing work.

Linked red audits count distinct run IDs whose following-audit verdict marks
a red or its attribution, assigned to the earliest associated acceptance in
the analysis. That acceptance may precede the audit. Six recent events are also
visible by **audit time** in the newest-100 export (three on each of November
19 and 20, two later flake clears on November 20). The longer receipt join
links six more run IDs. An audit can cover many acceptances, red runs can
belong to one episode and audits with no linking receipt are invisible here.
A linked count of zero means none observed.

### Hours at comparable load

These are UTC **commit-hour** buckets of equal accepted volume, with all
partial hours excluded. October 28–November 4, November 5–15 and November
16–20 are reporting blocks for hosted Phase 5, Phase 6 and Phase 7. A burst can
be the result of earlier work draining, so hour buckets control for accepted
output and leave arrival pressure, in-flight age, policy, check type, overlap
and review mix uncontrolled. The hourly check column assigns each distinct
run ID one unit across all receipts that link it. It measures recorded checks
for accepted operations, including their prior attempts. Project check-start
timestamps are unavailable at this grain.

| Period | Receipts in hour | Hours / receipts | Linked checks / landing | First try | Submit→main p50 / p90 min | Accepted / discarded runner min (n each) | Recomposes / landing | Main moved | Linked red audits |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| P5 hosted | 1–2 | 71 / 96 | 1.23 | 55/95 | 9.7 / 35.1 | — (0) / — (0) | 0.34 | 17/96 | 0 |
| P5 hosted | 3–5 | 24 / 89 | 1.53 | 38/89 | 22.8 / 87.5 | — (0) / — (0) | 1.10 | 61/89 | 0 |
| P5 hosted | 6–7 | 4 / 24 | 1.54 | 13/24 | 16.4 / 35.9 | — (0) / — (0) | 1.29 | 19/24 | 0 |
| P5 hosted | 8+ | 0 / 0 | — | 0/0 | — / — | — (0) / — (0) | — | 0/0 | 0 |
| P6 | 1–2 | 80 / 105 | 1.10 | 67/104 | 9.5 / 16.0 | 44.2 (59) / 1.7 (58) | 0.16 | 10/105 | 0 |
| P6 | 3–5 | 51 / 199 | 1.47 | 99/199 | 9.7 / 30.6 | 20.4 (68) / 4.6 (72) | 0.82 | 104/199 | 1 |
| P6 | 6–7 | 26 / 172 | 1.41 | 77/172 | 12.9 / 36.8 | 8.8 (30) / 2.8 (33) | 1.08 | 128/172 | 1 |
| P6 | 8+ | 33 / 314 | 1.44 | 127/313 | 14.4 / 32.1 | 11.9 (82) / 5.9 (90) | 1.30 | 257/314 | 2 |
| P7 | 1–2 | 30 / 47 | 1.26 | 29/47 | 12.8 / 43.0 | 92.4 (46) / 13.8 (43) | 0.43 | 11/47 | 1 |
| P7 | 3–5 | 28 / 115 | 1.90 | 52/115 | 24.9 / 82.6 | 86.8 (115) / 54.2 (114) | 1.60 | 89/115 | 3 |
| P7 | 6–7 | 15 / 101 | 1.83 | 45/101 | 21.2 / 96.1 | 76.8 (99) / 53.1 (98) | 1.67 | 86/101 | 3 |
| P7 | 8+ | 16 / 150 | 1.83 | 79/150 | 29.6 / 82.1 | 70.0 (150) / 62.6 (146) | 1.81 | 142/150 | 1 |

The two **59-landings/24 h** windows are a second comparison at the same
average load. The November 17 and November 19–20 busy windows differ by
0.29/h. The numbers below preserve each originally reported reading. Under the
uniform current path reader in the [JSON](queue-history.json), first try is
23/59 for the October baseline, 13/14 after E and 38/114 on November 17. The
two latest rolling windows reproduce their reported 43/59 and 64/121.
Directions that depend on the original October classification are qualified.

| Closed window | Landings/h | Starts/landing | First try then reported | Submit→main p50 / p90 min | Main-race attempts / elapsed min |
| --- | ---: | ---: | ---: | ---: | ---: |
| Oct baseline | 2.46 | 5.46 | 16/59 | 23.5 / 67.8 | 179 / 4,003.1 |
| After E | 0.70 | 1.29 | 10/14 | 12.5 / 22.4 | 5 / 38.2 |
| Nov 17 incident | 4.75 | 4.30 | 15/114 | 37.3 / 95.8 | 402 / 4,161.0 |
| Nov 18–19 matched | 2.46 | 2.46 | 43/59 | 16.0 / 36.0 | 97 / 671.9 |
| Nov 19–20 busy | 5.04 | 2.90 | 64/121 | 12.6 / 52.9 | 190 / 1,545.4 |

### Check duration

| From (UTC) | Started runs | Mean request→end min / start | Known runner min (unstamped runs) |
| --- | ---: | ---: | ---: |
| 10-28 | 479 | 17.7 | 5360.2 (385) |
| 11-02 | 903 | 9.1 | 56208.3 (100) |
| 11-09 | 947 | 8.1 | 57508.0 (63) |
| 11-16 | 1319 | 10.3 | 93019.5 (263) |

This weekly mean uses the metric 5.6 request-to-end minutes divided by
starts. It includes service, dispatch/runner delay, and different check
types. Four run wall durations are missing in the captured history. The
day-level data includes the latest-20 passed-check p50 and p90 where eligible.
The dogfood matched window on November 18–19 saw **14.8/17.5 min** on that
measure, versus **8.9/9.9 min** in the 5.04/h period. A separate full-check
sample before/after coverage removal is stronger evidence for the service
time change: **886 s p50** (41 runs) before, **567 s p50 / 647 s p90**
(232 coverage-free full passing runs) in the next-day re-read. The first
five coverage-free runs had **121 → 82 execution runner-minutes median**
from the old sample to the new one. [Speed budget definitions](../agents/regression-ladder.md#rung-1-landing-speed-budgets) ·
`45f49fb7:c210073c,ae49c3b1` · `d5de1c98:62870052,8ff80090`.

## What changed and what was measured

Dates are UTC. A pin is a hosted receipt or State unless marked as a decision
or comment. Shipped source and activated dogfood settings are separate. Where
landings followed a change but the record lacks a like-for-like follow-up, the
last column leaves persistence open. These rows cover the interventions aimed
at repeated checks or time to main that surfaced in the phase plans, bench
reports, queue model, retained receipts, and their Issues.

| Date and pin | Item | Change and intended effect | Bench and dogfood evidence | Persistence or disposition |
| --- | --- | --- | --- | --- |
| Phase 4, by Oct 23 | S01–S17 | Native landing train, batches and speculative prefixes share checks and overlap work. Overlap-aware selection puts independent work first. | Phase 4 clean burst-4 P1c took 297 s vs GitHub 702 s. On Oct 24 E3, Forge needed 2–3 serial diagnosis rounds once one member was red. | Clean-burst gain did not cover failing bursts. Native authority was replaced Oct 28. [Roadmap](../roadmap.md) · [E3](e3-failing-burst.md) |
| Oct 23, roadmap close record | Phase 4 CI speed | Native TypeScript cuts static time. | Typecheck 76 → 34 s in the recorded comparison. | No retained hosted before/after for this slice. [Roadmap](../roadmap.md) |
| Oct 23, roadmap close record | Phase 4 CI speed | Time-balanced shards, smarter test selection and fake timers shorten checks. | In E3, Forge still selected 325–328 files against 46–47 in GitHub's arm and each round took 209–351 s. | Later Actions suite, sizing and selection differed. [E3](e3-failing-burst.md#why-forge-was-slower-from-the-run-records) |
| Oct 23–24, roadmap close record | Phase 4/Q2 | Reuse passed checks, recover a lost run and finish no-op landings without queueing. | E3 still wedged in one attempt with a duplicate audit and orphaned checks. | Hosted Q1–Q4 replaced the native driver. [Roadmap](../roadmap.md) · [E3](e3-failing-burst.md) |
| Oct 24 experiment, published Oct 25 | E3 / G8 `39942bfe` | Put one red change into four parallel submissions to test isolation. | Three green changes took Forge 989 s vs tuned GitHub 189 s, with zero bad acceptances and zero red main on both arms. A check-width sensitivity still had Forge about 2.4× slower. | The dedicated rematch awaits an owner cost decision. Nov 19 gate and cost reads on the Item were separate from E3. |
| Oct 28, first receipt `1862a699` | B1.2b/B1.5b | Hosted main and queue become sole acceptance path, eliminating Mac handoff and dual writers. | The recovery drill and Phase 5 close give functional evidence. The new series begins at this authority seam. | One authority persisted. The start of hosted coverage precludes a continuous Phase 4 receipt comparison. [Phase 5 plan](../phase5-plan.md#bet-1-one-authority-then-delete) |
| Oct 29, Phase 5 close | B1.3/G1/G2/G6 | Move from the Mac runner to hosted Actions, warm dependencies and tune shard count. | The plan reports warm cache/shards/scope/runner-label slices landed. The Bet 2 baseline still averaged 19.9 request-to-end min per started check. | Provider, check and selection all moved. No isolated same-load series. [Phase 5 plan](../phase5-plan.md#gate-parity-g1g8-added-2026-10-28) |
| Oct 28–Nov 4, Phase 5 close `60483e2c` | Q1 | Desired-state controller continues across CLI, MCP and machine loss. | Q4 restart, sleep and Wi-Fi-loss drills each landed once. | Later lost ownership/wake cases needed specific repairs. [Phase 5 close](../phase5-close.md) |
| By Oct 31, Phase 5 plan | Q2 / `7e38bf5e` | Self-finish entries, alarm on no progress, then redrive or settle orphaned work. | Two queued entries stayed about a day after their alarm. Terminal failure at 60 minutes for undriven entries was added. | Useful for diagnosis and recovery, with further liveness counterexamples in November. [Phase 5 plan](../phase5-plan.md#where-the-plan-stands) |
| By Nov 4, Phase 5 close `60483e2c` | Q3–Q4 | Content-keyed check reuse survives restart when source/check inputs agree. | Lifecycle drill landed once per case. Historical reuse keys were incomplete. | Same-content evidence remained usable. Cross-head interaction proof is a separate mechanism. [Phase 5 plan](../phase5-plan.md#q3-content-keyed-check-reuse) |
| Oct 30 interim window | Finish freeze / Ready-first | Freeze a submitted selection and give Ready attempts first dispatch so moving heads do less repeated work. | At 2.13/h, checks fell from 5.46 to 1.78 per landing, while p90 widened from 67.8 to 121.0 min and only one of 27 landed first try. The contract gate also changed in the window. | No isolated timing effect. [Bet 2 interim window](bet2-metrics.md#3-before-and-after-same-method) |
| Oct 30, Phase 5 plan | B2.1/B2.2 | Gate trusted work on its declared contract, with a full fallback and stricter review policy. Bet goal p50 under 3 min and one fifth the check minutes. | Shipped on dogfood. Even the light after-E period measured 12.5 min p50. | Contract use persisted. The speed target remained unmet. [Phase 5 plan](../phase5-plan.md#bet-2-per-intent-contract-gates-full-suite-continuous) |
| By Nov 4, Phase 5 close `60483e2c` | B2.3 | Coalesced full main audit protects progress under narrower landing checks. | Live audit, but early red-main duration coverage was partial. | Full audits remain a real cost. Nov 19 exposed a wrong-culprit case when tests changed. [Phase 5 close](../phase5-close.md) |
| By Nov 4, Phase 5 close `60483e2c` | B2.4/G4 | Retry flaky test files, classify and bisect the real culprit, using fix-forward or a compensating landing. | Shipped. Nov 17–18 read found 33/9 flaky runs passed on in-check retry. | Helps against flakes. The Nov 19 coverage-change incident required further attribution fixes. [Phase 5 close](../phase5-close.md) · `45f49fb7:f1187576` |
| Oct 30 `248c9950` | Bet 2 E / `4a686b9a` | Scoped interaction recheck after main moves. | After E: 5 race attempts / 38 elapsed min, one scoped recheck, 1.29 starts/landing. Before: 179 / 4,003 min and 5.46 starts/landing. Load fell 3.5×. | The low-load gain attenuated in busy traffic. At matched October baseline load in Nov 18–19 there were 97 / 672 min, still a substantial improvement on the baseline. [Bet 2](bet2-metrics.md) |
| Oct 31 `9547902a` | Bet 2 D / `4a686b9a` | Narrow admission/queue work further in the Bet 2 rollout. | The ten landings after D had 1.40 checks/landing and 24.1 min p90 at 0.58/h. The encompassing after-E sample had 1.29 and 22.4. | No measurable incremental gain isolated. The comparable-load Issue was later superseded by the ladder evidence. [Bet 2](bet2-metrics.md) |
| By Nov 4, Phase 5 close `60483e2c` | B2.5 | Demote batches for trusted contract landings and simplify checks. | Landed. Trusted landings passing without a batch remained an unevidenced acceptance line at phase close. | Later cold-start default favoured queue groups for clean submissions. [Phase 5 plan](../phase5-plan.md#where-the-plan-stands) |
| By Nov 4, Phase 5 close `60483e2c` | B2.6 | Path/actor trust was intended to vary check depth with earned evidence. | Built disabled. Defaults gated on an owner decision. | No measured effect to assign. [Phase 5 plan](../phase5-plan.md#where-the-plan-stands) |
| Nov 3, saved `fbc39508` | `7fe54c7c` | Parallel atomic acceptance and cheap overtakes with early conflict recovery. | Prototype hit the physical-CI hard stop. A later parked stacked/zero-CI branch had no wall gain and regressed three latency guards, comment `16467c46`. | Broad prototype was not landed. Early conflict and bounded overtakes shipped in narrower slices. Optimistic takeover was dropped. |
| Nov 4, bench pin `ead2f465` | B1.5d / `36a087ea` | Publish live benchmark in place of E2 and trace conflict/recovery loops. | Per-task time improved 24–35% vs GitHub, but only N=1 wall win cleared the registered range test. t27456 and N=3 r3 showed long conflict, overtake and status loops. | Phase 6 added conflict-marker refusal, exact recovery advice and replays. Later N=10 passed on the revised bench but noisy/rare dogfood tails remained. [B1.5d](b15d-report.md) · [registered plan](b15d-bench-plan.md) |
| Nov 5 `bf32dcaf` | `6e587f06` | Retry a conflict against an unaccepted cohort prefix once that prefix settles. | Model reproduced orphan conflict before the fix and guards prompt rejection on actual main after it. | Later early-resolution changed how the advice is acted on. No longitudinal effect isolated. [Queue model](../../models/landing-queue/README.md#findings-and-counterexamples) |
| Nov 5 `199d301f` | `51bbbd00`, `c329d191` | Diagnose likely failing members and release suspects so healthy cohorts move. Recover a lost order wake. | Model checks isolation and no re-stacking on a known suspect. The later 12-Lane synthetic admission fixture uses this as baseline. | Lost holder chains needed a further redrive repair. [Queue model](../../models/landing-queue/README.md#findings-and-counterexamples) |
| Nov 5 `777f4786` / State `eef7b79d` | `e7d27937` | Run full Lane checks before entering the queue to isolate red work in parallel. | In a synthetic 12-Lane wave with three red, queue checks containing red went from 8/19 to 0/7, throughput 6.1 → 8.2/h, runner min/landing held at 46. | Dogfood stayed explicit full. Clean bench later chose queue-only by default due to duplicated checks and audits. [Synthetic wave](../operations/landing-batches.md#pre-queue-lane-checks) |
| Nov 5 `070470ff` | `72d50375` | Keep results through write outages and re-drive once writes resume. | Model/tests replayed 20 min outage. Subsequent expiry litmus found recovery still needed an event when no reader or writer returns. | Expiry wake was added. No normal-speed claim. [Queue model](../../models/landing-queue/README.md#findings-and-counterexamples) |
| Nov 5 `b6191f09` | `10b0a94b` | Group admitted entries whose passed runs fail carry into one fresh cohort. | Synthetic red wave moved 8.2 → 12.3/h, queue checks 7 → 2, total runs 19 → 14 and runner min/landing 46 → 34. | Later ten-receipt sample found no spare checks to remove by extending the hold for already-passed peers. No durable gain per additional hold measured. [Synthetic wave](../operations/landing-batches.md#pre-queue-lane-checks) · `45f49fb7:35d85e04` |
| Nov 5 `ebc587fc` | `19328518` | Supervisor replays lost drivers then reports typed exhaustion on permanent faults. | Model separates lost-step and permanently throwing states. Later fault matrix caught a separate missing round for already-ended checks. | Follow-ups retained in model/replays; no general idle poll. [Queue model](../../models/landing-queue/README.md#findings-and-counterexamples) |
| Nov 5–6 `ebc587fc`, `38e18f94` | `ea86f3fb` / `a7de3a93` | Keep stacked followers when an infrastructure retry retains the predecessor's exact head and receipt. | Historical incident lost a 75-file batch with about 74 runner min. The model checks the identical-generation case and invalidates changed predecessors. | Mechanism retained. No aggregate rate isolated. [Queue model](../../models/landing-queue/README.md#findings-and-counterexamples) |
| Nov 6 `38e18f94` | `c329d191`, `72d50375` | Follow parked order waits back to the holder and redrive the lost work. | Double-fault model and code replay passed. | Nov 17 had a new wait edge when the holder changed runs without leaving. [Queue model](../../models/landing-queue/README.md#findings-and-counterexamples) |
| Nov 6 `28008bba` | `7fe54c7c` | Refuse a now-unusable Lane proof early and start its needed recheck sooner. | Wave 3b had 0 of 20 recompositions eligible for the then-conservative proof, comment `a07b9fd6`. | Retained behind subsequent reuse rules. Adaptive admission replay on the same Issue saved almost no time and added one full run when wrong. It was dropped. |
| Nov 6 `165efaa2` | `0ea17a29` shard-pool trial | Let finished workers steal test files from a shared claim pool to shorten the last shard. | Later balancer-arm sample showed closer balance (1.11 vs 1.33 slowest/mean), with coverage and runner load in the mixes. | Decision flipped to a single pool path November 19. No stand-alone sustained dogfood latency estimate. `d5de1c98:62870052` |
| Nov 6 `6f90836e` | `7fe54c7c`, owner option A | Accept a Lane's first run after proving clean path-disjoint interaction on moved main. | Nov 6 retained 22 of 24 acceptances on one admission run, Issue comment `93181ea2`. Nov 18–19 23 of 59 carried after a race per 5.1. | Carry persisted. It did not eliminate rechecks for overlaps, check-surface changes or failed proofs. |
| Nov 6 `a5275df5` | `7fe54c7c` | Reuse the first check across clean untested Markdown overlap. | Qualified by targeted tests. Review kept global-risk classification after 18/25 examined cases would recheck anyway on path overlap. | Tested docs still required a proof or fast-mode exception. [Pre-queue checks](../pre-queue-checks.md) |
| Nov 6 `a3c4a0b5` | `7ecc4884` | Skip nonterminal progress wakes that could not change eligibility. | Model proves skipping progress is inert and dropping a terminal wake strands a head. | Calls saved on noisy run events. No isolated dogfood time claim. [Queue model](../../models/landing-queue/README.md#findings-and-counterexamples) |
| Nov 7 `663d9769` | `45f49fb7` | Add landing speed alerts and incident replay ladder. | Alerts plus model/regression fixtures landed, including historic paths that need no live N=10 cell. | Revealed subsequent incidents. Observability does not itself improve latency. [Regression ladder](../agents/regression-ladder.md) |
| Nov 8 `1b76700f`, `71cc37b8` | `05df5aed` | Generalize proved first-check reuse to other commands, symlinks and submodules. | Five-change comparison reported about 65 calls/landing versus 51 baseline while a batching opportunity was lost, `0bce207f:0ea1a02d`. | Reuse retained. Batching density and independent receipt/mirror semantics remained separate work. |
| Nov 8 `6c810657` | Docs tier | Skip the selected command on declared docs-only paths, keeping exact review and scope evidence. | Prior measured bench without a docs declaration ran full 259-file selection. | Later docs-only checks contribute to the changing dogfood check mix. Never use their wall time as full-check service time. [CI attribution](ci-minute-attribution.md) |
| Nov 8 `25d7e80e` | `7d98c7da` | Let a passed unrelated change overtake once, bounding repeated displacement. | Rust overtake report accepted as `b26a8073` Nov 11. | Order/risk cases still stranded followers in Nov 17 and 19 incidents. |
| Nov 8 `14796d94` | Scoped recheck expansion | Reuse scoped intersection under more gate types and reason about test-read documents and manifest placement. | Covered by targeted tests; exact O1 follow-up finds 8 of 22 post-O1 scoped runs selected zero tests, with a wide tail on others. | Scope remained material to both cost and safety. `45f49fb7:af537ec0` |
| Nov 9 `b73186d4`, Nov 10 `d0235b82` | Flip 1 `81d12a32` | Add strict and earned fast policy, audit freshness, refusal reason and second-check telemetry. | Strict dogfood baseline (149 landings) p50/p90 17.7/39.5 min and 56.6 discarded passed runner-min/landing. Scratch red drill detected failure 25 s after acceptance and recovered in 13.9 min. | Drill never exercised an earned fast carry. The 200-audited-landing requirement was soon removed. `81d12a32:c450aed7` |
| Nov 9 `bd5c08db` | `28f08555` | Scope a recheck for a composed cohort rather than discard the whole shared run. | Shared scoped result appears in two of the Nov 20 slow-tail receipts. | Coverage exists. No isolated gain across weeks. |
| Nov 9–10, model `reserve-fixed` | `10d253c6` | Give a superseded large Lane a bounded reservation on hot files. | Incident needed 10 operations and about 2.5 h. Model/test guards recovery within two attempts in its workload and release of waiters. | Subsequent O4-on replay regressed this path, so O4-on was dropped. [Queue model](../../models/landing-queue/README.md#findings-and-counterexamples) |
| By Nov 10, queue model `prequeue-cohort-fixed` and `six-slots` | Hosted pipeline | Check future cohorts on a pinned predicted predecessor while an earlier cohort checks. | Model enforces receipt/head pins and invalidation of stale successors. Same-head infra retry and early resolution have separate replays. | Serial alternative to speculative rechecks was retained in later O7 decision. Clean predecessor assumptions do not cover red or changed predictions. [Hosted pipeline](../agents/workflow.md#working-on-forge-not-github) |
| Nov 10 `3c85417d`, Nov 11 `f19cdb1f` | Identical-path reuse | Carry proved equal bytes/ancestry-only changes. Correct a shared-risk bypass in the initial optimization. | N=3 smokes still had three second checks each, two text conflicts and one tested doc. Known discarded passed command min/landing 0.50/0.57 in the two smokes. | The measured smoke discard gain did not materialize for those different-byte cases. [CI attribution](ci-minute-attribution.md) |
| Nov 11 `0fd26bc9` | Fast circuit breaker | Replace earned-fast counters and drill prerequisite with a green audit, fresh evidence and bounded red/unclear audit outcomes. | Switch bench used dogfood full+fast, but also changed admission mode, so its proof and cost do not isolate fast. An early Nov 19 read showed 50/50 audited green. A later browser-coverage change produced a real red. | Policy stayed explicit. The circuit breaker and full audit cause part of the cost and occasional fallback. [Landing modes](../pre-queue-checks.md#landing-modes) · `45f49fb7:f1187576` |
| Nov 13 `ac9b280f` | `83e6d0d3` | Retire stale overlapping runs atomically with replacement work. | Addresses t19456 delayed conflict discovery. Nov 17 captured 57 cancellations of landed work for the keep-run incident replay. | Prompt invalidation came with repeated destruction of still-useful runs. Keep-run later narrowed it. [Regression ladder](../agents/regression-ladder.md#rung-3-incident-replays) |
| Nov 13 `8f41564b` | Admission A/B/C, `8c9b84fc` | Default absent/false to queue-only; keep explicit full admission. | Clean replay N=10/5/3: queue-only 10 checks vs 17/16/16. Red-sensitivity cost crossover 15.6–28%. Dogfood measured 24.7% red of 364 decided, with 19/50 in latest decided subset as of Nov 18. | Default held for bench, dogfood retained explicit full. Automatic setting choice moved to `bd0f850e`, gated by the ladder. [Admission replay](../pre-queue-checks.md#replay-comparison-and-default-choice) |
| Nov 14 `06a4fa7b` decision | `8c9b84fc` early resolution v1 | Resolve an exact conflict while its predecessor checks. | Reached two valid cells. One resolved check was lost when a third overlapping task landed, and the task took 786 s. A different N=10 cell voided on an old pending operation despite replacement acceptance. | V1's repeated-run and stranded-operation evidence drove v2. [Early-resolution review](p6-early-resolve-review.md) · [N=10 diagnosis](p6-n10-diagnosis.md) · [tail trace](p6-n10-tail-trace.md) · [turn ledger](p6-n10-rework.md) |
| Nov 14 `8988242e` decision | `8c9b84fc` early resolution v2 | Pin early advice and check to the same predecessor and recover lost compose ownership. | Two of three N=10 cells used one accepted post-resolution check, 575/661 s task-to-main. Five live cells settled empty. | The measured branch for waiting never fired: 8–9% predecessor failure against ~69–70% break-even. Automatic sampling was removed; only owner-off remains. [Early-resolution review](p6-early-resolve-review.md) |
| Nov 15 `836d8f6b`, `2039c668` | `8c9b84fc` early resolution v3 | Install tolerant reader first, fix advice against already-resolved bytes and event ownership. | Release-pin N=10 861/1,112 s Forge/GitHub wall, 27/65 CI min. Owner accepted the Phase 6 benchmark with caveats, including N=16 convoy. | No live reproduction of a third overlapping group accepting while the resolved check ran. Same-bytes false sync loop reappeared on the queue-stage bench. [P6 close](../phase6-close.md) · [Release validation](p6-release-validation.md) |
| Nov 16 `85156859` | `c01d5457` | Cancel only pending cohort finish wakes, preserving children of running actions. | Two-Lane deployed replay accepted both original operations in 110.184 s, no stage over 60 s and no stall/redrive. | Functional result with n=2. Nov 18 compose-settle added separate protection for lost compose work. [P6 close](../phase6-close.md) |
| Nov 17 `3463f25f`, Nov 19 `0d6c3f62` | `5e3c3a3c`, N1 `48697ee7` | Wake passed followers when the older holder binds a new run. Ship permanent after review. | Incident pass-to-land p50/p90 79/101 min. Both switch arms missed the intended path in healthy cells; unit and incident replay supported the permanent path. | Queue stalled again on different risk/wait paths; short quiet recovery did not prove busy recovery. [Switch results](queue-stage-bench-2026-11-18.md) |
| Nov 17 `1ada3e56` | O2 `436bd3e0` | Account for cancelled provider-run minutes and correct receipts/closed-day Stats. | Shipped. The Nov 19–20 window still had 71 unstamped starts. | Instrumentation improved attribution. A reduction in total execution cost is still unproven. |
| Nov 17 `5d6ba2f1`, Nov 19 `9ce0b818` | O4 `026ce0cf` | Spare running solo work where fast mode would carry the result. | N=10 did not exercise the on-path. Default-on landing failed the hot-file starvation replay and fast-mode proof rows. The diagnosis assigned only ~83 of 3,069 cancelled job-min to this relaxation. | Switch deleted with **off** behaviour. A broader keep-run proof shipped separately. `4647d45b:15df3975` · `45f49fb7:755da7b1` |
| Nov 17 `5d6ba2f1`, Nov 19 `816f731b` | O3 `026ce0cf` | Keep previously green admissions when their cohort fails or a member withdraws. | Could not exercise the path in healthy cells. The on-path regressed incident replay `70a9bd2f`, which became a guard. | Switch and on-path deleted. No CI savings credited. `026ce0cf:024e130a` |
| Nov 17 `ea4a757d` | O1, `ab9766f3` | Classify JSON by readers, keeping interaction checks narrow. | Post-O1 read saw 20 code rechecks across 60 landings: 14 never scoped, 4 fell back, and the 2 truly narrowed runs still selected 83% of the full suite. | The contemporary read is incomplete for durations and uncontrolled for other fixes. O5 was deferred pending reach evidence. `45f49fb7:af537ec0` |
| Nov 18 `75c2c1fc` | `7772aa23` | Run static preflight on changed paths and reuse the base comparison. | Warm local static p50 16.3 → 3.8 s. | Isolated local saving. This is outside the receipt's submit-to-commit clock. `7772aa23:e59e92ec` |
| Nov 18 `bf9ccbff`, Nov 19 `2cf4ea7c` | `36fd3295` | Equal bytes in an early-resolved prefix no longer trigger repeated sync advice; repair once. | N=10 scripted bench hit false SYNC_REQUIRED on 3 of 10, adding about 54 s p50 / 67 s p90 on that path. | Permanent after review. A later dogfood message reports a related but distinct false sync after both predecessors landed, comment `f052866c`. No post-fix matched cell in the dossier. |
| Nov 18 `2c471f70`, Nov 19 `1d6eca9e` | `9a04d916` | Finish a completed compose exactly once and shorten silent conflict waits. | t27456 waited 17 min with a knowable conflict; compose-settle became the sole path after cross-model review. | Nov 20 saw another compose symptom during a source-worker failure. The Issue keeps its follow-up and no long-window proof is available. |
| Nov 19 `9faeae30` bench result | `4647d45b`, `5e3c3a3c` | A/B the three queue switches at accepted and dogfood policies. | N=3 like-for-like 866/883 s accepted vs 901 s current, 30/31 vs 30 billed min. Healthy N=10 arms showed no regression attributable to the switches, with no on-path gains established. | Owner cancelled the interim live N=10 and moved site-claim validation to the final P7 run. Two-deployment approach dropped. Later remaining switch planning chose one bench deployment. [Switch bench](queue-stage-bench-2026-11-18.md) |
| Nov 19 `378ab39b` | O6 `d5de1c98` | Remove routine coverage collection from the landing check. | Successful full checks p50 886 s before, 663 s first five after, 567 s p50 / 647 s p90 in n=232 re-read. Shard runner-min median 121 → 82 in first five. | Next-day full-check re-read held. Broader 20-passed-check median 8.9 min is a distinct population. `d5de1c98:62870052,8ff80090` |
| Nov 19 `e822ce2f` | `0ea17a29` | Keep the shared shard pool as the only mode, eliminating the split A/B path. | Earlier balancer arms showed slowest-to-mean shard ratios 1.33 and 1.11 before the coverage change, `d5de1c98:62870052`. | Pool adoption and coverage removal overlapped. The later full-check improvement cannot be allocated between them by daily totals. |
| Nov 19 `eccac2e5` | `45f49fb7` rung 2 | Path-triggered N=3 dry micro-bench intended to detect routine regressions. | Tooling landed. First and sampled later invocations skipped the scenario and had no stored measured baseline. | Qualification remains open. Queue- or source-setting changes gated on this proof keep their existing gate. `45f49fb7:c210073c` |
| Nov 19 `0448f09b` | `42200ce4` | Alarm on first-pass-to-land p90, excluding review/dependency holds, so the lead sees parked passed work. | Historical dogfood replay broke at 09:42 on Nov 17. Accepted bench trace of 120 landings took 2–13 s post-pass. | Detection now covers the dogfood failure mode. Quiet recovery did not establish the busy-speed goal. [Speed budgets](../agents/speed-budgets.md) |
| Nov 19 `7fa33a2b`, Nov 20 `0ef351c4` | `fa2c1383` | Keep eligible solo full runs through main moves so their pass can carry or seed a scoped recheck. | Replay of Nov 17 covers 57 cancels. Dev reported enabled ~03:30 Nov 20. Commit cohorts before/after had p90 73.1/35.1 min (43/78 landings), with different load, shorter checks and outage overlap. | 24 h attribution/check remains open. No isolated causal or durable gain established. `45f49fb7:35d85e04` · `fa2c1383:2b9a2bc2` |
| Nov 19 `6557e70e`, `27c58829`; Nov 20 `b5360557`, `c17a6df3` | `687d1eda` audit fixes | Skipped tests lose false pass status; coverage-changing landings have distinct attribution and cannot supply their own reuse baseline. | Dogfood main was red for at least 35 minutes and unrelated landings were blamed. Targeted incident replay guards culprit attribution, full audit and definition trials. | Four more reds were observed after parking switch-on. Coverage and other audit paths changed, so historical incidence rates are bounded. |
| Nov 19 `c84523da`, `f78ff7e7`; Nov 20 `db559c15` | `13ea93bf`, `5dcfce75` | Feed repeat guard failures into preflight and run the most useful checks first. | Earlier failed-check audit attributed 37 of 72 incident-day failures to a deterministic guard that could be caught before hosted CI. | New preflight coverage is observable, but there is no comparable-load post-fix red-rate sample in this capture. `45f49fb7:f1187576` |
| Nov 19 `ebd8d53f`, Nov 20 `bc81e99a` | `a217b83e` | Record full-check runner minutes and daily discarded-cost bounds; identify new test cost. | Replay found later checks, rather than the change's own check, first reflected coverage removal. Daily waste can have incomplete usage. | Instrumentation shipped. No change to runner work or proof rules. [Speed budgets](../agents/speed-budgets.md#daily-waste-tripwire) |
| Nov 20 `4be4b9bb`, `254cb9cc` | `43b51a5e` | Narrow actual CI risk and allow a bounded unrelated overtake; wake handed and parked followers. | One nightly workflow held nine passed entries for 80 min. Model plus cross-model review cover late handoffs, ordering and reservation cycles. | Issue records no >15 min non-overlap wait in early dogfood after the change. Adjacent rare urgent handoff remains open. Accepted bench lacks the workflow-changing input. |
| Nov 20 `48eba8db`, `78e2fff1` | `687d1eda` definition trial | Combine main's full check with a trial of a proposed changed check definition, to catch a newly exposed failure before acceptance. | The coverage-change replay guards the original bug. Both trial implementation receipts appear in the late window's ten slowest, at ~96 and ~73 min, with separate order-sensitive holds and rechecks. | Initial function qualified. The receipt timings do not isolate the extra trial cost. `45f49fb7:35d85e04` |
| Nov 20 `a9293be5`, `e8f2f50a` | `687d1eda` park | Hold appropriately evidenced checks that fail only on main's own red tests and record release/re-land evidence. | A model/incident replay exercises the hold. Four switch-on dogfood reds parked no admission. | Live re-land proof remains open. Explicit opt-in remains distinct from the baseline. |
| Nov 20 `5af80fb6`, `028ff58f` | `e62d834b`, `0d8a85a3` | Park during provider-wide failure behind a switch and recognize failures before a check plan binds. | Latest evidence had nine CHECK_NOT_PASSED operations linked to the provider incident, with missing duration. | First provider correction landed. A missing completion webhook can still hide a pre-plan failure, review `539f08e5`. |
| Nov 19, read `06dad130` | G8 `39942bfe` | Re-measure gate time and serving cost in dogfood. | Seven days to Nov 19 11:00: 277 landings, p50/p90 16.0/79.3 min and 2.93 runs/landing; 201 runs missing execution minutes. The shared dev meter had $9.34 list-rate usage in the period. | The ledger lacks entered invoices, and the shared dev number cannot be attributed entirely to dogfood. E3 rematch still unrun. |
| Nov 20 `bdd2c6ac` | `c3c69c57` | Carry a specific race reason across attempt forks. | 105 of 190 rows still lacked a reason in the mixed pre/post-deploy window, 16.9% of known race-waste execution. | Measure the 95% attribution bar after ~15:45 deployment. This alters diagnosis. |
| Nov 20 `a461ac95`, `0abcbf58` | `44f2b109` | Page failed check outcomes with noise tags and static-step evidence. | Broad historical read returned 130 retained diagnostic rows through two pages. | Failure outcomes differ from check starts and cannot recover a full run ledger. |
| Nov 20, owner `4b6d628e` | `4e013cdb` candidate 6 | Settle each main move once for ready carryable landings. | Trace of 23 carry paths split ~23.2 s at p50 into 3.6 s doomed acceptance, 15.6 s recompose/proof, 0.8 s hops and 2.0 s commit. Fixed-timeline p90 sensitivity 52.9 → 42.0 min if half the recorded holds go away. | Owner approved model and bench gates on Nov 20. Neither effect nor new performance was measured in this dossier. |
| Nov 19–20, decision `6ec1f274` and re-measure `50609335` | O5 `a110c2d6`, `ddf43617` | Scope schema/check-entry risk by proven reach. | Post-O1 exposure read and Fable discussion estimate savings. Early broad global-risk loosening and O7/O8 were set aside. | Post-O1 file-level reach estimated 113–1,272 minutes saved over 36 h, with no footprint data. O5 remained proposed. No confirmed gain. |

The [queue model](../../models/landing-queue/README.md#findings-and-counterexamples)
also distinguishes accepted fixes from intentionally failing litmus cases. A
model's pass establishes its safety/liveness property within its assumptions.
It supplies neither a production repeat rate nor a queue latency measurement.

## Direction at similar load

“Recent” compares Phase 7 to Phase 6 using the same commit-hour bins.
“Since October” refers to the exact 2.46/h windows. These are descriptive
comparisons with an identical load denominator and different work and service
mix. A row with incomplete coverage states the direction of the observed
series and whether the underlying metric can be judged.

| Metric | Verdict | Evidence at similar load |
| --- | --- | --- |
| Landings/day and hour | Improving observed throughput | P6's busiest complete week averaged 65.7/day; P7's partial week averaged 84.8/day. At fixed load throughput is held constant. Neither figure measures the queue's maximum capacity. |
| Checks per landing | Improving since October; regressing recently | Project starts fell 5.46 → 2.46 at 2.46/h. Accepted-receipt check links rose in every fixed hourly band from P6 to P7, for example 1.47 → 1.90 at 3–5/h. The incident's 4.30 improved to 2.90 in the later busy window. |
| First-try share | Improving since October; flat to mixed recently | Current classification is 23/59 → 43/59 at 2.46/h. At 3–5/h P6/P7 went 99/199 → 52/115 (50% → 45%) while 8+/h went 127/313 → 79/150 (41% → 53%). |
| Submit-to-main p50 | Improving since October; regressing recently | At 2.46/h, 23.5 → 16.0 min. From P6 to P7 at 3–5 accepts in the hour, 9.7 → 24.9 min. The later busy window's 12.6 min is a recovery relative to November 17's 37.3 min. |
| Submit-to-main p90 | Improving since October; regressing recently | At 2.46/h, 67.8 → 36.0 min. From P6 to P7 at 3–5 accepts in the hour, 30.6 → 82.6 min. Later busy-window p90 52.9 min remains below incident-day 95.8 even at slightly higher average load. |
| Accepted runner minutes/landing | Regressing in the stamped ledger | 20.4 → 86.8 known min per acceptance at 3–5/h. Phase 6 has 68/199 cost stamps in this bin and Phase 7 has 115/115. True cost trend across phases remains unresolved. Full-check execution shrank after O6 in a separate sample. |
| Discarded runner minutes/landing | Regressing in the stamped ledger | 4.6 → 54.2 known min per acceptance at 3–5/h (72/199 vs 114/115 stamps). Much better recent usage coverage, potential shared-run duplication and cancelled-usage repair prevent a clean physical-cost trend. November 19→20 went 84.7 → 30.9 in the ledger at about 5/h. |
| Recomposes/landing | Flat since October; regressing recently | 1.19 → 1.14 at 2.46/h. At 3–5/h, 0.82 → 1.60 from P6 to P7. The late busy read (1.36) improved on November 17 (2.09). |
| Main red count | Regressing among linked audit observations | Linked failed audits rose from 4 to 8 across the P6/P7 blocks despite fewer P7 days. Exact historical red-episode incidence is unknown. The coverage-change incident establishes a real red and attribution defect, separate from short later flake clears. |
| Check wall time | Improving since O6 | Full successful checks came down from 886 to 567 s p50 on the recorded samples. Before this fix November 18–19's last-20 passed checks were slower than October's 9.7 min mean request-to-end after E, which has a different denominator. |

The apparent after-E 1.29-start and 22.4-minute p90 gain disappeared as a
headline across heavier windows, while part of the improvement survived
against the pre-E baseline at equal load. No evidence isolates E from the
other October changes. The clean-disjoint first-check result in the November 6
read (22 of 24 landed on one admission run, mean 9.0 minutes versus about 25
in the older, busier wave) also did not generalize to the November 17
incident. Carry continued to save work: 33 of 121 late-window acceptances
classified as reused after a race. O3 and O4 yielded no verified gain on
bench or dogfood and their trial behaviour was removed. The latest 24-hour
gap was **0.72 main-race rechecks per landing** versus **0.78** in the
previous matched read. Other starts rose by **0.50/landing**. The evidence
cannot divide that increase across fresh admission, retries after red,
provider recovery and audit. `7fe54c7c:93181ea2` · `45f49fb7:35d85e04`.

### Costs inherent in the documented design

- **Main can move while the check runs.** Over a check of length (T), a
  stationary rate of (lambda) main moves/hour gives an expected
  (lambda T) moves with (T) in hours. The after-E sample had **0.70
  acceptances/h** and **9.7 min** mean request-to-end per run, about **0.11**
  moves/check using receipts as a proxy. The matched November 18–19 sample
  had **2.46/h** and **14.8 min** passed-check p50, about **0.61**. The busy
  window had **116 distinct main transitions / 24 h = 4.83/h** and **8.9 min**
  passed-check p50, about **0.72**. An Poisson illustration gives
  about 11%, 46% and 51% probabilities of at least one move. Those are
  illustrative, since the times are different statistics and arrivals bunch.
  In the busy window, **39/75** successful admissions fully inside the
  window overlapped a main commit during their **9.3-minute median**
  submit-to-admit span. **91/121** receipts changed base over the whole
  landing. The two exposures have different clocks. `45f49fb7:35d85e04`.
- **Proof and policy can require new evidence.** A single full-checked tree
  can prove its own state. Different-byte overlap, a text conflict or an
  order-sensitive change can require evidence for the interaction. A prior
  full pass can seed a scoped recheck; absent that basis, the documented
  path checks in full. On 20 code rechecks in the post-O1 read, 14 never tried
  to scope, four fell back, and two selected 83% of roughly 1,262 files.
  Twenty-nine named order-sensitive and nine path-overlap attempts cost
  **2,317.5 known runner-minutes**, 67% of the busy window's recorded
  race-waste execution. Cancellation that destroyed usable evidence and a
  rule that classified a nightly workflow as order-sensitive were distinct
  implementation defects. [Acceptance policies](../pre-queue-checks.md#landing-modes) ·
  `45f49fb7:af537ec0,35d85e04`.
- **Where work is checked changes the cost.** Explicit full admission spends
  work up front to keep red submissions out of the queue. It can later
  require a fresh check of the combined tree. Queue-only can share an exact
  check and avoid an extra audit on that head, but a red cohort can require
  more diagnosis rounds. Carry paths rely on full-main audit coverage; these
  audits consume runner time. Predicted-order work can reuse a check on its
  exact predecessor; a changed predecessor can invalidate that check. The
  30 s serialized settle tail comes from today's per-landing recompose,
  proof and publication path. The measured critical path is mostly
  composition and proof, with about 2 s on the observed commit transaction.
  A lost wake, spurious sync loop or unreachable compose is a separate defect.
  [Pre-queue checks](../pre-queue-checks.md) · `45f49fb7:7970cb99`.

## Bench versus dogfood

| Bench observation | Dogfood observation and reason for the gap |
| --- | --- |
| **N=1:** P6 tuned task median 338 s Forge vs 500 s GitHub, 30/73 billed CI min over ten tasks. | A serial task largely avoids main moving under it. Dogfood spans begin at submission and its check suite, infrastructure and policy differ. A 9–15 min full check alone can exceed a benchmark task's whole time to main. |
| **N=3:** P6 tuned task median 377/538 s and CI 30/81 billed min (Forge/GitHub). The later scripted switch baseline saw 10 starts and 30 billed minutes, within 2–4% wall of accepted N=3 pins. | Runner setup and the count of physical checks moved independently of wall. Earlier Forge N=3 smokes used 1.8/1.9 provider runs per landing, including 0.5/0.6 audit and 0.2 unlanded admissions; 1.1 run IDs per accepted receipt missed this work. One cold-source smoke spent 529 s fetching objects vs 15 s warm. These cells ran one command job, while dogfood has multiple shards and a shared job limit. |
| **N=10:** P6 rerun task median 360/566 s, all ten in 763/1,182 s, CI 24/69 billed min. The later validation pin produced 861/1,112 s and 27/65 billed min. | Queue-only strict on the bench differs from explicit full admission + fast on dogfood. In the same scripted N=10 smoke shape with all switches off, the dogfood policy increased 8→20 checks and 24→61 billed minutes. More audits and second runs can outweigh the clean benchmark savings. The N=10 website figures await the final P7 repeat. |
| **N=10 switch bench:** Accepted-policy pass-to-land p50 about 3 s; current dogfood-policy cells included 2–6 min bunched tails with a ~30 s serial settle gap. None of the three switch-on paths was exercised in a healthy cell. | Dogfood incident p90 pass-to-land 101 min. Long code checks and one head holding many passed followers created a different shape. In the latest dogfood window all ten slowest receipts changed base and eight waited after CI before CHANNEL_CHANGED. A replay can reach this path without retuning the workload. |
| **Failures:** Phase 4 E3 at width four took 989/189 s for the three healthy changes, versus favourable clean-wave observations. The Phase 6 N=16 convoy missed the acceptance bar despite the N=10 success. | Dogfood alternates between mostly green and red-heavy windows: 5/35 and 11/37 decided first checks red in the two latest reads. Admission's simulated CI-cost crossover varied from 15.6% to 28% with width and assumptions. An all-green or path-unreached cell leaves isolation and recovery effects unmeasured. |

Bench **CI minutes** are per-job rounded provider time. The dogfood receipt
series uses command/shard execution minutes. Benchmark **task time to main**
starts at dispatch to the agent; dogfood **submit-to-main** starts at the
recorded successful operation. A bench's N is concurrency rather than
receipts/hour. Source size, provider queueing, warm packs, task voids and
overlap shape affect cross-run results. [B1.5d](b15d-report.md) ·
[P6 baseline](p6-baseline.md) · [P6 results](p6-exit-bench-results.md) · [CI-minute attribution](ci-minute-attribution.md) ·
[Switch bench](queue-stage-bench-2026-11-18.md) · [E3](e3-failing-burst.md).

## Coverage and reproduction

- Early hosted receipts provide submission and commit times, attempt counts
  and visible check IDs. Title, admission and first-check proof fields enter at
  different points. The first successful pre-queue admission stamp in this
  extract is November 5 11:44 UTC, first `firstCheck` November 6 07:53,
  and the first accepted and discarded runner stamps November 10 09:34.
  Earlier project-level runner observations can exist without those receipt
  stamps. The October baseline lacked all 322 shard durations; the broad
  metrics read flagged 815 unstamped runs. In the latest rolling window,
  **71 of 351 runs** lack execution duration, so its **19,930.7 runner-min**
  is a lower bound. `436bd3e0` owns pending vs permanently unknown cancellation
  usage; `6714a1df` owns lost duration across replacement; pre-plan outages
  have their own `0d8a85a3` evidence. No permitted aggregate read allocates all 71.
- First-try classification changed as readers learned about attempts replaced
  at creation, retries after another landing, carried passes and recompositions
  before a check started. Current implementation classifies by Intent and
  stored history, whereas the live counter operates by Lane. Phase 5 records
  include unknowns and the older 5.1 comparison may have used a different
  reader. Nominally identical inputs can reproduce different first-try counts.
  Full-check count is the historical label of 5.6, which includes scoped starts.
  Attempt elapsed minutes can overlap and differ from execution and billed
  minutes. Project 5.6 includes audits, while receipt discarded cost does not
  cover all earlier failed or withdrawn submissions.
- Follow-audit verdicts changed to distinguish culprit, coverage mover and
  range membership in Item `687d1eda`. This extract has no stamped
  `mainRedHolds` rows. A held-after-check record requires at least one minute
  and is only evidence for that attempt. The bench's held-only post-pass
  measure, the acceptance CI-end-to-commit measure, and rung 1's **first**
  passed check-to-commit metric use different clocks. The most recent budget
  omits people/dependency holds and needs 20 eligible timestamps. Budget
  ratchets should be read with their effective date and effect on alerts.
- The failure read returned 130 retained rows and a terminal cursor after
  two pages. It is a bounded diagnostic of operation outcomes. It cannot
  reconstruct historical launches, duration, failures that were not recorded
  on that surface, or exact cost by cause. Six project metrics streams are read in pages by the CLI. The receipt traversal reported
  **26.2 MB** read; billed metrics I/O and calls were unavailable. A separate
  last-day metrics read took **33.7 s** and peaked at **176 MiB** CLI RSS.
- Inputs and provenance are summarized in the [raw series](queue-history.json).
  It retains coverage counts, published and recomputed windows, each calendar
  day's aggregates and a compact list of hourly acceptance/transition counts.
  No raw operator text, prompts, check errors or person identifiers are
  included.

Use `nforge agent ROOT landings` with `from`, `to`, and `limit:30`, then
repeat the same window with `nextCursor` until null. This capture used
`2026-10-01` through `2026-11-21`, then applied the stated cutoff to
`committedAt`. Run `nforge metrics ROOT --from 2026-10-01 --to 2026-11-21
--json` once for dated metric totals, and repeat for `2026-11-20` through
`2026-11-20T21:45:00Z` to pin the partial day. Keep the query's UTC
end-exclusive boundaries and CLI context fixed. `nforge metrics ROOT
--failures --checks --limit 100` takes the same date parameters and an
optional continuation. Historical figures and exact rolling windows are
sourced above, with a separate uniform classification for the JSON series.
