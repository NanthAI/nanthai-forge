# Phase 6 close

Phase 6 closed on 2026-11-16. [Phase 7](roadmap.md#phase-7-product-and-design-current) is current. The [Phase 6 plan](phase6-plan.md) summarizes delivery; Forge planning retains the acceptance evidence and owner decisions on Initiative `f1ce7574-337a-485f-8a81-0938845523e8`.

## Delivered

Forge's hosted landing loop now preserves exact source and check identities through overtakes, shared checks, conflict recovery and lost replies. Pending-only finish-wake retirement fixes the reproduced cohort owner loss without cancelling a running source action's later work. Source and CI readers reuse verified State/recipe preparation; source bytes remain in R2. Terminal landing capsules, smaller indexed headers and journal segments remove cold history from hot Convex records. The one-client agent surface, close-on-land reconciliation, read-only friction pages, mechanical cost/growth guards and the accepted design pack provide the handover to Phase 7. Tried-and-dropped approaches, including dual-written trees in packs, remain in [decisions](decisions.md#tried-and-dropped).

The [exit bench](research/p6-exit-bench-results.md) publishes all supplied series, exclusions and unfavorable results. Published primary time-to-main medians for Forge/GitHub are 338.472/500.097 s at N=1, 377.131/538.131 s at N=3, 353.583/527.077 s at N=5 and 359.633/565.508 s at N=10. The N=10 wall is 762.705/1181.678 s and CI is 24/69 minutes. N=1/3/5 use the tuned series; N=10 uses the separately registered v2 rerun. These are descriptive observations with three cells per arm/N, not an isolated causal effect. The later [release validation](research/p6-release-validation.md) is separate: both N=10 arms landed 10/10, with Forge/GitHub wall 861/1112 s and CI 27/65 minutes; it does not replace the headline series.

The [cross-repository suite](research/zoo-mini-report.md) covers 26 repository/path shapes. Every initial timing miss now meets the unchanged 1.5× baseline bar on five repeats. The last two medians are binary checked resolve **101.229 s against 137.123 s**, and shapes-bigbin **80.725 s against 106.678 s**. Qualification is against historical commands and clocks, not an interleaved causal speedup estimate or an overall Forge-over-Git speed claim. Source-only sync still trails Git and stays on S5.

## Exit criteria and disposition

| Phase 6 Initiative criterion | Close evidence or owner disposition |
| --- | --- |
| No open bug or core-claim Issue | The paged Phase 6 inventory contains 448 Issues: 402 closed, 45 abandoned and this documentation close `53945141` in progress before landing. All preceding P6 Issues are terminal. The owner's freeze rule and explicit Phase 7 moves retain later follow-ups below; this is not a claim of zero bugs in Forge. |
| Every friction fixed or dropped by the owner | Fixed, merged, dropped or explicitly moved under the owner's close decisions; no silent deferral. The last friction closures are `88d3cfba` and `2acd01c4` below. Their agent-surface leftovers remain on Phase 7 `ad80e037`; host/import and preflight follow-ups remain on `2abda01f` and `537e73d9`. |
| Repeat B1.5d: conflict-recovery loss fixed and no regression; beat GitHub at every N | Owner accepted the bench **with caveats on 2026-11-15**, comments `774187cd` and `bee4a0d1` on `8c9b84fc`. Published primary time to main, wall, CI and tokens favor Forge at every N. This is owner acceptance, not a claim that every literal gate passed: N=16 convoy has 9/16 tasks over 310.5 s; N=10 strict correctness is 6/7 and recovery turns 13/7; N=5 CI is 30 min against the historical +10% bar of 29.7. Range/coverage limitations and historical regressions remain in the report. Recovery recheck is `7d0ccd72`; final overlap validation is `0a9df3cd`. |
| Idle Convex stays at zero | **Not established by this close capture:** 69 journal-maintenance executions occurred in the otherwise workload-free five-minute window. The exact finding is below; documentation Issue `53945141` keeps this line open for the lead. No zero-idle pass is claimed. |
| Convex cost per landing meets the agreed target | **Owner accepted going to market at the measured cost on 2026-11-15**, replacing the earlier target as a P6 close gate. The current serving reference is **$1.682603/1,000 landings on Professional with calls and action compute inside included use**, or **$4.201304/1,000 at full Professional list rates**. Retained storage, R2 operations and weekly/deferred maintenance are excluded and unmeasured as an all-in allocation. The earlier billed 200-landing target remains a Phase 7 recheck on `686ecdde`, not a claim that it was met. See [cost to serve](operations/cost-to-serve.md#p6-final-cost-baseline). |

The last five Issues closed by the lead on 2026-11-16 retain these closing comments:

| Issue | Closing evidence |
| --- | --- |
| `c01d5457` — cohort finish wake | Receipt `85156859`, State `c267f7f0`; generic pending-only cancellation across all eight retirement sites. A fresh two-Lane failed-compose replay accepted both original operations in 110.184 s, no stage over 60 s and zero stall/redrive/reconcile handlers. One functional observation, not a speed/cost claim. The unrelated historical 605 s source action remains unexplained on `e3082c24`. |
| `5d689e6e` — binary checked-resolve timing | Receipts `e0543dbb`/`7d01dba1`, State `bfa44e03`; verified request-local State/recipe preparation removes repeated membership work. Five repeats per last row pass the unchanged bars above; all ten samples and earlier misses remain. Report receipt `de204c3c`, State `73737e81`. |
| `70a9bd2f` — cross-repository suite | Lead closing comment links the generic branch-selection, CI-isolation, owner-purge, wake and timing fixes (`c3ba84eb`, `2ba51fb8`, `127db380`, `c01d5457`, `5d689e6e`). Every original timing miss qualifies; remaining source-only sync is explicitly on `e7e35328`. |
| `88d3cfba` — readable friction records | Hosted `friction-list` and `x friction-triage`, receipt `f953a07d`; all 13 named historical records were found on dev. Planning-search/duplicate hints were outside its Done-when and move to `ad80e037`. |
| `2acd01c4` — landing closes declared Issues | Current close-on-land implementation and acceptance/planning tests cover default closes, `closes:false`, policy off, conditional checkbox reconciliation and idempotent held comments. The current form is a boolean; list-of-Issue support or clarified examples stay on `ad80e037`. |

## Current cost and growth references

The serving baseline comes from 30 accepted v2 N=10 landings in three cells, excluding harness metrics/placement reads. The two final fixes above do not raise the recorded reference: their evidence is fixture deltas and functional/timing qualification, not a comparable new whole-serving capture. Finish retirement keeps 154 fixture calls, adds 12 scheduler reads and removes 10 cancellation writes; State/recipe preparation reduces the flat 1/3/24-recipe fixture to two HTTP rounds and seven internal mutations. Neither observation reprices the serving subtotal.

**Storage and weekly backup maintenance remain unmeasured and need owner-only dashboard readings** of current physical DB/index storage, retained R2 stock and matching export I/O. Compressed backup ZIP bytes do not establish billed database reads. The [allocation table](operations/cost-to-serve.md#retained-storage-and-weekly-maintenance-allocation) preserves unknowns and separates historical/model scenarios from measurement. No invoices, plan fees or private account figures form part of this public close.

`node scripts/check-growth.mjs --print --machines` reports the phase-start → close counts: Convex tables **181 → 185**, public error codes **501 → 484**, agent actions **88 → 64**, CLI commands **53 → 40**, glossary terms **34 → 27**, machine dependencies **0 → 0** and unreferenced exports **22 → 2**. Close counts equal the recorded ratchets; six hosted paths are guarded. This close removes the superseded open-acceptance inventory and replaces the old current-cost reference; it adds no runtime surface or budget.

## Carried work and caveats

Each Item below was checked against its current parent, Phase 7 Initiative `28591eeb-b74b-413a-ac41-1fef018b3dc1`; no move is inferred from an old title.

| Phase 7 Item | Remaining work |
| --- | --- |
| `e3082c24` | Attribute the unexplained 605 s source action using existing result/failure records; no explanation is claimed by the wake fix. |
| `4a83a41f` | Test-flake cluster and remaining real-time rewrites, including the new hosted-history temporary-root leak that passed on retry. |
| `ad80e037` | Agent workflow papercuts, pending-save/wait and preflight exit guidance, friction search and closes-form leftovers. |
| `e7e35328` | S5 verified physical manifest qualification and remaining source-only sync gap: zoo median 5.07 s against Git 0.62 s across 23 source scenarios. |
| `2abda01f` | Host/import robustness, including large-repository host and public imports without linked GitHub sign-in. |
| `537e73d9` | Preflight selection precision and wall-budget leftovers. |
| `0a9df3cd` | Phase 7 close validation: N=10 plus overlap N=8; fix the GitHub o08 harness void, retain notice timing and delivery cost. |
| `7d0ccd72` | Recovery turns after the conflict-notice fix, without regressing the published wins; record agent variation rather than tuning to strict 6/7. |
| `45f49fb7` | Early regression ladder and later evidence checks; the full bench remains phase-gated. |
| `7456856f` | Bulk owner-person permanent-delete approval; no new purge is run by this close. |
| `686ecdde` | Billed 200-dogfood-landing cost recheck and missing whole-service allocation. |
| `d824900c` | Rare metrics-context classification and exact save-head lookup, preserving complete reports and explicit unknowns. |
| `b149b16b` | Live archive/journal, coordination-boundary and weekly-backup rechecks; receives the journal activity observed by this close capture. |

**22 fixture projects wait in trash** for owner purge or their existing expiry. The 40 original zoo-project purges completed separately under `127db380`; the later qualification/repair fixtures are a different set. No fixture identifiers are needed here.

The bench does not prove population effects, stable timing ranges, clean-task correctness for flagged tasks, a complete billed service cost or every old injected network/freeze-failure proof. The weaker-model comparison is unrun and ungated. Final GitHub overlap validation was voided; both Forge overlap modes landed 8/8, but there is no valid final paired GitHub comparison. The zoo does not establish process peak RSS, executed R2 billing/storage or an isolated causal improvement; historical baseline source identity is unknown. Its original setup failures, inherited CI overhead, missed timing bars and cleanup limitations remain visible in the report, with later closure evidence above. The [source-step memory study](research/source-step-memory.md) retains the large-repository envelope and Phase 8 streaming work; phase close does not qualify arbitrary repository sizes.

## Idle capture

The dev provider stream ran continuously for **300 seconds, 2026-11-16 02:34:27.446–02:39:27.446 UTC**, under the timing lock, after the docs were written and before landing. The project landing queue was empty and no benchmark, fixture, import, check or other workload was launched during the window. The collector used the same `convex logs --jsonl --success` provider feed and `completionUsage` adapter as the zoo/timing collectors, retaining numeric metadata only. Readiness reads before and after the window proved the stream live. There was no early close, detected gap, parse error or missing usage field.

**The capture is not a zero-idle result.** It observed:

| Function | Executions | DB read bytes | DB write bytes |
| --- | ---: | ---: | ---: |
| `projectJournalCapture:page` | 24 | 290,370 | 46,137 |
| `projectJournalPublish:page` | 22 | 316,378 | 79,828 |
| `projectJournalRun:pack` | 23 | 0 | 0 |
| **Total** | **69** | **606,748** | **125,965** |

The total includes 638 documents read and 156 written; cached completions: zero. The collector's own two readiness calls generated 12 executions, 94,352 DB-read bytes and zero writes **outside** the 300-second window; none was subtracted from its 69 executions. No function is hidden as collector overhead.

The observed functions are journal packing/maintenance. Their originating workload and whether this is a finite previously scheduled drain remain unproven by numeric execution metadata; no idle-leak diagnosis is inferred. The finding is attached to the existing Phase 7 live-journal recheck `b149b16b`. Issue `53945141` retains its unmet zero-execution line: the lead needs a genuinely quiet follow-up window or an explicit disposition. This docs-only close ran its one authorized capture and changed no worker, schedule, setting or runtime code.
