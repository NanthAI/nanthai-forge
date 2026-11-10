---------------------------- MODULE Incidents ----------------------------
EXTENDS Naturals
CONSTANTS Scenario, Fixed
VARIABLES pc, canonical, observed, inputsDone, returned, a, b, main, checked, applied, owner
vars == <<pc, canonical, observed, inputsDone, returned, a, b, main, checked, applied, owner>>
Init == /\ pc = 0 /\ canonical = "ready" /\ observed = "ready"
        /\ inputsDone = FALSE /\ returned = FALSE
        /\ a = "queued" /\ b = "queued"
        /\ main \in (IF Scenario \in {"outage", "cohorthold", "supervisor"} THEN {0, 1} ELSE {0})
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
\* Incident a7de3a93 (2026-11-05): b is the queue head, checking. Each dispatch
\* either reaches a runner (owner = TRUE: a result will arrive) or is lost: the
\* call failed after `unknown`, no execution exists and nothing reports (owner =
\* FALSE). LandingQueue's `Check` assumes every check reports pass/test/infra, so
\* it cannot express this. checked = 1: an acknowledgement deadline is armed
\* (fixed: the dispatch reconcile at 5 min, backed by the checking stall alarm).
\* Unfixed, only the 12 h execution watchdog remains; it lies beyond the stall
\* window and is not modelled, as in `outage`. applied = platform retries used
\* (cap 2); after the cap b ends with a stated outcome, never silently.
LostDispatch == /\ Scenario = "lostdispatch"
  /\ CASE pc = 0 -> /\ b' = "checking" /\ owner' \in BOOLEAN
                     /\ checked' = (IF Fixed THEN 1 ELSE 0) /\ pc' = 1
                     /\ UNCHANGED <<canonical, observed, inputsDone, returned, a, main, applied>>
       [] pc = 1 /\ owner -> /\ b' = "ready" /\ pc' = 2
                     /\ UNCHANGED <<canonical, observed, inputsDone, returned, a, main, checked, applied, owner>>
       [] pc = 1 /\ ~owner /\ checked = 1 /\ applied < 2 ->
                     /\ applied' = applied + 1 /\ owner' \in BOOLEAN
                     /\ UNCHANGED <<canonical, observed, inputsDone, returned, a, b, main, checked, pc>>
       [] pc = 1 /\ ~owner /\ checked = 1 /\ applied = 2 -> /\ b' = "failed" /\ pc' = 2
                     /\ UNCHANGED <<canonical, observed, inputsDone, returned, a, main, checked, applied, owner>>
       [] pc = 2 /\ b = "ready" -> /\ b' = "landed" /\ pc' = 3
                     /\ UNCHANGED <<canonical, observed, inputsDone, returned, a, main, checked, applied, owner>>
       [] OTHER -> FALSE
\* Issue ea86f3fb (incident a7de3a93, 2026-11-05): a is a checking predecessor,
\* b a dependent group stacked on a's predicted generation (checked = main: head
\* and receipt). a's check ends with a platform outcome and retries. owner = TRUE:
\* the retry keeps a's predicted head and receipt (same Candidate, unchanged
\* base); FALSE: main moved, so a recomposes with a new head and receipt (main =
\* 1). Unfixed, every retry supersedes b and its run (applied counts discarded
\* dependent checks, ~74 runner-minutes each in the incident). Fixed keeps b only
\* when the generation is unchanged. Publication still compares b's pins with a's
\* acceptance (`predecessorStatus`), so a stale b re-queues rather than lands.
RetryKeep == /\ Scenario = "retrykeep"
  /\ CASE pc = 0 -> /\ a' = "checking" /\ b' = "checking" /\ checked' = main
                     /\ owner' \in BOOLEAN /\ pc' = 1
                     /\ UNCHANGED <<canonical, observed, inputsDone, returned, main, applied>>
       [] pc = 1 -> /\ main' = (IF owner THEN main ELSE 1)
                     /\ b' = (IF Fixed /\ owner THEN b ELSE "queued")
                     /\ applied' = applied + (IF Fixed /\ owner THEN 0 ELSE 1) /\ pc' = 2
                     /\ UNCHANGED <<canonical, observed, inputsDone, returned, a, checked, owner>>
       [] pc = 2 -> /\ b' = "ready" /\ checked' = (IF b = "queued" THEN main ELSE checked) /\ pc' = 3
                     /\ UNCHANGED <<canonical, observed, inputsDone, returned, a, main, applied, owner>>
       [] pc = 3 -> /\ a' \in {"landed", "failed"} /\ pc' = 4
                     /\ UNCHANGED <<canonical, observed, inputsDone, returned, b, main, checked, applied, owner>>
       [] pc = 4 -> /\ b' = (IF a = "landed" /\ checked = main THEN "landed" ELSE "queued") /\ pc' = 5
                     /\ UNCHANGED <<canonical, observed, inputsDone, returned, a, main, checked, applied, owner>>
       [] OTHER -> FALSE
\* Issue 19328518: b is a pending entry (here the passed Ready head) whose one
\* driver step fails. main = 0: the step's task failed and nothing owns b
\* (owner = FALSE). main = 1: the queue lease still owns b, but every advance it
\* claims throws and rolls back, so the expired lease re-claims the same attempt.
\* inputsDone = the fault is permanent (every replay fails the same way).
\* applied = consecutive failed repairs (or uncommitted re-claims), cap 2.
\* Unfixed: the stall alarm only flags a Ready head (no replay) and a re-claim
\* that never commits looks owned, so b is pending forever. Fixed: the
\* supervisor replays the lost step each round and the claim counts re-claims;
\* after the cap b ends with a stated reason (never silently, never twice).
Supervisor == /\ Scenario = "supervisor"
  /\ CASE pc = 0 -> /\ b' = "ready" /\ owner' = (main = 1) /\ inputsDone' \in BOOLEAN /\ pc' = 1
                     /\ UNCHANGED <<canonical, observed, returned, a, main, checked, applied>>
       [] pc = 1 /\ main = 0 /\ owner -> /\ b' = "landed" /\ pc' = 2
                     /\ UNCHANGED <<canonical, observed, inputsDone, returned, a, main, checked, applied, owner>>
       [] pc = 1 /\ main = 1 /\ ~inputsDone -> /\ b' = "landed" /\ pc' = 2
                     /\ UNCHANGED <<canonical, observed, inputsDone, returned, a, main, checked, applied, owner>>
       [] pc = 1 /\ applied < 2 /\ ((main = 0 /\ ~owner) \/ (main = 1 /\ inputsDone)) ->
                     \* main = 0: a supervisor round; main = 1: the lease expires and is re-claimed.
                     /\ IF Fixed
                        THEN /\ applied' = applied + (IF inputsDone THEN 1 ELSE 0)
                             /\ owner' = (main = 1 \/ ~inputsDone)
                             /\ checked' = checked
                        ELSE /\ checked' = 1 - checked /\ UNCHANGED <<applied, owner>>
                     /\ UNCHANGED <<canonical, observed, inputsDone, returned, a, b, main, pc>>
       [] pc = 1 /\ applied = 2 -> /\ b' = "failed" /\ pc' = 2
                     /\ UNCHANGED <<canonical, observed, inputsDone, returned, a, main, checked, applied, owner>>
       [] OTHER -> FALSE
\* Issue d910db6b (failure injection): b is a checking entry whose run already
\* ended; its completion wake or the queue step after it was lost. The stall alarm
\* replays it once, inline. inputsDone = the replayed driver fails every time; a
\* transient one may fail once more. owner = a supervisor round is armed.
\* applied = failed replays, cap 2. Unfixed: no round ever follows an alarm for a
\* checking entry (the run lease was assumed to own it), so a replay that fails
\* leaves b pending with nothing scheduled. Fixed: a replay at the alarm arms the
\* round, which re-drives it and ends b after the cap.
CheckRound == /\ Scenario = "checkround"
  /\ CASE pc = 0 -> /\ b' = "checking" /\ inputsDone' \in BOOLEAN /\ owner' = FALSE /\ pc' = 1
                     /\ UNCHANGED <<canonical, observed, returned, a, main, checked, applied>>
       [] pc = 1 -> \E fails \in (IF inputsDone THEN {TRUE} ELSE BOOLEAN) :
                     IF fails
                     THEN /\ applied' = 1 /\ owner' = Fixed /\ pc' = 2
                          /\ UNCHANGED <<canonical, observed, inputsDone, returned, a, b, main, checked>>
                     ELSE /\ b' = "landed" /\ pc' = 3
                          /\ UNCHANGED <<canonical, observed, inputsDone, returned, a, main, checked, applied, owner>>
       [] pc = 2 /\ owner /\ ~inputsDone -> /\ b' = "landed" /\ pc' = 3
                     /\ UNCHANGED <<canonical, observed, inputsDone, returned, a, main, checked, applied, owner>>
       [] pc = 2 /\ owner /\ inputsDone /\ applied < 2 -> /\ applied' = applied + 1
                     /\ UNCHANGED <<canonical, observed, inputsDone, returned, a, b, main, checked, owner, pc>>
       [] pc = 2 /\ owner /\ inputsDone /\ applied = 2 -> /\ b' = "failed" /\ pc' = 3
                     /\ UNCHANGED <<canonical, observed, inputsDone, returned, a, main, checked, applied, owner>>
       [] OTHER -> FALSE
\* Incident c329d191 class (w3c, 2026-11-06): b is a passed head parked in
\* submission order behind older a, which is checking. a's run fails, but its
\* completion wake and its supervisor tasks are all lost (owner = FALSE: two
\* faults, e.g. OCC exhaustion then an outage), so a never learns it failed and
\* never wakes b. b is Ready, so only b's waiting reader acts: after a quiet
\* period it asks once (returned = TRUE). Unfixed, the ask re-drives only b's own
\* steps, and a parked b has none. Fixed, it follows b's order wait to a and
\* replays a's lost step.
OrderChain == /\ Scenario = "orderchain"
  /\ CASE pc = 0 -> /\ b' = "ready" /\ a' = "checking" /\ owner' = TRUE /\ pc' = 1
                     /\ UNCHANGED <<canonical, observed, inputsDone, returned, main, checked, applied>>
       [] pc = 1 -> /\ owner' = FALSE /\ pc' = 2
                     /\ UNCHANGED <<canonical, observed, inputsDone, returned, a, b, main, checked, applied>>
       [] pc = 2 -> /\ returned' = TRUE /\ owner' = Fixed /\ pc' = 3
                     /\ UNCHANGED <<canonical, observed, inputsDone, a, b, main, checked, applied>>
       [] pc = 3 /\ owner -> /\ a' = "failed" /\ pc' = 4
                     /\ UNCHANGED <<canonical, observed, inputsDone, returned, b, main, checked, applied, owner>>
       [] pc = 4 -> /\ b' = "landed" /\ pc' = 5
                     /\ UNCHANGED <<canonical, observed, inputsDone, returned, a, main, checked, applied, owner>>
       [] OTHER -> FALSE
\* Issue 72d50375 remainder (w3c, 2026-11-06): the same write outage as
\* `outage`, in settlement, but nobody ends it: the operator never returns,
\* no reader waits and nothing else writes (inputsDone = writes refused,
\* owner = b's step alive). The window simply expires. Unfixed, every
\* re-drive needs an event (the window end, a reader, the first write after
\* expiry), so b stays Ready. Fixed, beginning the window armed one expiry
\* task: it is that first write, closes the fence and re-drives b.
OutageExpiry == /\ Scenario = "expiry"
  /\ CASE pc = 0 -> /\ b' = "ready" /\ inputsDone' = TRUE /\ pc' = 1
                     /\ UNCHANGED <<canonical, observed, returned, a, main, checked, applied, owner>>
       [] pc = 1 -> /\ owner' = FALSE /\ pc' = 2
                     /\ UNCHANGED <<canonical, observed, inputsDone, returned, a, b, main, checked, applied>>
       [] pc = 2 -> /\ inputsDone' = FALSE /\ owner' = Fixed /\ pc' = 3
                     /\ UNCHANGED <<canonical, observed, returned, a, b, main, checked, applied>>
       [] pc = 3 /\ owner /\ ~inputsDone -> /\ b' = "landed" /\ pc' = 4
                     /\ UNCHANGED <<canonical, observed, inputsDone, returned, a, main, checked, applied, owner>>
       [] OTHER -> FALSE
\* Issue 7ecc4884 (cost slice 2, w3c 2026-11-06): b is a checking entry whose last
\* queue tick retained progress inside the throttle window (checked = 1), with no
\* wake pending (owner = FALSE). A progress event arrives: the wake it would
\* schedule reads the row and retires without changing anything, so none is
\* scheduled. The run then reports its terminal result inside the same window
\* (returned = TRUE). Unfixed, the skip rule is applied to that event too and
\* b's only wake is dropped. Fixed, only non-terminal events are skipped; the
\* terminal event always schedules its wake in the check-result transaction.
ProgressWake == /\ Scenario = "progresswake"
  /\ CASE pc = 0 -> /\ b' = "checking" /\ checked' = 1 /\ owner' = FALSE /\ pc' = 1
                     /\ UNCHANGED <<canonical, observed, inputsDone, returned, a, main, applied>>
       [] pc = 1 -> /\ pc' = 2
                     /\ UNCHANGED <<canonical, observed, inputsDone, returned, a, b, main, checked, applied, owner>>
       [] pc = 2 -> /\ returned' = TRUE /\ owner' = Fixed /\ pc' = 3
                     /\ UNCHANGED <<canonical, observed, inputsDone, a, b, main, checked, applied>>
       [] pc = 3 /\ owner -> /\ b' = "landed" /\ pc' = 4
                     /\ UNCHANGED <<canonical, observed, inputsDone, returned, a, main, checked, applied, owner>>
       [] OTHER -> FALSE
\* Incident 10d253c6 (core claim, 2026-11-10): b is a large Lane on hot files; a
\* is the next small landing of a stream on the same files, so every move of main
\* conflicts with b. applied = b's attempts (submissions); checked = 1 once main
\* moved after b's attempt began; returned = a was queued before b's attempt (an
\* older entry b would wait for in submission order). pc 0 = b submits, 1 = its
\* check runs (a pre-queue check holds no queue order), 2 = passed, 3 = landed or
\* failed, 4 = its check runs past any bound. owner = the attempt holds a
\* reservation; inputsDone = its time bound passed. Unfixed, the stream lands
\* during every check and each passed check fails COMPOSITION_CONFLICT at
\* publication. Fixed, an attempt after one supersession reserves b's files: a
\* waits (at most until the bound) and b, which never waits for an entry its
\* reservation holds back, publishes on its passed check. Timing assumption: the
\* bound (30 min) exceeds one check plus acceptance, so it passes only while b's
\* check runs past it. The stream, b's steps and the clock are weakly fair.
ReserveLive == owner /\ ~inputsDone /\ pc \in {1, 2, 4}
ReserveDriver == /\ Scenario = "reserve"
  /\ CASE pc = 0 /\ applied < 3 ->
                     /\ applied' = applied + 1 /\ checked' = 0 /\ b' = "checking"
                     /\ owner' = (Fixed /\ applied >= 1) /\ inputsDone' = FALSE
                     /\ returned' = (a = "queued") /\ pc' = 1
                     /\ UNCHANGED <<canonical, observed, a, main>>
       [] pc = 1 -> /\ b' \in {"passed", "failed", "stuck"}
                     /\ pc' = (IF b' = "passed" THEN 2 ELSE IF b' = "failed" THEN 3 ELSE 4)
                     /\ UNCHANGED <<canonical, observed, inputsDone, returned, a, main, checked, applied, owner>>
       [] pc = 2 /\ (ReserveLive \/ ~(returned /\ a = "queued")) ->
                     /\ b' = (IF checked = 0 THEN "landed" ELSE "conflict")
                     /\ pc' = (IF checked = 0 THEN 3 ELSE 0)
                     /\ UNCHANGED <<canonical, observed, inputsDone, returned, a, main, checked, applied, owner>>
       [] pc = 4 /\ ReserveLive -> /\ inputsDone' = TRUE
                     /\ UNCHANGED <<pc, canonical, observed, returned, a, b, main, checked, applied, owner>>
       [] OTHER -> FALSE
ReserveStream == /\ Scenario = "reserve"
  /\ \/ /\ a = "queued" /\ ~ReserveLive /\ a' = "landed" /\ returned' = FALSE
        /\ checked' = (IF pc \in {1, 2} THEN 1 ELSE checked)
        /\ UNCHANGED <<pc, canonical, observed, inputsDone, b, main, applied, owner>>
     \/ /\ a = "landed" /\ a' = "queued"
        /\ UNCHANGED <<pc, canonical, observed, inputsDone, returned, b, main, checked, applied, owner>>
Reserve == ReserveDriver \/ ReserveStream
Step == Wait \/ CohortConflict \/ LostWake \/ MovingMain \/ CrossHead \/ OrderWake \/ Outage \/ CohortHold \/ LostDispatch
        \/ Supervisor \/ CheckRound
        \/ RetryKeep \/ OrderChain \/ OutageExpiry \/ ProgressWake \/ Reserve
\* The two reserve fairness conjuncts are never enabled in any other scenario.
Spec == Init /\ [][Step]_vars /\ WF_vars(Step) /\ WF_vars(ReserveDriver) /\ WF_vars(ReserveStream)
FreshTerminal == returned => observed = canonical
NoOrphanConflict == ~(a \in {"failed", "cancelled"} /\ b = "conflict" /\ main = 0 /\ checked = 0)
NoPrematureConflict == Scenario = "cohort" /\ checked = 0 /\ a = "checking" => b # "conflict"
PromptMainConflict == Scenario = "cohort" /\ checked = 1 /\ pc > 0 => b = "conflict"
CohortSettles == Scenario = "cohort" => <>(b \in {"landed", "conflict"})
ExactCheckedHead == applied # 0 => applied = checked
EventuallyTerminal == <>(a = "landed" \/ a = "failed")
HeadLands == <>(b = "landed")
CohortForms == <>(b = "cohort")
HeadSettles == <>(b \in {"landed", "failed"})
\* A transient fault never ends a landing; only the cap on a permanent one does.
FailsOnlyPermanent == Scenario \in {"supervisor", "checkround"} /\ b = "failed" => inputsDone /\ applied = 2
\* ea86f3fb: no live dependent is pinned to a stale predecessor generation, none
\* lands on one, and a dependent check is discarded only when the head changed.
NoStaleStack == Scenario = "retrykeep" /\ pc \in 2..4 /\ b \in {"checking", "ready"} => checked = main
StackedExact == Scenario = "retrykeep" /\ b = "landed" => a = "landed" /\ checked = main
KeepsSameHead == Scenario = "retrykeep" /\ applied > 0 => main = 1
StackSettles == Scenario = "retrykeep" => <>(pc = 5)
\* A skipped progress event leaves every queue-visible fact as it was.
ProgressSkipIsNoop == Scenario = "progresswake" /\ pc = 2 => b = "checking" /\ owner = FALSE /\ ~returned
\* 10d253c6: b lands within two attempts; every reservation ends; the stream is
\* never held for good (no deadlock between b and the waiters it holds back).
WithinTwo == Scenario = "reserve" => applied <= 2
ReserveSettles == Scenario = "reserve" => <>(pc \in {3, 4})
ReserveEnds == Scenario = "reserve" => [](ReserveLive => <>~ReserveLive)
StreamFlows == Scenario = "reserve" => []<>(a = "landed")
=============================================================================
