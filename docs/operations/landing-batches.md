# Landing batches

Forge lands every change through the [hosted landing queue](../agents/workflow.md#landing-queue).
The queue runs on the server: it keeps going after a client disconnects, and no owner process
or local worker is needed. The native-owner batch driver that this page used to describe was
removed with one client mode (Issue 657d63ee). Its journals, its `land-ready` recovery command
and the owner Mac service went with it.

This page covers what a queued landing reports, how hosted progress keeps its timing,
queue-ahead advice, queue priority and the pre-queue Lane checks.

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

Lane `status` exposes these same submissions, including pre-Candidate dependency
waits. `land` includes one summary line per input Lane. Existing
entry statuses and counts remain available for compatibility; automation should
use submission state/reason/cause to distinguish waiting from failure. These read
adapters do not run checks or change acceptance policy.

## Attempt timing

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

Hosted Candidate submissions are ordered by `orderLandingEntries`: urgent before normal, then arrival order, with the same two-entry submitter
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
waits for review or a dependency. An order-release event replaces any pending
reservation or hold expiry wake immediately; a passed cohort never waits for an
obsolete bound after its holder ends.

A passed solo submission does not wait for an older entry it is independent of: when
neither change's paths equal, contain or sit inside the other's (the Candidates'
stored changed paths) and together they touch no [global-risk file](../pre-queue-checks.md#global-risk-files)
or shared test folder, it takes main first (core-claim incident `7d98c7da`, 2026-11-08:
passed landings waited 17-40 min behind unrelated rechecks). The older entry keeps its
check: on moved main it lands on that pass through the first-check rule, which applies
the same test, so an independent landing never makes it re-check.

**Graph-sealed order** (Issue `c6b81429`): an independent older entry never holds a
passed newer one, for any number of its check generations, including a Ready entry
that is itself parked behind an older submission. N independent landings therefore
reach main in about one check wall plus serial acceptance, however many dependent
entries are re-checking ahead of them. It is not sealed, and the bounded rule below
decides, when the older entry is urgent, is a Ready entry about to take main (the one
acceptance slot), is a member of a combined group, belongs to a project whose policy
keeps exact rechecks (`hostedCrossHeadReuse:false` or acceptance other than
`auto-on-pass`), or is **unsealed**: its re-check is scoped, or a proof of its pass was
refused for a reason no dependent change causes (audit debt, a scoped first check,
reuse policy). `unsealed` is set on the row once, in the write that installs that
attempt, and kept. The bounded rule: such an entry gives up its place to an unrelated
newer one for one check generation only (`overtaken` on the row); its next check holds
strict order, so it re-checks at most once because newer entries overtook it (at most
twice when a sealed guess was wrong). Combined groups and groups checked on a
predecessor's predicted head overtake nothing; dependent entries keep strict order.

The decision reads the claiming entry's project row and Candidate once and one Candidate
per skipped entry, in the claim transaction; no call is added and an idle queue costs
nothing. Each new wait is recorded on the row and copied to the receipt as `orderWaits`
(at most 8): the older `submissionId`, `held` (`dependent`, `unknown-paths`,
`accepting`, `urgent`, `overtaken`, `unsealed`, `no-proof`, `combined`, `composing`)
and `footprints` (`overlap`, `disjoint` or `unknown`). `landings` lists it. A
`disjoint` wait always names its cause; `accepting` is the acceptance slot, not order.
Recording reads the two Candidates only when the holder was not already compared.

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

An owner-review hold releases the predicted predecessor and any file reservation at once.
Dependent members retain their exact check bindings until those runs settle, then
recompose their original selections on current main. A full passing check is reused
only for an identical file tree (paths, blob hashes and modes), with the existing
reuse policy, authority, runner and main-audit checks. Changed trees get fresh checks.
A failed speculative run cannot fail the fresh composition. The owner-held submission
keeps its review pins and returns on approval against main as it is then. Existing
held trains are repaired on the next queue event, with no scan or idle timer.

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
