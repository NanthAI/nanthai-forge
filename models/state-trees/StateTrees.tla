---------------------------- MODULE StateTrees ----------------------------
(* Trees in packs: dual-write and the reader flag (Issue 676efbc2).          *)
(* A State has a flat manifest (the authority) and, when dual-write proved   *)
(* it, a pointer to a stored tree. A reader behind the flag may answer from  *)
(* the tree. The model checks that every answer equals the flat one, and     *)
(* that a pointer whose stored bytes no longer verify falls back to flat,    *)
(* while the write flag, the reader flag, saves, losses and corruption       *)
(* interleave freely.                                                        *)
EXTENDS Naturals

CONSTANTS
  States,   \* State ids
  Contents, \* abstract file lists
  Gate,     \* TRUE: a pointer is recorded only after the written bytes reproduce the flat manifest
  Verify    \* TRUE: a reader checks stored bytes against the identity its pointer names

None == "none"
Lost == "lost"

VARIABLES
  flat,     \* State -> content, or None before the State exists
  stored,   \* State -> what the object store holds for the State's segment: content, None or Lost
  intended, \* State -> the content the segment's digest stands for (fixed at write time)
  pointer,  \* State -> TRUE when Convex holds a pointer for the State
  writing,  \* State -> TRUE between the segment PUT and the commit that may record the pointer
  write,    \* project flag: dual-write on
  read,     \* project flag: this reader is switched to trees
  answer    \* the last answer a reader gave: [state, value, from]

vars == <<flat, stored, intended, pointer, writing, write, read, answer>>

Init ==
  /\ flat = [s \in States |-> None]
  /\ stored = [s \in States |-> None]
  /\ intended = [s \in States |-> None]
  /\ pointer = [s \in States |-> FALSE]
  /\ writing = [s \in States |-> FALSE]
  /\ write = FALSE
  /\ read = FALSE
  /\ answer = [state |-> None, value |-> None, from |-> None]

\* The flat writer: always runs, never depends on a flag.
Save(s, c) ==
  /\ flat[s] = None
  /\ flat' = [flat EXCEPT ![s] = c]
  /\ UNCHANGED <<stored, intended, pointer, writing, write, read, answer>>

\* Dual-write step 1: the tree writer builds a segment (d, the bytes in hand; a buggy writer may
\* build another content than the flat one) and puts it. The step completes when the store confirms
\* it holds exactly those bytes (R2 checks the SHA-256 checksum of the PUT), so at that moment the
\* store holds what the digest stands for; a PUT the store cannot confirm fails and records nothing.
PutSegment(s, d) ==
  /\ write
  /\ flat[s] # None
  /\ ~pointer[s]
  /\ ~writing[s]
  /\ stored' = [stored EXCEPT ![s] = d]
  /\ intended' = [intended EXCEPT ![s] = d]
  /\ writing' = [writing EXCEPT ![s] = TRUE]
  /\ UNCHANGED <<flat, pointer, write, read, answer>>

\* What a verified tree read returns: the stored content when it is the content the pointer's
\* digest stands for; otherwise the read is refused.
Verified(s) == stored[s] # Lost /\ stored[s] = intended[s]

\* Dual-write step 2: the commit. With the gate, the pointer is recorded only when the bytes the
\* writer put (the content its digest stands for, checked while the PUT is in flight) reproduce
\* the flat manifest; otherwise the State stays flat-only (the alarm). The store may lose or
\* corrupt the segment before or after this; readers then refuse it (Verify).
Commit(s) ==
  /\ writing[s]
  /\ writing' = [writing EXCEPT ![s] = FALSE]
  /\ pointer' = [pointer EXCEPT ![s] = (~Gate) \/ intended[s] = flat[s]]
  /\ UNCHANGED <<flat, stored, intended, write, read, answer>>

\* The object store loses or corrupts a segment at any time, also after the pointer is recorded.
Lose(s) ==
  /\ stored[s] \notin {None, Lost}
  /\ stored' = [stored EXCEPT ![s] = Lost]
  /\ UNCHANGED <<flat, intended, pointer, writing, write, read, answer>>

Corrupt(s, d) ==
  /\ stored[s] \notin {None, Lost}
  /\ d # stored[s]
  /\ stored' = [stored EXCEPT ![s] = d]
  /\ UNCHANGED <<flat, intended, pointer, writing, write, read, answer>>

\* Operators flip either flag at any time.
FlipWrite == write' = ~write /\ UNCHANGED <<flat, stored, intended, pointer, writing, read, answer>>
FlipRead == read' = ~read /\ UNCHANGED <<flat, stored, intended, pointer, writing, write, answer>>

TreeUsable(s) == pointer[s] /\ (IF Verify THEN Verified(s) ELSE stored[s] # Lost)

\* A reader behind the flag. A missing or refused pointer falls back to the flat manifest.
Read(s) ==
  /\ flat[s] # None
  /\ answer' =
       IF read /\ TreeUsable(s)
         THEN [state |-> s, value |-> stored[s], from |-> "tree"]
         ELSE [state |-> s, value |-> flat[s], from |-> "flat"]
  /\ UNCHANGED <<flat, stored, intended, pointer, writing, write, read>>

Next ==
  \/ \E s \in States, c \in Contents : Save(s, c) \/ PutSegment(s, c) \/ Corrupt(s, c)
  \/ \E s \in States : Commit(s) \/ Lose(s) \/ Read(s)
  \/ FlipWrite
  \/ FlipRead

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ flat \in [States -> Contents \cup {None}]
  /\ stored \in [States -> Contents \cup {None, Lost}]
  /\ pointer \in [States -> BOOLEAN]
  /\ write \in BOOLEAN
  /\ read \in BOOLEAN

\* Flat and tree answers agree: whatever a reader answered is the flat manifest of that State.
ReadersAgree == answer.state # None => answer.value = flat[answer.state]

\* A recorded pointer was proven against the flat manifest when it was recorded.
PointerProven == \A s \in States : pointer[s] => intended[s] = flat[s]

\* Dual-write never changes the authority: a State's flat manifest never changes once saved.
FlatStable == [][\A s \in States : flat[s] # None => flat'[s] = flat[s]]_vars
=============================================================================
