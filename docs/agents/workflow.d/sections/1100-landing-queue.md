### Landing queue

The server gates publication on `verify`, or the only definition, regardless of
the check selected by a submitter. The owner person may explicitly review another
defined check. Contributor fresh checks, composes and submissions each have a
300-operation UTC-day budget; operation-id replays do not consume another unit.

Direct submissions without a finish driver hold queue order only when checked, for
at most 60 seconds after settlement begins. If they are not accepted, the existing
60-minute progress deadline ends them with `LANDING_STALLED`; submit the same Lane
again to retry. Reservations require a finish driver and end on a recorded stall.
Revert metadata requires the retained reverse composition so its lineage is checked.

The existing Now, Lane and Intent views share the saved submission projection. Waiting
for a machine stays separate from a failed code check. Only review stops and current
code failures enter Needs you; current repair notices link to their recorded run and,
when present, their repair Intent. Historical notices stay in the Lane timeline with
Earlier, and later saves retain the earlier head's outcome without submitting new code.
The Channel strip uses the owner's last landing event, never a heartbeat. Hosted
copies without queue or worker observations preserve their existing display.
The projection embedded in ordinary Work status uses saved records without an
observation timestamp, elapsed ages or live worker observations, so unchanged reads
retain CLI/MCP parity. The dedicated pending read adds current observation
times, ages and worker observations; saved event times remain in both.

Initial checks on different Lanes run in parallel through the machine-wide check queue. A passed candidate then joins the **landing queue**, one FIFO slot per local owner and Channel. All local CLI/MCP acceptances, including a person's, use this slot. If main moved during the optimistic check (`CHANNEL_CHANGED`), finish releases the slot, syncs the Lane to current main, composes a new Candidate and runs the pinned check again through the machine queue. It rejoins the queue only to accept with expected-head CAS. Check-only work and other Channels remain independent; another move can require another pinned attempt. Every writer sharing an owner must run the upgraded implementation to participate.

`maxRetries` defaults to **3 retries after the initial attempt** (at most four checks); `0` disables automatic retries. Queue waiting consumes no retries. Each attempt has deterministic child operation IDs, pinned Channel/source inputs and its sync/Candidate/run/error in `attempts`. `landing` records observed queue positions and `waiting to land` / `landing` transitions. With bounded `waitMs`, a waiting receipt has `phase:"accept"`, `status:"waiting to land"`, `position` and `terminal:false`; replay the original request plus `resolved` to continue. Ending a bounded invocation releases its ticket; resuming rejoins the queue. A stopped or killed process releases its slot through PID/start-identity recovery. Retry pins and the original terminal receipt are retained alongside local Work in `agent-finish/`; keep that directory when recovering an in-progress finish on the same owner. Canonical child operations remain in Work. An exhausted budget returns `retry-exhausted`, `code:"CHANNEL_CHANGED"` and every attempt; a new operation starts a new budget. Check failures and sync conflicts stop immediately.

Configured native runners can check queued code candidates as ordered prefixes; `land-ready` resumes retained batches and cancellation preserves earlier passing prefixes. A batch pins its selecting driver's clean environment snapshot for runs and resumed drivers. Incompatible entries report changed field names; legacy entries without a snapshot report a fingerprint mismatch. Finish skips another check/audit for already-accepted source only when every input Lane/head has recorded acceptance in the destination Channel's retained history, then applies the configured completion policy. See [landing batches](../../../operations/landing-batches.md).
