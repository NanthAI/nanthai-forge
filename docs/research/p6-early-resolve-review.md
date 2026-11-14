# Early resolution review: verdict, invariants and build order

Status: **review and decision for Issue 8c9b84fc.** Early resolution stays. Its targeting, its place in
the train, its Automatic rule and two lifecycle rules change. Labels: **M** measured, **R** read from
source, **U** unproven. Evidence stays private; this page holds derived numbers and synthetic roles only.

## What was reviewed

Early resolution tells a late overlapping landing about an exact conflict with an unaccepted
predecessor as soon as the trial merge proves it, and lets the agent resolve against that predicted
State while the predecessor still checks ([pre-queue checks](../pre-queue-checks.md)). The earlier
[N=10 diagnosis](p6-n10-diagnosis.md) measured the problem it removes.

Three live N=10 pairs on the first build with it (M):

| Measure | Before | With early resolution |
| --- | --- | --- |
| Forge wall to all landed, seconds | 932 / 1024 / 1002 | 810 / 759 / 831 |
| Forge median task time to main, seconds | 402 / 374 / 360 | 417 / 402 / 403 |
| Conflict resolutions per cell | 2 / 2 / 2 | 1 / 0 / 1 |

One further cell voided: the late task landed, but an older submission of the same work stayed queued
for an hour. That cell is the subject of most of this page.

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
3. **The saving so far is one avoided resolution, not a parallel check.** Early resolution ran in two
   valid cells. In one the predecessors had landed before the resolved landing came back. In the
   other the resolved landing started a check on the predicted prefix, lost it when the third
   overlapping task landed, and checked again after every predecessor (M). Its time to main was
   786 s; with a surviving check the same schedule gives about 610 s (E).

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

**D4. Automatic uses expected waste against expected saving.** Resolve early while
`failure × resolution < (1 − failure) × wait`, that is `failure < wait / (resolution + wait)`. The
previous rule compared against `resolution / (resolution + wait)`, which turned early work off as
the saved wait grew. Explicit on and off still win.

**D5. Advice never fails the survivors.** Emitting advice is best effort. An error while naming a
Lane or reading a pin leaves the rejected member on the ordinary wait; it never returns a checked
cohort to individual checks.

**D6. The setting is temporary.** If the registered runs show Automatic never chooses to wait, the
sampling and the Automatic value are removed and only off remains.

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

| # | Slice | Fails first on |
| --- | --- | --- |
| 1 | Lineage invariant: supersede on conflicting sync, on resolution landing, on ownerless retry | replay of the voided cell: successor lands, older submission still live |
| 2 | Owner invariant: recovery on entering composing, repair on train drop, alarm and probe rules, observability | same replay with the leader drive failed, cancelled and dropped: no entry may wait past the compose bound |
| 3 | Target and guard: survivor target (draft), clean early sync refused, total advice | internal conflict with a disjoint outer predecessor; clean pinned sync |
| 4 | Linear train for resolved landings | scripted conflict trio: the resolved landing's first check must be the one accepted |
| 5 | One attempt fork helper with a lint guard; the retained conflict forks the current attempt (draft) | conflict retention after an installed check |
| 6 | Automatic rule (draft) and the D6 removal decision | rule table |

Each slice keeps the disjoint path at its current modelled cost per landing, keeps idle at zero
calls, and adds no table, public error code, agent action or setting.

## Proof

Fake clock first: the scripted conflict trio and the replay of the voided cell run on production
controllers with injected services. Then the registered scripted conflict and clean cells, then three
live N=10 pairs. The bar: no operation pending at grading in any cell, the late task's first
post-resolution check is the accepted one, clean cells within noise of the previous build on
submit-to-check and control calls, and wall to all landed no worse than the three cells above.

## Limits

- The median time to main is 29 s higher across the three new cells. The GitHub arm's comparable
  tasks drifted 10 s in the same sessions, check duration rose 7 s and submit-to-check 8 s, each
  inside its spread (M). In two of the three cells the median task had landed before early
  resolution first ran, and one cell never used it; all three show the same median. This is not
  attributed to the design; the scripted clean cell settles it (U).
- The exact lost link in the stranded submission is U until the observability above exists.
- Advice still follows cohort compose, about a minute after submission at this load (M). Offering
  the pinned sync from the save-time conflict notice, when the peer is already checking, is the next
  latency lever and is not built.
