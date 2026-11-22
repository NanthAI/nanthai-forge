# Queue shape replay specification

## Workload and input provenance

All times are minutes unless marked otherwise. Each seed has four hours of
warm-up and 20 scored hours. Every job drains after arrivals end. The frozen
Forge-profile traces use Poisson arrivals with a 20-minute high plateau at
twice the nominal rate each hour and a low plateau at half that rate, with a
seeded phase. The three retained fields are submit time, solo failure mark and
an independent uniform mark. The refit originally generated raw rates of
`nominal / (1 - p)`. Shape cells thin by `raw target × (1 - p) / nominal`
using the independent mark. The achieved number of scored offers varies by
seed. Rates and all other inputs are shared across paired cells wherever the
shape does not vary them.

| Input | Basis |
| --- | --- |
| Forge baseline offered load | 5 raw offers/hour is an assumption near the observed dogfood regime. The retained week had 641 accepted landings, or 3.82/hour. |
| Full Check | Shape median 9.5 min from the weekly CLI capture. The refit's original 9 min anchor stays in the historical arm. The refit used 80 worker-minutes and 12 simultaneously reserved slots. Reservation conservatively keeps the configured group until completion. |
| Scoped Check | Medians of 7.72 min wall and 78.25 worker-minutes from 385 ledger runs classified as scoped rechecks. For each run, use the longest positive job interval as the wall proxy and sum positive job intervals for worker-minutes. This sample sets service for a scoped tier, including fallback work present in the sample. |
| Check mix | The baseline routes 60% of synthetic offers through a full gate. This is an assumed workload mix, loosely guided by 625 first/main-race starts and 385 scoped recheck starts with job timings. Those counts do not measure the fraction of landings that require a full suite. The weak-selection cell uses 80%. A Lane keeps its assigned composition across rechecks. |
| Capacity | 60 worker slots from the refit's Forge profile. This is a shared-capacity assumption, including for the large monorepo. |
| Competing jobs | One slot per job from the observed ledger. Windows start 0, 2 and 5 days after 2026-11-14 22:18 UTC for seeds 137, 311 and 571. The original refit excludes modeled landing gates and pre-queue checks from background. Shape cells additionally exclude the removed Verify Forge mirror push workflow. Other measured jobs stay fixed across shapes. |
| Service variation | Lognormal scale with sigma derived from the observed 9.5/11.5-minute p50/p90. The same draw scales wall and worker time. |
| Failure inputs | Weekly first-red proxy 85/333, rounded to 0.255 as in the refit. Durable solo-failure probability is `(p - flake) / (1 - flake)` with an assumed 2% additional transient risk on an otherwise green run. A transient rechecks. A durable red closes without modeling an author's repair. |
| Publication | Draws from 158 unblocked settlements and 89 last timed recompositions. The observed distributions are capped at their respective p90 before drawing. Settlement and recomposition share one serial station. |
| Overlap | A baseline change selects one of 12 packages and touches a shared file with probability 20%, giving about 12% pair overlap. The monorepo assumes 200 packages and a 60% chance of touching a shared file, giving about 36% pair overlap. The extra cross-package overlap represents a shared schema or manifest. The refit's assumed contextual failure rate is 1% given overlap, checked only across the eight neighboring IDs on either side. |
| Slow CI and high traffic | Slow CI sets full wall time to 60 min and scales scoped wall and both costs proportionately, holding slots fixed. High traffic changes only mean raw offer rate, to 30 or 60/hour. |

## Model rules and limits

The pool runs queued work that fits available slots, in arrival order among
jobs that fit. On completion the pool releases slots and dispatches waiting
jobs before the check result's callback. Ties follow event insertion order.
All started work, including checks for rejected arrivals or superseded heads,
contributes to the relevant totals. The historical refit draws a main-race
discard on green with odds 425/641 per success. Its optional sampled hold
retains receipt hold values unchanged except for the prior time scaling.

The shape arm instead records the main position when each Candidate is
submitted for checking. A green singleton can move across independent main
advances and skip older independent singletons, following the sealed path
of Forge's [landing order](../../src/landing-overtake.ts). A green Lane waits
behind older active Lanes on overlapping paths. A disjoint move requires a
recomposition before a reusable full pass can land. An overlapping move, or any
move under a scoped pass, requires recomposition and a new Check. Disjoint work
can overtake an older unsealed entry once. Its replacement generation holds
order, with an exception for a disjoint follower that already passed when that
replacement started. Wake parked passes at settlement or when a replacement
starts and reevaluate their pins before serial publication. Contextual
incompatibility produces a red verdict on that Candidate. Assert that each
publication is individually green and compatible with accepted members.

This is a singleton capacity model. It approximates path-related proof
refusals and order waits. It omits combined batches, exact input and text
merges, global-risk files, priority, audit debt, red-main recovery, early
cancellation, provider quotas outside the fixed slot pool, and developer time.
There is no historical sampled hold or additional random main-race guess in
the shape arm. The baseline uses Forge-shaped inputs and a synthetic queue.
For comparison, the frozen hosted capture had submit-to-main p50/p90 of
39.1/61.5 min on the last 20 eligible observations. Differences from those
figures include the model's fixed arrival distribution, check mix, and omitted
stages. The controller fixtures separately exercise actual queue code at their
original load. They verify order behavior and provide a separate source of evidence
from the shape projections.

## Measures

- **Offers and landings/hour** use the score window. The landing count includes
  warm-up arrivals if they publish in-window. The backlog delta is pending work
  at score end minus pending work at score start.
- **Time to main p50/p90** is nearest-rank latency from submission to publication
  for scored arrivals that eventually land, including post-window drain.
- **Checks and worker-minutes per landing** use all warm-up, scored and drain
  work for modeled landings, including rejected attempts, divided by all
  eventual landings. A second minute total includes competing jobs. These
  are elapsed worker-minutes, without rounding or a billing estimate.
- **Capacity and order** are scored slot utilization, p90 cumulative CI wait
  and order wait for scored arrivals that eventually land, and related
  recheck/hold counts across the full replay. Source utilization is station
  busy time in the score window divided by scored time.
- **Flow** uses the refit's thresholds. At least 95% of individually viable
  scored offers must publish in the score window, and pending growth must
  stay within 5% of scored offers. In the shape arm the delivery numerator
  covers only scored offers. The historical refit retains its original
  numerator, which includes any warm-up arrivals that publish in-window.
  These thresholds assess the model and have no product effect.
