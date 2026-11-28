# Phase 7 close benchmark results

Ten agents reached main 35% sooner, on 59% fewer CI minutes. These are median savings across paired Forge and GitHub runs from 27–28 November 2026. Six scored N=10 pairs landed all ten tasks in both arms. The ranges below show how much the savings varied across eligible pairs.

| Metric | Median saving | Range | Pairs |
| --- | ---: | ---: | ---: |
| Wall time to all ten landings | 34.5% | 30.0–41.6% | 5 |
| Median task time to main | 28.3% | 19.9–36.9% | 6 |
| Billed CI minutes | 59.2% | 56.1–63.9% | 5 |
| Cached input tokens | 37.7% | 28.8–42.8% | 5 |

The a13 agent-runtime delay excludes that pair from wall time only. The a10 post-landing re-check excludes that pair from CI and cached input only. Both count for median task time.

## Method and comparison with Phase 6

The paired runs used the same ten tasks on one repository and reused the [registered Phase 6 bench method](p6-exit-bench-plan.md). The scored cohort used Codex 0.166.0 and gpt-6.1-sol at high reasoning effort. Each pair's saving is `(GitHub − Forge) / GitHub`. We take the median of those savings for each metric. Wall and task time use first acceptance. CI uses provider-billed minutes, and cached input counts tokens reported as cached.

| Metric | Phase 6 public N=10 figures, Forge / GitHub | Phase 7 pooled saving |
| --- | --- | ---: |
| Wall time | 12:43 / 19:42 (35% lower) | 34.5% |
| Median task time to main | 6:00 / 9:26 (36% lower) | 28.3% |
| Billed CI minutes | 24 / 69 (65% lower) | 59.2% |
| Cached input tokens | 19.1M / 37.6M (49% lower) | 37.7% |

The [Phase 6 exit report](p6-exit-bench-results.md) used three repetitions per arm and a separately registered N=10 rerun. Its absolute figures remain historical. The later [Phase 6 release validation](p6-release-validation.md) measured 861 / 1,112 s wall and 27 / 65 billed CI minutes. Phase 7 measured the N=10 scored workload and an N=8 overlap workload. The public N=1/3/5 comparisons remain Phase 6 measurements. This close bench describes outcomes on one repository with these workload and release pins.

## Queue stage and claw-back

The [queue-switch bench](queue-stage-bench-2026-11-18.md) investigated passed landings held behind a parked or rechecking predecessor. It found a 2–6 min tail when landings recomposed and settled in series after a main move. The healthy comparison cells seldom entered the paths the switches changed. N1 shipped on incident replay and unit-test evidence. O3 and O4 were removed following regressions in targeted replays. The [queue history](queue-history.md) records the measured gains, trade-offs and evidence gaps.

| Claw-back | Result |
| --- | --- |
| False sync advice | The scripted burst hit the false loop on 3 of 10 landings, adding about 54 s at p50 and 67 s at p90 on that path. The early-resolution fix landed. A matched post-fix timing for this path is unavailable. |
| Local preflight | Changed-path static checks and reuse of the base comparison cut warm static p50 from 16.3 s to 3.8 s over three runs on a change limited to `src/`. The first cold pass was 13.2 s. The post-fix landing-check comparison below measures the remaining failure rate separately. |
| Burst waits and repeat checks | The scheduler-only model for settling each main move once saved an estimated 0.8 s at p90. It stayed offline. The owner kept the existing queue engine and adopted grouping for compatible, already-passed work waiting on CI capacity and full rechecks under saturation. The recorded bench-30 replay used 75.7 calls per landing both ways and reduced p90 from 52.0/50.0/45.9 to 38.3/38.1/36.9 min across three seeds. |
| CI cost and attribution | Forge corrected discarded runner-minute accounting, removed its duplicate mirror-triggered verification, added mirror and audit cadence, and recorded dispatch causes for hosted checks. Per-test input closure reached 6.65% conservative worker-minute reuse against a 30% gate and was dropped. The owner deferred the cost-first queue engine. |
| Convex cost and start contention | The matched Phase 6 release cell metered $4.84 per 1,000 task landings. A source index refresh loop pushed a5/a6 to $5.51/$6.56. Fixing the loop brought the final a12/a13 cells to $3.61/$3.60. The earlier Phase 6 dogfood baseline ($1.688095 per 1,000) has a different workload and billing basis. Failed starts fell from 9 in each of a7/a9 to 0 in each of a10–a13 after the start-path fix. The owner accepted zero failed starts for close. A12/a13 still had 15 optimistic concurrency retries each, tracked in Item `4d690674`. |

The [offline queue-shape replay](../../models/queue-shapes/README.md) covers slow checks, sustained traffic, weak test selection and a large monorepo. Its slow-CI and high-traffic cases exposed saturation with near-full worker occupancy. The [queue model](../../models/landing-queue/README.md) and the live bench answer different questions about performance.

## Landing checks after the preflight fixes

The dogfood re-read uses the first 100 accepted landings after receipt `33d797d1` (#31943, 23 Nov 2026 at 20:57:06 UTC), ending at `6cbc06ed` on 24 Nov at 21:07:14 UTC. Using the sweep's `nforge metrics` check-failed-attempt count, a submission that fails twice counts twice.

| Window | Check-failed attempts per 100 accepted landings | Interpretation |
| --- | ---: | --- |
| Earlier baseline | 34.2 | Historical rate from the original sweep |
| Earlier comparison | 37.0 | The follow-up found 36 of 38 attempts preceded the relevant preflight fix. This window cannot measure the effect of that fix. |
| First 100 landings after the final preflight fix | 20.0 | 20 failed attempts and 1,693.7 recorded runner-minutes. The target of at most 13 was missed. |

The matching failure diagnostics name 15 test failures with a real tag, three test budget failures, one static-step failure and one runner failure recorded as `CHECK_FAILED`. A separate `CHECK_NOT_PASSED` runner record is outside that numerator. The retained diagnostics identify tests and steps. Historical local selection and cutoff evidence is incomplete, so a failure cannot be assigned to a particular preflight tier from those diagnostics alone.

The separate selector cohort began after receipt `ef718e17` (#31936, 23 Nov at 19:57:14 UTC) and its first 30 accepted landings ended at `fee3baca` on 24 Nov at 04:18:17 UTC. In that cohort, 29 of 30 landings used a full check, against a target of at most 10 of 30 and an earlier sample of 22 of 30. The receipts carried 27 full stamps. Of the three unstamped checks, two run summaries confirmed full union gates and one selected a scoped recheck. One full check dispatched before the anchor and landed after it. Replacing that landing with the next post-anchor check leaves the share at 29 of 30. Median recorded runner time for the original 30 was 94.7 minutes. These are receipt runner-minutes, measured separately from the close bench's billed CI minutes.

The post-fix windows follow the close sweep in comment `7806fa42` on Item `0a9df3cd`. The earlier cause analysis is comment `9bdd01f0` on Item `13ea93bf`.

## Final release and overlap

On final accepted main #32227 (State `e58f8257`, receipt `8bc7ff7b`), a12 and a13 each landed 10/10 in both arms with zero failed Forge starts. Final-release targets were 673.499 s wall and 27 billed CI minutes, set by adding the earlier a7–a9 spread to a11's clean result. Both billed 29 Forge CI minutes. In a12 the queue formed a two-task batch and gave one member a later check after a real file conflict. In a13 runnable tasks arrived far enough apart to need separate checks. Each Forge arm used ten successful solo jobs.

A12 passed the 673.499 s wall gate at 627.397 s. A13 missed it at 1,129.937 s. In a13 the agent runtime took 358.144 s to collect a completed command's output. The agent followed the unchanged stale-work recovery hint 3.852 s after delivery. The lead applied the recorded harness exclusion to a13 wall only. Its raw wall was 24.7% longer on Forge than on GitHub. GitHub's median task time was lower in every overnight pair than in either daytime pair, and all of those task times count. These samples cannot isolate a time-of-day effect.

A10 contributes to wall and median task time only. A post-landing re-check added four billed minutes and at least 6.488M cached tokens. The timing measures use first acceptance, before that re-check. The fix prevented duplicate no-op checks. The pool also excludes a8 because its Forge arm failed the filesystem event gate before dispatch.

The publication cohort starts at a7 on #32217 after the source-seed fix. The fixed scope retains a7 and a9 on that release, a10 and a11 on #32224 and a12 and a13 on #32227. Scored a2/a3 and a5/a6 were taken on earlier P7 pins before the source-seed fix. The earlier a5 Forge arm had one timing flag. Its observed median was 352.223 s as retained in the ledger. The nine eligible timings used in that arm's report had a median of 319.887 s (bench comment `b7115f73`).

On #32224, valid N=8 overlap a6 landed all eight tasks in each arm. Forge Auto and Offer both scored 8/8 strict, billed 11 CI minutes each, and took 393.447 s and 461.832 s respectively. Neither had a pipeline-cascade restart or corrective replacement wait. GitHub scored 1/8 strict, took 2,611.934 s and billed 130 minutes. The interrupted and void overlap arms remain in the ledger, including the slow Auto arm on #32217 that prompted the queue diagnosis.

Source records are Forge Items `0a9df3cd` and `4e013cdb`. The #32224 report is `0d025a95`. The #32227 report `ccffbffc` precedes diagnosis `e6f711f3` and final pool decision `8ffb59c3`, reflected here.

## Run ledger

Two scripted N=10 main-move diagnostics also ran on 27 Nov. Both landed 10/10 with no voids and zero model tokens. These matched Forge-only diagnostics are outside the paired pool (report `5fbd0a55`).

| Run ID | Pin | UTC start | Wall s | Median task s | CI min | Convex executions / estimated USD |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| forge-n10-r1-main-move-dry-a1-20261127T021638 | Fix State `2a6ff21f` | 2026-11-27T02:20:39Z | 615.744 | 377.543 | 30 | 2,300 / $0.05533 |
| forge-n10-r1-main-move-dry-a1-20261127T030922 | Baseline #32196 | 2026-11-27T03:13:09Z | 539.670 | 367.929 | 29 | 2,269 / $0.05061 |

The ledger covers every recorded P7 close-bench arm from dry a10 and scored a2 onward. The Nov 13–15 dry a1–a9, N=10 a1 and overlap a1/a2 belong to the P6 programme. The release column is the pinned Forge release. UTC start uses the measured cell start when available and the run ID’s setup timestamp for a refusal. A dash marks an unavailable observation, including GitHub’s lack of Forge start telemetry. Partial batch metrics are retained on completed arms. Time of day carries no exclusion. Dry qualification, overlap, and the earlier scored pairs serve separate purposes and are outside the N=10 publication pool.

| Run ID | Release | UTC start | Arm | Landed | Wall s | Median task s | CI min | Cached M | Failed starts | Validity | Reason for void or exclusion |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| forge-n3-r1-dry-a10-20261126T215331 | #32196 | 2026-11-26T21:57:57Z | Forge | 10 | 800.541 | 203.279 | 27 | — | 0 | Valid dry | Scripted qualification. |
| github-n3-r1-dry-a10-20261126T215331 | #32196 | 2026-11-26T21:57:58Z | GitHub | 10 | 1466.962 | 315.920 | 74 | — | — | Valid dry | Scripted qualification. |
| github-n10-r1-a2-20261126T223541 | #32196 | 2026-11-26T22:36:25Z | GitHub | 10 | 1158.044 | 424.024 | 73 | 34.092 | — | Valid scored | Earlier scored pair outside the fixed final pool. |
| forge-n10-r1-a2-20261126T230334 | #32196 | 2026-11-26T23:07:53Z | Forge | 10 | 759.021 | 358.514 | 29 | 24.171 | 5 | Valid scored | Earlier scored pair outside the fixed final pool. |
| github-n10-r1-a3-20261126T232755 | #32196 | 2026-11-26T23:28:39Z | GitHub | 10 | 888.571 | 429.318 | 67 | 32.759 | — | Valid scored | Earlier scored pair outside the fixed final pool. |
| forge-n10-r1-a3-20261126T235034 | #32196 | 2026-11-26T23:54:59Z | Forge | 10 | 710.564 | 356.786 | 27 | 23.809 | 3 | Valid scored | Earlier scored pair outside the fixed final pool. |
| github-n10-r1-a4-20261127T035016 | #32208 | 2026-11-27T03:50:16Z | GitHub | 0 | — | — | — | — | — | Void before dispatch | Exact harness qualification was missing. |
| forge-n10-r1-a4-20261127T035022 | #32208 | 2026-11-27T03:50:22Z | Forge | 0 | — | — | — | — | — | Void before dispatch | Exact harness qualification was missing. |
| forge-n3-r1-dry-a11-20261127T035054 | #32208 | 2026-11-27T03:55:09Z | Forge | 10 | 848.635 | 207.014 | 27 | — | 0 | Valid dry | Scripted qualification. |
| github-n3-r1-dry-a11-20261127T035054 | #32208 | 2026-11-27T03:55:11Z | GitHub | 10 | 1444.536 | 295.206 | 70 | — | — | Valid dry | Scripted qualification. |
| forge-n3-r1-dry-a12-20261127T043641 | #32210 | 2026-11-27T04:40:43Z | Forge | 10 | 848.774 | 197.728 | 27 | — | 1 | Valid dry | Scripted qualification. |
| github-n3-r1-dry-a12-20261127T043641 | #32210 | 2026-11-27T04:40:44Z | GitHub | 10 | 1482.670 | 301.163 | 65 | — | — | Valid dry | Scripted qualification. |
| github-n10-r1-a5-20261127T051646 | #32210 | 2026-11-27T05:17:31Z | GitHub | 10 | 892.676 | 472.221 | 68 | 36.473 | — | Valid scored | Earlier scored pair outside the fixed final pool. |
| forge-n10-r1-a5-20261127T054042 | #32210 | 2026-11-27T05:45:00Z | Forge | 10 | 705.495 | 352.223 | 26 | 22.202 | 4 | Valid scored | Earlier scored pair outside the fixed final pool. |
| github-n10-r1-a6-20261127T060341 | #32210 | 2026-11-27T06:04:28Z | GitHub | 10 | 1312.918 | 454.428 | 70 | 36.422 | — | Valid scored | Earlier scored pair outside the fixed final pool. |
| forge-n10-r1-a6-20261127T063350 | #32210 | 2026-11-27T06:37:38Z | Forge | 10 | 1064.948 | 328.375 | 30 | 21.563 | 4 | Valid scored | Earlier scored pair outside the fixed final pool. |
| github-overlap-n8-r1-a3-20261127T070339 | #32210 | 2026-11-27T07:03:39Z | GitHub | 3 | — | 898.346 | — | — | — | Interrupted | Operator stopped the GitHub arm while fixes were pending. Three landings appear in six retained task records. |
| overlap-n8-r1-a3 (arm not dispatched) | #32210 | — | Forge Auto | — | — | — | — | — | — | Unrun | Operator stopped the overlap batch before this arm. |
| overlap-n8-r1-a3 (arm not dispatched) | #32210 | — | Forge Offer | — | — | — | — | — | — | Unrun | Operator stopped the overlap batch before this arm. |
| forge-n3-r1-dry-a13-20261127T090737 | #32217 | 2026-11-27T09:12:16Z | Forge | 10 | 894.067 | 220.881 | 30 | — | 0 | Valid dry | Scripted qualification. |
| github-n3-r1-dry-a13-20261127T090737 | #32217 | 2026-11-27T09:12:17Z | GitHub | 10 | 1516.603 | 303.928 | 76 | — | — | Valid dry | Scripted qualification. |
| github-n10-r1-a7-20261127T095140 | #32217 | 2026-11-27T09:52:26Z | GitHub | 10 | 1108.749 | 546.279 | 65 | 32.818 | — | Valid scored | — |
| forge-n10-r1-a7-20261127T101925 | #32217 | 2026-11-27T10:23:03Z | Forge | 10 | 742.060 | 379.709 | 27 | 19.593 | 9 | Valid scored | — |
| github-n10-r1-a8-20261127T104304 | #32217 | 2026-11-27T10:43:49Z | GitHub | 10 | 1003.031 | 626.663 | 73 | 39.673 | — | Completed arm; batch void | Paired arm refused at the filesystem gate. Observational metrics retained. |
| forge-n10-r1-a8-20261127T110856 | #32217 | 2026-11-27T11:08:56Z | Forge | 0 | — | — | — | — | — | Void before dispatch | Filesystem event gate, 2/3 missed events. |
| github-n10-r1-a9-20261127T111628 | #32217 | 2026-11-27T11:17:17Z | GitHub | 10 | 1111.400 | 540.902 | 68 | 36.817 | — | Valid scored | — |
| forge-n10-r1-a9-20261127T114344 | #32217 | 2026-11-27T11:48:23Z | Forge | 10 | 649.474 | 341.166 | 26 | 21.055 | 9 | Valid scored | — |
| github-overlap-n8-r1-a4-20261127T120656 | #32217 | 2026-11-27T12:07:47Z | GitHub | 6 | — | 1747.846 | 93 | 34.445 | — | Completed arm; batch void | Paired arm refused at the filesystem gate. Observational metrics retained. |
| forge-offer-overlap-n8-r1-a4-20261127T125503 | #32217 | 2026-11-27T12:55:03Z | Forge Offer | 0 | — | — | — | — | — | Void before dispatch | Filesystem event gate, 3/3 missed events. |
| forge-auto-overlap-n8-r1-a4-20261127T125511 | #32217 | 2026-11-27T12:59:34Z | Forge Auto | 8 | 3335.590 | 2711.902 | 39 | 52.541 | 0 | Completed arm; batch void | Paired arm refused at the filesystem gate. Observational metrics retained. |
| github-overlap-n8-r1-a5-20261127T140234 | #32217 | 2026-11-27T14:03:19Z | GitHub | 6 | — | 1683.595 | 71 | 23.794 | — | Completed arm; batch void | Paired arm refused at the filesystem gate. Observational metrics retained. |
| forge-offer-overlap-n8-r1-a5-20261127T144936 | #32217 | 2026-11-27T14:54:11Z | Forge Offer | 8 | 511.849 | 332.863 | 12 | 8.028 | 7 | Completed arm; batch void | Paired arm refused at the filesystem gate. Observational metrics retained. |
| forge-auto-overlap-n8-r1-a5-20261127T151625 | #32217 | 2026-11-27T15:16:25Z | Forge Auto | 0 | — | — | — | — | — | Void before dispatch | Filesystem event gate, 3/3 missed events. |
| forge-n3-r1-dry-a14-20261127T174221 | #32224 | 2026-11-27T17:42:21Z | Forge | 0 | — | — | — | — | — | Void before dispatch | Filesystem event gate, 3/3 missed events. |
| github-n3-r1-dry-a14-20261127T174221 | #32224 | 2026-11-27T17:42:21Z | GitHub | 0 | — | — | — | — | — | Void before dispatch | Filesystem event gate, 3/3 missed events. |
| forge-n3-r1-dry-a15-20261127T180845 | #32224 | 2026-11-27T18:08:45Z | Forge | 0 | — | — | — | — | — | Void before dispatch | Filesystem event gate, 2/3 missed events. |
| github-n3-r1-dry-a15-20261127T180845 | #32224 | 2026-11-27T18:08:45Z | GitHub | 0 | — | — | — | — | — | Void before dispatch | Filesystem event gate, 2/3 missed events. |
| forge-n3-r1-dry-a16-20261127T184514 | #32224 | 2026-11-27T18:49:29Z | Forge | 10 | 862.568 | 212.485 | 28 | — | 0 | Valid dry | Scripted qualification. |
| github-n3-r1-dry-a16-20261127T184514 | #32224 | 2026-11-27T18:49:30Z | GitHub | 10 | 1642.075 | 325.434 | 69 | — | — | Valid dry | Scripted qualification. |
| github-n10-r1-a10-20261127T192818 | #32224 | 2026-11-27T19:29:10Z | GitHub | 10 | 929.780 | 429.720 | 63 | 33.434 | — | Valid scored | CI and cached input excluded for the post-landing re-check (f081111a). Wall and median use first acceptance. |
| forge-n10-r1-a10-20261127T195226 | #32224 | 2026-11-27T19:56:57Z | Forge | 10 | 608.708 | 344.048 | 30 | 25.236 | 0 | Valid scored | CI and cached input excluded for the post-landing re-check (f081111a). Wall and median use first acceptance. |
| github-n10-r1-a11-20261127T202238 | #32224 | 2026-11-27T20:23:23Z | GitHub | 10 | 916.797 | 492.810 | 72 | 31.118 | — | Valid scored | — |
| forge-n10-r1-a11-20261127T204722 | #32224 | 2026-11-27T20:52:02Z | Forge | 10 | 580.913 | 315.874 | 26 | 22.165 | 0 | Valid scored | — |
| github-overlap-n8-r1-a6-20261127T210813 | #32224 | 2026-11-27T21:09:00Z | GitHub | 8 | 2611.934 | 1515.694 | 130 | 38.142 | — | Valid overlap | Independent of the paired N=10 pool. |
| forge-offer-overlap-n8-r1-a6-20261127T215711 | #32224 | 2026-11-27T22:01:29Z | Forge Offer | 8 | 461.832 | 355.112 | 11 | 8.629 | 0 | Valid overlap | Independent of the paired N=10 pool. |
| forge-auto-overlap-n8-r1-a6-20261127T221029 | #32224 | 2026-11-27T22:15:00Z | Forge Auto | 8 | 393.447 | 312.909 | 11 | 7.762 | 0 | Valid overlap | Independent of the paired N=10 pool. |
| forge-n3-r1-dry-a17-20261128T014818 | #32227 | 2026-11-28T01:52:31Z | Forge | 10 | 834.971 | 209.518 | 30 | — | 0 | Valid dry | Scripted qualification. |
| github-n3-r1-dry-a17-20261128T014818 | #32227 | 2026-11-28T01:52:33Z | GitHub | 10 | 1561.320 | 298.765 | 72 | — | — | Valid dry | Scripted qualification. |
| github-n10-r1-a12-20261128T022958 | #32227 | 2026-11-28T02:30:43Z | GitHub | 10 | 896.774 | 428.801 | 66 | 33.781 | — | Valid scored | — |
| forge-n10-r1-a12-20261128T025303 | #32227 | 2026-11-28T02:57:19Z | Forge | 10 | 627.397 | 336.886 | 29 | 21.041 | 0 | Valid scored | CI gate miss; valid paired data remain in the pool. |
| github-n10-r1-a13-20261128T031452 | #32227 | 2026-11-28T03:15:37Z | GitHub | 10 | 906.263 | 430.413 | 71 | 30.864 | — | Valid scored | Pair excluded from wall only. The Forge agent runtime delivered the command result 358 s after exit. |
| forge-n10-r1-a13-20261128T033916 | #32227 | 2026-11-28T03:43:16Z | Forge | 10 | 1129.937 | 317.910 | 29 | 21.673 | 0 | Valid scored | Wall only excluded. The Forge agent runtime delivered the command result 358 s after exit. The other metrics keep this pair. |
