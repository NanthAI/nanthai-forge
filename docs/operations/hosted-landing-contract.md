# Hosted landing ownership contract

This contract maps native landing submissions onto hosted Lanes. It describes
the shared invariants, the implemented differences and the work still needed
before moving an existing native owner's authority. It does not enable that
move. Canonical-owner migration is deferred to Phase 5; changing a transport
address does not make the local landing train server-capable.

Read [landing batches](landing-batches.md#submission-observations) for the native
submission model and [source exchange](source-exchange.md#hosted-landing-queue-api)
for the hosted API. The [architecture](../architecture.md#hosted-final-acceptance)
describes the implemented publication boundary. The candidate slices below are
design work, not claims of deployed capability or new acceptance policy.

## One acceptance owner

A project has one canonical main, selected by explicit source authority:

- `native-owner`: native Work and its Channel moves are authoritative. A hosted
  projection or owner acceptance request cannot independently advance that main.
- `server-shadow`: hosted source work can prepare Candidates and queue outcomes,
  but cannot publish a competing accepted main. Native authority remains real.
- `server`: the hosted Channel and acceptance ledger own main. A client checkout,
  restored owner, browser, check provider and mirror are not competing writers.

`sourceAuthority` includes a monotonically increasing `epoch`; missing legacy
fields mean `native-owner` at epoch zero. Project origin, `hostingRequest`,
heartbeat, machine presence and cached capability discovery do not select
authority. `nextSourceAuthority` prepares a mode/epoch CAS but is not a migration
API. See [authority contracts](../architecture.md#hosted-source-authority-and-operation-contracts).

Today H08 constructs canonical hosted Candidates, H13 retains landing requests,
H14 publishes server acceptance, H15 drives finish and H17 constructs compensating
source. H18 CLI/MCP addressing reaches those APIs without a native owner/listener.
Those components do not migrate an already bound native owner. In particular,
the legacy owner-listener/Work/exchange writers are not proven fenced by the new
epoch merely because H14 checks it.

## Submission, attempt and execution identity

These concepts retain their meaning across owners; their serialized identities
are not currently interchangeable.

| Concept    | Native contract                                                                                                                                                                 | Hosted mapping                                                                                                                                                                                                                                       |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Request    | Original operation UUID and retained request digest; saved ordered Lane heads and dependency pins do not follow later saves.                                                    | H01 envelope keyed by project, actor and original operation UUID; canonical payload hash includes expected pins and array order. H13 retains the original request and H08 Candidate.                                                                 |
| Submission | S01 derives one `submissionId` per operation, Intent and Lane using `finishChild`. `entryOperationId` can identify a delegated land entry separately from the parent operation. | H13 allocates one durable submission UUID for the entire Candidate request. Its input-page observations currently share that UUID across Lanes and omit `entryOperationId`. Preserve the returned ID; do not calculate a native ID for it.           |
| Attempt    | Finish has deterministic attempt/phase UUIDs; single land retains its ordinal; batch attempts derive from entry and batch IDs. An unselected attempt can be null.               | H13 reserves an immutable first attempt. H15 reserves a child UUID, parent/ordinal/time, observed main and compose/check/accept UUIDs before IO on each main race. `pendingAttempt` exposes source work before the new landing attempt is installed. |
| Candidate  | Work View ID, source head, exact ordered Lane inputs/dependencies and composed base.                                                                                            | Immutable canonical Candidate ID/digest, registered source, ordered input/dependency roots, base head **and receipt**, and composition algorithm. A conflict retains exact side States and conflict pages.                                           |
| Check/run  | Run ID and exact source, definition, environment, selection and executor plan.                                                                                                  | H10 run ID plus Candidate digest/head, definition/configuration/environment and immutable plan/terminal evidence. H14 revalidates the exact evidence; a display verdict is insufficient.                                                             |
| Execution  | Local/provider execution identity retained by the check adapter, distinct from attempt/run/queue residency.                                                                     | H05 source job and H10 check executions have their own durable identities, provider bindings and fences. Replacing a controller does not allocate replacement compute.                                                                               |
| Acceptance | Original Channel-move operation ID and actual accepted transition; reconcile before retrying after an unknown reply.                                                            | H14 receipt ID is the attempt's retained accept UUID. Receipt links submission/attempt, previous head/receipt, actual Candidate/head, actor, epoch, policy and exact check evidence.                                                                 |

Shared persistent identities include State/blob content hashes and the semantic
Intent, Lane, saved source, Candidate, run and acceptance records. Migration must
preserve existing IDs and their provenance, not hash their contents into new
identities or rewrite native IDs using hosted UUID generation. A lossless explicit
identity mapping is needed wherever the schemas differ. Physical Convex row IDs,
snapshot/page references, project source revisions, record/source/lifecycle
versions, queue sequences, leases, scheduler wake IDs and hosted job/signature
bindings are hosted control/storage details; they are not native submission IDs
or proof of acceptance.

Native `FinishJournal` and `LandJournal` live beside Work, retaining parent
commands, selection and child operations. S03 recovery reads those pins; Work
Candidates/runs/Channel moves remain the evidence. Hosted `HostedAgentJournal`
retains normalized commands and child/request pins before mutation IO, while
server tables own progress. Neither journal is a second acceptance owner. Native
request hashing and H01 canonical hashing differ; importing a journal requires an
explicit versioned bridge, not a re-hash under the same UUID.

## Shared state and observation semantics

`src/landing-submission-state.ts` is the shared pure projection used by native
S01 and hosted landing. It observes progress; it never authorizes or drives it.

- `pending`: reasons are `queued`, `checking`, `waiting-for-review`,
  `waiting-for-dependency` and `pending-infra`. Admission and H13 `ready` remain
  pending; neither is accepted main. A worker outage is not a source failure.
- `terminal-failed`: causes are `conflict`, `check-failed`, `infra`, `stale-head`
  or `rejected`. Retain the underlying status/error; cancellation projects as
  rejected in this vocabulary, not as an extra shared cancelled state.
- `landed`: established by an actual canonical acceptance receipt, never by equal
  source bytes, an older Lane acceptance or a passed check alone.
- `superseded`: a newer saved Lane head differs from that input's `attemptHead`.
  Preserve its actual `outcome`, operation, selected head and receipt. It does not
  cancel the old request or claim the newer save landed. Unsaved edits are outside
  this saved-head observation. Native finish's recorded sync head is its
  `attemptHead`; hosted H15 retains the original saved input heads throughout.

The source-relative projection sets `terminal` when state is no longer pending
and `complete` only for `landed`; superseded observations are not complete even
if their retained outcome is landed. A request-level hosted status is not this
per-input projection. H15 `inputs` explicitly reads staged input pages/current
Lane heads to produce it; regular status stays constant-size. Unstaged pages are
reported as unstaged, not as an empty completed selection.

Hosted `phase` (`queued`, `checking`, `ready`, `terminal-failed`, `landed`) is a
controller state, not another shared submission vocabulary. H13 may prepare a
request without H15 finish, in which case it stops at ready. H15 retains policy
waits rather than spinning. Hosted attempt-history rows currently label older
attempts superseded without retaining their full prior projected outcome in the
response; this is a gap, not the source-relative promise above.

S05's native wait cursor contains selection-scoped deduplication state keyed by
owner directory and selected Lane/operation IDs. Reconnect rereads authority;
watch notifications are hints, and registration is followed by a reread to close
lost wakeups. It is not a server event offset or a portable authority token.
H15 status instead returns a submission `version`, `unchanged` and
`pendingAttempt`; H18 status/observe performs finite authorized reads. Only an
explicit hosted **run** wait currently subscribes. Neither cursor grants access,
starts a driver, cancels work on disconnect nor turns observer timeout into a
landing verdict. A future submission wait must retain these semantics with a
project/authority/selection-scoped cursor and explicit reconnect/resnapshot rules.

## Fencing and final publication

Fences answer different questions and cannot substitute for one another.

| Guard                                                           | What it protects                                                                                                                                 | What it does not authorize                                                                                                    |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Native owner lock, Channel drain slot and S02 driver generation | Short Work publications by the current local driver. `beforePublish` rechecks generation under the same Work lock; execution remains outside it. | Distributed ownership, hosted epoch validity or another provider execution. PID/lease age alone cannot fence a hosted writer. |
| Hosted authority mode/epoch                                     | Which owner may create new canonical source/landing transitions for this project.                                                                | Reader/contributor access, exact check evidence or current main selection.                                                    |
| H13 queue lease owner/token, submission and attempt             | Current controller's mutable transition/publication; claim and recovery wake commit together.                                                    | Acceptance. Expiry permits reconciliation of the same attempt/run, not a new paid dispatch.                                   |
| H15 IO wake/generation                                          | A metadata-transfer completion belongs to the still-pending source/page phase.                                                                   | Replacing source selection or reviving a terminal request.                                                                    |
| H05/H10 controller and worker/execution fences                  | Exact source/check job and late/duplicate provider messages, alongside signed input bindings.                                                    | Source registration as landing permission, or a lease as proof that remote execution stopped.                                 |
| Main head and receipt CAS                                       | The actual predecessor is still the one on which this Candidate was prepared. Receipt comparison detects same-head/new-receipt ABA.              | Reusing a verdict for a different Candidate, even when its resulting bytes match.                                             |

The native acceptance command uses `expectedPrevious` plus Work publication and
its retained Channel receipt. Existing native disjoint-proof paths are explicit
exceptions implemented by native acceptance, not a general evidence-transfer
rule. Hosted acceptance requires both expected main head and receipt plus epoch;
H15 currently recomposes/rechecks on races instead of importing that fast path.

H14's final transaction must continue to independently validate the live queue
claim, current server epoch, current main head/receipt, canonical clean Candidate
and registered State, current policy digest, actor and exact check evidence. It
also checks a requested parent submission has actually landed. It atomically
publishes the receipt/event, snapshot delta, Channel selection, request/operation
settlement and queue release. Staged inclusion pages and later bounded lifecycle
materialization do not widen that authority boundary. Completion compares exact
saved versions/heads so newer saves and reopen events stay active; the receipt is
authoritative while materialization is pending.

On a head **or receipt** race, retain the old attempt and reserve new compose,
check and accept identities before external IO. Recompose the original ordered
H08 manifests against observed main, then check the new exact Candidate. Never
switch to latest Lane saves, silently choose conflict sides, reuse old evidence
or assume a speculative predecessor landed. H15 yields with backoff and retains
each child; its backoff delay is not a retry ceiling. Native finish's configured
retry behavior remains separate.

On unknown publication outcome, first reconcile the original receipt under its
original identity. If already published, return that historical receipt without
moving main again or rechecking old policy as a condition of acknowledging
history. An unpublished attempt still needs all current guards. Current access
is required for either path. Cancellation/terminal outcomes cannot be revived by
late callbacks. Ambiguous provider dispatch is reconciled by its execution
identity; an empty listing or expired controller lease does not prove no dispatch
occurred.

H17 compensation selects the receipt's actual previous and accepted heads,
including batch/dependency effects, and creates an isolated revert Lane. Ordinary
H08 compose and H15/H14 finish then apply current rules on current main. Revert
never reverses merely the requested Lane delta or rewinds a Channel pointer.

## Requests use current authority

The seam requires the following request behavior. The gaps below distinguish
missing enforcement/integration from the existing final acceptance guarantees.

1. Discover project authority/capabilities using current authenticated access.
   Treat it as an observation, not a capability that survives revocation or epoch
   changes. Native projects currently advertise only hosted capability discovery.
2. Before new work, retain the original operation, actor and payload including
   expected epoch/main or Lane versions, then send it to the selected owner.
   Repeated identical requests reconcile; changed payload/pins under that UUID
   remain `WORK_OPERATION_CHANGED`. Refreshing credentials does not change actor
   kind or grant person acceptance to agent tools.
3. Each read/page/source-byte return rechecks current reader authority. Each
   mutation, async completion and source/check callback uses its current project
   authority boundary; final acceptance checks current policy again. Cached
   source, past access, signed job results and a previous enqueue are insufficient.
4. A completed historical operation may be acknowledged after a mode/epoch change
   under current access, without repeating its effects. Pending old-epoch work
   retains its identity/result and receives an explicit stale-authority outcome;
   do not patch the epoch inside the old immutable request and resend it as fresh.
5. During migration, reconciliation must decide whether an operation completed
   under its original owner or remains a proposal for the new owner. Import any
   resulting source with explicit provenance and identity links. No automatic
   native fallback during a hosted outage and no silent owner/routing switch.

These are authority-preservation requirements for the seam. They do not add a
contributor eligibility rule, person confirmation, check requirement for people,
quota, retention rule or other new product policy. People retain clean unchecked
acceptance where already supported; agents retain the current exact-check and
autonomy/review rules. No new deployment, credential provisioning or cutover
action is supplied by this document.

## Unsupported offline-local cases

- A native-authority project cannot land through a hosted projection while its
  owner machine/service is unavailable. A submitted local journal stays pending
  until that owner resumes; powering off the owner is not a terminal failure.
- A server-authority client's offline edits or local save are not a durable hosted
  enqueue, canonical hosted Lane save or main acceptance. Preserve local bytes and
  reconcile against current Lane/main versions when connected; current H18 has no
  offline mutation queue that promises later acceptance.
- An independently restored native owner can retain and check source, but is not
  a failover authority for the bound server project. Its local Channel move does
  not become hosted main through a stale whole-Work upload.
- Local paths, process IDs, locks, observer cursors and runner journals cannot be
  transported as server fencing or authenticated provider evidence. A local check
  report is not an H10 canonical run receipt. There is no implicit local runner or
  alternate provider when a configured hosted runner is unavailable.
- A client cannot observe fresh hosted authority, receipts, source or revocation
  while disconnected. Last known status stays labelled historical/unknown. This
  does not restrict standalone unbound native Forge or erase offline edits.

## Migration invariants (deferred implementation)

The migration seam must satisfy these invariants before enabling an authority
switch for an existing owner. This is not an executable cutover procedure.

1. Pin the native main head and actual receipt, Work revision, hosted source/
   journal revision, snapshot/object closure and expected authority mode/epoch.
   Stage and validate complete source and record pages without a whole-history
   transaction. Partial seeds are not selected main.
2. Preserve source bytes/hashes, Intent/Lane/save/Candidate/run/acceptance IDs,
   ordered dependencies, lifecycle history and revert provenance. Include S03
   journal-only commands/attempt pins, queued waits and unknown outcomes through
   an explicit recovery format; do not assume a Work snapshot contains them.
3. During shadow operation native main remains authoritative. Hosted shadow
   outcomes do not create a competing accepted ledger or reusable approval for
   different source. Deployment and live qualification are separate evidence.
4. Reconcile in-flight acceptance/execution receipts under the old authority,
   preserving unresolved work. Publish the final authority/epoch switch together
   with expected main/receipt and source/Work pins. Moved pins require renewed
   preparation, never overwriting concurrent accepted work.
5. Fence **every** bound Channel writer: direct accept, native finish/automatic
   landing, owner request completion, hosted Work selection, source return,
   bootstrap/import and recovery paths. Bound CLI/MCP route new submissions to
   current authority. Standalone unbound owners retain native behavior.
6. Preserve exact original operation identities across the switch with an
   explicit bridge. Old-epoch delayed results remain historical source/proposals
   or reconciled receipts, never a second fresh hosted acceptance. Do not adopt
   an arbitrary local check as trusted remote evidence or duplicate an ambiguous
   provider execution to simplify migration.
7. Server-authority source return merges permitted client Lane/source deltas;
   a stale snapshot cannot replace canonical Lane heads, runs, lifecycle,
   submissions, attempts or accepted main. Portable recovery must fold hosted
   records, acceptance snapshot deltas and pending completion overlays, not only
   display rows. Export/restore keeps exact receipt chains and pending work.
8. Returning to native is another explicit increasing-epoch switch seeded from
   latest server main/receipts and reconciled work. An outage never automatically
   restores the last local main. Observer cursors are owner-specific: restart
   from authoritative selected records and deduplicate with retained identities.

## Gaps and candidate slices

Each item names a concrete difference and a bounded follow-up. None is
implemented by this contract. Canonical-owner migration remains deferred to
Phase 5, including its routing and recovery prerequisites. Older hosted planning
uses H21a/H21b for portions of that work; those plan labels are not landed code.

### G1 — Atomic authority switch and all-writer fencing

H01 supplies pure epoch CAS preparation and an authorized authority read; H14
checks server epoch. There is no complete native-owner cutover. Legacy routing
still uses `hostingRequest`/backup format; legacy acceptance completion and source
publication do not implement the same cross-owner epoch contract. Implement the
pinned switch and audit all writers as one migration workstream, with a stale
old-owner completion/upload test and same-head/new-receipt race tests.

Pointers: `src/hosted-source-authority.ts` (`nextSourceAuthority`),
`convex/projectSourceAuthority.ts`, `convex/projectHostedChannels.ts` (`seed`),
`convex/projectHostedAcceptancePublish.ts`, `convex/projectWorkActions.ts`
(`acceptChannel`), `convex/ownerAcceptance.ts` (`isNativeOwner`, `complete`),
`convex/projectExchange.ts` (`publish`), `src/hosted-agent-cli.ts`
(`hostedAgentAddress`) and `src/native-work.ts` (`accept-channel`).

### G2 — Canonical main pull, snapshot folding and portable recovery

H14 appends acceptance snapshot deltas and materializes landed heads later.
`projectHostedChannels:current` reads schema-2 main, but legacy `projectMain:current`
still returns `SOURCE_UNAVAILABLE` in server mode. Existing native export and
legacy journal export do not fold the complete hosted queue/record/acceptance
tables into a restorable owner. Add paged folding and canonical main pull with
exact receipt restoration, including pending completion and stale source return.

Pointers: `convex/projectMain.ts`, `convex/projectHostedAcceptancePublish.ts`,
`convex/projectHostedAcceptanceCompletion.ts`, `convex/projectHostedSnapshots.ts`,
`convex/projectSourceReturn.ts`, `convex/projectReturnCommit.ts`,
`convex/projectWorkActions.ts` (`exportJournal`) and `src/native-backup.ts`.

### G3 — Lossless submission identity bridge

Native S01 has per-Lane deterministic submission IDs; H13 has one allocated
request ID shared by its input rows. Define an additive mapping that keeps both
public IDs and parent/entry operation lineage, then use it in migration and
cross-owner observations. Test multi-Lane finish, delegated land entries and
replay without changing either existing identity scheme.

Pointers: `src/landing-submission.ts` (`projectSubmission`, `landingAttemptId`),
`src/landing-submission-read.ts`, `src/land-journal.ts`,
`convex/projectHostedLanding.ts` (`enqueue`) and
`convex/projectHostedFinish.ts` (`inputs`).

### G4 — Hosted submission wait and reconnect cursor

S05 observes selected submissions with a scoped reconnect cursor. H18 currently
accepts a numeric submission version for finite reads and provides a live
subscription only for runs. Add a requested submission wait over the same
transport, with current access, initial snapshot/registration/reread, scoped
deduplication, resnapshot after cutover and cleanup on disconnect. Test a missed
wake, pending source attempt, superseding save and observer timeout without
starting or cancelling work.

Pointers: `src/agent-wait.ts`, `src/agent-wait-cursor.ts`,
`src/agent-wait-submission.ts`, `convex/projectHostedFinish.ts` (`status`),
`src/hosted-agent-contract.ts`, `src/hosted-agent-transport.ts` (`observe`),
`src/hosted-agent-observe.ts` and `src/mcp-hosted-agent.ts`.

### G5 — Historical attempt outcomes retain their own evidence

H13 attempt pages label every older attempt superseded with null reason/cause;
H15 input pages apply the submission's current observation even when asked for
an older attempt. Neither response is a complete historical attempt outcome.
Retain per-attempt settlement/evidence and project supersession separately from
that outcome. Test a failed/conflicted old attempt followed by a landed child,
and a later Lane save, without rewriting immutable attempt pins.

Pointers: `convex/projectHostedLanding.ts` (`attempts`),
`convex/projectHostedFinish.ts` (`inputs`),
`convex/projectHostedLandingStore.ts`, `src/hosted-landing.ts` and
`src/landing-submission-state.ts` (`sourceSubmission`).

### G6 — Native recovery journals cross the ownership seam

S03 resumes owner-local finish/land journals; H18 has a distinct client journal
and server operation/finish records. No converter transfers journal-only native
requests, unknown outcomes and deterministic children into that hosted model.
Define a versioned recovery manifest and reconciliation bridge before migrating
pending work. Test crashes before/after every retained child, a lost acceptance
reply and hash-format differences without reselection or duplicate execution.

Pointers: `src/agent-finish-journal.ts`, `src/land-journal.ts`,
`src/landing-worker-journals.ts`, `src/native-backup.ts`,
`src/hosted-agent-journal.ts`, `src/hosted-source-operation.ts`,
`convex/projectHostedOperations.ts` and `convex/projectHostedFinishCompose.ts`.

### G7 — Landing cancellation distinct from lifecycle/check cancellation

Native landing can cancel an entry and recheck only the applicable prefix.
H13/H15 expose no equivalent landing-request cancel transition; H18 actions do
not include it. Abandoning a Lane or cancelling a source/check job is not proof
that its landing request was cancelled. Add an explicit idempotent request
cancellation path with retained outcome and late-publication fencing, preserving
already accepted source. Test a final-CAS race and delayed check/source callback.

Pointers: `src/landing-batch-cancel.ts`, `src/landing-batch-step.ts`,
`src/hosted-agent-contract.ts` (`hostedAgentActions`),
`src/hosted-landing.ts` (`hostedLandingStateSchema`),
`convex/projectHostedLanding.ts`, `convex/projectHostedFinishControl.ts` and
`convex/projectHostedLifecycle.ts`.

### G8 — Train scheduling, speculative batches and diagnosis adapter

H13 selects runnable requests by Channel sequence and H15 recomposes each
request. One H08 Candidate may already contain many Lanes, but this is not the
native compatible-entry batching, overlap ordering, speculative predecessor or
retained prefix diagnosis engine. Port the planner/diagnosis adapter separately
using immutable hosted selections and named attempts. Test non-monotone prefix
results and cross-half interactions; never treat independently passing halves
as permission to land their unchecked union or missing graph edges as independence.

Pointers: `src/landing-train-plan.ts`, `src/landing-batch-order.ts`,
`src/landing-batch-types.ts`, `src/landing-batch-check.ts`,
`src/landing-diagnosis.ts`, `convex/projectHostedLandingControl.ts`
(`claimLandingQueue`) and `convex/projectHostedFinishCompose.ts`.

### G9 — Trusted path coverage and explicit evidence-reuse parity

Native acceptance has a configured manifest-disjoint fast path; hosted H14
currently passes unavailable changed-path coverage to existing review policy
and H15 rechecks every raced composition. H08 does not publish the trusted
changed-path evidence needed to evaluate those native rules. First add verified
path/manifest coverage to registered Candidate provenance; separately evaluate
parity for existing fast-path policy with exact plan/coverage proofs. Do not
expand eligibility, bypass review or transfer checks merely because hashes or
display path claims match.

Pointers: `src/native-work.ts` (`nativeFastPath` call), `src/native-fast-path.ts`,
`src/hosted-compose.ts`, `convex/projectHostedComposePublish.ts`,
`convex/projectHostedAcceptancePublish.ts` (`reviewReason`),
`convex/projectHostedCheckRead.ts` and `convex/projectHostedFinishCompose.ts`.

### G10 — Current-project authorization at explicit finish resume

`projectHostedFinish:resume` loads the request, authenticates the original actor
and schedules pending work, but does not call the current project/contributor
authority helper before scheduling. The later driver does call
`hostedWriteProject`, so this observation is not an acceptance bypass. Align the
explicit resume admission boundary with current contributor authority and retain
completed-receipt reconciliation semantics. Test a revoked contributor resuming
their own pending request, project removal and an old epoch without new source,
check or acceptance work. This applies the established authority contract; it
does not propose a new role or additional user step.

Pointers: `convex/projectHostedFinish.ts` (`resume`),
`convex/projectAutonomy.ts` (`acceptanceActor`),
`convex/projectHostedFinishStore.ts` (`loadFinish`),
`convex/projectHostedFinishControl.ts` (`finishStep`),
`convex/projectHostedRecords.ts` (`hostedWriteProject`) and
`convex/projectAuthority.ts` (`activeProject`).

## Pull-based Mac checks

`nforge worker DEPLOYMENT_URL PROJECT_ID MACHINE_UUID` registers an authenticated
project-owner collector session and subscribes to its configured machine's queue.
Configure the runner with provider `self-hosted`, the stable `machineId`, runtime,
platform and the machine's `checkEnvironment().fingerprint`. Legacy `mac` settings
remain readable without changing their pinned digests. See the
[self-hosted runner setup and container recipe](self-hosted-runner.md). The fixed collector uses the existing
`FORGE_HOSTED_CHECK_KEY_ID` / `FORGE_HOSTED_CHECK_KEY_<ID>` signing configuration;
project commands receive neither that key nor the collector's account token.

A claim records the live owner before source preparation or command execution.
The 60-second execution lease is renewed by signed callbacks every 20 seconds.
Targeted watchdogs requeue the same exact run once, fencing the prior execution,
then settle another expiry as `runner-unavailable` with `MAC_RUNNER_LEASE_EXPIRED`
or `MAC_RUNNER_NO_OWNER`. Unclaimed work has the same finite owner windows. Cancel
settles immediately, fences late callbacks and stops a connected process through
its status subscription. No process or controller restart is needed.

Checks download hash-verified source directly from hosted object storage/R2 into
a private checkout and use the configured command and clean environment. No Git
export, GitHub branch or `forge-check/<runId>` ref is involved. Redacted stdout,
stderr and selected artifacts use `projectHostedOutputApi` signed targets and
verified commits. Local failed transfers retain their private spool. An idle
worker retains only subscriptions: it performs no polling or periodic Convex
calls. Provider execution records do not themselves grant acceptance; current
landing policy and exact-Candidate evidence are still checked separately.

## Hosted main audit

Hosted main keeps one audit row per project. A passed full-gated landing adopts
its exact run as green evidence, clears red main and cancels the pending audit
wake. A docs-only pass inherits an already green parent. Contract and scoped
landings count toward an audit of the newest accepted Candidate: **10 counted
landings or 24 hours**, whichever comes first. A full-gate failure requests an
early audit when counted landings are outstanding. Repeated requests coalesce.

Audits use the configured hosted check runner and `gate.mode: "audit"`. The
content key pins project, source head, check definition, runner configuration,
environment and authority epoch. Replaying that key adopts the original run;
it does not dispatch another check. An unavailable, interrupted or cancelled
audit gets one separate retry. A newer main does not cancel an active audit,
and an older result cannot overwrite a newer full-passed landing.

Only an audit with effective scope `full` re-greens main. Legacy audit runs with
no effective field retain their full-suite default; an explicit `docs` or
`contract` scope never inherits that default. A reduced passed audit retains its
actual run result but records a stalled outcome with status alarm step `not-full`.
It preserves the last green boundary, red state, debt and counted landings,
including their original age. It schedules no immediate retry; the next landing
re-evaluates the normal cadence for a full audit of the latest main.

The single owned wake is used for pending audit cadence. Active audits use the
existing provider watchdogs, with no additional audit timer. Status reports
`MAIN_AUDIT_STALLED` and the current step after 15 minutes without observed
progress; an interrupted or unavailable terminal result retains a stalled event.
There is no wake after all counted landings are covered, and no idle polling. New submissions
use full checks when unaudited debt reaches twice the configured count or age;
`mainGate` exposes that evidence to the gate decision. A failed audit records
red main and requests culprit classification. Contract acceptance reads that
red state; passing audit evidence or a full-passed fix clears it and releases
held requests in pages of 100.

Owner acceptance status and `check-settings` include `mainAudit` with head,
result, last green evidence, counted landings, settings, red start/minutes and a
retained stall alarm. The owner can configure cadence through
`projectHostedMainAudit:configure` with a retained operation UUID, current
authority epoch, expected settings digest (initially `null`) and
`settings: {landings: 10, minutes: 1440}`. The versioned execution setting uses
runner-kind key `main-audit`; key `runner` remains the runner configuration.
The configure receipt returns the settings digest for the next compare-and-swap.

Rollout can seed green evidence through internal `projectHostedMainAudit:seed`
from the last accepted, retained full-passed run. It checks current check and
runner pins before adoption. Historical runs without gate metadata do not claim
full-suite evidence. No initial audit is dispatched by this seed.

Audit events retain red, green and stalled outcomes.
`calculateHostedRedMainMetrics` consumes revision-pinned exported events and,
when supplied, culprit acceptance times to calculate metric R over a requested
period. The event source must be authenticated and its coverage stated by the
caller; missing history never establishes zero historical red time. Free
GitHub-hosted runners on a public repository incur no runner charge; private
repository minutes and other configured providers follow their own billing.

## Hosted culprit recovery and fix notices

A failed hosted audit schedules classification after its red state commits. The
recovery journal reads the accepted range in one indexed page, probes the failed
tests on the audited head to distinguish a flake, then bisects comparable
passing/failing evidence. A range of k landings uses at most
`1 + ceil(log2(k + 1))` probes. Missing, mixed or incomparable evidence opens
fix-forward work. A passing flake probe records a flake and clears that episode.
Newer counted landings remain pending: recovery uses the audit's pinned coverage
count, rather than counting docs receipts, and schedules remaining audit debt
through the existing cadence.
Probe and automatic-revert completion continue through scheduled internal
callbacks; status reads never advance recovery.

One proven receipt produces a compensating reverse Lane using the existing
revert source worker, followed by ordinary composition, a full check and final
acceptance on current main. Conflicts or source/check failures produce
fix-forward work. Accepted work and the original Lane remain retained. A later
green main supersedes a pending automatic reverse. The recovery receipt records
the failing tests, adjacent source/run proof, actual reverse receipt and undo
command. Main is never rewound.

The original Intent stays active with optional `needsFix.state` of `reverted`
or `needs-fix`, its saved accepted head, capped failure excerpts and undo command.
Compact project summaries ride existing hosted status, workspace and briefing
reads; CLI/MCP status and the next start briefing expose them. Bound native
status makes one on-demand capability read and no follow-up notice query.
Notice-aware clients opt into the additive fields; legacy clients and documents
keep their existing shapes. Web rendering and the Start a fix button remain
follow-up work.

`start {intentId}` opens a sibling from the saved head with the failure and fix
brief. Server-pinned restore bases reapply the original change plus the fix,
preserving later accepted work. Private Candidate and finish metadata retain
those bases across reviewed finishes and retries, even after a notice is closed.
Authoritative selection forces a full check; fix Lanes reserve their solo check
instead of entering deferred batches. Current hosted batches also use a full
union check and fall back to exact solo checks on failure. A notice clears only
when the Intent re-lands after the reverse or its owner closes it; replay of an
older acceptance or close cannot clear a newer notice.

Deploy the fixed source worker with optional `restoreBases` compose-plan support
before deploying server recovery hooks: those hooks can immediately schedule
recovery for red audits. Older source workers strictly reject the extended
plan. Keep the contract gate dark until the server schema/recovery, source
worker and GitHub Actions gate runner are all deployed and the combined
recovery/gate budget checks pass. Then use the drained-queue preflight and
owner-approved policy flip described in the hosted gate workflow. No backfill
is required for absent optional fields.
