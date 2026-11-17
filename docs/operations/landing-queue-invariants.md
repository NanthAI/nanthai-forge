# Landing queue invariants

Targets; violations remain.

| ID | Contract |
| --- | --- |
| S1 | Current lease/fence and previous head+receipt compare before publication. |
| S2 | Exact pass, carry proof, or accepted predecessor pin before acceptance. |
| S3 | Pass older work only with unrelated known footprints and the sealed/bounded rule. |
| S4 | Lifetime: one generation lost solely to newer entries; two after a wrong sealed guess. |
| S5 | Three main-race recompositions, then strict order. Exclude platform retries and batch fallback. |
| S6 | Decide and record every wait in its writing transaction; no cycles. |
| S7 | Parking and reclaim preserve passed evidence. |
| S8 | Shared acceptance includes every member; speculative failures settle no member. |
| S9 | Invalidate pinned descendants, preserving unrelated groups. |
| S10 | Terminal phases stay terminal and retire work; a settled queue owns no queue tasks. |
| S11 | No bare polling. Eight short lease retries, then one expiry wake; record urgent waits. |
| S12 | Alert once at the root; followers show their dependency. |
| L1 | Parked deadline: 1.5× holder check wall, clamped 5–15 minutes, unknown 10. Re-arm on firing. |
| L2 | A changed wait decision leaves a pending claim in that transaction. Include holder parking. |
| L3 | Unblocked Ready: one 30-second slot per predecessor plus itself. |
| L4 | Dependent waits end within remaining bounded generations and one slot. |
| L5 | Scheduled driver, armed deadline, owned provider completion, or validated chain of ≤16 hops. |
| L6 | Admission/compose/reservation waits own wakes: train 5 minutes, reservation 30 minutes. |
| L7 | Lease recovery finishes publication or releases it; terminal failures name a structured reason. |
| L8 | One actionable root alert after 15 minutes without progress. |

Inspector: waits, drivers, receipts, generations and terminal retirement. Fencing, batch provenance, timed bounds and alerts remain unverified.

Eight seeds cover eight profiles; 20 took 136 seconds. Counterexamples stay in the corpus; an S4 mutant must fail.

## Owner rollout decision

Calibration is stopped; retained results are unqualified. Sequence: foundation, order-key wakes, parked deadlines.
Each runtime rule has a documented, default-on switch, deleted after proof. Post diff/invariants on
`5e3c3a3c`; await lead go after cross-model review. Skip failing targets with that Item until their
rule lands. No parked entry: calls, reads and writes stay unchanged.

After each landing, watch two hours or 20 dogfood landings, whichever comes first. Compare
discarded runner share, median/p90 time to main, parked entries without alarms and wakes per
landing. Morning references are 31%, 27.8 minutes and 65.8 minutes; measure missing count
baselines rather than guessing. A regression disables that rule's switch and goes to the lead.

Cap 3, urgent-retry removal, early-refusal scope and per-generation `unsealed` wait for a real
N=10 bench A/B of both arms, with owner go. The lifetime S4 bound remains.
