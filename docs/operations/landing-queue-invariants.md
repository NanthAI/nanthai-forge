# Landing queue invariants

Targets; violations remain.

| ID | Contract |
| --- | --- |
| S1 | Current lease/fence and previous head+receipt compare before publication. |
| S2 | Exact pass, carry proof, or accepted predecessor pin before acceptance. |
| S3 | Pass older work only with unrelated known footprints and the sealed/bounded rule, or bounded only when the older side's own global risk is the sole link, a parked Ready entry included (`43b51a5e`). |
| S4 | Lifetime: one generation lost solely to newer entries; two after a wrong sealed guess. |
| S5 | Three main-race recompositions, then strict order. Exclude platform retries and batch fallback. |
| S6 | Decide and record every wait in its writing transaction; no cycles: a reservation holder never parks on an entry whose wait chain leads back to a waiter on its reservation (`43b51a5e`). |
| S7 | Parking and reclaim preserve passed evidence. |
| S8 | Shared acceptance includes every member; speculative failures settle no member. |
| S9 | Invalidate pinned descendants, preserving unrelated groups. |
| S10 | Terminal phases stay terminal and retire work; a settled queue owns no queue tasks. |
| S11 | No bare polling. Eight short lease retries, then one expiry wake; record urgent waits. |
| S12 | Alert once at the root; followers show their dependency. |
| L1 | Parked chain liveness (Item 687d1eda, option B): a parked waiter holds no timer (idle costs nothing). Every `orderWait` chain, and every row held for red main or waiting on a dependency, ends at an unparked entry, through entries that still hold the order or a live landing reservation, and that end is driven: an armed stall alarm, a finish wake due within the stall window, a live check (an entry checking a non-terminal run that has an armed confirm, an armed watchdog once the provider accepted the dispatch, or a runner lease with its matching armed expiry; a running run alone drives nothing) or a queue wake or queue lease while runnable. A held red-main row is live while main is red or its release page is armed; a row under the CI-down hold (`FORGE_QUEUE_HOLD_ON_CI_DOWN`) while its probe wake or release page is armed; a dependency wait while its parent is live or its dependents page is armed. A hop whose reservation expired but is still kept (writeLanding's `reserving` ignores expiry) is an end: live if it is driven itself, else excused only by its direct waiter's own reservation-expiry claim. A live but undriven end is excused only by the waiter's own finish wake due within one check wall; a terminal, missing, looping or order-dropping end fails whatever claim the waiter holds. Source mutants of the review e7137e30 liveness bugs must fail it. |
| L2 | A changed wait decision leaves a pending claim in that transaction. Include holder parking. |
| L3 | Unblocked Ready: one 30-second slot per predecessor plus itself. |
| L4 | Dependent waits end within remaining bounded generations and one slot. |
| L5 | Scheduled driver, armed deadline, owned provider completion, or validated chain of ≤16 hops. |
| L5b | Strict L5 (stale-check fixture, Item 9a04d916): the 15-minute stall alarm is no driver, and a finish wake counts only if due within one check wall (5 minutes). |
| L6 | Admission/compose/reservation waits own wakes: train 5 minutes, reservation 30 minutes. |
| L7 | Lease recovery finishes publication or releases it; terminal failures name a structured reason. |
| L8 | One actionable root alert after 15 minutes without progress. |

Inspector: waits, drivers, receipts, generations and terminal retirement. Fencing, batch provenance, timed bounds and alerts remain unverified.

Eight seeds cover eight profiles; 20 took 136 seconds. Counterexamples stay in the corpus; an S4 mutant must fail.

## Owner rollout decision

Calibration is stopped; retained results are unqualified. Sequence: foundation, new-run wake, parked-chain liveness (L1: the chain end owns the deadline; per-row parked alarms were rejected on idle cost, 687d1eda).
Each runtime rule has a documented switch, deleted after proof. The new-run wake (N1) has no
switch: an order holder that starts checking a run it can be charged for (`overtakeOlder` is `spend`; never while merely queued, which
is a free overtake that records no mark) drives one Ready follower whose latest receipt wait names
that holder as `accepting`/`unsealed` without overlapping footprints (a full receipt list is skipped), or one a wake handed to that holder and that has not claimed since (`orderWaitHanded`, incident `43b51a5e` case 2).
The woken claim records the lifetime mark, so the holder re-checks at most once for followers.
Carry re-pins, parking and metadata writes wake nobody. Skip failing targets with `5e3c3a3c` until
their rule lands. No parked entry (`orderWaited` unset): calls, reads and writes stay unchanged; a holder whose waiters all cancelled keeps the marker and can pay one empty indexed read.

After each landing, watch two hours or 20 dogfood landings, whichever comes first. Compare
discarded runner share, median/p90 time to main, parked entries without alarms and wakes per
landing. Morning references are 31%, 27.8 minutes and 65.8 minutes; measure missing count
baselines rather than guessing. A regression disables that rule's switch, or for a rule without one is fixed forward as a bug, and goes to the lead.

Cap 3, urgent-retry removal, early-refusal scope and per-generation `unsealed` wait for a real
N=10 bench A/B of both arms, with owner go. The lifetime S4 bound remains.

## Settlement after a main move

A Ready finish keeps its passed evidence while parked on an older entry.
When the holder leaves the order, the release wakes the oldest waiter and hands
the rest to it. If main moved, publication refuses the first waiter's old head
or receipt with `CHANNEL_CHANGED`. The finish releases its lease, reserves a
named retry on current main and recomposes the original inputs. That retry
either proves carry or needs another check. Followers handed to it can then
meet another main move when it publishes. See the [order claim](../../convex/projectHostedLandingControl.ts),
[waiter release](../../convex/projectHostedFinishWake.ts),
[publication fence](../../convex/projectHostedAcceptancePublish.ts) and
[named retry](../../convex/projectHostedFinishCompose.ts).

Waking all waiters can start their decisions sooner, but each single-head
publication changes the predecessor the remaining proofs must cover. If they
all recompose on the same main, each later publication must still re-pin or
recheck. Waking dependent entries sooner can start work on a base their holder
will supersede. The existing early-refusal path already groups certainly stale
pre-queue passes within the bounded cohort hold where it can. Its five-entry
fixture lands the first pass and groups four refusals into one replacement check
with no extra calls against its serial baseline. The fixture also checks that
there is no work left scheduled after settlement.
[Early-refusal guard](../../tests/hosted-landing-early-refusal.test.mjs)

The 121-landing ladder window recorded 45 post-check waits ending in
`CHANNEL_CHANGED` across 35 landings. Their per-landing unions total 761.6 minutes.
The carry hop trace measured p50 of 0.8 seconds in scheduler hops out of 23.2
seconds from CI end to commit. In a fixed-timeline sensitivity, removing up
to 0.8 seconds from each affected interval saves 0.8 seconds at p90, about
0.1% of the estimated gain from halving those waits (52.89 to 42.02 minutes).
The receipt timings cannot separate a greater saving from the risk of
starting speculative work. The estimate supports keeping the existing scheduler. [Ladder and cause split](https://dev.forge.nanthai.tech/?project=mh7aafndrxmj8c2q0931zbjk2n8h4ffs&projectTab=planning&planningItem=45f49fb7-d591-44c5-b94c-319b37577835)
[Hop trace, comment 287a6ce4](https://dev.forge.nanthai.tech/?project=mh7aafndrxmj8c2q0931zbjk2n8h4ffs&projectTab=planning&planningItem=4e013cdb-5ed0-4ed7-85ea-6b9ec144738c)

The full round in design note `755da7b1` needs a trusted Candidate for each
carried prefix and chained publication that preserves each member's own
head, check proof, receipt and revert target. Today's batch publication
writes every member's receipt against one shared checked head.
The design estimate is 30–40 agent-hours. The
[settlement model](../../models/landing-queue/README.md#settlement-round-after-main-moves)
tests ordering and evidence under a second main move and a lost wake. The
model does not measure service latency or cost.
[Batch publication](../../convex/projectHostedLandingBatchPublish.ts)
