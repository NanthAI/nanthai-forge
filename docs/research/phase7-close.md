# Phase 7 close

Phase 7 rebuilt Forge's public site and signed-in app, then measured the rebuilt product on the close benchmark and in dogfood. The [Phase 7 plan](../phase7-plan.md) gives the delivery order. Forge planning retains the acceptance evidence and owner decisions. [Phase 8](../roadmap.md#phase-8-public-beta-planned) owns beta onboarding, permissions, workflows and production.

## Delivered

The public Threads page is static and makes zero Convex calls. The signed-in app uses React 19, React Aria Components and the shared [design system](../../DESIGN.md). The rebuilt shell brings Lanes, Needs me, Plan, Code and account screens into the same navigation and uses one bounded, event-driven read for the live Lane line. The design system replaces screen-local patterns and styles. Convex Auth replaced the previous sign-in provider in development. The CLI/MCP weight guard and regression ladder make startup, package weight, call counts and landing evidence part of verification. [Framework and sign-in decisions](../decisions.md#2026-11-16-sign-in-spike-verdict-convex-auth-v2-item-de67c77d), [Phase 7 plan](../phase7-plan.md).

## Exit criteria and disposition

| Initiative line | Close evidence or disposition |
| --- | --- |
| `28591eeb` · Site and design | The Threads page `1df5e506`, site pass `6beca32b`, Now view `9e748e41), web board `08d57362` and React key fix `f9309eec` have closed evidence. The Fable direction, design rules, shared base and shell are recorded on `00201e13`, `f86cfa49`, `6ebb58ab` and `84125787`. The built-screen five-second test is on `6ebb58ab` (comment `44bdf722`). Warm first highlighted output measured 829 ms p50 and 1,381 ms p95, **missing the 1 s p95 budget**. Phase 8 `4bc460aa` owns Lane changes latency. The remaining diff and highlighter work `22fa2a33` and dependency graph `d35431d8` moved to Phase 9. [Web diff measurement](web-diff-path.md), [speed budgets](../agents/speed-budgets.md). |
| `28591eeb` · Planning on the web | Web Plan, its follow-up, Initiative progress and rich discussions have closed evidence on `d3357f40`, `f0d0fdd6`, `b7a0dff1` and `9a3d6f5f`. The Plan groups completed, in-progress and remaining Items, with the individual acceptance evidence on the board. [Plan guide](../guides/plan.md). |
| `28591eeb` · Story and launch | The close benchmark and public wording landed in receipt `90757726` (#32231), with owner-delegated sign-off on `4e013cdb`. The older hero and tooling Items `e622411b` and `dd078934` are abandoned. Visual signature `ecdf473c` and LLM discoverability `00c3f715` are in Phase 8. Production, publication and outside access remain owner decisions. [Public benchmark wording](../why-forge.md), [results](p7-close-bench-results.md). |
| `28591eeb` · Work carried from Phase 6 | Lane undo `e7812d8f`, failure diagnostics `2c420916`, landing defaults `f9a35757` and symbol-level overlap `3629cf24` are closed. The [Phase 7 plan](../phase7-plan.md) and the engineering line below identify the carried verification work. The 200-landing billed-cost recheck and remaining archival or scheduled checks are tracked under `702e6d99`. |
| `28591eeb` · Early work and Hearth | The approved build index and run order are in comments `3ee28029` and `e0404ba0`. Session pushes `11ba7bb9`, overlap at save `f4fa7b76`, and the orchestrator feed `f65d8024` are closed. Hearth's mark, top bar and icons are closed on `1a37307f`, `641d887b` and `593b1ef2`. Preview deployments `bbedd496` and the remaining Hearth slices `1c49f597`, `38e85188` and `bf67494d` moved to Phase 9 in the re-bucket. |
| `28591eeb` · Dated and volume rechecks | All eight named flake Items are closed, including the checkout-stat fixture `d1ede0e3` under Phase 6. Mirror retry `adff6f58` has replay evidence, with the next live 422 proof on `702e6d99`. That Phase 8 Item also owns the 200-landing billed comparison. Earlier speed and cost lines are recorded on `10b0a94b`, `a7de3a93`, `7f085ec9`, `ee7ad4d8`, `8618024c`, `ac5200f5`, `65534f20`, `0bce207f` and `768115f9`. Overlap verification moved from `5471e31c` to `411727ba`. The owner dropped the overtaking prototype on `7fe54c7c` (comment `039c8032`). Shard-tail measurements remain in Phase 9 on `0ea17a29`. |
| `28591eeb` · Carried hardening and operating rules | The Phase 6 hardening follow-up `c30c06ae` was verified on main #31265 (receipt `cf757b09`). Remaining budget gaps are in Phase 8 on `c7e85cd7`. The idle evidence below records zero tab-driven Convex calls. The owner retains approval for release and outside use. |
| `5a141b20` · Rebuilt screens, public page, invitations, review and landing flows, sealed secrets | The C1/C2/C3 board had 127 closed Items, one abandoned Item and one in-flight Item at close inventory. Closed deliveries include the public page `1df5e506`, invitation email `c6629fda`, review findings `5dda91bc`, the land-it recipe `9d1b6974`, and CI Secret Objects `f3663cbb`. Screen review and acceptance sit on the individual Items. The fresh docs-only agent scorecard `a0cf8c22` (comment `59aaf96d`, main #32230) completed 6/6 journeys in 67 model turns with one recovered CLI error. Owner device checks, including native Safari, phone touch and VoiceOver, are in Phase 8 on `5e67eed6`. The titles follow-up appears below. |
| `d924336c` · Engineering, carried fixes, security follow-ups and sign-in provider removal | All 103 Items in the Initiative were closed. Acceptance records include preflight selection `537e73d9`, slow source-action attribution `e3082c24`, metrics context `d824900c`, and bounded I/O and placement `411727ba`. The Convex Auth move followed the passing spike on `de67c77d` and its pre-removal security review. The single verified manifest and source-only sync gap is in Phase 8 on `e7e35328`. [Sign-in verdict](../decisions.md#2026-11-16-sign-in-spike-verdict-convex-auth-v2-item-de67c77d), [data placement](../data-placement.md). |
| `3153d505` · Close benchmark and recovery | `0a9df3cd` records six paired N=10 runs and the valid N=8 overlap arms, including voids and the final-release gate misses. Across 120 N=10 task records, Forge/GitHub median recovery turns were **0/5**, down from **13/7** in Phase 6 (comment `12074aa0`). All 120 tasks landed. Recovery evidence was folded into the bench from `7d0ccd72`. Cached input rose against the Phase 6 Forge figure, and Phase 8 Item `2880f68f` owns that investigation and the regression-ladder recheck. |
| `3153d505` · Billed serving cost | Metered Convex cost on the matched Phase 6 release cell was **$4.84 per 1,000 task landings**, compared with **$3.61/$3.60** on final cells a12/a13 after the index-refresh fix. These cells have their own workload and billing basis. The comparable 200-landing dashboard read against the **$1.68/1,000 Professional marginal** and **$4.20/1,000 full-list** references moved from `686ecdde` to Phase 8 `702e6d99`. It remains open, including the split by landing, web and background traffic. |
| `3153d505` · Whole-app security review | The owner chose a read-only Gemini 4 Neon review for Phase 7. The ledger on `d05013f6` (comment `ff7dfa0e`) records 20 findings, 0 critical, 4 high, 10 medium and 6 low, and their dispositions. The high and medium fixes landed, with a residual risk recorded by the lead. Deferred low findings and the Mythos review are tracked under Phase 8 `a31ea521`. |
| `3153d505` · Close document | This document records the four Initiative dispositions, the published results, the growth snapshot and the retained idle measurements. The landing and pulled-main evidence belong on `d05013f6`. |

## Final benchmark and dogfood targets

The [Phase 7 close results](p7-close-bench-results.md) record all 52 arm entries, including voids and exclusions. Six valid paired runs each landed all ten tasks on both Forge and GitHub. The comparison uses median savings across eligible pairs on one repository.

| N=10 measure | Median saving | Range | Pairs |
| --- | ---: | ---: | ---: |
| Wall time to all ten landings | 34.5% | 30.0–41.6% | 5 |
| Median task time to main | 28.3% | 19.9–36.9% | 6 |
| Billed CI minutes | 59.2% | 56.1–63.9% | 5 |
| Cached input tokens | 37.7% | 28.8–42.8% | 5 |

On the final release (#32227), both Forge runs had zero failed starts and billed **29 CI minutes**, above the **27-minute** gate. A12 took **627.397 s**, within the **673.499 s** wall gate. A13 took **1,129.937 s** including a **358.144 s** agent-runtime delivery delay, so the lead excluded that pair from pooled wall time only. A10 remains in wall and task time, with CI and cached input excluded for the extra post-landing recheck. Across the eligible pairs, Forge's medians were **339.026 s** per task, **627.397 s** wall, **27** billed CI minutes and **21.055M** cached input tokens. The Phase 6 exit values were **359.633 s**, **762.705 s**, **24** and **19.145M**, respectively. Phase 6 release validation also billed **27** Forge CI minutes. [Exit comparison](p7-close-bench-results.md#method-and-comparison-with-phase-6), [final-release evidence](p7-close-bench-results.md#final-release-and-overlap).

The valid N=8 overlap run on #32224 landed all eight tasks in each arm. Forge Auto and Offer each scored **8/8 strict**, used **11** billed CI minutes, and took **393.447 s** and **461.832 s** respectively. GitHub scored **1/8 strict**, used **130** minutes and took **2,611.934 s**. [Overlap evidence](p7-close-bench-results.md#final-release-and-overlap).

| Dogfood target | Result | Phase 8 |
| --- | --- | --- |
| At most 13 check-failed attempts per 100 accepted landings | **20 per 100 (missed)** in the first 100 accepted landings after `33d797d1`. Fifteen of the 20 were real test failures. | `3f68ab0a` already owns this target and its corrective follow-up. |
| At most 10 full checks per 30 accepted landings | **29 of 30 (missed)** after `ef718e17`. Median recorded runner time was **94.7 min**. | `3f68ab0a` also owns this target and its follow-up. |

The dogfood windows count failed attempts and full-suite share, respectively. The separate speed-budget read on `ab9766f3` counted **31 attempts over 20 accepted landings**, or **1.55 per landing** against a **4.00** budget (comment `fc336b17`). [Post-fix dogfood windows](p7-close-bench-results.md#landing-checks-after-the-preflight-fixes).

## Growth at close

`node scripts/check-growth.mjs --print --machines` on the close Lane base at main #32231 reported:

| Surface | Close | Guard baseline | Guard start |
| --- | ---: | ---: | ---: |
| Convex tables | 213 | 213 | 181 |
| Public error codes | 491 | 491 | 501 |
| Agent actions | 69 | 69 | 88 |
| CLI commands | 44 | 44 | 53 |
| Glossary terms | 26 | 26 | 34 |
| Machine dependencies | 0 | 0 | 0 |
| Unreferenced exports | 5 | 5 | 22 |

The six guarded hosted paths are landing acceptance, dogfood checks, GitHub mirror, dev deploys, release signing and weekly backup. This close adds one evidence document and its package entry. The guard-start column is the tool's recorded starting reference.

## Idle capture

The retained dev capture on `18af654d` (comments `6d74519b` and `1a6fc279`, tool receipt `6a816706`) opened a signed-in tab on an empty scratch project on 23 November at 21:02 UTC. The tool counted project-attributed successful Convex executions and database usage from the provider log, with a 30-second settle before the idle window.

| Window | Convex executions | DB bytes | Documents read | Writes |
| --- | ---: | ---: | ---: | ---: |
| Opening burst | 10 | 12,445 | 31 | 0 |
| Open and idle for 30 minutes | **0** | **0** | **0** | **0** |

The opening burst verifies attribution to the project. The idle window predates the final screen landings, had no stage changes and covers functions that report project attribution. A separate ten-minute Plan/Item observation on `411727ba` (comment `43748e07`) recorded **0 new calls from idle tabs** and 26 server-driven pushes during project activity. The captures establish the tab result for those windows. Deployment-wide work can still run from earlier writes, as recorded for journal maintenance in the [Phase 6 capture](../phase6-close.md#idle-capture) and the follow-up on `b149b16b`. This close reuses the recorded evidence.

## Open Phase 7 Items at close inventory

The inventory followed all eight planning pages across the four Initiatives. Of the 461 Items, 449 were closed, 10 abandoned and two in progress. The table is a close-time snapshot for the lead.

| Initiative | Pages | Closed | Abandoned | Archived | In progress |
| --- | ---: | ---: | ---: | ---: | ---: |
| `28591eeb` · Backlog and new findings | 3 | 213 | 8 | 0 | 0 |
| `5a141b20` · Rebuilt screens | 2 | 127 | 1 | 0 | 1 |
| `d924336c` · Engineering alongside | 2 | 103 | 0 | 0 | 0 |
| `3153d505` · Close | 1 | 6 | 1 | 0 | 1 |

| Item | Open Done-when lines at the inventory | Proposed disposition |
| --- | --- | --- |
| `e1d90605` · Recent landings titles | Show the landing title on one line, keep the ungrouped landing number secondary, and cover the behavior with a test. The no-new-calls and bytes-per-view line is ticked. | **In flight.** Lane `c1a31734` follows receipt `b2374aa6`. Close with evidence after the builder verifies the follow-up on pulled main and records its passing regression check. |
| `d05013f6` · Whole-app security review and close document | Record exit evidence per Initiative line, growth counts and an idle capture. The security-review line is ticked. | Close with the accepted document, hosted check and pulled-main verification. |
