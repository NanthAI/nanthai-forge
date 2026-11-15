# Early resolution review: verdict, invariants and build order

Status: **review and decision for Issue 8c9b84fc.** Early resolution stays. Slices 1 to 5 of the build
order are on main and were measured live; the Automatic rule and its sampling are removed (D6), and
the review of the landed build left the follow-ups listed under [After landing](#after-landing). Labels:
**M** measured, **R** read from source, **U** unproven, **E** estimated. Evidence stays private; this page
holds derived numbers and synthetic roles only.

## What was reviewed

Early resolution tells a late overlapping landing about an exact conflict with an unaccepted
predecessor as soon as the trial merge proves it, and lets the agent resolve against that predicted
State while the predecessor still checks ([pre-queue checks](../pre-queue-checks.md)). The earlier
[N=10 diagnosis](p6-n10-diagnosis.md) measured the problem it removes.

Three live N=10 pairs on each build (M):

| Measure | Before | First build | Build with slices 1 to 5 |
| --- | --- | --- | --- |
| Forge wall to all landed, seconds | 932 / 1024 / 1002 | 810 / 759 / 831 | 819 / 763 / 690 |
| Forge median task time to main, seconds | 402 / 374 / 360 | 417 / 402 / 403 | 359 / 364 / 360 |
| Slowest task time to main, seconds | 918 / 988 / 963 | 786 / 732 / 808 | 790 / 748 / 661 |
| Conflict episodes per cell | 2 / 3 / 2 | 1 / 0 / 1 | 1 / 2 / 1 |
| Check runs per cell (discarded) | 8 / 9 / 9 (0) | 9 / 8 / 8 (1) | 9 / 8 / 7 (0) |

One further cell of the first build voided: the late task landed, but an older submission of the same
work stayed queued for an hour. That cell is the subject of most of this page.

## Verdict

1. **The mechanism is right.** No alternative lets the late arrival resolve sooner: accepted main
   does not contain the conflict yet, Forge cannot resolve a real conflict by itself
   ([structural merge](structural-merge.md) selected no merger), and making cohorts serial gives up
   the CI saving. The conflict is known at compose time; acting on it then is the whole gain.
2. **Its shape is wrong in four places**, each seen in the runs:
   - the resolution target was rebuilt from queue metadata and could miss the conflicting peer;
   - the resolved landing was composed on its pinned predecessor instead of the train tail, so a later
     overlapping group that landed first discarded its check;
   - the Automatic rule was inverted;
   - nothing ended an older live submission when its work continued in a resolution Lane, and
     nothing owned a cohort that re-entered composing.
3. **The saving is resolution time, not a parallel check.** On the first build, early resolution ran
   in two valid cells. In one the predecessors had landed before the resolved landing came back. In
   the other the resolved landing started a check on the predicted prefix, lost it when the third
   overlapping task landed, and checked again after every predecessor (M); its time to main was 786 s.
   On the build with slices 1 to 5 it ran in two of three cells: each resolved landing was checked
   once and that check was accepted (575 s and 661 s to main), including one where another group was
   accepted while it checked (M). In both, the predecessor had landed, or landed within seconds,
   before the resolved landing's check started. The agent resolved while the predecessor was still
   checking, which is worth 75 to 100 s per episode (E, and the product's own samples say 100 s, M).

## Decisions

**D1. One rule names the prefix.** Advice names, and the resolved landing composes on, the same
State: the current fixed train tail, when its exact predecessor chain contains the State the worker
signed the conflict against. A conflict between cohort members uses the installed survivor check; a
conflict against the outer base uses the outer predecessor. No second rule selects a compose base for
early landings.

**D2. A clean early sync is a refusal, not a success.** The advised State was chosen because an
exact trial merge conflicted with it. If the pinned sync of the same Lane head merges cleanly, the
target was wrong. Forge then keeps the original submission, records no early pin and says so. This
is the mechanical guard for the wrong-target class.

**D3. Early pins are acceptance preconditions only.** The train stays linear. A resolved landing is
selected like any other entry and composes on the tail; acceptance still requires each pinned
predecessor's exact head and receipt. A predecessor that lands is then the predicted base, so the
stale-check rule keeps the check.

**D4. Superseded by D6.** The expected-waste rule was corrected before the live
review; the measured runs showed no useful wait branch, so no rate rule remains.

**D5. Advice never fails the survivors.** Emitting advice is best effort. An error while naming a
Lane or reading a pin leaves the rejected member on the ordinary wait; it never returns a checked
cohort to individual checks.

**D6. Remove Automatic and its sampling; only off remains.** Implemented; only the owner-off override remains. The registered runs settled the condition this
decision waited on. Automatic never chose to wait: it measured an 8 to 9% predecessor
failure rate against a break-even of 69 to 70% (resolution 44 to 45 s, wait saved 100 to 101 s, M).
By D4 it waits only when more than about two thirds of watched predecessors fail, or when the wait
left is a few seconds; the first is a broken train and the second saves nothing. A project that does
wait stops measuring and returns to cold start, so the choice cannot hold either (R). The sample
window is a write to the queue row and three clauses of advice text for a branch that does not fire.
Early resolution is on unless `acceptance.earlyResolve` is `"off"`; stored
`"automatic"` and `"on"` read as on.

## Two invariants

### A live submission always has an owner

A pending landing is owned by exactly one of: the queue (runnable), a running check, a finish drive
whose scheduled task is pending or running, an order wait on a live holder, or a review. An owner
that is a single scheduled drive can be lost; Forge has met this before for order waiters.

The stranded submission was a cohort of one that re-entered composing after an overlapping landing
moved main (R, M). Its only owner was the leader's finish drive scheduled in that transaction. No
compose result was ever consumed. Three existing safeguards then missed it (R):

- the train hold expired after five minutes and the queue dropped the train so later work could
  move, but nothing repaired the dropped cohort (a later landing's check started 1.4 s after that
  expiry, 82 s after its submission, M);
- the fifteen-minute alarm saw other entries land, treated that as progress for this one, and
  re-armed at sixty minutes;
- the lost-driver probe covers a Ready entry's finish, not a queued cohort leader's.

The retained observations do not include the finish wake, the cohort record or the scheduled task,
so which link broke is **U**: the drive failed, was never scheduled, or ended without scheduling its
next step. The invariant holds for every one of them:

- **Entering composing arms recovery.** The transaction that puts a cohort into composing arms a
  bounded recovery owner for its leader, as every later compose step already does.
- **Dropping a train repairs it.** When the queue drops a train for a dead compose, it re-drives or
  splits that cohort in the same transaction.
- **Queue progress is not my progress.** An alarm is deferred only for an entry that waits behind a
  live predecessor. An entry first in line, or one whose own cohort is composing, is probed.
- **The probe covers cohort leaders** and reports a finish wake that failed, was cancelled, ended
  without a successor, or is missing.

### One Lane lineage has one live submission

A resolution Lane continues its origin Lane's work. Today a sync that conflicts creates the
resolution Lane and leaves the origin's live submission alone, unless that submission is queued with
sync-required advice (R). The stranded submission had no advice, so its successor landed beside it.
A repeated `land` with the same selection also joins the live submission, even with `retry`, and
does not check whether anything drives it (R).

- **A conflicting sync ends the origin's live submissions** in the publish transaction, as
  `LANDING_SUPERSEDED`. The conflict proves the same head cannot land on that target.
- **Landing a resolution Lane ends them again** in the completion step that already completes the
  origin Lane. This is the backstop for every other route.
- **A retry re-drives.** Joining a live submission runs the lost-driver probe; an ownerless one is
  superseded and the new request is admitted.

A model test asserts, after every transition, that each Lane lineage has at most one live submission
and each live submission has an owner.

## Smallest observability that names a lost owner

No new table and no new call. The cohort record, already written at each step, keeps its last
drive step and time. The supervisor round, which already reads the scheduled task, writes what it
found into the stall it publishes: the finish wake's state, the compose status and the cohort step.
A landing that needed repair then names the driver it lost in `observe`, `queue` and its receipt.

## Build order

| # | Slice | Fails first on | State |
| --- | --- | --- | --- |
| 1 | Lineage invariant: supersede on conflicting sync, on resolution landing, on ownerless retry | replay of the voided cell: successor lands, older submission still live | on main |
| 2 | Owner invariant: recovery on entering composing, repair on train drop, alarm and probe rules, observability | same replay with the leader drive failed, cancelled and dropped: no entry may wait past the compose bound | on main |
| 3 | Target and guard: survivor target, clean early sync refused, total advice | internal conflict with a disjoint outer predecessor; clean pinned sync | on main |
| 4 | Linear train for resolved landings | scripted conflict trio: the resolved landing's first check must be the one accepted | on main |
| 5 | One attempt fork helper with a lint guard; the retained conflict forks the current attempt | conflict retention after an installed check | on main |
| 6 | Automatic rule corrected (D4), then removed with its sampling (D6) | rule table | removed |

Each slice keeps the disjoint path at its current modelled cost per landing, keeps idle at zero
calls, and adds no table, public error code, agent action or setting.

## Proof

Fake clock first: the scripted conflict trio and the replay of the voided cell run on production
controllers with injected services. Then the registered scripted conflict and clean cells, then three
live N=10 pairs. The bar: no operation pending at grading in any cell, the late task's first
post-resolution check is the accepted one, clean cells within noise of the previous build on
submit-to-check and control calls, and wall to all landed no worse than the three cells above.

## After landing

The landed build was read against this page and measured in five live cells (three N=10, two overlap
N=8). Both invariants held: every cell settled with an empty queue, no landing was dropped, no stall
alarm or repair ran, and the only superseded submissions were the advised originals, one per early
episode (M). Strict acceptance is unchanged: every early pin is still an exact acceptance
precondition (R). Convex cost per landing did not rise once the meter's own metrics read, which grows
with retained history, is set aside (M). The post-review fixes now cover these four findings; live requalification is still separate:

1. **A waiting early entry has an event owner.** The failed shared-check/solo-tail
   fixture reproduced an ownerless queued wait. The current claim already clears
   runnable, so the proposed tight loop was not reproduced. The resolution now
   parks on a predecessor settlement/re-pin event and retains its recovery alarm.
   The new fixture guards the event-owned wait through acceptance and zero idle tasks.

2. **No conflict notice against what a Lane already resolved (M).** When the predecessor's Lane is
   still open, the save that completes an early resolution flags an exact conflict between the
   resolution Lane and that predecessor, and later replies tell the agent to change its edit. The
   compose is clean. Trial merging now proves peer deltas already contained in
   the recorded resolution target and omits them; a later peer edit still gets
   checked. Acceptance closes old notices, including for Lanes left open.
3. **Advice cannot leave partial state.** Optional reads precede parking. The
   predecessor's settlement owner is marked first; failures during member writes
   propagate and roll the mutation back. The injected partial-write failure leaves
   every rejected member unchanged.
4. **The recovery alarm outside composing keeps the ordinary probe.** A five-minute
   recovery alarm that fires after composing ended re-arms the fifteen-minute
   alarm at the original progress bound, rather than falling to the hour deadline.
   Same-selection retries probe every live phase, and withdrawing a preparing goal
   returns terminal cancellation while fencing late source completion.

## Limits

- The higher median time to main on the first build did not persist: 359 to 364 s on the build with
  slices 1 to 5, against 402 to 417 s (M). It was session noise, not design cost.
- The exact lost link in the stranded submission is still U. No live cell lost a driver, so the
  retained owner diagnosis has not yet named one.
- Live cells did not produce an overlapping third group accepted while a resolved landing checked;
  only the fake-clock trio covers that shape.
- Advice still follows cohort compose. The save-time conflict notice named the conflicting peer 40 s
  and 76 s before the advice reached the agent in the two early episodes (M). Saved-peer
  notices now offer pinned sync when the peer is already checking. The fake-clock delivery
  schedules improve 295 to 255 s and 331 to 255 s with three checks and zero idle tasks;
  those are synthetic results, not new live measurements.
