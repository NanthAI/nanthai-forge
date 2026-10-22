# Local landing batches

Native `finish` operations with an explicitly configured check runner queue code
candidates in Work format 17 (18 with unified Intents). The managed owner worker resumes incomplete batches and dependency waits.
`land-ready` remains an explicit finite recovery command. Legacy projects without a runner policy retain their existing
finish protocol. Git, protected paths, supervised review, invariant-pinned
acceptance and docs-only candidates retain the ordinary finish path. Applicable
passing evidence can still use the disjoint fast lane, which checks queued paths
as well as changes on main before overtaking.

A drain selects up to four ready candidates (eight on a remote runner) with compatible
check, runtime and lifecycle pins. A local runner never waits for a batch to fill. Entries are
ordered by `finish` priority (`urgent`, then `normal`) and original arrival. After
two entries from one submitter, later entries yield one position per round to
other submitters in that priority class. This changes order without imposing a
quota. Requeued entries retain their arrival timestamps.

The batch retains its base, ordered entries, cumulative prefix Candidates, conflict
Candidates, deterministic run IDs, attribution and acceptance receipt. Source pins
are immutable even if an input Lane advances. A composition conflict ejects that
entry and composition continues. Checks run outside Work, Lane and landing
locks. The selector receives the union of candidate changed paths, so tooling
changes retain the full-check override.

## Durable finite driver

The drain advances recorded batches through selection, composition, check reservation,
evaluation, acceptance and completion. Selection pins the original batch and inputs;
composition publishes its prefix Candidates and run IDs together. Each check is
reserved under that original run ID before execution. Evaluation retains an optional
`settlement` cursor naming the passing/failing prefixes and cancellation boundary.
A resumed evaluated batch continues at acceptance without dispatching checks again.
Older batches without a cursor recover from their existing Candidates and run evidence.

Acceptance keeps its original deterministic operation ID and expected-previous CAS.
Recovery reconciles that canonical receipt before comparing speculative parents or
current main, including when main advanced again after the lost reply. Acceptance
replay also reconciles interrupted lifecycle work without moving main twice. A
cancellation after evaluation invalidates the cursor and evaluates the applicable
prefix using its own exact check evidence.

The existing per-channel drain queue admits one driver; a competing finite call can
observe its waiting position. Each admitted driver claims a monotonically increasing
generation in the owner-local `landing-drivers` journal. Selection, composition,
check reservation, evaluation, acceptance and final entry publication revalidate
that generation inside their short Work critical section. A replaced driver cannot
publish those transitions. Late check receipts still attach to the original run;
replacing a driver does not cancel or restart that execution. No locks are held
while checks execute or while their outcomes are observed. A saturated drain
observes without writing unchanged Work.

The cursor is additive and optional; current older writers preserve unknown record
fields. The generation journal does not change Work's format, revision or queue
contents. Keep it with the owner-local control journals on recovery; canonical
Candidates, runs and Channel receipts remain in Work. There is no new writer-upgrade
requirement. The same finite drain is used by finish, `land-ready` and the managed
owner worker below.

## Stacked Lanes

After a stack parent lands, single and batch landing reapply the saved child's
delta from its pinned parent base onto selected current main, using sync's
three-way merge. The composed Candidate retains its original Lane/head inputs
and records the selected main; neither saved Lane metadata nor working files are
rewritten. Parent-only updates and unrelated accepted work stay on main. This
also handles whole-file replacements when main equals the saved parent's version.
Each level in a deeper stack retargets after its own parent lands.

Real conflicts retain the original States and name accepted Lane deltas that
touch the conflicting paths, excluding unrelated accepted inputs and inherited
parent source. Resolution uses the existing sync/checkpoint flow. See
[stacked Lanes](../agents/workflow.md#stacked-lanes).

## Remote bursts

Modal and GitHub Actions checks do not share the owner's CPU, so a burst need not queue
behind one check. Before the first check of an idle channel, the drain waits until
`acceptance.batchWindowMs` (default 2000) after the oldest queued entry, or until a
batch is full. Entries arriving while a check runs form a speculative batch stacked on
the newest active one: its base is that batch's final prefix, so its exact-head check
covers main as it will be once the parent lands. Up to `checks.concurrency` batches
(default 4) are checked at once. A stacked batch accepts only after its parent
finished and only if main equals its recorded `previous`; its failure verdict is
trusted only then. If the parent landed a shorter prefix, failed or was cancelled, the
stacked batch is superseded and its entries requeue at their original age for a check
on real main. A restarted driver adopts every recorded batch in order. Local runners
never stack or wait.

A passing batch moves main once, with every included Lane head recorded in its
Candidate. A remote failure (Modal or GitHub Actions) checks all proper prefixes in one parallel round, lands
the longest passing prefix, and attributes the next entry to its exact failed
run. The remaining entries requeue. Local runners halve the prefix interval
instead, only accepting a prefix that passed its own exact-Candidate check. Interrupted
or cancelled checks remain distinct from failed checks. `cancel` also accepts a
queued entry operation ID: it ejects that entry, checks and lands only the prefix
before it, and requeues the later entries. Already accepted work is retained.

If main advances while checking, acceptance uses the existing manifest-disjoint
proof when available. Otherwise it retains the old attempt and requeues on the
new main. A restarted driver adopts persisted Candidates, runs and acceptance IDs;
a lost acceptance reply never causes another Channel move.

Every batch acceptance requests the existing coalesced full-main audit, including
when the landing check was full. Audit failure creates the existing fix-forward
Intent without rolling back main by default. Opt-in [optimistic landing](optimistic-landing.md)
can compensate attributed failures under trusted policy. Modal audits use a separate capacity queue so
audit execution cannot occupy a landing-check slot. Audits do not block the
acceptance response. Modal budget enforcement is separate from batching.

Format 17 adds `landingEntries` and `landingBatches`; it does not activate the
historical unified Intent format 16. Format 18 composes unified Intents and
batching; explicit Intent migration converts formats 15, 16 and 17 to 18. Batch
writes preserve the unified representation.

Selecting a batch with more than four entries promotes Work to format 19 (legacy
Intents) or 20 (unified Intents) before publishing it. Four-entry batches retain
formats 17/18; later smaller batches never downgrade a promoted owner. Current
readers retain both the old four-entry and new eight-entry shapes, including
previously written formats 17/18. Explicit Intent migration maps format 19 to 20
without changing batch pins, and a migration retry preserves format 20. Portable
snapshots, record pages and hosted projections retain the format and entries.
Readers capped at format 18 reject 19/20 with `WORK_UPGRADE_REQUIRED` and
“upgrade nforge” before reading records or preparing writes. Upgrade all writers
sharing the owner before creating a larger batch. Writers must support the owner’s
current format. Original source, checks, conflicts and acceptance history remain
retained. Undo accepted work through a checked compensating change.

## Submission observations

Landing receipts add a `submissions` array per saved Lane/Intent input. Each
`submissionId` is deterministic from its retained operation and Lane/Intent IDs;
replaying that operation preserves the identity and selected `head`. `land`
uses the retained per-entry child operation; `finish` uses its parent operation,
including when overlap ordering delegates to child landing entries.
`entryOperationId` identifies that child without replacing the submission's
operation identity. A new request has a new submission identity. Changing a payload under
the same operation remains `WORK_OPERATION_CHANGED`.

`attemptId` identifies a particular landing try, separately from its check run
and provider execution. Batch selection derives it from the entry and batch IDs;
a requeued entry on another batch gets another attempt, while adoption retains
it. Ordinary finish uses the existing attempt operation ID; single-entry land
uses its retained attempt ordinal. Before an attempt is selected it is null.
Existing Work and driver journals need no migration to expose these fields.

The additive `state` is `pending`, `terminal-failed`, `landed` or `superseded`.
Pending reasons are `queued`, `checking`, `waiting-for-review` and
`waiting-for-dependency`. Pending is never a failed verdict, and review waits
have `terminal:false`, `complete:false`. Failure `cause` is `conflict`,
`check-failed`, `infra`, `stale-head` or `rejected`; cancellation retains its
existing status and projects as rejected. Runner interruption/unavailability is
infra evidence, not a failed source check. These labels do not add retry policy.

A newer saved Lane head makes the original submission observation `superseded`,
with `complete:false`; `outcome` retains its original pending, failed or landed
observation. The original `head`, operation, attempt and acceptance evidence stay
unchanged. Unsaved edits do not change this saved-head observation. Finish's
recorded sync head (`attemptHead`) belongs to its attempt, so syncing within that request alone
does not supersede it. Supersession is observational: it never cancels a driver,
discards source, or marks the newer save landed. The original pinned request may
still progress. Explicit review acceptance settles the reviewed Candidate.

Lane `status` and pending-status JSON expose these same submissions, including
pre-Candidate dependency waits retained in local journals. Compact pending text
shows one line per displayed Lane, within its existing 15-line budget; full JSON
retains all inputs. `land` includes one summary line per input Lane. Existing
entry statuses and counts remain available for compatibility; automation should
use submission state/reason/cause to distinguish waiting from failure. Canonical
Work records override stale local batch observations. These adapters do not start
a worker, run checks, or change acceptance policy.


## Managed owner lifecycle

The existing `serve`/MCP owner lifecycle and detached presence worker also drive
submitted native landing batches. No separate landing daemon is created. Start
`nforge serve OWNER --port 4173` to recover retained work immediately. An observer
client can disconnect while the owner service keeps running. A local Mac cannot
drive while powered off; starting the owner again reconciles saved work.

The landing worker registers wake sources before scanning, then rechecks after
registration and each sweep. Durable Work publication wakes enqueue, check
completion, cancellation, review and Channel/dependency changes through a private
local notification socket. Native filesystem notifications also cover `work.json`,
finish/land journals, exact-run `result.json` receipts and batch queue release.
These are invalidations: saved records and original operation IDs are the authority.
Startup repairs missed notifications. New land journals retain their exact parent
request and selection so dependency waits replay the original pins. Retained finish
dependency waits also resume without a person invoking `land-ready`.

Idle landing workers have no polling timers, hosted subscriptions, Work writes
or hosted writes. Local service observations live beside the driver journals in
`landing-workers`; they update on lifecycle events, never as a periodic heartbeat.
Pending status reports service state, live process identities, last event time,
queued/checking recovery count and dependency waits. An unavailable worker leaves
submissions pending, not failed. Existing presence and hosted-listener schedules
are separate from landing wake sources. Readers never start a landing worker.

Shutdown stops driving and fences further controller publication, without
cancelling the submitted jobs. A restarted worker adopts original batch, Candidate,
run and acceptance IDs under the same channel drain queue and generation fence.
Multiple owner processes can observe; only the queue holder drives a channel.
Runner/controller infrastructure recovery retains its existing semantics: no
arbitrary local command is automatically rerun merely because its runner died.

### Owner Mac launchd setup

The lead installs the existing `serve` process using
`scripts/launchd/com.nanthai.forge-owner.plist`. Replace `__NODE__` and `__CLI__`
with absolute paths to the supported Node executable and the reviewed installed
`dist/cli.js`; replace `__OWNER__`, `__PORT__`, `__NODE_BIN__` and `__STATE_DIR__`
with the canonical owner, selected port, Node directory and a private log directory.
Use XML escaping for replacements. The template contains no credentials. Preserve
any owner-selected environment configuration in the existing service setup; do
not embed secret values in the plist. The CLI startup URL contains a local token,
so keep its log directory private and never copy those logs into a report.

After installing the reviewed build and writing the substituted plist as
`~/Library/LaunchAgents/com.nanthai.forge-owner.plist` (mode 0600), the lead runs:

```sh
plutil -lint "$HOME/Library/LaunchAgents/com.nanthai.forge-owner.plist"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.nanthai.forge-owner.plist"
launchctl enable "gui/$(id -u)/com.nanthai.forge-owner"
launchctl kickstart "gui/$(id -u)/com.nanthai.forge-owner"
```

Observe local pending status to confirm recovery. Stop driving with
`launchctl bootout "gui/$(id -u)/com.nanthai.forge-owner"`; saved submissions
remain. Re-enable with bootstrap/enable/kickstart. Accepted history is retained;
undo accepted source through the existing checked compensating change. These
commands are lead installation steps, not actions performed by a finite agent.
