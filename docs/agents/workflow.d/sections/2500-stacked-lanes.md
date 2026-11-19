## Stacked Lanes

`start {"outcome":"Next slice","stackOn":"PARENT_LANE_ID"}`
materializes the parent's latest **saved** head, including its unlanded source.
Unsaved parent files are excluded. The Lane retains its parent/head pin and a
landing dependency; a new Intent also records `after:{intentId:parentIntentId}`.
Stacks can span multiple Intents or Lanes of one Intent. The dependency is the
exact parent Lane, so unrelated siblings do not delay a stack.

`sync {"laneId":"CHILD_LANE_ID"}` reapplies the child's aggregate delta from its
pinned parent head onto the parent's latest saved head. Existing checkpoints stay
retained. Overlaps use the normal sync markers and checkpoint resolution flow.
Each child is synced in its own working directory; syncing one Lane does not edit
another agent's files. Restack a deeper chain from oldest to newest.

A parent's accepted Candidate input and Channel receipt automatically select main
as the child's next target, including when the parent lands with unrelated Lanes
in a cumulative batch Candidate belonging to another Intent. This retargeting does
not rewrite a child working copy while its agent is editing: `sync`, or the existing automatic sync during `finish`,
brings in the accepted source. Status identifies the landing receipt; a later
main advance is included on sync. An abandoned parent remains visible until an
explicit `sync {"laneId":"CHILD_LANE_ID","ontoMain":true}` detaches the child.
This reapplies only the child's delta onto main (or the native bootstrap source
when main has no receipt yet); parent-only changes are omitted and overlaps remain
conflicts. `undo-sync` restores the pre-sync source base and stack pin.

When `land` picks up a saved child after its parent has landed, both single and
batch landing compose the child's aggregate delta from its saved parent base onto
the selected current main. This uses sync's three-way merge semantics, including
whole-file changes where main still has the saved parent's version. The resulting
Candidate retains the original Lane input/head pins; the saved Lane and working
files stay unchanged, including unsaved edits. The Candidate records its selected
main and exact checked source. A deeper chain retargets each child after its own
parent lands, without a manual sync. Real conflicts retain the original States
and identify accepted Lane deltas touching the conflicting paths.

Child `finish` and `land` use the existing dependency wait until the parent has an
accepted input in the destination Channel. `land {"laneIds":["PARENT","CHILD"]}`
can process the chain in order; `land-ready` resumes waiting finishes after their
parents land. A child never supplies its parent's acceptance merely by containing
its source. Operation IDs retain the original start/sync selection on replay,
including interruption after working files were applied.

Stack landing detection checks Candidate inputs before traversing source ancestry,
so unrelated acceptance history does not re-read every source tree for a new stack.
`status`, `peers` and `pending` show the stack chain and parent movement,
abandonment or landing in one line. A missing parent record reports `parent-missing`;
a stack without a parent ID reports `parent-unknown`. Chain traversal stops at
missing parents or cycles and reports `chainStatus` instead of inventing ancestry.
Detached stacks stop at main. Child briefs include the parent's latest
handoff; child handoffs retain its pinned fields and `handoff-read` also returns
the latest parent handoff. Missing handoffs are reported as absent.

Hosted parent notices (Issue dc62b120). A Lane stacked on another is told when its parent changes,
so it never lands on or waits for a parent that moved. Each direct dependent gets one board note from
the parent (`board.notices` on its next Lane action, and a blocked `wait` returns early with
`reason:"message"`), naming the event and the exact command: the parent **saved** a new head (`Your next
save restacks onto it if clean; now: nforge agent . sync '{"laneId":"CHILD"}'`), was **abandoned** (`Unstack onto main: ... sync
'{"laneId":"CHILD","ontoMain":true}'`), or its **landing failed or was cancelled** (unstack, or restack
after the fix). One note per event per dependent: further parent saves stay quiet until the child
restacks, an abandonment is announced once (the landing it cancels adds nothing), and a landing failure
is announced once until the parent is saved again. A two-deep chain is told level by level: the middle
Lane's restack is a save, which tells the newest. There is no polling or timer; a stopped board
(operator switch) sends none. Cost: a Lane nobody stacked on pays nothing new on save or abandon.
A stacked start adds one dependents row and a flag on the parent's overlap row; a parent event reads
that parent's dependents (at most 20) and writes about 5 rows per dependent. A failed or cancelled
landing reads one empty dependents range in a project without stacks; only a project that has stacks
resolves the landing's Lanes.

Hosted automatic restack (Issue f61e9339). When the parent saved newer work, the child's next `save`
restacks it with no extra step: after the save completes in the child's own checkout, Forge runs the
ordinary hosted `sync` with `cleanOnly:true` (operation id derived from the Lane, its saved head and the
parent head, so a retried save replays it). If it applies cleanly, the child's head and stack pin move
onto the parent's newest saved head and the checkout installs it; at that moment the working copy equals
the just-saved head, so no unsaved work is at stake. The save receipt reports `restack` with `status`
(`restacked`, `conflict`, `failed` or `in-progress`), the parent Lane and head, the previous head
(`from`, kept in `lane-history`) and the new `head`. If it would conflict, nothing changes: no conflict
files and no resolution Lane, the receipt names the manual `sync`, and later saves do not retry that
parent head; the parent's next save re-arms it. `sync` without `cleanOnly` keeps the normal conflict
flow. An abandoned, landed or failed parent is never followed automatically: its notice above names the
command. Other Lane actions show the pending restack as `stack` (`restack:"ready"` or `"conflict"`).
`land --save` does not restack: landing already composes the child onto its parent or onto main. Cost: a
Lane without a stack reads nothing new; a stacked Lane's action adds one point read of its dependents row;
a parent save also writes its newest head to each dependent's row (one small patch per dependent, at
most 20); one sync operation runs per parent change per dependent, only on that child's save. Idle costs
nothing.

Stacked owners use Work format 21 (legacy Intents) or 22 (unified Intents).
Readers capped at 20 reject these owners before writing, preserving stack pins.
Ordinary owners keep their existing format. These formats and commands concern
native owners; Git compatibility Lanes retain their existing workflow.

Peer Lane observations include `landing` advice from the retained handle and
indexed check records: `editing`, `checked-green`, `queued`, `in-batch`, `failed`
or `landed`, the latest check for that saved head, and `suggestedAction`.
The same projection decorates lifecycle peers, MCP peers and status peers without
joining the owner writer queue. A later save never borrows a prior head's green run.
