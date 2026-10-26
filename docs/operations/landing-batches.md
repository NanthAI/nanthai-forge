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
enqueue also refuses duplicate pinned inputs across finish/land operations.
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
Use XML escaping for replacements. The template sets `FORGE_CHECK_SCOPED=1`, matching the installed maintainer CLI
wrapper. Keep that setting aligned with the submitter; preserve any intentional
`FORGE_CHECK_FULL` or other check configuration in both runtimes. The service's `PATH`
starts with the selected Node directory and need not match agent shell ordering.
The template contains no credentials. Preserve
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

For an existing service, boot it out before bootstrapping a replacement plist so
launchd reloads its environment. After a build-only update, use
`launchctl kickstart -k "gui/$(id -u)/com.nanthai.forge-owner"` to restart the loaded
service with the reviewed build.

Observe local pending status to confirm recovery. Stop driving with
`launchctl bootout "gui/$(id -u)/com.nanthai.forge-owner"`; saved submissions
remain. Re-enable with bootstrap/enable/kickstart. Accepted history is retained;
undo accepted source through the existing checked compensating change. These
commands are lead installation steps, not actions performed by a finite agent.

### Durable client admission

CLI and MCP `finish`/`land` accept `wait:false`. The caller publishes the existing
owner-local journal, with immutable source pins, before returning. The worker
reconciles that same journal and canonical Work evidence; no second queue or
acceptance authority is created. First-use finish saves source before admission.

Async replays read atomically published journal snapshots without taking the
long-lived per-operation driver slot. They validate the original request digest
and report canonical submission outcomes. Omitted/true `wait` keeps synchronous
compatibility, including replay of an asynchronously submitted operation.
The observation flag is not part of the retained request digest.

An absent worker is explicit in the receipt and leaves work pending. Use the
returned status/pending/wait selectors to observe progress; client disconnect
does not cancel submitted work. A check-only async finish is also retained for
worker recovery and never requests acceptance.

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
