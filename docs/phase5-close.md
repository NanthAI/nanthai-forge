# Phase 5 close

Phase 5 closed on 2026-11-04. The accepted roadmap handover is source commit `60483e2c810cd82f51af0a5a3e2428ae8d9ab2c1`. The [Phase 5 plan](phase5-plan.md) retains slice-level status; [Phase 6](phase6-plan.md) and Forge planning own all carried work.

## Delivered

Hosted main became the sole acceptance authority. B1.6–B1.8 removed push, source return, relay, format-ladder, reconcile and legacy acceptance paths. New bytes go to R2 with a verification guard against new Convex file-storage writes. Contract checks, continuous main audit, flake classification and culprit bisection are live; batch demotion still needs acceptance evidence and path/actor trust landed disabled.

Overlap at first write, semantic conflicts and Now overlap presentation landed. B1.5d found only 13 of 45 blocking notices useful; precision and missing notices remain Phase 6 work. No-Mac import of a 28,902-file repository became agent-writable in **2 min 31 s and 2 min 37 s**, compared with 9 min 29 s before packing and an earlier 16 min 56 s. R2 PUTs fell from 28,372 to 49.

The [published B1.5d result](research/b15d-report.md) reports time to main per task 24–35% lower than Git + GitHub at N = 1, 3, 5 and 10. Its range test holds at N = 1, 3 and 10. Whole-batch wall time is a clear win only at N = 1; there is no overall correctness difference. CI minutes were 331 versus 910; cached-input tokens 257M versus 386M. Rate-card estimates were $0.86 for scored cells and $3.11 for the whole bench; these are **estimates, not billed invoices**. Registered cells had 34 task voids from 53 contamination hits. Including the separately disclosed owner-requested extra N = 3 run gives 37 voids from 58 hits; the review classified all 58 hits as false positives. The extra run is a deviation, not an extra registered sample.

## Exit criteria and disposition

| Phase 5 criterion | Close evidence |
| --- | --- |
| Bet metrics and metric 5 met or honestly reported | Met by honest reporting, with blind rows 5.4, 5.7, 5.8 and R named. Comparable-load Bet 2 evidence remains on 4a686b9a; billed attribution belongs to 9db58ca6. |
| E1–E3 and R3 published beside the historical 2.36× figure | [Why Forge](why-forge.md) and B1.5d publish favorable and unfavorable results; B1.5d replaces E2 and carries R3. |
| Bet 1 cutover, B1.6–B1.8 and LOC reported | Cutover and deletion work complete; the plan retains scope and LOC evidence. B1.9 and the authority watch carry to 6.1. |
| Q4 lifecycle drill | Restart, sleep and Wi-Fi-loss drills each landed once without stranded work. Raw evidence private. |
| No-Mac import at most five minutes, docs true | Both measured imports above meet the bar; capability docs were corrected. |

The close's measured idle window was 600 seconds with zero Convex completions. Two signed-in Home tabs were outside that window: their watch remains on 02bcad74 and 59bb75f3. The close does not prove their idle behavior.

## Carried work and backup blocker

- **6.1:** backup 13402039; legacy storage 40dad5e0 with 8678148e; B1.9 64d7192b; authority watch 02bcad74; idle polling 59bb75f3; harness findings d8cf81b4 and 02ee5788. P1 and B1.9 purges **did not run**.
- **6.2:** conflict recovery 36a087ea, overlap precision ee9d5738, push delivery 11ba7bb9, overtakes, Lane-open and failed-check recovery.
- **6.3–6.5:** owner friction triage, cost-per-landing attribution/target, comparable-load metrics, regression ladder 45f49fb7 and exit repeat 8c9b84fc. The current roadmap decides stages over historical labels.
- **Phase 7:** production move c4106170, sharing b987e608, rotation 14da52b3 and G8 39942bfe. Publication and outside-user trials remain owner decisions.

The weekly backup failed with `WORK_INDEX_UNAVAILABLE` on 2026-11-02; the last good backup at close was 2026-10-29. Fix and qualify backup before the storage move/purge. See [legacy storage cleanup](operations/legacy-storage-cleanup.md). The triage and numeric Convex cost target remain pending; the close does not choose them. Raw evidence is private, held off-repo by the owner; ask before relying on it.
