--------------------------- MODULE LandingQueue ---------------------------
EXTENDS Naturals, FiniteSets, Sequences, TLC
CONSTANTS N, Cohort, Width, CrashBound, MoveBound, AllowCancel, AllowAdvice, AllowReuse, InitiallyQueued, Isolation
\* Pre-queue Lane check (e7d27937). Red: changes whose own check fails on their
\* base. Independent: changes the conservative-impact proof accepts after any
\* main move. SuffixWaits is the previous claim order, in which a group also waits
\* for older entries stacked behind it (litmus only).
CONSTANTS PreQueue, Red, Independent, LaneInfra, SuffixWaits
\* Cohort hold (10b0a94b). "none": the earlier shape, no tracking (state counts
\* unchanged). "before": today's code, tracked: a refused member forms its cohort
\* while peers still decide their own proof. "hold": it waits, holding no queue
\* order, until no peer is deciding or its bounded hold expires. "keep-order":
\* the same hold, but it keeps its queue order (litmus only).
CONSTANTS Hold
OneCohort == [e \in 1..N |-> 1]
Entries == 1..N
SingletonCohorts == [e \in Entries |-> e]
SmallCohorts == [e \in Entries |-> IF e <= 2 THEN 1 ELSE 2]
Terminal == {"landed", "terminal-failed", "needs-action"}
SourceEntryPhases == {"composing", "queued", "checking", "ready", "terminal-failed", "landed"}
SourceBatchPhases == {"composing", "checking", "fallback", "landed", "superseded", "split", "failed"}
EntryPhases == SourceEntryPhases \cup {"new", "needs-action"}
BatchPhases == SourceBatchPhases \cup {"idle", "ready"}
Min(s) == CHOOSE x \in s : \A y \in s : x <= y
Keep(s, ids) == SelectSeq(s, LAMBDA x : x \in ids)
Range(s) == {s[i] : i \in 1..Len(s)}
VARIABLES q, main, stamp, moves, counts, audit, running, crashes, claim, fence
vars == <<q, main, stamp, moves, counts, audit, running, crashes, claim, fence>>
\* Inactive historical batch bodies are forgotten. Only Active/PredPending
\* read their phase, and both distinguish active vs inactive, never the outcome.
\* Entry reasons, accepted counts, actual main and fresh receipt names remain.
Empty == [phase |-> "idle", members |-> {}, included |-> {}, rejected |-> {},
          base |-> {}, rev |-> 0, head |-> {}, proof |-> <<>>, retries |-> 0, pred |-> 0, receipt |-> 0,
          lane |-> FALSE]

Init == /\ q = [phase |-> [e \in Entries |-> IF InitiallyQueued
                                  THEN IF PreQueue THEN "checking" ELSE "queued" ELSE "new"],
                rank |-> [e \in Entries |-> IF InitiallyQueued THEN e ELSE 0],
                sequence |-> IF InitiallyQueued THEN N ELSE 0,
                reason |-> [e \in Entries |-> ""], solo |-> {}, advice |-> {},
                suspect |-> {}, unstacked |-> {},
                batches |-> [g \in Entries |-> Empty], train |-> <<>>,
                lane |-> [e \in Entries |-> IF PreQueue /\ InitiallyQueued THEN "checking" ELSE "none"],
                lbase |-> [e \in Entries |-> {}], lrev |-> [e \in Entries |-> 0],
                lretries |-> [e \in Entries |-> 0], tried |-> {},
                expired |-> {}, early |-> FALSE]
        /\ main = {} /\ stamp = 0 /\ moves = 0
        /\ counts = [e \in Entries |-> 0] /\ audit = [cas |-> TRUE, exact |-> TRUE, authorized |-> TRUE]
        /\ running = TRUE /\ crashes = 0 /\ claim = 0 /\ fence = 0
Live == {e \in Entries : q.phase[e] \notin Terminal \cup {"new"}}
\* An admitted entry deciding its own proof: not tried yet, or in its one-member
\* Lane group (exact, proved reuse or refused). A refused member waits for them.
Deciding == {e \in Entries : PreQueue /\ q.phase[e] = "queued" /\ q.lane[e] = "passed"
                             /\ e \notin q.tried}
  \cup UNION {q.batches[g].members : g \in {h \in Entries : q.batches[h].lane
                                          /\ q.batches[h].phase \in {"composing", "checking", "ready"}}}
\* Held: a refused member (tried, batchable, free) while a peer is deciding and its
\* bounded hold has not expired. Released in the transaction that ends the last
\* decision (derived state); a lost wake is the Incidents `cohorthold` litmus.
Held == IF Hold \in {"hold", "keep-order"}
        THEN {e \in Entries : q.phase[e] = "queued" /\ e \in q.tried /\ e \notin q.expired
                              /\ (\A g \in Entries : q.batches[g].phase \in {"composing", "checking", "ready"}
                                   => e \notin q.batches[g].members)
                              /\ Deciding # {}}
        ELSE {}
\* An entry still in its pre-queue Lane check holds no queue order, nor does a
\* held one (else a peer it waits for waits for it: `prequeue-hold-order`).
QueueLive == {e \in Live : q.rank[e] > 0 /\ q.lane[e] # "checking"
                           /\ (Hold # "keep-order" => e \notin Held)}
Earliest(entries) == CHOOSE e \in entries : \A f \in entries : q.rank[e] <= q.rank[f]
Active == {g \in Entries : q.batches[g].phase \in {"composing", "checking", "ready"}}
\* UUID spelling is unobservable. Recycle a name only after EVERY modeled
\* reference has gone; generation-fenced delayed messages are abstract stutters.
ReceiptNames == 0..(4*N + 2)
UsedReceipts == {stamp} \cup {q.batches[g].rev : g \in Active}
  \cup {q.batches[g].receipt : g \in Active}
  \cup {IF Len(q.batches[g].proof) = 4 THEN q.batches[g].proof[2] ELSE 0 : g \in Active}
  \cup {q.lrev[e] : e \in {x \in Entries : q.lane[x] \in {"checking", "passed"}}}
FreshReceipt == Min(ReceiptNames \ UsedReceipts)
InBatch(e) == \E g \in Active : e \in q.batches[g].members
\* An admitted entry first tries its own Lane proof; only then is it batchable.
Batchable(e) == ~PreQueue \/ q.lane[e] = "unknown" \/ e \in q.tried
Free == {e \in Entries : q.phase[e] = "queued" /\ Batchable(e) /\ ~InBatch(e)}
\* Selectable for a cohort: a held entry is not runnable.
Sel == Free \ Held
Adoptable == {e \in Entries : PreQueue /\ q.phase[e] = "queued" /\ q.lane[e] = "passed"
                             /\ e \notin q.tried /\ ~InBatch(e)}
\* 51bbbd00: entries named by combined-failure evidence whose own check has not
\* passed. They still check and may land, but never serve as a speculative base
\* and never hold queue order against later entries.
Suspects == {e \in Live : e \in q.suspect /\ q.phase[e] # "ready"}
CleanTrain == SelectSeq(q.train, LAMBDA g : q.batches[g].members \cap Suspects = {})
TrainTail == IF Len(CleanTrain) = 0 THEN 0 ELSE CleanTrain[Len(CleanTrain)]
PredPending(g) == LET b == q.batches[g] IN
  IF b.pred = 0 THEN FALSE ELSE
    q.batches[b.pred].phase \in {"checking", "ready"} /\
    q.batches[b.pred].head = b.base /\ q.batches[b.pred].receipt = b.rev
Exact(g) == q.batches[g].base = main /\ q.batches[g].rev = stamp
PredOK(g) == Exact(g)
Proof(b) == <<b.base, b.rev, b.head, b.included>>
Reset(b) == [b EXCEPT !.phase = "composing", !.included = b.members,
                     !.rejected = {}, !.proof = <<>>, !.pred = 0]
\* Ordinary solo recovery can coexist with a train. Retire only groups whose
\* pinned predecessor chain depends on the changed generation, not neighbors.
RECURSIVE Descendants(_, _)
Descendants(g, depth) == IF depth = 0 THEN {g} ELSE
  LET prior == Descendants(g, depth - 1) IN
    prior \cup {h \in Active : IF q.batches[h].pred \in prior THEN
      q.batches[h].rev = q.batches[q.batches[h].pred].receipt ELSE FALSE}
Suffix(g) == Descendants(g, N) \ {g}
\* Never wait for an entry that is itself stacked behind you: it can only publish
\* after you (second prequeue counterexample). SuffixWaits restores the old rule.
Behind(g) == IF SuffixWaits THEN {} ELSE UNION {q.batches[h].members : h \in Suffix(g)}
Invalidated(g) == LET descendants == Suffix(g) IN
  [q EXCEPT !.batches = [h \in Entries |-> IF h \in descendants
                         THEN Empty
                         ELSE q.batches[h]],
            !.phase = [e \in Entries |-> IF \E h \in descendants :
                         e \in q.batches[h].members /\ e \in Live
                       THEN "queued" ELSE q.phase[e]],
            !.train = Keep(q.train, Range(q.train) \ descendants)]
Arrives(e) == q.phase[e] = "new" /\ \A prior \in 1..(e-1) : q.phase[prior] # "new"
Submit(e) == /\ Arrives(e)
             /\ q' = [q EXCEPT !.phase[e] = "composing"]
             /\ UNCHANGED <<main, stamp, moves, counts, audit, running, crashes, claim, fence>>
\* The durable desired handle exists before initial source preparation ends.
\* Queue sequence is allocated only at canonical enqueue, not at source submit.
Admit(e) == /\ running /\ q.phase[e] = "composing"
            /\ q' = IF PreQueue
                    THEN [q EXCEPT !.phase[e] = "checking", !.lane[e] = "checking",
                           !.lbase[e] = main, !.lrev[e] = stamp,
                           !.rank[e] = q.sequence + 1, !.sequence = @ + 1]
                    ELSE [q EXCEPT !.phase[e] = "queued", !.rank[e] = q.sequence + 1,
                              !.sequence = @ + 1]
            /\ UNCHANGED <<main, stamp, moves, counts, audit, running, crashes, claim, fence>>
AdmissionFailure(e) == /\ running /\ q.phase[e] = "composing"
            /\ q' = [q EXCEPT !.phase[e] = "terminal-failed", !.reason[e] = "SOURCE_RETRY_EXHAUSTED"]
            /\ UNCHANGED <<main, stamp, moves, counts, audit, running, crashes, claim, fence>>
\* The project's configured check of this change alone, on the main it composed
\* on, in parallel with every other arrival. A failing test ends it before the
\* queue; two platform retries, then it enters unadmitted (unknown, not red).
LaneCheck(e, outcome) ==
  /\ PreQueue /\ running /\ q.phase[e] = "checking" /\ q.lane[e] = "checking"
  /\ (outcome = "pass" => e \notin Red) /\ (outcome = "test" => e \in Red)
  /\ (outcome = "infra" => LaneInfra)
  /\ LET enter == [q EXCEPT !.phase[e] = "queued"] IN q' = CASE outcome = "pass" -> [enter EXCEPT !.lane[e] = "passed"]
               [] outcome = "test" -> [q EXCEPT !.phase[e] = "terminal-failed",
                                        !.reason[e] = "CHECK_FAILED", !.lane[e] = "failed"]
               [] q.lretries[e] < 2 -> [q EXCEPT !.lretries[e] = @ + 1,
                                        !.lbase[e] = main, !.lrev[e] = stamp]
               [] OTHER -> [enter EXCEPT !.lane[e] = "unknown"]
  /\ UNCHANGED <<main, stamp, moves, counts, audit, running, crashes, claim, fence>>
\* Reuse first, once: the Lane run is the exact proof of a one-member group. On
\* a moved main only the conservative-impact proof (Reuse) may carry it.
LaneAdopt(g) ==
  /\ running /\ claim = 0 /\ Adoptable # {} /\ g = Min(Entries \ Active)
  /\ Len(q.train) < Width /\ Earliest(Sel \cup Adoptable) \in Adoptable
  /\ LET e == Earliest(Adoptable)
         b == [Empty EXCEPT !.phase = "ready", !.members = {e}, !.included = {e},
                 !.base = q.lbase[e], !.rev = q.lrev[e], !.head = q.lbase[e] \cup {e},
                 !.receipt = FreshReceipt, !.lane = TRUE]
     IN q' = [q EXCEPT !.batches[g] = [b EXCEPT !.proof = Proof(b)], !.phase[e] = "ready",
                       !.tried = @ \cup {e}, !.advice = @ \ {e}, !.train = Append(@, g)]
  /\ UNCHANGED <<main, stamp, moves, counts, audit, running, crashes, claim, fence>>
\* A refused proof returns the member to the batchable pool for one combined
\* check, keeping its rank; Claim never waits for its own speculative suffix.
LaneRefused(g) ==
  /\ PreQueue /\ running /\ claim = 0 /\ q.batches[g].lane /\ q.batches[g].phase = "ready"
  /\ ~Exact(g) /\ ~(q.batches[g].included \subseteq Independent)
  \* In code the refusal happens at publication, after the order claim. The
  \* earlier configurations ("none") keep the simpler unordered refusal.
  /\ (Hold # "none" => ~\E e \in QueueLive \ (q.batches[g].members \cup Suspects \cup Behind(g)) :
                         q.rank[e] < q.rank[Earliest(q.batches[g].included)])
  /\ LET b == q.batches[g] invalid == Invalidated(g) IN
     q' = [invalid EXCEPT !.batches[g] = Empty,
           !.phase = [x \in Entries |-> IF x \in b.members \cap Live THEN "queued"
                     ELSE invalid.phase[x]],
           !.train = Keep(@, Range(@) \ {g})]
  /\ UNCHANGED <<main, stamp, moves, counts, audit, running, crashes, claim, fence>>
Gate(e) == /\ Arrives(e)
           /\ q' = [q EXCEPT !.phase[e] = "needs-action", !.reason[e] = "OVERLAP_OR_REVIEW"]
           /\ UNCHANGED <<main, stamp, moves, counts, audit, running, crashes, claim, fence>>
Precompose(e) == /\ AllowAdvice /\ e \in Free /\ e \notin q.advice
                /\ q' = [q EXCEPT !.advice = @ \cup {e}]
                /\ UNCHANGED <<main, stamp, moves, counts, audit, running, crashes, claim, fence>>
Form(g) ==
  /\ running /\ claim = 0 /\ Sel # {} /\ g = Min(Entries \ Active)
  /\ Len(q.train) < Width
  /\ Earliest(Sel \cup Adoptable) \in Sel
  /\ LET entry == Earliest(Sel) IN
     /\ (entry \in q.solo => ~\E e \in QueueLive \cap q.solo : q.rank[e] < q.rank[entry])
     /\ (IF TrainTail = 0 \/ entry \in q.solo THEN TRUE
          ELSE q.batches[TrainTail].phase \in {"checking", "ready"})
     /\ LET members == IF entry \in q.solo THEN {entry}
                       ELSE {e \in Sel : Cohort[e] = Cohort[entry] /\ e \notin q.solo}
            base == IF TrainTail = 0 \/ entry \in q.solo THEN main ELSE q.batches[TrainTail].head
            rev == IF TrainTail = 0 \/ entry \in q.solo THEN stamp ELSE q.batches[TrainTail].receipt
        IN q' = [q EXCEPT !.batches[g] = [Empty EXCEPT !.phase = "composing",
                     !.members = members, !.included = members, !.base = base,
                     !.rev = rev, !.receipt = FreshReceipt,
                     !.pred = IF entry \in q.solo THEN 0 ELSE TrainTail],
                   !.advice = @ \ members, !.train = Append(@, g),
                   !.early = @ \/ (Hold # "none" /\ Deciding # {} /\
                                    \E m \in members : m \in q.tried /\ m \notin q.expired)]
  /\ UNCHANGED <<main, stamp, moves, counts, audit, running, crashes, claim, fence>>
Compose(g, dropped) ==
  /\ running /\ g \in Active /\ q.batches[g].phase = "composing"
  /\ dropped \subseteq q.batches[g].members
  /\ LET b == q.batches[g] IN
     q' = [q EXCEPT !.batches[g] = [b EXCEPT
                  !.included = b.members \ dropped, !.rejected = dropped,
                  !.head = b.base \cup (b.members \ dropped), !.phase = "checking"],
          !.phase = [e \in Entries |-> IF e \in b.members \ dropped
                    THEN "checking" ELSE q.phase[e]],
          !.train = IF dropped = b.members THEN Keep(@, Range(@) \ {g}) ELSE @]
  /\ UNCHANGED <<main, stamp, moves, counts, audit, running, crashes, claim, fence>>
Settle(g) ==
  /\ running /\ q.batches[g].rejected # {}
  /\ ~PredPending(g)
  /\ LET b == q.batches[g] IN
     q' = [q EXCEPT !.phase = [e \in Entries |-> IF e \in b.rejected
                    THEN IF Exact(g) THEN "terminal-failed" ELSE "queued" ELSE q.phase[e]],
          !.reason = [e \in Entries |-> IF e \in b.rejected /\ Exact(g)
                     THEN "COMPOSITION_CONFLICT" ELSE q.reason[e]],
          !.solo = IF Exact(g) THEN @ ELSE @ \cup b.rejected,
          !.batches[g] = IF b.included = {} THEN Empty ELSE
            [b EXCEPT !.rejected = {}, !.members = b.included]]
  /\ UNCHANGED <<main, stamp, moves, counts, audit, running, crashes, claim, fence>>
\* A failed one-member group with no predecessor on exact main is its member's
\* own exact check (settle); any other test failure splits, and attribution may
\* name any subset of the pending members as suspects.
Released(g, reason, named) ==
  LET b == q.batches[g]
      pending == b.members \cap Live
      solo == Cardinality(b.members) = 1 /\ b.pred = 0 /\ Exact(g)
      dead == reason = "SOURCE_RETRY_EXHAUSTED" \/ reason = "CHECK_NOT_PASSED" \/ (reason = "CHECK_FAILED" /\ solo)
      invalid == Invalidated(g)
  IN [invalid EXCEPT !.batches[g] = Empty,
        !.solo = @ \cup pending, !.suspect = (@ \ b.members) \cup (named \cap pending),
        !.phase = [e \in Entries |-> IF e \in pending THEN
                  IF dead THEN "terminal-failed" ELSE "queued" ELSE invalid.phase[e]],
        !.reason = [e \in Entries |-> IF e \in pending /\ dead THEN reason ELSE q.reason[e]],
        !.train = Keep(@, Range(@) \ {g})]
Release(g, reason) == /\ q' = Released(g, reason, {}) /\ claim' = 0
     /\ UNCHANGED <<main, stamp, moves, counts, audit, running, crashes, fence>>
CanUnstack(g) == LET b == q.batches[g] IN
  b.pred # 0 /\ q.batches[b.pred].phase \in {"composing", "checking"} /\ b.members \cap q.unstacked = {}
Unstack(g) ==
  LET b == q.batches[g] invalid == Invalidated(g) live == b.members \cap Live IN
  /\ q' = [invalid EXCEPT !.batches[g] = [Reset(b) EXCEPT !.base = main, !.rev = stamp,
              !.members = live, !.included = live, !.receipt = FreshReceipt],
            !.unstacked = @ \cup live,
            !.train = IF g \in Range(@) THEN @ ELSE Append(@, g),
            !.phase = [e \in Entries |-> IF e \in live THEN "queued" ELSE invalid.phase[e]]]
  /\ UNCHANGED <<main, stamp, moves, counts, audit, running, crashes, claim, fence>>
Check(g, outcome) ==
  /\ running /\ q.batches[g].phase = "checking" /\ q.batches[g].included # {}
  /\ outcome \in {"pass", "test", "infra"}
  /\ (outcome = "pass" => q.batches[g].included \cap Red = {})
  /\ LET b == q.batches[g] IN
     IF outcome = "pass" THEN
       /\ q' = [q EXCEPT !.batches[g].phase = "ready", !.batches[g].proof = Proof(b),
                 !.suspect = @ \ b.included,
                 !.phase = [e \in Entries |-> IF e \in b.included THEN "ready" ELSE q.phase[e]]]
       /\ UNCHANGED <<main, stamp, moves, counts, audit, running, crashes, claim, fence>>
     \* A platform retry re-checks the same pinned base, members and composed head
     \* (ea86f3fb): it keeps its reserved receipt, so dependents stacked on that
     \* (head, receipt) stay valid and keep their checks. A retry whose predicted
     \* head or receipt changes is a `Rebase`/`Unstack`, which still invalidates.
     ELSE IF outcome = "infra" /\ b.retries < 2 THEN
       /\ q' = [q EXCEPT !.batches[g].retries = @ + 1]
       /\ UNCHANGED <<main, stamp, moves, counts, audit, running, crashes, claim, fence>>
     ELSE IF outcome = "infra" THEN Release(g, "CHECK_NOT_PASSED")
     \* No member named: a stacked group below an unpassed predecessor may recompose
     \* once on main without it. Any failure may instead split with any attribution
     \* (the code also splits members that failed before), a superset of the code.
     \* Isolation = FALSE keeps the pre-51bbbd00 bounds (split naming nobody).
     ELSE \/ /\ Isolation /\ CanUnstack(g) /\ Unstack(g)
          \/ \E named \in (IF Isolation THEN SUBSET (b.members \cap Live) ELSE {{}}) :
               /\ q' = Released(g, "CHECK_FAILED", named) /\ claim' = 0
               /\ UNCHANGED <<main, stamp, moves, counts, audit, running, crashes, fence>>
SourceFailure(g) == /\ running /\ q.batches[g].phase = "composing"
                    /\ Release(g, "SOURCE_RETRY_EXHAUSTED")
\* An adopted Lane group binds its own run with no cohort membership: the cohort
\* governance fallback does not apply to it (`admittedReuseFirst`).
Fallback(g) == /\ running /\ g \in Active /\ claim = 0 /\ ~(q.batches[g].members \subseteq q.solo)
               /\ ~q.batches[g].lane
               /\ Release(g, "GOVERNANCE_OR_COMPOSE_FALLBACK")
Rebase(g) ==
  /\ running /\ g \in Active /\ claim = 0
  /\ ~Exact(g) /\ ~PredPending(g)
  /\ LET b == q.batches[g] invalid == Invalidated(g) IN
     q' = [invalid EXCEPT !.batches[g] = [Reset(b) EXCEPT !.base = main, !.rev = stamp, !.members = b.members \cap Live, !.included = b.members \cap Live, !.receipt = FreshReceipt],
           !.phase = [e \in Entries |-> IF e \in b.members \cap Live THEN "queued"
                     ELSE invalid.phase[e]],
           !.train = IF g \in Range(@) THEN @ ELSE Append(@, g)]
  /\ UNCHANGED <<main, stamp, moves, counts, audit, running, crashes, claim, fence>>
Claim(g) == /\ running /\ claim = 0 /\ q.batches[g].phase = "ready"
            /\ q.batches[g].rejected = {} /\ PredOK(g) /\ Exact(g)
            /\ ~\E e \in QueueLive \ (q.batches[g].members \cup Suspects \cup Behind(g)) :
                 q.rank[e] < q.rank[Earliest(q.batches[g].included)]
            /\ claim' = g
            /\ UNCHANGED <<q, main, stamp, moves, counts, audit, running, crashes, fence>>
Publish(g) ==
  /\ running /\ claim = g /\ q.batches[g].phase = "ready" /\ Exact(g) /\ PredOK(g)
  /\ LET b == q.batches[g] IN
     /\ (b.proof = Proof(b) \/ (AllowReuse /\ Len(b.proof) = 4))
     /\ main' = b.head /\ stamp' = b.receipt
     /\ counts' = [e \in Entries |-> counts[e] + IF e \in b.included THEN 1 ELSE 0]
     /\ audit' = [cas |-> audit.cas /\ main \subseteq b.head /\ b.base = main /\ b.rev = stamp,
                  exact |-> audit.exact /\ b.proof = <<main, stamp, main', b.included>>,
                  authorized |-> audit.authorized /\ Len(b.proof) = 4 /\
                    b.proof[3] \subseteq main' /\ b.proof[4] = b.included]
     /\ q' = [q EXCEPT !.batches[g] = Empty,
               !.phase = [e \in Entries |-> IF e \in b.included THEN "landed" ELSE q.phase[e]],
               !.train = Keep(@, Range(@) \ {g})]
  /\ claim' = 0
  /\ UNCHANGED <<moves, running, crashes, fence>>
Cancel(e) == /\ AllowCancel /\ running /\ claim = 0 /\ e \in Live
             /\ ~\E g \in Active : e \in q.batches[g].members
             /\ q' = [q EXCEPT !.phase[e] = "terminal-failed", !.reason[e] = "LANDING_CANCELLED"]
             /\ UNCHANGED <<main, stamp, moves, counts, audit, running, crashes, claim, fence>>
\* Cancel/abandon and peer release share one transaction.
CancelBatch(g, e) == /\ AllowCancel /\ running /\ claim = 0 /\ g \in Active
                    /\ e \in q.batches[g].members \cap Live
                    /\ q' = [Released(g, "CANCEL_RELEASE", {}) EXCEPT
                              !.phase[e] = "terminal-failed", !.reason[e] = "LANDING_CANCELLED"]
                    /\ claim' = 0
                    /\ UNCHANGED <<main, stamp, moves, counts, audit, running, crashes, fence>>
MoveMain == /\ moves < MoveBound
            /\ main' = main \cup {0} /\ stamp' = FreshReceipt /\ moves' = moves + 1
            /\ UNCHANGED <<q, counts, audit, running, crashes, claim, fence>>
Crash == /\ running /\ crashes < CrashBound
         /\ running' = FALSE /\ crashes' = crashes + 1
         /\ UNCHANGED <<q, main, stamp, moves, counts, audit, claim, fence>>
Restart == /\ ~running /\ running' = TRUE /\ claim' = 0 /\ fence' = fence + 1
           /\ UNCHANGED <<q, main, stamp, moves, counts, audit, crashes>>
\* Owner-agent conservative-impact proof reuse, after a disjoint main move.
\* Analysis/audit eligibility is a constant assumption; the old run is immutable.
Reuse(g) == /\ AllowReuse /\ running /\ claim = 0 /\ ~Exact(g)
            /\ q.batches[g].phase = "ready" /\ q.batches[g].pred = 0
            /\ q.batches[g].base \subseteq main
            /\ (PreQueue => q.batches[g].included \subseteq Independent)
            /\ q' = [q EXCEPT !.batches[g].base = main, !.batches[g].rev = stamp,
                              !.batches[g].head = main \cup q.batches[g].included]
            /\ UNCHANGED <<main, stamp, moves, counts, audit, running, crashes, claim, fence>>
StaleClaim(g) == /\ running /\ claim = g /\ (~Exact(g) \/ q.batches[g].phase # "ready") /\ claim' = 0
                 /\ UNCHANGED <<q, main, stamp, moves, counts, audit, running, crashes, fence>>
\* The hold's one-shot wake at its bound (HOSTED_TRAIN_HOLD_MS). Not fair here, so
\* liveness never relies on it; any expiry interleaving is explored.
HoldExpire(e) == /\ e \in Held /\ q' = [q EXCEPT !.expired = @ \cup {e}]
                 /\ UNCHANGED <<main, stamp, moves, counts, audit, running, crashes, claim, fence>>
Driver(g) == Admit(g) \/ AdmissionFailure(g) \/ LaneAdopt(g) \/ LaneRefused(g)
             \/ (\E o \in {"pass", "test", "infra"} : LaneCheck(g, o))
             \/ SourceFailure(g) \/ StaleClaim(g) \/ Form(g) \/ Settle(g) \/ Rebase(g) \/ Claim(g) \/ Publish(g)
             \/ (\E d \in SUBSET Entries : Compose(g, d))
             \/ (\E o \in {"pass", "test", "infra"} : Check(g, o))
Next == (\E e \in Entries : Submit(e) \/ Gate(e) \/ Precompose(e) \/ Cancel(e) \/ HoldExpire(e))
        \/ (\E g \in Entries : Driver(g) \/ Reuse(g) \/ Fallback(g) \/ (\E e \in Entries : CancelBatch(g,e)))
        \/ MoveMain \/ Crash \/ Restart
Spec == Init /\ [][Next]_vars /\ WF_vars(Restart)
        /\ \A g \in Entries : WF_vars(Driver(g))
\* Focused seven-entry scenario reaches six occupied pipeline slots, then
\* explores pass/fail and dependent invalidation without unrelated advice/gates.
Oldest(groups) == CHOOSE g \in groups : \A h \in groups :
  q.rank[Earliest(q.batches[g].members)] <= q.rank[Earliest(q.batches[h].members)]
WidthNext ==
  LET fresh == {e \in Entries : q.phase[e] = "new"}
      composing == {g \in Active : q.batches[g].phase = "composing"}
      ready == {g \in Active : q.batches[g].phase = "ready"}
      checking == {g \in Active : q.batches[g].phase = "checking"}
  IN IF fresh # {} THEN Submit(Min(fresh))
     ELSE IF claim # 0 THEN Publish(claim)
     ELSE IF composing # {} THEN Compose(Oldest(composing), {})
     ELSE IF Free # {} /\ Len(q.train) < Width THEN Form(Min(Entries \ Active))
     ELSE IF ready # {} THEN Claim(Oldest(ready))
     ELSE IF checking # {} THEN Check(Oldest(checking), "pass") \/ Check(Oldest(checking), "test")
     ELSE FALSE
WidthSpec == Init /\ [][WidthNext]_vars /\ WF_vars(WidthNext)
FillsSix == <>(Len(q.train) = 6)
TypeOK == /\ main \subseteq Entries \cup {0} /\ stamp \in ReceiptNames
          /\ \A e \in Entries : q.phase[e] \in EntryPhases /\ counts[e] \in 0..N
          /\ Len(q.train) <= Width /\ claim \in Entries \cup {0}
          /\ \A g \in Entries : q.batches[g].phase \in BatchPhases
          /\ \A e \in Entries : q.lane[e] \in {"none", "checking", "passed", "unknown", "failed"}
          /\ q.tried \subseteq Entries /\ q.expired \subseteq Entries /\ q.early \in BOOLEAN
          /\ q.suspect \subseteq Entries /\ q.unstacked \subseteq Entries
S1 == audit.cas /\ {e \in Entries : counts[e] > 0} \subseteq main
S2 == audit.exact
AuthorizedEvidence == audit.authorized
S3 == \A e \in Entries : counts[e] <= 1
UniqueRanks == Cardinality({q.rank[e] : e \in {x \in Entries : q.rank[x] > 0}}) =
               Cardinality({e \in Entries : q.rank[e] > 0})
UniqueReservations == Cardinality({q.batches[g].receipt : g \in Active}) = Cardinality(Active)
                      /\ \A g \in Active : q.batches[g].receipt # stamp
Membership == \A e \in Live : Cardinality({g \in Active : e \in q.batches[g].members}) <= 1
TrainSound == Cardinality(Range(q.train)) = Len(q.train) /\ Range(q.train) \subseteq Active
\* No live speculative group is stacked on a suspect's unproven head.
NoStackOnSuspect == \A g \in Active :
  q.batches[g].pred # 0 => q.batches[q.batches[g].pred].members \cap Suspects = {}
\* A dependent's pinned receipt names exactly one predicted head (ea86f3fb): while
\* its predecessor slot still reserves that receipt, it predicts the pinned head.
\* A same-head platform retry keeps both; any head change takes a fresh receipt.
StackPinned == \A h \in Active : LET p == q.batches[h].pred IN
  p # 0 /\ p \in Active /\ q.batches[p].receipt = q.batches[h].rev => q.batches[p].head = q.batches[h].base
Reasons == \A e \in Entries : q.phase[e] \in {"terminal-failed", "needs-action"} => q.reason[e] # ""
KnownRedNeverQueued == \A e \in Entries : q.lane[e] = "failed" =>
                        q.phase[e] = "terminal-failed" /\ ~InBatch(e) /\ counts[e] = 0
RedNeverQueued == \A e \in Red : ~InBatch(e) /\ counts[e] = 0
LaneRunsBounded == \A e \in Entries : q.lretries[e] <= 2
\* A passed Lane check on unchanged main is the landing check: no queue check runs.
NoQueueCheck == \A g \in Entries : q.batches[g].phase # "checking"
\* No refused member forms a cohort while a peer still decides its own proof,
\* unless its bounded hold expired.
NoEarlyCohort == ~q.early
L1 == \A e \in Entries : (q.phase[e] # "new") ~> (q.phase[e] \in Terminal)
L2 == \A e \in Entries : (e \in Live) ~> (e \notin Live)
=============================================================================
