---------------------------- MODULE Incidents ----------------------------
EXTENDS Naturals
CONSTANTS Scenario, Fixed
VARIABLES pc, canonical, observed, inputsDone, returned, a, b, main, checked, applied, owner
vars == <<pc, canonical, observed, inputsDone, returned, a, b, main, checked, applied, owner>>
Init == /\ pc = 0 /\ canonical = "ready" /\ observed = "ready"
        /\ inputsDone = FALSE /\ returned = FALSE
        /\ a = "queued" /\ b = "queued" /\ main = 0
        /\ checked = 0 /\ applied = 0 /\ owner = TRUE
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
CohortConflict == /\ Scenario = "cohort"
  /\ CASE pc = 0 -> /\ a' = "checking" /\ b' = (IF Fixed THEN "deferred" ELSE "conflict")
                     /\ pc' = 1
                     /\ UNCHANGED <<canonical, observed, inputsDone, returned, main, checked, applied, owner>>
       [] pc = 1 -> /\ a' = "failed" /\ pc' = 2
                     /\ UNCHANGED <<canonical, observed, inputsDone, returned, b, main, checked, applied, owner>>
       [] pc = 2 /\ Fixed -> /\ b' = "retry-on-main" /\ pc' = 3
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
Step == Wait \/ CohortConflict \/ LostWake \/ MovingMain \/ CrossHead
Spec == Init /\ [][Step]_vars /\ WF_vars(Step)
FreshTerminal == returned => observed = canonical
NoOrphanConflict == ~(a = "failed" /\ b = "conflict" /\ main = 0)
ExactCheckedHead == applied # 0 => applied = checked
EventuallyTerminal == <>(a = "landed" \/ a = "failed")
=============================================================================
