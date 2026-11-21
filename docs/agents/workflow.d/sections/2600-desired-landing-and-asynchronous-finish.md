### Desired landing and asynchronous finish

`land` returns after recording the desired saved heads, with
`handle:{operationId,entryIds}` and the current `phase`. `wait:true` or CLI `--wait`
watches that handle; the caller never becomes its controller. `finish` also
supports durable submission with `wait:false`. Finish checkpoints first; land
selects saved heads and leaves unsaved edits alone.
The owner worker then drives the retained request. Disconnecting the caller does
not cancel submitted work. If no owner worker is running, the receipt says so;
the submission stays pending until the owner service starts.

Read `nforge agent OWNER landing '{"operationId":"UUID"}'` after reconnecting.
This is read-only, including for completed work. Replaying the submission keeps
its source pins and original outcome. A different operation for the same Lane/head
reuses pending or landed entries. After a terminal failure (including cancellation),
a fresh operation ID creates a new submission without requiring a save or sync.
Mixed selections reuse pending or landed entries and submit the remaining heads. `wait` is excluded from the request identity. Synchronous `finish`
retains its existing protocol.

For a hosted project, a
short `finish` request without an `operationId` reuses the original operation
while its outcome is pending or unknown. After a terminal outcome, it reuses the
operation only if its saved Lane heads and the primary Lane bytes that finish
would capture are unchanged. Changed source starts a new operation; its receipt
names the previous operation in `supersedes`. A lost reply with unchanged source
still reconciles the original work without another checkpoint or check.
An explicit UUID always retains its exact request, regardless of later edits.
Reconnects may supply the original resolved source/check/dependency pins; the
owner compares them with the retained finish, rather than treating filled
defaults as changed caller inputs. Later unsaved bytes stay out of pending or
explicit replay. The owner worker resumes check-only submissions through the same
native admission boundary. A pending check-only receipt includes `waitingOn`:
the owner root and worker observation before execution, the exact declared
landing dependency, or the run ID, status and observed controller while checking.
These observations do not start another run or accept source.

For a bound project under hosted source authority, uploaded source preparation
precedes hosted admission. The hosted goal then survives the initial composition
job, checking and acceptance without the client or owner Mac. Its controller
retains a fenced reconciliation wake before advancing. Preparatory upload/save
receipts remain explicit; they do not claim hosted queue admission.

Queued entries whose content is already on main or empty against their base settle
without a check or Channel move. A newer saved Lane head settles the older queued
goal as superseded, naming the replacement and retaining the original source.
These terminal outcomes are returned through the original requester handle.
Native queue observations reuse no-op composition for unchanged submitted source and
accepted main. View or saved stack changes invalidate that result; stacked entries
also revalidate retained parent and landing evidence. Stall deadlines read live
entry headers and selected batch/run progress; terminal continuations follow each
prefix's exact run ID without hydrating unrelated run evidence.

After 15 minutes without a recorded run, batch-step or acceptance event, pending
native entries expose `stall:{code,step,missingOwner,lastProgressAt,alarmAt,message}` in
receipts, `status --pending` and landing observations. A missing wait reason is
reported as `unrecorded-wait`, with the landing controller named. Hosted queued
entries count queue-head progress too: a live predecessor or queue owner suppresses
the follower alarm, and an ownerless wait names the predecessor it waits behind.
A `LANDING_STALLED` observation follows its receipt's exact repair command for the
original operation. Do not resubmit a live landing: a replay resumes its retained
operation and cannot restart a running check. When no repair command is available,
read `queue {}` and `observe {operationId}` first. If the receipt explicitly records
`terminal-failed` and directs a retry, fix the cause and retry in the same Lane.

Queued receipts show position, entries ahead, live predecessor and an approximate
ETA based on shared-check groups and observed parallel service waves. Native workers
own one deadline while unalarmed work is pending. Hosted entries retain one alarm
deadline, transfer it during admission and cancel it at settlement. Reading never drives or repairs the queue. Real progress clears
the alarm and starts a new deadline. A hosted queued entry reaching its alarm deadline retains
one orphan-recovery deadline 60 minutes after its last progress (the dropped-landing limit);
entries waiting for review or a dependency never get one. Checking entries keep
the run lease watchdog. At the checking alarm, Forge can also look up the
original Actions execution and collect its retained shard results when no report
fold was recorded. Members of a shared run use one recovery with the existing
bounded provider confirmation schedule. An active HTTP collector keeps its
lease, and provider success still needs the original shard evidence. At the deadline Forge re-drives the entry (a cohort
stuck composing is split into halves that compose apart); if that makes no progress and nothing is left to drive it
(not claimable, no pending attempt of its own, no batch peer holding the fallback
turn or a run), Forge ends it as `terminal-failed` with `LANDING_STALLED` and a
reason through the cancellation path, so the requester gets an outcome and batch
peers are re-selected. While something live still drives it, the deadline re-arms
at 2, 4, 8 and 16 hours and then stops; it never ends live work. Cancelling a
batch member hands the individual fallback turn to the next member at once. Idle and settled queues have no recurring
alarm wake. The hosted preparation watchdog grows from 30 seconds to one hour
while no progress is recorded (three controller calls per hour at that cap);
source completion still wakes it immediately.

Native receipts include `durable`, `landingWorker` and `observe` commands for
`landing`, Lane `status`, `pending-status` and `wait`. The caller holds no source or Work lock
while waiting on checks. Admission does not start or install an owner service.
