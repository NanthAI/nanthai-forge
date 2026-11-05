# Pre-queue Lane checks

Decision record for running each Lane's own full check before the hosted landing
queue, on whatever runner the project configured. Behaviour lives in
[landing batches](operations/landing-batches.md#pre-queue-lane-checks); the model
is [`models/landing-queue`](../models/landing-queue/README.md).

## Context

With 12 builders in parallel, each change's first full check ran inside the serial
queue: builders skip the near-full suite locally, and a check-only pass counts only
while main is unchanged, which never holds at that rate. The queue became the place
where broken changes were first found. In one wave, 44 of 51 check runs failed or
were cancelled, isolating one culprit took about 75 minutes, and a passing check
takes about 22 minutes. Merge-queue tools avoid this by running each change's CI
before it enters the queue, so the queue mostly sees green.

The owner kept two constraints: **bring your own CI** (any runner configured
through `configure-check` / `configure-runner`: GitHub Actions, other hosted CI,
self-hosted machines, the local runner; nothing GitHub-specific in the core path)
and **proved reuse** as the S2 contract for acceptance across a main move.

## Decision

`acceptance.admissionCheck: "full"` turns the existing admission run into a
pre-queue Lane check. It is the default: a project without the setting gets it,
and `false` opts out (owner decision, 2026-11-05). A finish that carries no
configured check (no `configure-check`) skips it and queues as before.

1. **Lane check.** When a batchable owner-agent finish is submitted (`land`,
   `land --save`), Forge enqueues the project's configured check, with its
   configured gate, for that change alone on the main it composed on. Every
   arrival's check runs at once, in parallel, on the project's own runner through
   the ordinary `enqueueHostedCheck` path, so every runner provider is eligible.
   WIP saves never start a check; `land --save --check-only` keeps its existing
   reuse.
2. **Admission rules.** The submission is not in the queue while its Lane check
   runs: it is not runnable, not batchable and holds no queue order.
   - A failing test ends it with `CHECK_FAILED` and its failing files. A change
     known to be red never enters the queue.
   - A run that ends without a failing test (runner unavailable, cancelled,
     timeout) starts a new Lane check, at most twice; then the change enters
     unadmitted. Unknown is not red.
   - A pass enters the queue. Queue order is the time a change entered the queue,
     not its submission time: an older submission still checking, or one that
     re-entered after a refused proof, never holds back a change that entered
     before it.
3. **The queue re-verifies only the combination.** An admitted change first tries
   its own Lane run, once:
   - on unchanged main, that run is the exact acceptance evidence and the change
     lands with no second run;
   - on a moved main, the existing conservative-impact proof decides. If the main
     delta and the change are independent (disjoint paths and disjoint affected
     tests), the change lands on proved reuse; the main audit covers the new head.
   - Otherwise the proof is refused, the change re-enters the queue as a new
     entry and joins a cohort for one combined check. That combined check is the
     re-check after main touched the change's import closure.
   Cohorts of admitted changes use the admitted failure prior, so they are larger.
   A refused change waits for peers still deciding their own Lane run (bounded by
   the train hold, holding no queue order, with one armed wake), so the refused
   changes of one wave share one cohort check (Issue 10b0a94b).

The Lane check never re-runs because main moved. Re-running it would race main
again (model finding 5, moving-main starvation) and add a full run per move; the
combined check verifies the same interaction once per cohort.

## Three test tiers

Each tier answers a different question. None depends on a particular CI provider.

1. **Local (builder machine): a quick first answer.** Preflight runs the tests
   closest to the change first (the changed tests, then direct and nearer
   transitive consumers), with a measured time estimate instead of a fixed cut.
   Issue c14f4065 replaced the former fixed 25-file cap for nearby consumers with
   this: tiers in order (changed tests, explicit coverage and smoke; direct
   consumers; distance-2 consumers), trimmed only by a local time budget (180 s by
   default, `budgetSeconds` overrides). The plan, the receipt and the builder
   output name the rule, the trimmed tier, the estimate and the number of tests
   left for this pre-queue tier. The local tier **may leave out** any consumer test of the change that is
   not itself a changed or added test file, plus the near-full set that preflight
   already hands to the runner. It never decides acceptance.
2. **Pre-queue Lane check (project runner, any CI): the complete consumer set,
   off the builder's machine.** It runs the project's configured check on the
   project's runner. Forge's `verify` selects either the full suite or every
   transitive test importer of the change plus fixed smoke coverage, all static
   checks included. That is the same selector with no closeness cut, so it contains
   every test the local tier left out. **Guarantee:** with
   the pre-queue check on (the default), every test left out locally runs on the Lane's own
   Candidate before it can enter the queue, unless one of these is true:
   - the Lane check ended without a verdict after two restarts (unknown): the left-out
     tests then run first in the change's queue check;
   - the project configured a check whose selection is narrower than the consumer
     set (a custom command, or a contract gate that declares fewer tests): the
     pre-queue tier then covers only what that check selects;
   - the project opted out (`admissionCheck: false` or `true`): there is no
     pre-queue tier, and left-out tests run first in the queue check.
3. **Landing (queue check of the combination): the authority.** It checks the
   exact combined head, or accepts by exact or proved reuse of tier 2, and the
   post-accept main audit runs the full suite on the new head. Tiers 1 and 2 never
   accept anything by themselves.

## Why not the alternatives

- **Check on every save:** most saves are checkpoints, not candidates; it multiplies
  runner minutes by the save count.
- **Scoped admission only (`admissionCheck: true`):** GitHub Actions only, and an
  affected-set selection misses failures outside the selector's view.
- **Re-check the Lane on each closure-touching main move:** see above; the cohort
  check is the cheaper and bounded re-check.
- **Proved reuse for whole cohorts:** a batch publishes several same-head receipts,
  which the existing recovery proof does not cover. Members try reuse one at a
  time instead, before cohorts form.

## Consequences

- Every submitted change costs one full check on the project's runner, in parallel,
  before the queue. A single Lane on unchanged main pays nothing extra: its Lane
  run is the landing check (one run, as without the Lane check). Queue checks run only for changes that are not independent of
  what landed meanwhile, or for unadmitted changes.
- Proved reuse depends on the check's test-impact selector (`scripts/forge-check.mjs`
  for Forge itself) and on owner-agent automatic acceptance. Other projects' checks
  get the Lane check and exact adoption on unchanged main, and use the combined
  check after a main move.
- No polling: a Lane check wakes its submission only when its run reaches a
  terminal state, as admission did before. Idle costs nothing.

## When to turn it off

Set `acceptance.admissionCheck: false` when one full check per change costs more
than the queue saves:

- the runner bills per minute and changes rarely fail their first check;
- the check is very long and the queue rarely holds more than one change, so
  there is nothing to run in parallel with;
- the runner has fewer free slots than changes arrive at once, so Lane checks
  would wait for each other anyway.

A solo user does not need to turn it off: a single Lane on unchanged main
lands on its Lane run with no second run.

## Measured effect

On the synthetic 12-Lane wave with 3 red changes, no queue check contained a red
change (before: 8 of 19) and no queue run was thrown away (before: 0.67 per
landing). With the cohort hold, the 8 changes that missed proved reuse share two
cohort checks instead of 7 groups: runner minutes per landing fell from 46 to 34,
landings per hour rose from 6.1 (8.2 without the hold) to 12.3 and Convex calls
per landing from 121 (99) to 77. A single Lane uses one run (22 runner minutes) with or without the Lane check.
Details are in [landing batches](operations/landing-batches.md#pre-queue-lane-checks).
The live effect on the project's runner is not yet measured.
