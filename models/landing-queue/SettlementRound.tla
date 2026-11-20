-------------------------- MODULE SettlementRound --------------------------
EXTENDS FiniteSets, Naturals, Sequences
CONSTANT Fixed
VARIABLES q
vars == <<q>>

\* Landings 1, 2 and 3 passed on the initial base. A foreign commit moves main
\* while all three are parked. A round carries the ordered prefix permitted by
\* the existing proof rule. The remaining suffix needs one exact shared check.
Entries == 1..3
Interval(lo, hi) == {e \in Entries : lo <= e /\ e <= hi}
StatePin(revision, included) == <<revision, included>>
Receipt(e, base, head, evidence, kind) ==
  [entry |-> e, base |-> base, head |-> head, evidence |-> evidence, kind |-> kind]
History == 1..Len(q.receipts)
NextEntry == Len(q.receipts) + 1
Base == StatePin(q.moves, Interval(1, NextEntry - 1))

Init ==
  \E carry \in 0..3 :
    q = [phase |-> "parked", moves |-> 0, base |-> StatePin(0, {}),
         carry |-> carry, through |-> 0, exact |-> StatePin(0, {}),
         receipts |-> <<>>, rounds |-> 0, checks |-> 0, lost |-> FALSE]

MainMove ==
  /\ (q.moves = 0 /\ q.phase = "parked") \/
     (q.moves = 1 /\ q.phase \in {"planned", "checking", "checked"})
  /\ q' = [q EXCEPT !.moves = @ + 1,
           !.phase = IF @ = "parked" THEN "awake" ELSE @]

\* The order-release transition both wakes the round and retains its recovery.
\* Lose one scheduled drive before the first decision, then recover by alarm.
LoseWake ==
  /\ q.phase = "awake" /\ ~q.lost
  /\ q' = [q EXCEPT !.phase = "alarm", !.lost = TRUE]
Alarm ==
  /\ q.phase = "alarm"
  /\ q' = [q EXCEPT !.phase = "awake"]

Decide ==
  /\ q.phase = "awake"
  /\ q' = [q EXCEPT !.phase = "planned", !.base = Base, !.rounds = @ + 1,
           !.through = IF Fixed THEN 3 ELSE NextEntry]

\* A later main event invalidates a whole preparation, including a check
\* already in flight. Original passes and settled prefix receipts remain.
RePin ==
  /\ q.phase \in {"planned", "checking", "checked"} /\ q.base # Base
  /\ q' = [q EXCEPT !.phase = "awake"]

PublishCarry ==
  /\ q.phase = "planned" /\ q.base = Base
  /\ LET last == IF q.carry < q.through THEN q.carry ELSE q.through
         end == IF last < NextEntry THEN NextEntry - 1 ELSE last
         carried == [i \in 1..(end - NextEntry + 1) |->
                       LET e == NextEntry + i - 1
                           previous == StatePin(q.moves, Interval(1, e - 1))
                           head == StatePin(q.moves, Interval(1, e))
                       IN Receipt(e, previous, head, <<previous, head, e>>, "carry")]
     IN q' = [q EXCEPT !.receipts = @ \o carried,
              !.base = StatePin(q.moves, Interval(1, end)),
              !.phase = IF end = 3 THEN "done"
                         ELSE IF end = q.through THEN "awake"
                         ELSE "checking",
              !.checks = IF end < q.through THEN @ + 1 ELSE @]

CompleteCheck ==
  /\ q.phase = "checking" /\ q.base = Base
  /\ q' = [q EXCEPT !.phase = "checked",
           !.exact = StatePin(q.moves, Interval(1, q.through))]

PublishChecked ==
  /\ q.phase = "checked" /\ q.base = Base
  /\ q.exact = StatePin(q.moves, Interval(1, q.through))
  /\ q' = [q EXCEPT !.receipts = @ \o
             [i \in 1..(q.through - NextEntry + 1) |->
               Receipt(NextEntry + i - 1, Base, q.exact, q.exact, "check")],
           !.phase = IF q.through = 3 THEN "done" ELSE "awake"]

Next == MainMove \/ LoseWake \/ Alarm \/ Decide \/ RePin \/
        PublishCarry \/ CompleteCheck \/ PublishChecked
Spec == Init /\ [][Next]_vars /\ WF_vars(Next)

PublicationOrder ==
  /\ Len(q.receipts) <= 3
  /\ \A i \in History :
       LET r == q.receipts[i]
       IN /\ r.entry = i
          /\ r.base[2] = Interval(1, Cardinality(r.base[2]))
          /\ (i = 1 \/ q.receipts[i - 1].head[1] <= r.base[1])
          /\ (r.kind = "carry" => r.base[2] = Interval(1, i - 1))
          /\ (r.kind = "check" =>
                IF i - 1 \in r.base[2] \/ i = 1
                THEN r.base[2] = Interval(1, i - 1)
                ELSE /\ q.receipts[i - 1].kind = "check"
                     /\ q.receipts[i - 1].base = r.base
                     /\ q.receipts[i - 1].head = r.head)

ExactEvidence ==
  \A i \in History :
    LET r == q.receipts[i]
    IN /\ r.base[1] = r.head[1] /\ r.base[1] > 0
       /\ i \in r.head[2] /\ i \notin r.base[2]
       /\ r.base[2] \subseteq r.head[2]
       /\ IF r.kind = "carry"
          THEN /\ i <= q.carry /\ r.head[2] = r.base[2] \cup {i}
               /\ r.evidence = <<r.base, r.head, i>>
          ELSE r.evidence = r.head

\* A stable main consumes a single cohort decision and at most one replacement
\* check. A different accepted base can require a new round.
OneRoundPerMove == q.rounds <= q.moves /\ q.checks <= q.moves
L1 == \A e \in Entries : <>(e \in {q.receipts[i].entry : i \in History})
L2 == (q.phase # "done") ~> (q.phase = "done")
=============================================================================
