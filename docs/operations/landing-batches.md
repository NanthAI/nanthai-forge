# Landing batches

The [hosted queue](../agents/workflow.md#landing-queue) continues after clients disconnect.

Receipts, timing, queue advice, priority and pre-queue checks follow.

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

Before a cohort composes, one finish action uploads the missing exact metadata
pages and plan together (at most three objects). Already-stored pages keep their
existing binding. One resume publishes the verified bindings together and
schedules the normal finish settle. The settle still checks priority and cohort
eligibility before dispatching the original source operation. A failed or lost
upload leaves the same retained wake to retry. The scheduler receives no plan
bodies, and this changes neither source authority nor check selection.

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
Waiting behind a live
predecessor does not raise `LANDING_STALLED`; old false alarms are retracted from
current reads. Unrelated queue progress cannot postpone an ownerless entry's alarm
or reset a failed controller's retry count. An ownerless wait names its predecessor in the alarm. The existing
orphan-recovery deadline remains, so losing that predecessor cannot strand work.

## Hosted queue priority

Hosted Candidate submissions are ordered by `orderLandingEntries`: urgent before normal, then arrival order, with the same two-entry submitter
fairness within each priority class. Existing submissions without priority are
normal. Hosted `finish` accepts `priority:"urgent"|"normal"` (omission means normal),
including while its Candidate is still composing. The authenticated project owner,
or an agent using that owner's authority, can request urgent. Other contributors
still submit normally and receive a `priorityReason` explaining the governance rule.
Priority changes order; it does not change check, review or acceptance requirements.

Independent checks run in parallel; acceptance uses submission order within priority classes.
Failed, stalled, red-main-held, review-waiting and dependency-waiting entries give up order.
Related or unknown footprints keep strict order; combined and predicted-head groups overtake nothing.
An unrelated solo pass may bypass graph-sealed work. Sealing requires reusable full evidence and
`auto-on-pass` reuse policy. Scoped or non-dependent proof refusals mark `unsealed` for life.
Otherwise `overtaken` spends one generation; the next check holds order. A wrong sealed prediction
allows at most one additional lost generation. An older entry linked to a disjoint pass only by its
own global risk (the pass touches no risk file and no shared sequence or test folder) is never
sealed, since its pass cannot carry, but takes the same one-generation overtake instead of a
`dependent` hold (incident `43b51a5e`: one workflow file held 9 passes for 80 min). A Ready
entry parked behind an older submission is not about to land, so it takes that overtake too,
once for its passed generation.

`orderWaits` records up to eight holders with `held` reason, `footprints` classification and measured
`seconds` when a recorded Ready wait ends. Older waits without a start time omit `seconds`. A
withdrawal discards the still-open interval. The queue records these times within its existing row updates,
reading Candidates only for a new comparison; a link made only by the older side's own global
risk counts as `disjoint`. Current parking clears the waiter's alarm and hands remaining waiters
to the oldest wake; incident `5e3c3a3c` exposes stale edges in that path. A handed Ready waiter is marked as handed to
the entry it now waits for (`orderWaitHanded`; its own next claim clears the mark and records its
real wait), so the new-run wake finds it if that entry re-checks instead, a queued entry (a
conflict cohort or an early resolution) that then binds a run included. A waiter whose latest
claim recorded an overlap with the holder that then landed gets no mark (main moved under its
files, so its pass cannot carry); neither the new-run wake nor a baton drives a waiter whose latest
claim overlaps the exact entry it waits on, one that was left unmarked that way, or one whose own
change touches a global-risk file (`ownGlobalRisk`, set by its claim from paths it already read:
every older live entry holds it, so a drive only parks it again; not for an urgent waiter, whose
claim skips non-urgent older entries). A holder that leaves
without landing (withdrawn, failed, parked on red main) hands its waiters on marked: their passes
still carry (review `14cf6d7e` F1). A full receipt list is unknown and never held this way. A
publication hold on red main ends the entry's reservation, as parking does. An entry that parks for a
hold lasting a check (its holder is not a Ready entry about to land) passes the Ready followers
handed to it on: it drives the oldest younger one and hands it the rest, one index page per park
and only towards higher sequence, so a reservation wait can never close a wake cycle (incident
`43b51a5e` case 2: 12 passes waited out each head's re-check in a chain). A reservation holder
never parks on an older entry whose chain of parked waits leads back to a waiter on its own
reservation (handed links included; the chain is read, at most 8 rows, only for the entry it
would wait on): a solo holder that may overtake goes ahead of that entry when their footprints are
disjoint; otherwise (an overlap, a combined group, a pipelined successor) its reservation ends and
its waiters are woken (`43b51a5e` case 3: three landings and ten passes
behind them waited for each other until the reservation's time bound). A spent bounded step is
recorded as `overtaken` whether or not the older entry's pass could carry.
The [queue invariants](landing-queue-invariants.md) distinguish current defects from target
wake/deadline guarantees and describe the replay gate. `CHANNEL_CHANGED` retains which older
or newer landings moved main; a recheck count alone does not establish starvation.

An owner can reprioritise a queued Candidate submission through the existing agent
CLI or the hosted `forge_task` MCP tool:

```sh
nforge x ROOT prioritize '{"submissionId":"SUBMISSION_UUID","priority":"urgent","operationId":"CHANGE_UUID"}'
```

Use `priority:"normal"` with a new operation ID to undo a promotion. Replay the same
operation ID and parameters after an unknown reply. The command retains the
original priority version; an older retry cannot overwrite a later owner's change.
The queue itself raises a submission to urgent once, on its third re-check caused by main moving
(the recompose cap, [queue invariant S5](landing-queue-invariants.md)). The `priorityReason` says so,
and the same `prioritize` undo applies.
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
predecessor lands unchanged, even if the successor check completed first. Cohort
formation takes queued entries without a bound check. Progress wakes leave a
checking solo entry and its successors in their current generations. An
individual fallback with an immutable Candidate, reserved acceptance receipt and
exact live check is also a valid predecessor; its solo flag prevents re-batching
that member. When a cohort falls back, its shared generation leaves the train.
Waiting siblings take their solo compose turns through the fallback controller,
so a parked member cannot block the older work it is waiting for. A split
singleton's withdrawal leaves its sibling cohorts and their check generations
in the train.
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
A batch never outlives its members. When a member ends (cancelled,
superseded, dropped or failed on any path, or landed alone after leaving the
cohort), the same write checks its batch: if it is still composing, checking
or in fallback and no member is live, it settles `landed` through the ordinary
batch write, which releases its capsule waits. That reads the batch and member
rows up to the first live one, at most eight. A composing or checking batch
first retires the successors stacked on a member that ended failed; one
stacked on a member that landed keeps its check, since its publish still
compares the pinned head. The shared publish skips the check: it settles its
batch in the same transaction. Late compose or check results for a settled
batch change nothing. As a backstop, the capsule pack step, which already
reads the batch of a landing that ended at least 7 days ago, applies the same
rule when it finds that batch still open: if no member is live it settles the
batch, packs the landing and writes one `LANDING_BATCH_LEAKED` failure-log row
naming the batch (`nforge metrics ROOT --failures`). A healthy batch is
terminal long before then, so this adds no calls or reads to the healthy path.
Early-resolution advice distinguishes conflicts against the outer base from
conflicts between cohort members. Internal conflicts are exposed after the
survivor check is installed and pin its exact checked State and reserved
receipt, so a disjoint outer predecessor cannot replace the conflicting peer.
A conflict from that speculative base becomes terminal `COMPOSITION_CONFLICT`
only on the matching accepted base or after recomposition on current main. Conflicts composed without a
speculative predecessor retain their existing immediate terminal behavior.

A retained compose with no live check holds its slot for at most five minutes
(`HOSTED_TRAIN_HOLD_MS`); ordinary review, contributor and recovery work keeps its
existing path. Metadata selection reads only bounded indexed cohort windows and
the bounded active train, independent of queue length and retained history.

With `acceptance.admissionCheck: "full"`, only changes whose own Lane check
passed form a cohort; an unadmitted change checks alone
([passed-change grouping](../pre-queue-checks.md#decision)).

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

When main already moved during source preparation, a batchable retained goal queues its exact selection
for recomposition on current main before starting admission. The existing main read supplies this
comparison; no extra query or source probe is made. A conflict with already-accepted source spends
no check.

Absent or `false`, `acceptance.admissionCheck` checks the composed head in the queue.
`"full"` opts in to a separate pre-queue Lane check. It makes admission the project's configured check on any configured runner: GitHub Actions, other hosted CI or a registered
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
  entry can publish only after the group. The same holds through any chain of waits:
  an entry never parks on one whose order waits or stacked predecessors lead back to
  it (it goes ahead instead), and when the predecessor it is stacked on is parked on
  such a chain, that predecessor's claim runs again and goes ahead (if the entry
  holds a live reservation, the reservation ends instead, as in a reservation
  cycle). At most 8 indexed reads per claim, only for a parked or stacked entry it
  would wait for; rows the claim already read cost none.

A pending full admission can be the first predicted-head predecessor when a
follower has known disjoint paths with unplaceable global risk in Strict mode.
Instead of checking the follower alone and repeating after the predecessor
lands, the follower uses one full check of their exact union in the existing
pipeline. In Strict and Fast mode, overlapping paths whose fixed predecessor already holds queue order use that same exact composition before a follower check is reserved:
a real text conflict returns pinned advice while the predecessor is pending, and only becomes
terminal against accepted main. A failed predecessor releases the follower's original source.
Earlier admissions still hold no queue order and do not become overlap predecessors. A full execution width queues the overlapping follower for existing capacity instead of starting
an independent admission that cannot detect the conflict. Merge semantics are unchanged.
Unknown paths, placeable disjoint manifests, disjoint risk in Fast mode,
Fast-mode disjoint arrivals, different actor/policy/check/priority pins and disjoint risk at a full execution width keep the
ordinary admission path. The predecessor keeps its admission and holds no general queue
order. A successor that passes first parks its exact proof on that predecessor's
existing settlement event; it does not treat the still-unaccepted base as a main
race or repeat its check. Admission platform retries retain those waiters and pins. Its admission pass preserves the same predicted head and receipt; failure,
review or changed source/receipt invalidates descendants through ordinary train
recovery. No publication uses an unchecked combination.

A successful two-entry risk pair uses two checks instead of three, with no extra
runner minutes. If a pending predecessor fails or changes, an already executing
follower may waste one full combined check before checking its restored selection;
that costs that check's runner minutes. The existing pipeline width bounds such
speculation. No new table, queue timer, per-file call or idle work is added. The
fake-clock A/C replay and its 4,000-file metadata budget are in
`tests/hosted-landing-overtake.test.mjs`.

Lane checks wake their submission only when the run reaches a terminal state;
nothing polls and an idle queue costs nothing.

Measured on the synthetic 12-Lane wave (`tests/hosted-landing-prequeue.test.mjs`:
real queue code, fake 22-minute runs, 12 changes arriving together, 3 of them red):

| | Before (`admissionCheck: false`) | Lane check (e7d27937) | With full admission and cohort hold |
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
the stall alarm finds a repeated lost compose drive, splits the same way. The first
lost drive replays its retained generation within the existing train hold; only a
second loss splits it. A shared check that ends
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

