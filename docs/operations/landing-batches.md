# Local landing batches

This page describes the native-owner landing path used by local projects. The dogfood project has landed through the hosted queue since the cutover on 2026-10-28, so most of this page does not describe how Forge lands its own work. The native-owner path and its worker are deleted with B1.9 (owner decision 2026-10-31).

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

Before combining entries, the controller requires a passed full solo gate for each exact submitted head or the same Q3 reuse key on that base main. Check-only `finish` and Lane `run` supply this evidence. An unchecked entry receives a singleton admission check with the full-test override; green entries return to selection for batching. With no other entry waiting, that checked singleton can land directly. Explicit partial test lists and multi-entry combined results never supply solo evidence for one of their inputs.

A failing solo check settles its entry as terminal-failed with the reported failing test files. It does not enter prefix diagnosis. Its retained result remains visible in the existing repair-lineage notices. Prefix diagnosis remains available when individually green entries fail only in combination. Gate evidence is re-observed against the current definition, declared inputs and accepted main. Already-green entries can still join speculative combined batches; unchecked entries wait for an admission check on accepted main. Acceptance still requires an applicable exact-Candidate check.

The batch retains its base, ordered entries, cumulative prefix Candidates, conflict
Candidates, deterministic run IDs, diagnostic observations and acceptance receipt. Source pins
are immutable even if an input Lane advances. A composition conflict ejects that
entry and composition continues. Checks run outside Work, Lane and landing
locks. The selector receives the union of candidate changed paths, so tooling
changes retain the full-check override.

## Submission and execution environments

A queued submission retains the submitting Node version, canonical executable and
binary digest, platform/OS/architecture, a content digest of the installed Forge JavaScript modules, packaged runtime helpers and declared dependency versions,
check definition and clean check settings. Worker admission compares those pins.
On worker admission, queued entries whose only changed fields are Node version,
executable location or binary digest are automatically re-pinned after checking
the original source/check definition and all other environment settings. Arrival
order and entry identities remain unchanged. `runtimeRepins` records the event,
changed field names and old/new execution pins; a fresh batch/run checks the new
runtime. No previous passing evidence is transferred. Unstarted selected batches
are superseded before re-admission. CLI content, check definition, platform/OS/
architecture or check setting changes (including `FORGE_CHECK_SCOPED` and
`FORGE_CHECK_FULL`) still interrupt before dispatch and name only changed fields.
Configure the owner service and submitter with the same installed build and check
settings, then submit a new finish/land operation. The original evidence remains
readable. Node upgrades need a service restart to load the updated generated
workflow; queued Node-only entries no longer require manual resubmission.

Shell defaults (`PATH`, `TERM`, `LANG`, `TZ` and `LC_*`) come from the owner worker.
Different shell defaults do not invalidate a submission, unless a check explicitly
names them in its environment/credential passthrough declarations. Selection records
the worker's complete clean environment and fingerprint in the batch; its checks and
acceptance use that exact snapshot, including `PATH`. Existing exact-check admission
and evidence reuse still compare full fingerprints. Compatible submissions with
different shell defaults may share that worker snapshot; submitting a shell path
does not select the worker's tools.

Async finish/land journals retain submission pins before returning, including when
a dependency delays enqueueing. Restart retains original source/check pins. Node-only changes take the recorded
re-admission path above; a retained batch cannot start under different CLI content
or physical host pins. Install builds immutably and restart the service when
upgrading. Old records remain readable: environment snapshots retain their recorded
Node version and check settings; entries with only a legacy fingerprint require an
exact match because their compatibility cannot be established from missing details.
Previously selected legacy batches still recover their recorded run snapshot.

Use `nforge land ROOT LANE_ID OTHER_LANE_ID --wait --operation-id UUID` for a
complete selected wave instead of a shell resubmission loop. The JSON result
includes a per-Lane `table`; stderr prints it too. Failures exit nonzero. Replaying
the same operation preserves failed checks and conflicts. New parent journals
serialize duplicate Lane/head admission, including ordinary non-batch work; batch
land admission reuses existing handles for duplicate pinned inputs; the low-level
finish queue retains its original request identity checks.
An entry whose composed files and modes are already on main ends as `accepted`
with `alreadyOnMain` (the containing main head), no check, no acceptance and no Channel move or
post-accept audit; its Lanes complete under the usual completion policy. Different
State metadata or merge parents do not require another check. The retained entry
establishes landing of its exact Candidate and Lane/head inputs for dependencies,
including stacked children; unlanded siblings and newer saves still wait.
A queued entry whose input saves all predate their Lanes' completion never runs:
it lands this way when main contains it, otherwise it ends `cancelled` with a
reason (reopen the Lane and
finish again to land it). Saves made after completion use the ordinary landing
path even if lifecycle metadata still says completed. Retained duplicate entries
for the same Lane/head are selected one at a time; later copies then end already on main.
Infrastructure recovery retains its entry and records `infrastructureRetries`;
unavailable runners and budget decisions remain explicit terminal outcomes. Ambiguous dispatch recovery follows the
original provider journal/run, without an additional submission or dispatch.

## Durable finite driver

The drain advances recorded batches through selection, composition, check reservation,
evaluation, acceptance and completion. Selection pins the original batch and inputs;
composition publishes its prefix Candidates and run IDs together. Each check is
reserved under that original run ID before execution. Evaluation retains an optional
`settlement` cursor naming the passing/failing prefixes and cancellation boundary.
A resumed evaluated batch continues at acceptance without dispatching checks again.
Older batches without a cursor recover from their existing Candidates and run evidence.

Every queued entry omitted from selection retains `waitingFor`: the blocking rule,
reason, predecessor entry IDs and their exact Lane/head inputs when applicable.
Overlap, duplicate inputs, active check capacity, batch size and incompatible batch
pins are distinct rules. The next selection refreshes these observations; arrival
age stays unchanged. Admission records initial overlap and capacity waits in its
existing transaction, so unchanged wait observations do not publish Work. Canonically accepted prefixes stop acting as overlap blockers
even before their entry-settlement publication completes.

Checking entries expose the batch and run IDs they wait for. Once checks have
observations but publication is pending, `waitingFor.rule` is `settlement`.
Status reads derive this from canonical batch/run records, so lock contention
cannot disguise a settlement wait as a live check. Reads do not publish progress
or restart a run. Existing driver adoption handles retained batches.

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

Check admission returns Work-lock contention to its existing asynchronous retry
loop, including finite drains outside the owner worker. This lets earlier FIFO
writers on the same event loop advance while parallel diagnostic checks reserve
their original run IDs.

The cursor is additive and optional; current older writers preserve unknown record
fields. The generation journal does not change Work's format, revision or queue
contents. Keep it with the owner-local control journals on recovery; canonical
Candidates, runs and Channel receipts remain in Work. There is no new writer-upgrade
requirement. The same finite drain is used by finish, `land-ready` and the managed
owner worker below.

## Overlap planning and observation

The durable selector consumes the existing saved-region overlap plan, including its
ready/smaller/earlier-start order and connected groups. Within that order, disjoint
entries can share a compatible batch. A high-overlap successor waits for its
submitted predecessor to settle, then composes on actual accepted main before
checking; it is never speculatively checked across that overlap edge. Predictions
and bilateral notices remain advisory and require no acknowledgement. Existing
priority, submitter fairness, runner shapes, dependency and acceptance rules remain.

`wait` emits `train` events for channels containing the selected Lanes' submissions.
Each snapshot names the submitted entry order, exact input heads, overlap groups,
coverage and predecessor entry IDs (`waits`). An empty queue reports `idle`. These
are the same derived predictions used by selection, not a guarantee of a future
batch or evidence of semantic compatibility. Incomplete analysis remains explicit.

The stream also delivers the overlap slice's durable `notice` records to either
participant, with original heads, paths and proposed order. A notice is marked
`historical` when a participant has a different saved head. New saves are analysed
for new submissions; an already queued request retains its original heads and
predictions. Wait cursors deduplicate both notices and unchanged train snapshots.
Observation starts no checks or driver and writes no Work or coordination records.

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

GitHub Actions checks do not share the owner's CPU, so a burst need not queue
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
Candidate. A remote failure (GitHub Actions) checks all proper prefixes in one parallel round, lands
the longest observed passing prefix, and records the next entry's failed prefix
run. The remaining entries requeue. Local runners halve the prefix interval
instead, only accepting a prefix that passed its own exact-Candidate check. A
failed prefix is evidence about that exact combination on its recorded base;
it does not establish a standalone or minimal failing Lane. Halving does not
assume monotonicity for attribution or promise the longest passing prefix. Interrupted
or cancelled checks remain distinct from failed checks. `cancel` also accepts a
queued entry operation ID: it ejects that entry, checks and lands only the prefix
before it, and requeues the later entries. Already accepted work is retained.

## Retained failure diagnosis

Each scheduled prefix probe has a diagnostic node reserved in the batch before
external execution. Its ID is the original child run ID; parent links retain the
split path. Nodes retain ordered entry IDs and saved Lane/head inputs, base/previous main, Candidate/head,
check definition and runtime fingerprint, observed status/cause and the selection
reference. The canonical run retains exact Lane/dependency pins, executor plan,
physical executions and logs. Unknown selection stays explicitly unknown; a plan
pin or command-reported selection is recorded when available.

Restart traverses the same prefix plan, reconciles reserved nodes from canonical
runs and adopts unfinished executions under their original IDs. Completed exact
checks are not dispatched again, including when the driver stopped between a
child result and its diagnostic publication. Cancellation re-evaluates only the
applicable prefix; earlier observations remain retained. Pending infrastructure
is inconclusive and remains resumable under the existing adapter's semantics.
Structured runner/preparation errors and failed non-executions without an exit
or signal remain inconclusive instead of triggering source bisection. Signal
failures and exit 137 remain failed checks; they do not prove transient infra.

When a remote full prefix fails and every shorter prefix passed, attribution waits
for one fresh check of the same full Candidate. Rechecking the whole selection
includes the failing files and preserves the existing exact-Candidate acceptance
gate, including interactions with earlier entries. `confirmation` retains the
original failed run, the deterministic confirmation run, known failing file names
(or the selected files when per-file verdicts are unavailable), and its verdict.
Custom checks without file evidence retain an empty file list. A passing rerun
records `flake` for that observation and lands the full checked prefix; another
failure records `confirmed` before the boundary entry ends failed. Infrastructure
or cancellation remains inconclusive. Reservation precedes dispatch; restarting
adopts the same confirmation operation and never schedules a third observation.
Original failed diagnostic nodes remain visible. This confirmation also applies
to retained evaluated batches before they attribute the boundary.

Finish and land receipts expose `diagnosis`, including observed failing sets,
the smallest **observed** failing set and `minimization: "incomplete"`. The legacy
`culpritId`/`culpritViewId` fields identify a boundary entry/prefix only; they do
not assert minimal blame. Parallel diagnosis retains earlier failed prefixes even
when a longer prefix passes. A full passing batch still accepts atomically,
without requiring every intermediate prefix to pass.

Accepted main transitions also schedule a finite background precomposition window
of up to 50 queued submissions, including members of a waiting group. Two metadata
passes of ten entries start potentially overlapping or unknown-coverage source
before warming the next ordinary unchecked known-disjoint entry. Groups, fallback
members and independently checking entries keep their existing preparation for
disjoint changes. Later proven-disjoint entries keep
ordinary queue composition, avoiding quadratic clean recomposition on every main
move. Each probe
retains the original input/dependency pins and uses the ordinary verified source
worker. It reserves no check and does not change group membership. A clean result
is cached against its immutable original selection and exact main receipt for a
later individual retry, including fallback metadata-attempt rotation. Installation
checks those exact input/dependency roots and main again. A useful queue claim
atomically takes source ownership from a pending probe before preparing its train
or check. The old IO wake and compose-completion binding are fenced; late probe
results cannot replace the claimed preparation. An individual retry can adopt the
same source operation only on its exact main head and receipt. A failed adopted
probe yields to a fresh ordinary composition without failing the submission.
A real conflict immediately settles the waiting submission with
`COMPOSITION_CONFLICT`; its error message names the retained resolution
Candidate, the first ten conflicting paths (with an additional-file count and
complete R2 conflict pages) and the input Lanes of the main transition. The signed
summary stays in internal compose metadata; released Candidate and pending-attempt
DTOs retain their strict shapes for already-running agents. The next
status, observe or active wait sees this canonical outcome before queue selection.
No client read starts probes, and idle queues schedule no precomposition work.
The existing first post-publication completion tick starts this work; ordinary
acceptance adds no queue read or scheduling write to its final CAS. The trigger
retains receipt IDs and resolves the accepted Candidate by its signed digest in
the background, keeping path lists out of publication scheduling metadata.
Delayed events keep their earlier path and Lane context while each new job pins
actual current main, so a newer disjoint landing cannot hide an older conflict.
If main moves during a probe, that event retains one latest target and its peer
Lanes. Completion resumes that target before returning the entry to the queue;
repeated deliveries neither cancel the running source job nor duplicate it.
The retained revision and peer context stay together even if a newer main event
has not arrived. Clean probes do not rewrite public progress or re-arm stall timers.
An obsolete conflict on an earlier accepted head is retained as an artifact;
the latest notified compose or ordinary current-head continuation decides the
outcome, so a later main fix cannot produce a stale terminal conflict.
Probes retain queue eligibility. When the head reaches its pending probe it keeps
the existing queue lease, which completion releases immediately; later probes
finishing first cannot jump older entries into the train.
Entries outside the optimization window retain ordinary queue composition.

Source ancestry reduction proves a cut relative to the selected roots. It reduces
verified parent paths in descendant-first order, so prefetching the shared base
cannot force traversal below it. Frontier scheduling investigates unresolved
branches above a known common ancestor before fetching its older history; deferred
IDs remain pending until the proof is complete. Unknown side branches and cycles cannot prove a
cut; recursive merge bases, source bytes and exact hash verification are preserved.

Passing independent halves or pairs never licenses accepting their union. Later
queued entries are recomposed and checked on actual main after a passing prefix
lands; evidence from the old composition is not transferred. Candidate dependency
closures stay intact and pre-Candidate dependency waits remain pending. Speculative
child observations stay provisional until the actual predecessor matches; a
superseded batch keeps historical diagnostics. This strategy checks prefixes,
not arbitrary subsets, and makes no exhaustive or minimal-set search claim.

If main advances while checking, acceptance uses the existing manifest-disjoint
proof when available. Otherwise it retains the old attempt and requeues on the
new main. A restarted driver adopts persisted Candidates, runs and acceptance IDs;
a lost acceptance reply never causes another Channel move.

Every batch acceptance requests the existing coalesced full-main audit, including
when the landing check was full. Audit failure creates the existing fix-forward
Intent without rolling back main by default. Opt-in [optimistic landing](optimistic-landing.md)
can compensate attributed failures under trusted policy. Audits do not block the
acceptance response.

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
operation identity. A duplicate land request references the existing submission identity. Changing a payload under
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
does not supersede it. Outstanding agent goals end as superseded with the newer head named. Shared
checks and all source evidence remain retained; the newer save is never marked
landed by that outcome. Explicit person review retains its exact Candidate.

Lane `status` and pending-status JSON expose these same submissions, including
pre-Candidate dependency waits retained in local journals. Compact pending text
shows one line per displayed Lane, within its existing 15-line budget; full JSON
retains all inputs. `land` includes one summary line per input Lane. Existing
entry statuses and counts remain available for compatibility; automation should
use submission state/reason/cause to distinguish waiting from failure. Canonical
Work records override stale local batch observations. These adapters do not start
a worker, run checks, or change acceptance policy.

## Managed owner lifecycle

This section describes the retained native landing controller. Hosted projects
use the [hosted landing queue](../agents/workflow.md#landing-queue), which keeps
running after a client disconnects and needs no local owner process.

The landing worker registers wake sources before scanning, then rechecks after
registration and each sweep. Durable Work publication wakes enqueue, check
completion, cancellation, review and Channel/dependency changes through a private
local notification socket. Native filesystem notifications also cover `work.json`,
finish/land journals, exact-run `result.json` receipts and batch queue release.
These are invalidations: saved records and original operation IDs are the authority.
Startup repairs missed notifications. New land journals retain their exact parent
request and selection so dependency waits replay the original pins. Retained finish
dependency waits also resume without a person invoking `land-ready`.

Worker errors retain the affected operation and write one structured `landing-worker-error` line to the owner's stdout log with the error code and available operation, Lane, Channel and run IDs. The controller retries failed sweeps itself with exponential backoff from 100 ms to a one-minute cap, so a persistently failing entry costs one retry and one log line a minute; retries do not expire or require a new submission. New `land` and `finish` submissions explicitly wake the registered driver. Notifications received during error backoff remain pending for the next sweep.

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

### Owner Mac launchd setup (retired)

No owner service runs for the dogfood project. Its launchd jobs were unloaded on 2026-10-29, and it lands through the hosted queue (see [Hosted queue priority](#hosted-queue-priority)). The retired owner service is not part of the hosted workflow. Its code and launchd template are assigned to B1.9 removal.

### Durable client admission

`land` submits desired state by default; `wait:true` only watches its durable
handle. CLI and MCP `finish` also accept `wait:false`. The native caller publishes
the owner-local journal, with immutable source pins, before returning. The worker
reconciles that same journal and canonical Work evidence; no second queue or
acceptance authority is created. First-use finish saves source before admission.

Async replays read atomically published journal snapshots without taking the
long-lived per-operation driver slot. They validate the original request digest
and report canonical submission outcomes. `landing {operationId}` reads a
selected handle without admission, recovery or writer locks. `land wait:true`
observes this same handle; synchronous finish retains its existing protocol.
The observation flag is not part of the retained request digest.

An absent worker is explicit in the receipt and leaves work pending. Use the
returned status/pending/wait selectors to observe progress; client disconnect
does not cancel submitted work. A check-only async finish is also retained for
worker recovery and never requests acceptance.

### Attempt-local timing

Progress includes `attempts`, one per selected batch/requeue, with its own
selection, composition start/end, check reservations, CI evidence, diagnosis
probe reservations, settlement, commit observation and completion. Writer-lock
spans retain request, acquisition and release times plus wait/hold milliseconds
under the attempt that actually acquired them. A requeued entry starts from its
new batch selection; diagnosis probes never extend its composition interval.
`commitObservedAt` is the controller's observation after durable publication,
not the earlier ChannelMove timestamp. Missing historical/provider times remain
unknown. Owner-local lock evidence is retained alongside landing journals.

Hosted progress retains timing with each attempt's progress, including source
preparation, selected check reservations and CI end evidence. A current run's
observed running time is labelled `ciObservedAt`; it is not a provider start time.
Recompositions freeze the old attempt and its settlement time before installing
fresh timing. Hosted `committedAt` is recorded in the atomic acceptance transaction;
it is distinct from a later controller observation of publication.

## Cost and latency observations

Existing agent status `checkCosts` retains monthly runner totals and adds fixed-size
`train` totals. Making-of includes the selected Intent's submission timing, per-run
costs and shared execution costs for each submission, with the same accounting categories: landing, diagnosis, retry, invalidated
speculation, preview and full-main audit. Other checks remain explicitly unclassified.
A shared batch execution can appear in several Intent reports; project totals
count it once. Do not add Intent totals to estimate project spend.

Physical runner/execution IDs deduplicate controller adoption and shared submissions.
Later complete observations fill previously unknown quantities. Replacement job or
Sandbox attempts retain their own cost; unknown legacy attempt attribution stays
unclassified. Categories are exclusive: invalidated work takes precedence over retry,
then the original check purpose. No reserved but unexecuted prefix is counted as a
physical execution. Legacy aggregate costs without execution IDs cannot establish
physical deduplication and are counted separately as unidentified coverage.

Actions execution seconds and separately rounded job minutes are distinct. Blacksmith
allowance units use the existing x64 estimator's vCPU/2 basis. Gross estimates retain
the pinned runner rate. Remaining shared allowance and estimated net cost stay unknown;
no provider usage API is contacted and no allowance is independently deducted per run
or project. Unknown timing, rates and legacy quantities remain explicit. Local preview
provider cost is zero under the existing own-machine basis; hardware, electricity and
operator costs are not estimated.

New landing entries retain first selection and terminal timestamps at their existing
state transitions. Queue wait is arrival to first selection; end-to-end latency is
arrival to the actual acceptance receipt or recorded terminal state. Requeue retains
original arrival and first selection. Review waits remain pending. Legacy entries can
report arrival to first recorded check reservation with a named legacy basis; missing
terminal timestamps stay unknown, even when their checks have ended. A cancelled job's
end is not a submission cancellation time.

Actual local preview invocations retain duration, execution identity and saved inputs
in the existing private coordination journal. Reusing a source-only cached observation
adds no execution; reexecuting external commands retains another measurement. These
local advisory measurements are separate from portable Work/check evidence. Selected
making-of records show feedback duration coverage. Immutable Work page projections and
preview records are cached; cold reads hydrate one page at a time, warm unchanged
collections read no run records. Reads install no observer or idle polling.

After `npm run build:core`, run `node scripts/replay-landing-train.mjs` for deterministic
synthetic serial/train reference-planner comparisons. The replay uses the production batch selector, saved-source overlap planner,
arrival ordering and prefix evaluation with explicit shapes (serial one entry,
train eight entries/four speculative batches), disposable synthetic source and
logical fake-CI durations. It covers clean bursts, paragraph conflicts, cross-file and
higher-order interactions, non-monotone prefixes, dispatch rejection/lost replies,
modeled controller restart boundaries, retries, cancellation/late completion and
stale-main invalidation. The JSON reports outcome/queue percentiles, executed checks,
job minutes, allowance units and gross cost with audits/previews separate and included
in totals. The reference model does not prove durable-driver recovery, production overlap
coverage, provider behavior or production throughput. Its configured fake durations
are model inputs; outputs are synthetic measurements, never a live speedup claim.
No cost cap, collection delay or scheduling policy is added by accounting or replay.

## Queue-ahead preview cost and applicability

Submission and observation may attach an already cached advisory
[queue-ahead preview](../agents/workflow.md#queue-ahead-conflict-advice). Each pair
uses the existing source composition reducer: main with the earlier submitted
Candidate, then the submitting Candidate with that projected main. The result
names conflicting paths and the exact earlier entry; it does not predict a
combined landing order. Existing priority, fairness and batch selection remain
authoritative. Eight entries bound speculative composition, not admission.

Finite hosted `observe`, `status` and `landing` reads return canonical state without
waiting for source download or speculative composition. They attach only advice
already cached for the exact fresh authorized selection, including main, submitted
head, peer pins and peer phases. A cache miss reports `queueAheadUnavailable`.
Explicit preview computation retains its pins and cost; it never caches a status
snapshot. After a long preview, another canonical read must select applicability
before the cached advice can appear. Failed, ejected and cancelled entries cannot
retain advice through a cached result. A peer that already conflicts
with main is unavailable speculation, rather than a claim about the submitting
Lane. Hosted reducers run outside Convex on the existing hash-verified object
transport; generated preview States are never uploaded or accepted as evidence.

Queued receipts also include `queue`: total entries, entries ahead, live predecessor
identity/phase/progress and an approximate ETA. Members sharing `batchId` count as
one service group, including parallel checking groups. ETA uses recent observed
selection-to-commit service time, or an explicit initial estimate of three minutes
per group; it is advisory and does not delay admission or change queue order.
Queue-head progress extends queued entries' progress clock. Waiting behind a live
predecessor does not raise `LANDING_STALLED`; old false alarms are retracted from
current reads. An ownerless wait names its predecessor in the alarm. The existing
orphan-recovery deadline remains, so losing that predecessor cannot strand work.

## Hosted queue priority

Hosted Candidate submissions use the same `orderLandingEntries` sorter as native
Forge: urgent before normal, then arrival order, with the same two-entry submitter
fairness within each priority class. Existing submissions without priority are
normal. Hosted `finish` accepts `priority:"urgent"|"normal"` (omission means normal),
including while its Candidate is still composing. The authenticated project owner,
or an agent using that owner's authority, can request urgent. Other contributors
still submit normally and receive a `priorityReason` explaining the governance rule.
Priority changes order; it does not change check, review or acceptance requirements.

Checks of independent submissions run in parallel, but submissions take main in
that order. A passed submission waits while an older one in its priority class is
still queued, checking or passed; an urgent one waits only for older urgent ones.
An older entry gives up its place when it fails, stalls, is held for red main, or
waits for review or a dependency.

A passed solo submission does not wait for an older entry it is unrelated to: when
neither change's paths equal, contain or sit inside the other's (the Candidates'
stored changed paths) and together they touch no [global-risk file](../pre-queue-checks.md#global-risk-files),
it takes main first (core-claim incident `7d98c7da`, 2026-11-08: passed landings
waited 17-40 min behind unrelated rechecks). The older entry keeps its check: on
moved main it lands on that pass through the first-check rule when it qualifies,
otherwise it re-checks. Each entry gives up its place this way for one check
generation only (`overtaken` on the row); its next check holds strict order, so it
re-checks at most once because newer entries overtook it. Passed and urgent entries
are never overtaken; combined groups and groups checked on a predecessor's predicted
head overtake nothing. The decision reads the claiming entry's project row and
Candidate once and one Candidate per skipped entry, in the claim transaction; no call
is added and an idle queue costs nothing. Related entries keep strict order.

The waiter keeps its passed check and owns no
timer or stall alarm: the older entry keeps its own alarm, and when it gives up its
place or lands, only the oldest waiter is woken and the rest wait for that one. A
waiter whose check main has since moved past re-checks after the older entry lands,
not beside it, so it re-checks once rather than once per landing ahead. So a
re-check after a main race is only ever caused by an entry submitted before it,
and each re-check attempt's
`CHANNEL_CHANGED` message names the landings that moved main and whether they
were submitted before or after it (core-claim incident `e4aee4fe`, 2026-11-01: a
slow submission re-checked six times in an hour while newer ones overtook it).
When main moved only in files disjoint from the Candidate, the first-check rule
or the scoped re-check keeps the work bounded; a non-source file in a `scripts/` or
`tests/` subfolder selects the code beside or naming it rather than the full suite.

An owner can reprioritise a queued Candidate submission through the existing agent
CLI or the hosted `forge_task` MCP tool:

```sh
nforge x ROOT prioritize '{"submissionId":"SUBMISSION_UUID","priority":"urgent","operationId":"CHANGE_UUID"}'
```

Use `priority:"normal"` with a new operation ID to undo a promotion. Replay the same
operation ID and parameters after an unknown reply. The command retains the
original priority version; an older retry cannot overwrite a later owner's change.
A running check is never cancelled for priority. Finish/status returns effective
`priority`, `priorityReason` and `priorityVersion` on the submission, alongside a
one-based `queuePosition` in the response for queued work. Position is a current observation, including active
checks ahead of queued work, and can change as other Candidates arrive or settle.
Composing, checking, ready and terminal submissions have no queued position.

Hosted automatic-accept projects batch by default, including existing policies
without a landing setting. `acceptance.landing: "serial"` opts out; the explicit
`batched` setting remains valid. An explicit legacy `optimistic` setting retains
its hosted serial behavior. Eligibility and current governance are unchanged.
A group checks the full union without requiring separate solo checks first. A
main-race recheck of a group whose members all hold a full-pass basis runs the
union of their scoped intersections instead
([hosted acceptance gate](../workflows.md#hosted-acceptance-gate)).

A group's receipts say LANDED only for members its shared State carries. The
compose worker accounts for every member as merged or as a retained conflict and
refuses a clean result that skips one; a step that must wait for merge
calculations re-runs the same member instead of moving past it. Acceptance then
compares each member's own changed paths with the shared State's changed paths,
from Candidate records it already reads. A member with a path missing there
publishes only when recorded State parents prove it was merged (a bounded walk of
at most two rows per member, and only for that member). An unproven member never
publishes: the group falls back to exact single landings
(`BATCH_MEMBER_UNPUBLISHED`).

The queue pipelines six groups by default. The observed GitHub merge queue used
six simultaneous groups; matching that execution width bounds speculative waste
while allowing ten to fifty concurrent finishes to progress. `checks.concurrency`
overrides the width (1–16); this is runner scheduling, never an admission limit.
Once a group's exact head and final acceptance receipt are reserved, its successor
composes and checks on that predicted main. Publication remains ordered and fenced
by the exact head and receipt. A passing successor keeps its evidence when the
predecessor lands unchanged, even if the successor check completed first. An
individual fallback with an immutable Candidate, reserved acceptance receipt and
exact live check is also a valid predecessor; its solo flag prevents re-batching
that member.
A failed, cancelled or re-pinned predecessor invalidates its dependent generations
in that transition, including a solo tail whose head or acceptance receipt changes;
the original member selections return to the queue and check again on surviving
main. Other groups retain their evidence. Source and check completion events
advance the pipeline; an idle queue schedules nothing.

A composition conflict on an unaccepted predecessor is advisory. The existing
`wouldConflict` notice names that predecessor group and the conflicting files;
the rejected entry stays queued, with no agent action required. Only rejected members
wait on the predecessor settlement event. Clean survivors check the retained
shared Candidate immediately and remain grouped. When the predecessor lands with
the exact predicted head and receipt, that completed generation is reused;
conflicts on that now-accepted base can be retained without another merge. A
newer main transition recomposes only the rejected selections. If the shared check
splits or fails, parked rejections also recompose individually on actual main;
the failed survivor prefix is never terminal conflict evidence. A rejected
member evidence or authority error settles only that member. A predecessor
failure or invalidation returns live descendants to the queue.
Rejected members leave the train even when every member conflicts. A retried
cohort restores its live members in their original order before successors can
pin its new tail. Terminal solo rows leave the train after invalidation, so
later queue events do not repeat it.
A conflict from that speculative base becomes terminal `COMPOSITION_CONFLICT`
only on the matching accepted base or after recomposition on current main. Conflicts composed without a
speculative predecessor retain their existing immediate terminal behavior.

A retained compose with no live check holds its slot for at most five minutes
(`HOSTED_TRAIN_HOLD_MS`); ordinary review, contributor and recovery work keeps its
existing path. Metadata selection reads only bounded indexed cohort windows and
the bounded active train, independent of queue length and retained history.

Cohort size is `acceptance.batchMaxSize` (1 to 8) when set. Absent, the queue
picks the k that minimises expected checks per member, 1/k + 1 - (1-p)^k, capped
at 8. p is the failure rate of the last 20 shared checks of that kind (first
checks, or cohorts of admitted members), smoothed by a prior worth four outcomes:
0.3 for first checks and 0.05 for admitted cohorts, which can only fail by
interaction. Unadmitted cohorts start at three; admitted cohorts at five. Each
settled shared check or admission writes one outcome to the queue row.

`acceptance.admissionCheck: true` adds a per-change admission on GitHub Actions
runners. Each batchable arrival immediately runs its own Candidate's affected set
(the scoped gate, or its contract gate when the actor is contract-eligible), in
parallel with every other arrival. A failing test ends that submission alone with
`CHECK_FAILED` and its failing files; it never joins a cohort. An admission that
ends without a failing test lets the member join unadmitted. An admitted member
waits, not runnable and with no timer, while an earlier arrival is still
admitting; the last admission to settle releases it, so arrivals that admit
together form one cohort. An admitted member without a cohort lands on its own
admission run when that run is still exact evidence on current main, with no
second run; scoped evidence counts towards the main audit cadence. Scoped
admission is opt-in: a clean five-member cohort runs six checks instead of one and
uses about 30% more Convex calls per landing. With one bad change in four, it
runs five checks instead of six and uses about 38% fewer.

An admission run is not in the queue yet: while it runs, its submission holds no
queue order, so younger submissions that are already queued never wait for it.

### Pre-queue Lane checks

`acceptance.admissionCheck: "full"` is the default (absent means `"full"`;
`false` opts out). It makes admission the project's configured check on any configured runner: GitHub Actions, other hosted CI or a registered
self-hosted or Mac machine. Each batchable arrival's check runs at once, with
its configured gate, on the main it composed on, in parallel with every other
arrival ([decision record](../pre-queue-checks.md)). A finish that carries no
configured check (a project without `configure-check`) skips the Lane check and
queues directly. A single Lane on unchanged main lands on its Lane run: one run,
the same runner minutes as without the Lane check.

- A failing test ends the submission with `CHECK_FAILED` before the queue. A
  change known to be red never joins a cohort or a queue check.
- A run that ends without a failing test starts the same Lane check again, at
  most twice; then the change enters unadmitted.
- A passing change enters the queue and first tries its own Lane run, once. On
  unchanged main it lands on that run with no second check. On a moved main the
  finish retry applies the [first-check rule](../pre-queue-checks.md#decision):
  a clean, path-disjoint change with no global-risk file lands on its Lane run
  and the main audit runs at once; otherwise it recomposes on current main and
  joins a cohort for one combined check, sized with the admitted prior.
- A refused change waits for peers that entered the queue before it and are still
  deciding their own Lane run, so they form one cohort instead of one group each.
  The wait holds no queue order, ends in the transaction where the last peer
  decides, and lasts at most the train hold (5 minutes); one wake at that bound is
  armed with the hold, and a write outage that refuses it is re-driven when
  writes resume.
- Early refusal (Issue 7fe54c7c): a change waiting for its turn whose Lane run is
  bound to an older main is refused at once, without waiting, while every older
  change holding order is itself refused or stale, of one cohort, and no retained
  group can move main first. It recomposes beside them; its first order waiter is
  driven once, so the wave's refusals chain in one pass instead of one per
  recomposition. Each change still recomposes once and no check is added. It reads
  one indexed window of at most 16 older rows and their attempts, only while a
  change is waiting; positions past the cohort size keep their turn. On the
  five-change fixture wave the cohort formed 1.5 s (three refusal steps) sooner
  with 215 instead of 221 transactions.
- The Lane check never re-runs because main moved; the combined check is that
  re-check, once per cohort.
- A group never waits for an older entry stacked behind it in the pipeline: that
  entry can publish only after the group.

Lane checks wake their submission only when the run reaches a terminal state;
nothing polls and an idle queue costs nothing.

Measured on the synthetic 12-Lane wave (`tests/hosted-landing-prequeue.test.mjs`:
real queue code, fake 22-minute runs, 12 changes arriving together, 3 of them red):

| | Before (`admissionCheck: false`) | Lane check (e7d27937) | With cohort hold (default) |
| --- | --- | --- | --- |
| Queue checks containing a red change | 8 of 19 (0.42) | 0 of 7 | 0 of 2 |
| Accepted landings per hour | 6.1 | 8.2 | 12.3 |
| Superseded or cancelled queue runs per accepted landing | 0.67 | 0 | 0 |
| Passing Lane runs not reused, per accepted landing | 0 | 0.89 | 0.89 |
| Runner minutes per accepted landing | 46 | 46 | 34 |
| Runs (Lane + queue) | 19 | 19 (12 + 7) | 14 (12 + 2) |
| Convex calls per accepted landing | 121 | 99 | 77 |
| Single Lane alone: runs, runner minutes, Convex calls | 1, 22, 56 | 1, 22, 59 | 1, 22, 59 |

"Before" includes repeat-offender isolation (51bbbd00). Wall time counts runner
rounds, so these figures exclude dispatch latency. Without the cohort hold the 8
admitted changes that missed proved reuse were re-checked as 7 queue groups,
and each refused peer waited in queue order behind the oldest refused one until
its 15-minute stall alarm. With the hold they form two cohorts (the admitted
cohort size is five) in two queue runs. The
same contract test passes on GitHub Actions and on a registered self-hosted
runner.

A shared check that fails a test splits its cohort into groups that check at
the same time. Members whose changed paths or declared contract tests match the
failing files (the retained diagnosis) check alone and the other members compose
together as a new cohort; without such a match, the cohort splits into two
halves. A group of one lands on its held admission run when that is still exact
evidence on current main; admission never runs again. Two or more groups of one
share one serial individual line, likely members last, with the existing
per-member diagnosis, so one landing does not force every other single to
recheck. A cohort that lands second meets the moved main and rechecks on main
including the first. A cohort that cannot compose, because its compose fails or
the stall alarm finds it still composing, splits the same way. A shared check that ends
without a failing test file or report (runner unavailable, Actions 403 or server
error, cancelled, timed out) is a platform failure: the same cohort checks again,
recomposing only if main moved, at most twice. After that every member ends with
`CHECK_NOT_PASSED` and without `batchSolo`; a resubmit re-derives eligibility.

Batch formation follows the same order and groups one priority class. A mixed
batch after a promotion, or a normal batch with urgent work waiting outside it
(including members of another unstarted batch), is superseded before its check
is reserved. Its members return to selection with
their exact Candidate pins. Distinct batch IDs retain late composition replies
against the old batch. Already reserved batch checks continue normally.

Individual fallback also selects urgent before normal, retaining its existing
healthy-before-suspect preference within the selected priority class. An already
selected solo preparation or running check continues; priority applies at the
next selection. A suspect hint cannot override an owner's urgent choice.

A priority mutation updates its submission and the derived ordering projection,
with no new scheduling. Committed queue events maintain compact ordering pages of
128 entries; ordering changes read/write O(pages), while ordinary timing progress
updates only the queue clock. Existing bulk check-wake and abandonment mutations
flush their directory once before commit, rather than rewriting it per member.
A selected status reads its exact page, the channel
summary and its live predecessor with a fixed metadata-read budget independent
of queue length. Batch selection retains its indexed windows. Next-entry selection reads indexed priority-class
heads, including legacy normal rows. Explicit reads add no background work or
polling; idle queues incur zero additional Convex calls.

Released strict wait/stack readers keep their original submission body. Selected
landing/finish status and observation reads opt into priority fields with
`priorityInfo:1`; the current CLI/MCP transport supplies that flag. Against an older
server it retries only an explicit argument-validation rejection without that
read extension, then remembers legacy reads. Authorization/source failures are
never retried through another route. Advertised capability action names remain
unchanged; a new priority write still needs the new server.

Verified queue-advice objects are cached beside the Lane in
`ROOT.forge-client/queue-ahead-objects`; observing the queue never adds downloaded
object files to the Lane source directory.
