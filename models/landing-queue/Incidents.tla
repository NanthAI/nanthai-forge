---------------------------- MODULE Incidents ----------------------------
EXTENDS Naturals
CONSTANTS Scenario, Fixed
VARIABLES pc, canonical, observed, inputsDone, returned, a, b, main, checked, applied, owner
vars == <<pc, canonical, observed, inputsDone, returned, a, b, main, checked, applied, owner>>
Init == /\ pc = 0 /\ canonical = "ready" /\ observed = "ready"
        /\ inputsDone = FALSE /\ returned = FALSE
        /\ a = "queued" /\ b = "queued"
        /\ main \in (IF Scenario \in {"outage", "cohorthold"} THEN {0, 1} ELSE {0})
        /\ checked \in (IF Scenario = "cohort" THEN {0, 1} ELSE {0})
        /\ applied = 0 /\ owner = TRUE
Idle == UNCHANGED vars
\* Minimal litmus reductions, not full historical incident replays.
Wait == /\ Scenario = "wait"
  /\ CASE pc = 0 -> /\ canonical' = "landed" /\ pc' = 1
                     /\ UNCHANGED <<observed, inputsDone, returned, a, b, main, checked, applied, owner>>
       [] pc = 1 -> /\ inputsDone' = TRUE /\ pc' = 2
                     /\ UNCHANGED <<canonical, observed, returned, a, b, main, checked, applied, owner>>
       [] pc = 2 -> /\ returned' = TRUE /\ pc' = 3
                     /\ observed' = (IF Fixed THEN canonical ELSE observed)
                     /\ UNCHANGED <<canonical, inputsDone, a, b, main, checked, applied, owner>>
       [] OTHER -> FALSE
\* checked = 1 means the worker independently proves a conflict on main.
\* checked = 0 is a conflict only with A's unaccepted same-cohort prefix.
CohortConflict == /\ Scenario = "cohort"
  /\ CASE pc = 0 -> /\ a' = "checking"
                     /\ b' = (IF Fixed /\ checked = 0 THEN "deferred" ELSE "conflict")
                     /\ pc' = 1
                     /\ UNCHANGED <<canonical, observed, inputsDone, returned, main, checked, applied, owner>>
       [] pc = 1 -> /\ a' \in {"failed", "landed", "cancelled"} /\ pc' = 2
                     /\ main' = (IF a' = "landed" THEN 1 ELSE 0)
                     /\ UNCHANGED <<canonical, observed, inputsDone, returned, b, checked, applied, owner>>
       [] pc = 2 /\ Fixed -> /\ b' = (IF b = "deferred" THEN "retry-on-main" ELSE b) /\ pc' = 3
                     /\ UNCHANGED <<canonical, observed, inputsDone, returned, a, main, checked, applied, owner>>
       [] pc = 3 /\ Fixed -> /\ b' = (IF b = "retry-on-main" THEN
                                          (IF main = 0 THEN "landed" ELSE "conflict") ELSE b)
                     /\ pc' = 4
                     /\ UNCHANGED <<canonical, observed, inputsDone, returned, a, main, checked, applied, owner>>
       [] OTHER -> FALSE
LostWake == /\ Scenario = "stranded"
  /\ CASE pc = 0 -> /\ owner' = FALSE /\ pc' = 1
                     /\ UNCHANGED <<canonical, observed, inputsDone, returned, a, b, main, checked, applied>>
       [] pc = 1 /\ Fixed -> /\ owner' = TRUE /\ pc' = 2
                     /\ UNCHANGED <<canonical, observed, inputsDone, returned, a, b, main, checked, applied>>
       [] pc = 2 -> /\ a' = "landed" /\ pc' = 3
                     /\ UNCHANGED <<canonical, observed, inputsDone, returned, b, main, checked, applied, owner>>
       [] OTHER -> FALSE
\* Two abstract head generations suffice for the liveness cycle. They are NOT
\* receipt UUIDs and are never used to justify a successful CAS in this harness.
MovingMain == /\ Scenario = "moving"
  /\ CASE pc = 0 -> /\ checked' = main /\ pc' = 1
                     /\ UNCHANGED <<canonical, observed, inputsDone, returned, a, b, main, applied, owner>>
       [] pc = 1 -> /\ main' = 1 - main /\ pc' = 2
                     /\ UNCHANGED <<canonical, observed, inputsDone, returned, a, b, checked, applied, owner>>
       [] pc = 2 -> /\ pc' = 0
                     /\ UNCHANGED <<canonical, observed, inputsDone, returned, a, b, main, checked, applied, owner>>
       [] OTHER -> FALSE
\* Real cross-head reuse checks C, composes C+new-main and accepts with a proof.
CrossHead == /\ Scenario = "reuse"
  /\ CASE pc = 0 -> /\ checked' = 1 /\ pc' = 1
                     /\ UNCHANGED <<canonical, observed, inputsDone, returned, a, b, main, applied, owner>>
       [] pc = 1 -> /\ main' = 2 /\ pc' = 2
                     /\ UNCHANGED <<canonical, observed, inputsDone, returned, a, b, checked, applied, owner>>
       [] pc = 2 -> /\ applied' = 3 /\ checked' = (IF Fixed THEN 3 ELSE checked) /\ pc' = 3
                     /\ UNCHANGED <<canonical, observed, inputsDone, returned, a, b, main, owner>>
       [] OTHER -> FALSE
\* Incident c329d191 (2026-11-05): b is a passed head waiting in submission order
\* for older a, with no timer while parked (owner = FALSE, checked = 0). a fails
\* and wakes b once; that drive fails (Convex OCC exhaustion), so the wake is
\* lost. `checked` = 1 is b's stall alarm: the fix arms it in the same
\* transaction as the wake, so a lost drive is re-driven; parked waiters stay free.
OrderWake == /\ Scenario = "orderwake"
  /\ CASE pc = 0 -> /\ b' = "ready" /\ owner' = FALSE /\ checked' = 0
                     /\ pc' = 1
                     /\ UNCHANGED <<canonical, observed, inputsDone, returned, a, main, applied>>
       [] pc = 1 -> /\ a' = "failed" /\ owner' = TRUE /\ checked' = (IF Fixed THEN 1 ELSE 0) /\ pc' = 2
                     /\ UNCHANGED <<canonical, observed, inputsDone, returned, b, main, applied>>
       [] pc = 2 -> /\ owner' = FALSE /\ pc' = 3
                     /\ UNCHANGED <<canonical, observed, inputsDone, returned, a, b, main, checked, applied>>
       [] pc = 3 /\ checked = 1 -> /\ owner' = TRUE /\ checked' = 0 /\ pc' = 4
                     /\ UNCHANGED <<canonical, observed, inputsDone, returned, a, b, main, applied>>
       [] pc = 4 /\ owner -> /\ b' = "landed" /\ pc' = 5
                     /\ UNCHANGED <<canonical, observed, inputsDone, returned, a, main, checked, applied, owner>>
       [] OTHER -> FALSE
\* Issue 72d50375 (2026-11-05): a write outage (the dev storage pause) refuses
\* every write for minutes. main = 0 puts it in the middle of b's CI, main = 1
\* in the middle of settlement. inputsDone = writes refused; owner = b's
\* scheduled step is alive; returned = the runner still holds b's passed result.
\* A step that fires during the outage throws and Convex never retries it. The
\* unfixed runner drops its result after ~3 s. Fixed: the runner keeps the
\* result until accepted, and resumed writes (or a waiting reader) re-drive the
\* lost step. No timer or poll is modelled: recovery follows the outage's end.
Outage == /\ Scenario = "outage"
  /\ CASE pc = 0 -> /\ b' = (IF main = 0 THEN "checking" ELSE "ready") /\ inputsDone' = TRUE
                     /\ pc' = 1
                     /\ UNCHANGED <<canonical, observed, returned, a, main, checked, applied, owner>>
       [] pc = 1 -> /\ owner' = FALSE /\ returned' = (main = 0 /\ Fixed) /\ pc' = 2
                     /\ UNCHANGED <<canonical, observed, inputsDone, a, b, main, checked, applied>>
       [] pc = 2 -> /\ inputsDone' = FALSE /\ owner' = Fixed
                     /\ b' = (IF main = 0 /\ returned THEN "ready" ELSE b) /\ pc' = 3
                     /\ UNCHANGED <<canonical, observed, returned, a, main, checked, applied>>
       [] pc = 3 /\ owner /\ b = "ready" /\ ~inputsDone -> /\ b' = "landed" /\ pc' = 4
                     /\ UNCHANGED <<canonical, observed, inputsDone, returned, a, main, checked, applied, owner>>
       [] OTHER -> FALSE
\* Issue 10b0a94b: b is an admitted change whose Lane proof was refused on a moved
\* main; it holds (not runnable, no queue order) until its peer a, still deciding
\* its own proof, decides, so both join one cohort. The peer's decision releases b
\* in the same transaction and schedules one queue wake; that drive is lost (OCC
\* exhaustion). The peer may also never decide (a stuck compose). main = 0: the
\* lost wake; main = 1: a write outage (72d50375) also refuses the hold's own
\* step. checked = the hold's wake: 1 armed, 2 thrown during the outage. Fixed:
\* the hold arms one wake at its bound in the same transaction, and resumed
\* writes re-drive it if it threw. Unfixed: only the peer's release wakes b.
CohortHold == /\ Scenario = "cohorthold"
  /\ CASE pc = 0 -> /\ b' = "held" /\ owner' = FALSE /\ checked' = (IF Fixed THEN 1 ELSE 0) /\ pc' = 1
                     /\ UNCHANGED <<canonical, observed, inputsDone, returned, a, main, applied>>
       [] pc = 1 -> /\ a' \in {"decided", "stuck"}
                     /\ b' = (IF a' = "decided" THEN "queued" ELSE b) /\ owner' = (a' = "decided")
                     /\ pc' = 2
                     /\ UNCHANGED <<canonical, observed, inputsDone, returned, main, checked, applied>>
       [] pc = 2 -> /\ owner' = FALSE /\ inputsDone' = (main = 1) /\ pc' = 3
                     /\ UNCHANGED <<canonical, observed, returned, a, b, main, checked, applied>>
       [] pc = 3 /\ checked = 1 ->
                     /\ IF inputsDone THEN /\ checked' = 2 /\ UNCHANGED <<b, owner>>
                        ELSE /\ checked' = 0 /\ owner' = TRUE /\ b' = "queued"
                     /\ pc' = 4
                     /\ UNCHANGED <<canonical, observed, inputsDone, returned, a, main, applied>>
       [] pc = 4 -> /\ inputsDone' = FALSE
                     /\ checked' = (IF checked = 2 /\ Fixed THEN 1 ELSE checked)
                     /\ pc' = (IF checked' = 1 THEN 3 ELSE 5)
                     /\ UNCHANGED <<canonical, observed, returned, a, b, main, applied, owner>>
       [] pc = 5 /\ owner /\ b = "queued" -> /\ b' = "cohort" /\ pc' = 6
                     /\ UNCHANGED <<canonical, observed, inputsDone, returned, a, main, checked, applied, owner>>
       [] OTHER -> FALSE
Step == Wait \/ CohortConflict \/ LostWake \/ MovingMain \/ CrossHead \/ OrderWake \/ Outage \/ CohortHold
Spec == Init /\ [][Step]_vars /\ WF_vars(Step)
FreshTerminal == returned => observed = canonical
NoOrphanConflict == ~(a \in {"failed", "cancelled"} /\ b = "conflict" /\ main = 0 /\ checked = 0)
NoPrematureConflict == Scenario = "cohort" /\ checked = 0 /\ a = "checking" => b # "conflict"
PromptMainConflict == Scenario = "cohort" /\ checked = 1 /\ pc > 0 => b = "conflict"
CohortSettles == Scenario = "cohort" => <>(b \in {"landed", "conflict"})
ExactCheckedHead == applied # 0 => applied = checked
EventuallyTerminal == <>(a = "landed" \/ a = "failed")
HeadLands == <>(b = "landed")
CohortForms == <>(b = "cohort")
=============================================================================
