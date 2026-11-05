--------------------------- MODULE LandingQueue ---------------------------
EXTENDS Naturals, FiniteSets, Sequences, TLC
CONSTANTS N, Cohort, Width, CrashBound, MoveBound, AllowCancel, AllowAdvice, AllowReuse, InitiallyQueued, Isolation
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
          base |-> {}, rev |-> 0, head |-> {}, proof |-> <<>>, retries |-> 0, pred |-> 0, receipt |-> 0]
Init == /\ q = [phase |-> [e \in Entries |-> IF InitiallyQueued THEN "queued" ELSE "new"],
                rank |-> [e \in Entries |-> IF InitiallyQueued THEN e ELSE 0],
                sequence |-> IF InitiallyQueued THEN N ELSE 0,
                reason |-> [e \in Entries |-> ""], solo |-> {}, advice |-> {},
                suspect |-> {}, unstacked |-> {},
                batches |-> [g \in Entries |-> Empty], train |-> <<>>]
        /\ main = {} /\ stamp = 0 /\ moves = 0
        /\ counts = [e \in Entries |-> 0] /\ audit = [cas |-> TRUE, exact |-> TRUE, authorized |-> TRUE]
        /\ running = TRUE /\ crashes = 0 /\ claim = 0 /\ fence = 0
Live == {e \in Entries : q.phase[e] \notin Terminal \cup {"new"}}
QueueLive == {e \in Live : q.rank[e] > 0}
Earliest(entries) == CHOOSE e \in entries : \A f \in entries : q.rank[e] <= q.rank[f]
Active == {g \in Entries : q.batches[g].phase \in {"composing", "checking", "ready"}}
\* UUID spelling is unobservable. Recycle a name only after EVERY modeled
\* reference has gone; generation-fenced delayed messages are abstract stutters.
ReceiptNames == 0..(3*N + 2)
UsedReceipts == {stamp} \cup {q.batches[g].rev : g \in Active}
  \cup {q.batches[g].receipt : g \in Active}
  \cup {IF Len(q.batches[g].proof) = 4 THEN q.batches[g].proof[2] ELSE 0 : g \in Active}
FreshReceipt == Min(ReceiptNames \ UsedReceipts)
Free == {e \in Entries : q.phase[e] = "queued" /\
                         ~\E g \in Active : e \in q.batches[g].members}
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
            /\ q' = [q EXCEPT !.phase[e] = "queued", !.rank[e] = q.sequence + 1,
                              !.sequence = @ + 1]
            /\ UNCHANGED <<main, stamp, moves, counts, audit, running, crashes, claim, fence>>
AdmissionFailure(e) == /\ running /\ q.phase[e] = "composing"
            /\ q' = [q EXCEPT !.phase[e] = "terminal-failed", !.reason[e] = "SOURCE_RETRY_EXHAUSTED"]
            /\ UNCHANGED <<main, stamp, moves, counts, audit, running, crashes, claim, fence>>
Gate(e) == /\ Arrives(e)
           /\ q' = [q EXCEPT !.phase[e] = "needs-action", !.reason[e] = "OVERLAP_OR_REVIEW"]
           /\ UNCHANGED <<main, stamp, moves, counts, audit, running, crashes, claim, fence>>
Precompose(e) == /\ AllowAdvice /\ e \in Free /\ e \notin q.advice
                /\ q' = [q EXCEPT !.advice = @ \cup {e}]
                /\ UNCHANGED <<main, stamp, moves, counts, audit, running, crashes, claim, fence>>
Form(g) ==
  /\ running /\ claim = 0 /\ Free # {} /\ g = Min(Entries \ Active)
  /\ Len(q.train) < Width
  /\ LET entry == Earliest(Free) IN
     /\ (entry \in q.solo => ~\E e \in QueueLive \cap q.solo : q.rank[e] < q.rank[entry])
     /\ (IF TrainTail = 0 \/ entry \in q.solo THEN TRUE
          ELSE q.batches[TrainTail].phase \in {"checking", "ready"})
     /\ LET members == IF entry \in q.solo THEN {entry}
                       ELSE {e \in Free : Cohort[e] = Cohort[entry] /\ e \notin q.solo}
            base == IF TrainTail = 0 \/ entry \in q.solo THEN main ELSE q.batches[TrainTail].head
            rev == IF TrainTail = 0 \/ entry \in q.solo THEN stamp ELSE q.batches[TrainTail].receipt
        IN q' = [q EXCEPT !.batches[g] = [Empty EXCEPT !.phase = "composing",
                     !.members = members, !.included = members, !.base = base,
                     !.rev = rev, !.receipt = FreshReceipt,
                     !.pred = IF entry \in q.solo THEN 0 ELSE TrainTail],
                   !.advice = @ \ members, !.train = Append(@, g)]
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
  /\ LET b == q.batches[g] IN
     IF outcome = "pass" THEN
       /\ q' = [q EXCEPT !.batches[g].phase = "ready", !.batches[g].proof = Proof(b),
                 !.suspect = @ \ b.included,
                 !.phase = [e \in Entries |-> IF e \in b.included THEN "ready" ELSE q.phase[e]]]
       /\ UNCHANGED <<main, stamp, moves, counts, audit, running, crashes, claim, fence>>
     ELSE IF outcome = "infra" /\ b.retries < 2 THEN
       /\ q' = [Invalidated(g) EXCEPT !.batches[g].retries = @ + 1,
                 !.batches[g].receipt = FreshReceipt]
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
Fallback(g) == /\ running /\ g \in Active /\ claim = 0 /\ ~(q.batches[g].members \subseteq q.solo)
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
            /\ ~\E e \in QueueLive \ (q.batches[g].members \cup Suspects) :
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
            /\ q' = [q EXCEPT !.batches[g].base = main, !.batches[g].rev = stamp,
                              !.batches[g].head = main \cup q.batches[g].included]
            /\ UNCHANGED <<main, stamp, moves, counts, audit, running, crashes, claim, fence>>
StaleClaim(g) == /\ running /\ claim = g /\ (~Exact(g) \/ q.batches[g].phase # "ready") /\ claim' = 0
                 /\ UNCHANGED <<q, main, stamp, moves, counts, audit, running, crashes, fence>>
Driver(g) == Admit(g) \/ AdmissionFailure(g) \/ SourceFailure(g) \/ StaleClaim(g) \/ Form(g) \/ Settle(g) \/ Rebase(g) \/ Claim(g) \/ Publish(g)
             \/ (\E d \in SUBSET Entries : Compose(g, d))
             \/ (\E o \in {"pass", "test", "infra"} : Check(g, o))
Next == (\E e \in Entries : Submit(e) \/ Gate(e) \/ Precompose(e) \/ Cancel(e))
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
Reasons == \A e \in Entries : q.phase[e] \in {"terminal-failed", "needs-action"} => q.reason[e] # ""
L1 == \A e \in Entries : (q.phase[e] # "new") ~> (q.phase[e] \in Terminal)
L2 == \A e \in Entries : (e \in Live) ~> (e \notin Live)
=============================================================================
