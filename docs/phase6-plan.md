# Phase 6 plan — closed

Phase 6 closed on 2026-11-16. [Phase 7 is current](roadmap.md#phase-7-product-and-design-current). Read the [Phase 6 close](phase6-close.md) for every exit criterion, the owner decisions that changed the close gates, current cost reference, final fixes, idle capture and carried work. Forge Initiative `f1ce7574-337a-485f-8a81-0938845523e8` retains the detailed Issues and closing comments.

## Delivered stages

| Stage | Outcome and evidence |
| --- | --- |
| 6.1 Close the Phase 5 tail | Backup recovery, B1.9 retirement, legacy storage cleanup, R2-only new-byte enforcement, authority/idle fixes and benchmark harness corrections. [Phase 5 close](phase5-close.md) retains the starting obligations; [data placement](data-placement.md) describes today's byte owners. |
| 6.2 Landing under contention | Exact-source conflict recovery, early resolution, shared/stacked checks, overtake and finish-wake recovery, and verified State/recipe preparation. [Exit bench](research/p6-exit-bench-results.md), [release validation](research/p6-release-validation.md) and [zoo](research/zoo-mini-report.md) retain favorable and unfavorable observations. |
| 6.3 Bugs and friction | The pre-close paged inventory has 402 closed and 45 abandoned P6 Issues; only documentation close `53945141` remains in progress before its landing. The last wake, timing, zoo, friction-read and close-on-land Issues closed on 16 November. Explicitly moved follow-ups remain on their Phase 7 Items, listed in the close. |
| 6.4 Cost and agent surface | One hosted client mode, consolidated agent actions/CLI, bounded read-only records and conditional close-on-land. Terminal capsules, Work journal segments, indexed headers and request-local read reuse remove hot-path history and duplicate reads. [Cost to serve](operations/cost-to-serve.md#p6-final-cost-baseline) records the measured reference and missing all-in allocation. |
| 6.5 Engineering health | Mechanical growth/cost and repeated-class guards, landing model/replays and public scenario evidence. The remaining [regression ladder](agents/regression-ladder.md) work stays on Phase 7 `45f49fb7`; no close-time benchmark is invented. |
| Design preparation | Art direction, design rules and mockups feed the Phase 7 product build; [DESIGN.md](../DESIGN.md) remains the design authority. |

## Exit decisions

The original exit required no open bug or core-claim Issue, every friction fixed or dropped, a B1.5d repeat with the conflict-recovery loss fixed and no regression, zero idle Convex calls and the agreed cost target. The owner's freeze rule distinguishes pre-freeze work from later core/severe bugs. Every incomplete line is now terminal with evidence or explicitly moved by the owner; the [close](phase6-close.md#exit-criteria-and-disposition) names the disposition for each criterion.

The owner accepted the exit bench with its literal misses on 15 November: convoy N=16 per-task timing, strict N=10 correctness, recovery turns and incomplete comparison coverage remain disclosed. Published primary time to main, wall, CI and token results favor Forge at every N. Later validation is separate, not a headline replacement. Recovery and final overlap rechecks belong to `7d0ccd72` and `0a9df3cd` in Phase 7.

The owner accepted going to market at the measured serving cost on 15 November instead of the earlier P6 target. The current reference is Professional **$1.682603/1,000** with calls/compute included, or **$4.201304/1,000** at full list. Storage and weekly backup/maintenance allocation remain unmeasured and need owner-only dashboard readings. The earlier billed 200-landing bar is a Phase 7 recheck on `686ecdde`; no invoice or all-in price is claimed.

## Growth at close

The close's `node scripts/check-growth.mjs --print --machines` reports phase start → close: tables **181 → 185**, public error codes **501 → 484**, agent actions **88 → 64**, CLI commands **53 → 40**, glossary terms **34 → 27**, machine dependencies **0 → 0** and unreferenced exports **22 → 2**. Current counts equal their ratchet baselines. Six hosted paths are guarded; per-change reasons remain in `tests/growth-ledger/`.

## Handover to Phase 7

The [close's carried-work table](phase6-close.md#carried-work-and-caveats) verifies each current Phase 7 parent and names the source-only sync gap, unexplained source action, flakes, workflow/preflight/import papercuts, regression ladder, cost/context rechecks and bulk owner-delete flow. The Phase 7 Initiative is `28591eeb-b74b-413a-ac41-1fef018b3dc1`; read its current body and build-index comment before starting. [Roadmap](roadmap.md) owns stage names and [status](status.md) describes capabilities.

[Decisions](decisions.md) retains tried-and-dropped alternatives and owner constraints; the [lead rules](agents/lead.md), [builder rules](agents/briefings.md#building-forge) and [workflow](agents/workflow.md) own delivery practice. The superseded open-acceptance table, old ordering and duplicate-triage draft have been removed from this plan; their history remains in source control and the original planning records. No scope, limit, production move, publication or outside-user trial is authorized by the close.
