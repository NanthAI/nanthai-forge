# Hosted landing queue model

This is a finite TLA+ abstraction of the hosted queue at accepted source
`d34fe6fa3332d0e924f5ae22dbe1646e76aa1ddd5be3b6b7691021ff032671ba`.
It describes the pinned implementation, including undesirable behavior. The
same-cohort litmus also guards the corrected controller behavior below. It is
not a refinement proof of the TypeScript or of the source merge algorithm.
No runtime, Convex, policy or byte-placement behavior changes.

CI bundling (1ef05eea), reordering (ec7fec62), shortest-check-first (99817627),
and parallel server landings (7fe54c7c, f3916e55) are future mechanisms, not
assumptions of this model. Their implementation requires a new model review; the
phase-name guard alone cannot detect algorithm changes.

## Run

```sh
npm run model:landing-queue                 # small.cfg; current path, including reuse
npm run model:landing-queue -- races        # admitted entries: advice, cancel, CAS race, crash
npm run model:landing-queue -- submission   # desired-source preparation and admission order
npm run model:landing-queue -- strict       # literal S2, reuse disabled
npm run model:landing-queue -- six-slots    # seven singleton groups, six occupied slots
npm run model:landing-queue -- isolation    # suspect naming and one-time unstack (51bbbd00)
npm run model:landing-queue -- all          # all configurations sequentially
npm run model:landing-queue -- reuse-core   # expected literal S2 counterexample
npm run model:landing-queue -- wait         # expected observation counterexample
npm run model:landing-queue -- wait-fixed   # canonical-terminal observation
npm run model:landing-queue -- cohort
npm run model:landing-queue -- cohort-fixed
npm run model:landing-queue -- stranded
npm run model:landing-queue -- stranded-fixed
npm run model:landing-queue -- orderwake       # expected liveness violation (c329d191)
npm run model:landing-queue -- orderwake-fixed
npm run model:landing-queue -- outage          # expected liveness violation (72d50375)
npm run model:landing-queue -- outage-fixed
npm run model:landing-queue -- orderchain      # expected: a holder that lost every driver strands its parked waiters (c329d191 class)
npm run model:landing-queue -- orderchain-fixed
npm run model:landing-queue -- expiry          # expected: an outage nobody ends strands a Ready head (72d50375)
npm run model:landing-queue -- expiry-fixed
npm run model:landing-queue -- progresswake    # expected liveness violation: a skip rule that also drops the terminal wake (7ecc4884)
npm run model:landing-queue -- progresswake-fixed
npm run model:landing-queue -- moving
npm run model:landing-queue -- reuse
npm run model:landing-queue -- reuse-fixed
npm run model:landing-queue -- prequeue           # pre-queue Lane check, main move, proved reuse
npm run model:landing-queue -- prequeue-strict    # the same, reuse disabled, literal S2
npm run model:landing-queue -- prequeue-platform  # Lane-check platform failures, crash
npm run model:landing-queue -- prequeue-before    # expected: a red change enters the queue
npm run model:landing-queue -- prequeue-suffix    # expected: waiting for your own suffix deadlocks
npm run model:landing-queue -- prequeue-solo      # one Lane, unchanged main: no queue check
npm run model:landing-queue -- prequeue-solo-moved # expected: a main move needs the queue check
npm run model:landing-queue -- prequeue-cohort        # cohort hold: refused changes form one cohort
npm run model:landing-queue -- prequeue-cohort-mixed  # the same with a red and an independent change
npm run model:landing-queue -- prequeue-cohort-before # expected: a cohort forms while peers decide
npm run model:landing-queue -- prequeue-hold-order    # expected: a hold that keeps its order deadlocks
npm run model:landing-queue -- prequeue-early         # early refusal: stale Lane proofs refused together
npm run model:landing-queue -- prequeue-early-mixed   # the same with a red and an independent change
npm run model:landing-queue -- cohorthold             # expected: lost release wake (10b0a94b)
npm run model:landing-queue -- cohorthold-fixed
npm run model:landing-queue -- lostdispatch           # expected: a lost check dispatch strands the head (a7de3a93)
npm run model:landing-queue -- lostdispatch-fixed
npm run model:landing-queue -- supervisor             # expected: a driver that fails every time strands the head (19328518)
npm run model:landing-queue -- supervisor-fixed
npm run model:landing-queue -- checkround             # expected: a checking entry whose replayed driver fails again is stranded (d910db6b)
npm run model:landing-queue -- checkround-fixed
npm run model:landing-queue -- retrykeep              # expected: a same-head retry discards dependent checks (ea86f3fb)
npm run model:landing-queue -- retrykeep-fixed
npm run model:landing-queue -- firstcheck             # change 556 class: first-check break caught by the audit, recovered (7fe54c7c)
npm run model:landing-queue -- firstcheck-revert      # expected: the single culprit is reverted (witness)
npm run model:landing-queue -- firstcheck-two         # two suspects: nothing reverted, fixed forward
npm run model:landing-queue -- firstcheck-two-fix     # expected: the fix-forward path is taken (witness)
npm run model:landing-queue -- firstcheck-mixed       # two breaks among three changes
npm run model:landing-queue -- fast                   # fast landing mode: earned, fresh, one audit stall (81d12a32)
npm run model:landing-queue -- fast-witness           # expected: a relaxed-class change is carried (witness)
npm run model:landing-queue -- fast-decision          # expected: freshness checked only at decision publishes on a stale audit
npm run model:landing-queue -- fast-break             # a relaxed-class break: audit, revert or fix, fast lost, no lost work
npm run model:landing-queue -- fast-strict            # policy strict: a relaxed class is never carried
npm run model:landing-queue -- fast-unearned          # policy fast, not earned: nothing is carried
npm run model:landing-queue -- fast-earn              # expected: only after the drill is a relaxed class carried (witness)
```

An installed JDK is a **development-only** prerequisite. On the development Mac, `java`
and `/usr/bin/java` resolve to Homebrew OpenJDK 17.0.18; the macOS Java
registry also lists Azul Zulu 25.0.3 (arm64). The runner selects the registered JDK through `java_home` on macOS (Java 25 here); other systems use PATH Java. If macOS has no registered JDK, it explicitly reports use of PATH Java. No Java installation is performed. Earlier incomplete calibration runs used PATH Java 17. The selected Java 25 executable was verified as arm64-only. TLC 2.19 labels all 64-bit JVMs `x86_64` in part of its banner; this is a [bitness label in upstream code](https://raw.githubusercontent.com/tlaplus/tlaplus/v1.7.4/tlatools/org.lamport.tlatools/src/util/TLCRuntime.java), not a CPU-architecture observation.

The npm command uses `nforge heavy`. The runner downloads the official
[TLA+ tools v1.7.4 release](https://github.com/tlaplus/tlaplus/releases/tag/v1.7.4),
verifies SHA-256
`936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88`
before execution, launches Java with the existing check environment allowlist and private HOME/XDG/temp directories (also Java `user.home`/`java.io.tmpdir`), and removes its private temporary JAR and TLC state files on
completion. The stable release tag and checksum are both pinned; a changed asset
fails closed. No JAR or generated state files belong in source. TLC reports
version 2.19, revision `5a47802`. One worker, fingerprint polynomial 0 and seed 1
make runs comparable. Java heap is bounded at 2 GiB, plus JVM/native overhead;
the default `small` run has a five-minute execution deadline; optional wider configurations may run longer and requires 40 GB free before
starting. Slot wait and download time are separate from reported Java wall time.
At very large production queue sizes, this tool still makes **zero Convex calls,
zero DB reads/writes and zero provider calls**. Exploration cost grows with model
bounds, not production records. Idle cost is zero. The model is opt-in; only the
fast syntax-only phase-name guard runs in ordinary foundation verification.

## State and properties

`q` holds entry phases/reasons, canonical admission ranks, solo eligibility, advisory precompose markers,
cohorts and the ordered survivor train. Each cohort pins its observed main
(`base`, `rev`), predicted result, included/rejected members and immutable check
proof. `claim`, `fence`, `running` and `crashes` model the publication driver.
`main` is accepted contribution provenance, not a file tree. `stamp` selects a receipt name; every reservation/recomposition allocates a name fresh relative to all current references, including a same-source new receipt. Batch slots are separate from entry identities, so a rejected leader can recover while its survivors continue.

- **S1**: every accepted contribution remains in main ancestry; each publication
  compares both observed source and receipt before one atomic main transition.
- **S2**: the exact proof tuple (base, receipt, composed head, included members)
  that passed is the tuple published on current main. Checked in `strict.cfg`;
  **violated by the existing cross-head reuse path** in `reuse-core.cfg`.
- **S3**: each submitted entry's acceptance counter is at most one. Repeated
  operation deliveries after settlement are stuttering steps.
- **L1**: every modeled submission (including source preparation) eventually lands, fails with a reason, or
  reports needs action. `Reasons` also checks reason retention.
- **L2**: every live entry eventually leaves the live set. With finitely many
  submissions and fixed priority/arrival rank this checks absence of permanent
  waiting behind another entry. It is not a numerical latency bound.

`Spec` adds weak fairness of each group's driver and restart. A crash preserves
all durable state; restart releases the expired claim with a newer fence. It
also assumes finitely many crashes and main moves, eventual delivery/completion
of source and check work, and no permanent failure of the trusted transaction or
scheduler infrastructure. Once crash/main budgets are exhausted a continuously
runnable entry must progress. Check *success* is unnecessary: failed tests and
exhausted infrastructure retries terminate. These assumptions matter: weak
fairness of dispatch alone does not imply successful transactions, eventual
external CI completion, or an interval in which main stops moving.

Review, unanswered blocking overlap and unresolved dependencies are needs-action
boundaries here, not a promise that a human acts. Real review/dependency requests
can remain canonically pending forever; unconditional canonical L1 for those
requests is false without an additional environment assumption. L2 across an
infinite stream of urgent arrivals likewise requires a no-infinite-overtaking
assumption or fairness across priority classes, which current policy does not
promise. The finite model does not silently add that product policy.

## Pre-queue Lane check

`PreQueue` adds the state of [pre-queue Lane checks](../../docs/pre-queue-checks.md)
(`acceptance.admissionCheck: "full"`). `q.lane` is each entry's Lane check
(`checking`, `passed`, `unknown`, `failed`), pinned to the main it composed on
(`lbase`, `lrev`); `lretries` counts platform restarts and `tried` the entries
that already offered their own run. The constant `Red` names changes whose own
check fails on their base, so any check that includes one fails; `Independent`
names changes the first-check rule (`clean-disjoint-v1`: clean composition,
path-disjoint from what main gained, no global-risk file) accepts after any main
move. `clean-disjoint-v2` (a clean text merge of untested Markdown also counts)
only widens which real changes are `Independent`: the model's content is sets of
changes, so a clean merge is already the union, and `Reuse` is unchanged.
`NoQueueCheck` says no queue group ever checks; it is checked only by the solo
configs.

- `LaneCheck` runs for every arrival at once. A failing test is terminal before the
  queue; two platform restarts, then the entry enters unadmitted.
- An entry in its Lane check holds no queue order (`QueueLive` excludes it).
- Selection takes the earliest runnable entry. An admitted entry that has not
  tried its run forms a one-member ready group on its Lane proof (`LaneAdopt`):
  exact on unchanged main, carried by `Reuse` only when `Independent`, otherwise
  `LaneRefused` returns it to the batchable pool for a combined check.
- `Behind(g)`: a group never waits for an older entry stacked behind it.
- Not modelled: a passed solo entry overtaking an older unrelated entry once per check
  generation (Issue 7d98c7da). The model keeps strict order, which only removes behaviours;
  the code bounds the overtaken entry to one extra check (`tests/hosted-landing-overtake.test.mjs`).

Added properties: `KnownRedNeverQueued` (a failed Lane check is terminal, never in
a group, never accepted), `RedNeverQueued` (no red change is ever in a group or
accepted, without platform outcomes) and `LaneRunsBounded`; S1, S3, authorized
evidence, L1 and L2 still hold, and S2 holds with reuse off (`prequeue-strict`).

Findings while extending the model:

7. **Arrival order with a pre-queue check deadlocks (implementation shape).** An
   older entry that finishes its Lane check, or re-enters after a refused proof,
   after a younger group formed is stacked behind that group; the younger group
   then waits for it to publish first. `prequeue-suffix` keeps the previous claim
   rule and finds the cycle. Fix: an entry in a group's own speculative suffix
   never holds that group (`convex/projectHostedLandingSuffix.ts`, called from
   `olderLandingAhead` for entries that went through the pre-queue check), and an
   entry still in its Lane check holds no order. A similar cycle may exist without
   the pre-queue check when a refused cross-head proof recomposes behind a younger
   train; this model does not explore that path and the code does not apply the
   rule there.
8. **Red enters the queue without it.** `prequeue-before` (same red change,
   `PreQueue = FALSE`) violates `RedNeverQueued` at once: the first full check of
   a red change is a queue check.
9. **A single Lane pays nothing extra.** `prequeue-solo` (one entry, no main move,
   reuse off) holds `NoQueueCheck`: the Lane run is the landing check. The first
   run found the cohort governance `Fallback` releasing an adopted Lane group into
   a queue check; in code an adopted entry binds its own run with no cohort
   membership, so `Fallback` now excludes Lane groups. `prequeue-solo-moved` (one
   main move) violates `NoQueueCheck`, as it should: a moved main needs the
   combined check unless the proof holds.

## Cohort hold

`Hold` (Issue 10b0a94b) models the cohort hold
(`convex/projectHostedLandingCohortHold.ts`). Admitted changes each try their own
Lane run first; on a moved main the refused ones recomposed and each formed its
cohort before its peers had tried, so the synthetic wave re-checked 8 changes as
7 groups. `Deciding` is the set of admitted entries that have not tried their run
or are in their one-member Lane group. `Held` is a refused (tried, free) entry
while `Deciding` is not empty and its bounded hold has not expired: it is not
selectable and holds no queue order. Release is derived state, so it happens in
the transaction that ends the last decision. `HoldExpire` (the one-shot wake at
`HOSTED_TRAIN_HOLD_MS`) is not fair, so liveness never relies on it. With
`Hold # "none"` a refused proof needs the order claim (`LaneRefused`), as in code,
where refusal happens at publication. `"none"` keeps the earlier shape and state
counts; `OneCohort` puts every entry in one cohort class.

- `prequeue-cohort` and `prequeue-cohort-mixed` hold S1, S3, `RedNeverQueued`,
  `NoEarlyCohort` (no refused member forms a cohort while a peer still decides,
  unless its hold expired), L1 and L2.
- `prequeue-cohort-before` (today's code, tracked) violates `NoEarlyCohort`.
- `prequeue-hold-order` (the hold keeps its queue order) violates L1: the held
  older entry waits for a younger peer's decision while that peer's publication
  waits for the older entry's place. In code this was the existing chain in the
  wave: refused peers parked behind the oldest refused member until its 15-minute
  stall alarm. Fix: a held entry holds no order and wakes its order waiters.
- Incidents `cohorthold`: the peer's decision releases the hold and schedules one
  queue drive, which is lost (OCC exhaustion); in another branch the peer never
  decides; with `main = 1` a write outage also refuses the hold's own wake. The
  unfixed shape (release by the peer only) violates `CohortForms`.
  `cohorthold-fixed` arms one wake at the bound in the hold's transaction and
  re-drives it after the outage (`redriveCohortHold`). Replayed against the
  implementation in `tests/hosted-landing-cohort-hold.test.mjs`.

### Early refusal

`Hold = "early"` (Issue 7fe54c7c) is today's code: the cohort hold, and a Lane
group that publication must refuse (`~Exact`, not `Independent`) is refused
before its turn (`EarlyRefusal`) when every older entry holding order is a
refused batchable member or in such a Lane group, all of one cohort class, and no
non-Lane group is active. Without it the refusals ran one per recomposition (wave
3b: four in 4.3 minutes before one cohort formed). The code bounds it further:
the older window is at most 16 rows and positions past the cohort size keep their
turn.

- `prequeue-early` and `prequeue-early-mixed` hold the same invariants and
  liveness as `prequeue-cohort`, including `NoEarlyCohort`: the early-refused
  member is held while an older peer still decides.
- Replayed against the implementation in
  `tests/hosted-landing-early-refusal.test.mjs` (one pass, one combined check, no
  more transactions than the serial path).

## First-check landings and no lost work (Issue 7fe54c7c)

`Reuse` is the first-check landing: an `Independent` change lands on its own
passed Lane run after main moved. The constant `Breaks` names Independent changes
whose content is wrong only beside other content (a path-disjoint semantic
break, change 556): their own Lane check passes on the base they composed on,
and `Fails(h)` makes any check of a head holding an unfixed break plus anything
else fail. So a rechecked break fails its second check, while a first-check
break reaches main.

- `AuditRed`: the coalesced main audit, armed at once after a first-check
  landing, finds the break and marks main red (`q.red`). `Reuse` requires green
  main, so no change lands on its first check while main is red.
- `Revert(e)`: only when `e` is the sole unfixed break on main. The reverse is
  an ordinary landing on current main: a fresh receipt under the same claim
  rule, removing only `e`'s content; `e` is recorded in `q.reverted` and its
  Lane is kept (code: `start {intentId}` opens a Lane at its saved head).
- `FixForward`: any red main (several suspects, or a reverse that conflicts)
  may instead land a fix on top, keeping every change (`q.fixed`).
- `NoLostWork`: every accepted change is on main, or is a reverted break.
  `NoBlindRevert`: only breaks are reverted, never a fixed one. `S1` exempts
  reverted changes. `MainRecovers` (liveness, with fair recovery): a broken or
  red main always becomes green.
- `firstcheck` (N=3, `Breaks = {2}`), `firstcheck-two` (both changes break
  together: `NeverReverted` holds, nothing is reverted blindly) and
  `firstcheck-mixed` (two breaks among three) pass; `firstcheck-revert` and
  `firstcheck-two-fix` are witnesses that the revert and fix-forward paths are
  reachable. Three deliberate mutations were each caught: reverting any change
  on main (`NoLostWork`), a revert that rewinds main (`S1`), and no recovery
  (`MainRecovers`).
- Every `LandingQueue` configuration checks `NoLostWork` and `NoBlindRevert`
  with `Breaks = {}`, which adds no states (their counts are unchanged). The
  `Incidents` litmus reductions model abstract heads and entry phases, not
  accepted content, so `NoLostWork` has no meaning there; they were re-run
  unchanged.

## Landing modes (Issue 81d12a32)

`Fast` is the project policy (`acceptance.landingMode: "fast"`). `Relaxed` names changes the
first-check rule refuses only for a class fast mode relaxes (a tested-doc overlap, or global
risk that is not order-sensitive); an order-sensitive or overlapping change is in neither
`Independent` nor `Relaxed` and always takes the second check. `Carries(s)` replaces the
`Independent` test in `Reuse`, `LaneRefused` and `EarlyRefusal`: a group carries when it is
`Independent`, or when `FastOK` and it is `Independent` or `Relaxed`.

- `Earned`: `q.audited >= EarnAfter` (audited landings since the last red audit) and
  `q.drilled` (a red audit was recovered by `Revert` or `FixForward`). Code: 200 landings,
  under 5% unclear audits, a drill on record (`src/landing-mode.ts`); the unclear share is
  not modelled.
- `Fresh`: main not red, no stalled audit, at most `StaleAfter` unaudited landings. Code adds
  the age bound of the oldest unaudited landing; time is not modelled.
- A carried landing (`Reuse`) is audit debt (`q.unaudited`); an exact check of the new head
  is its own audit and counts toward earning, as does `AuditGreen`. `AuditRed` sets
  `q.audited` to 0. `AuditStall` (at most `Stalls` times, not fair) ends an audit without a
  verdict; `AuditRetry` (fair) clears it.
- `FreshAt = "publish"` is the code: `Publish` requires `FastOK` again for a group that was
  carried by a relaxation (`b.fast`), and `LaneRefused` returns a lapsed fast group to the
  second check. `"decision"` is the litmus.

Properties: `FastSound` (every landing carried by a relaxation was published while the policy
was fast, the project had earned it and the audit was fresh), `LostOnRed` (a red main is never
earned), `NeverFast` (holds in strict and unearned configurations; the witness elsewhere), and
the existing S1, S3, `NoLostWork`, `NoBlindRevert`, `MainRecovers`, L1 and L2.

Finding 10. **Freshness checked only when the proof is decided is not enough.** In
`fast-decision` a stalled or red audit, or new audit debt, between `Reuse` and `Publish` lets
a fast landing publish on a stale audit (`FastSound` violated). Fix: the publication
transaction checks earned and fresh again (`convex/projectHostedAcceptancePublish.ts`,
`fastLanding`); replayed in `tests/hosted-first-check-landing.test.mjs` ("refused at
publication once the audit has stalled").

Finding 11. **A fast publication that is refused must give the claim back.** The first
`fast-break` run deadlocked: the group held the claim, `Publish` refused it (main had gone red
after the claim), and `Revert`, `FixForward` and `LaneRefused` all need the claim free, so
main stayed red and L1, L2 and `MainRecovers` failed. `StaleClaim` now also releases a claim
whose fast carry lapsed, and `Claim` never takes one again. The code already does this in one
transaction: the refused publication throws `CHECK_EVIDENCE_REFRESH`, which releases the queue
and reserves a fresh decision (`convex/projectHostedFinishControl.ts`).

With `Fast = FALSE` the new state never changes: `fast-strict` explores exactly the states of
`prequeue-early` (152,165 generated, 50,065 distinct).

## Model-to-code map and simplifications

Line references are to the pinned source above. Every abstraction below is a
scope limitation; passing TLC does not verify the omitted implementation.

| Model action/state | Code anchor | Abstraction and reason |
| --- | --- | --- |
| `Submit`, `Admit`, `AdmissionFailure`, `Gate` | `convex/projectHostedLandingDesired.ts:27`, `convex/projectHostedLandingDesired.ts:197`, `convex/projectHostedLandingDesired.ts:212`, `convex/projectHostedLanding.ts:209`, `convex/projectHostedLandingPins.ts:28` | One entry per Lane/operation. The durable desired handle enters `composing`; source completion admits it or retains a structured failure. Canonical queue order is assigned at enqueue, so a later source job may enter first. Source cursor/transport work and selection validation are hidden; aliases stutter. Multi-Lane selections and access revocation remain outside the state space. |
| needs action | `src/agent-default-gates.ts:28`, `convex/projectHostedLandingControl.ts:315`, `src/hosted-landing.ts:117` | Blocking overlap/review/dependency is an observable result, not a new stored terminal phase. Advisory overlaps never gate. Answer/resubmit is outside this finite episode. |
| `Form`, `SmallCohorts` | `convex/projectHostedLandingBatchStore.ts:83`, `convex/projectHostedLandingOrder.ts:43` | Fixed cohort compatibility and one actor/priority/policy; rank is allocated at canonical admission. Dynamic cohort sizing, actor fairness and urgent preemption are reduced to finite selection. Membership and source-completion/admission order can differ in `submission.cfg`; the default starts after three admissions to keep the exploration small. |
| `Precompose`, claim in `Form` | `convex/projectHostedLandingPrecompose.ts:50`, `convex/projectHostedFinishPrecompose.ts:13`, `convex/projectHostedFinishCompose.ts:268` | An advisory marker, never a queue claim. Useful selection detaches its advisory work. Peer markers may physically survive until attempt/shared-run validation; this model hides them at logical cohort selection, and merge outcomes remain nondeterministic. Byte-cache hit/miss, metadata uploads and late advisory callbacks are hidden; they grant no check/publication authority. |
| `Compose(g,dropped)` | `src/hosted-compose-worker.ts:78`, `src/hosted-compose-worker.ts:175`, `src/hosted-source-step-merge.ts:342`, `src/hosted-source-step-merge.ts:387` | Arbitrary rejected subsets overapproximate merge outcomes. Dependencies and ordered prefix source merges become provenance-set union; hashes, manifests, ancestry traversal and R2 I/O are assumed correct. No claim that conflicting file bytes are proven preserved. The cohort litmus separately represents an earlier-member-only conflict. |
| `q.train`, width | `src/hosted-landing-batch.ts:16`, `convex/projectHostedLandingPipeline.ts:23`, `convex/projectHostedLandingWake.ts:28` | Width is 6; a fixed checked tail supplies its predicted head and final receipt. Reusable active record slots, with distinct fresh symbolic receipt names, stand in for historical batch UUIDs. The small bound exercises fewer than six slots; `six-slots.cfg` separately reaches six occupied slots with seven entries, pass/fail invalidation and no unrelated environment branching. |
| trim rejected members, `Settle` | `convex/projectHostedLandingCohortConflicts.ts:18`, `convex/projectHostedLandingCohortConflicts.ts:39`, `convex/projectHostedLandingBatchFinish.ts:132`, `convex/projectHostedLandingSpeculativeConflict.ts:18` | Rejected members leave the train. Speculative rejection waits for predecessor settlement; exact-main rejection retains a terminal conflict; moved main releases it for solo recomposition. Per-member evidence failures become ordinary terminal reasons. |
| `Invalidated`, `Rebase` | `convex/projectHostedLandingPipelineInvalidation.ts:24`, `convex/projectHostedLandingBatchStore.ts:267` | Bounded predecessor closure identifies transitive dependents; an ordinary solo recovery can coexist with a later train. Descendants revert to original selections; independent groups remain. Inactive historical batch bodies are forgotten (the active record slot becomes `idle`); no transition reads their outcome. Entry outcomes/reasons, counts and current-main receipt are retained, and fresh symbolic names prevent record-slot reuse from impersonating any referenced old generation. Generation-bound delayed callbacks stutter; source-job callback validation itself is not proved. |
| `Check`, `SourceFailure`, `Release`, `Fallback` | `convex/projectHostedLandingBatchCheck.ts:43`, `convex/projectHostedLandingBatchSplit.ts:65`, `convex/projectHostedLandingBatchRelease.ts:16`, `convex/projectHostedLandingBatchFallback.ts:18` | Source retry exhaustion terminalizes its members (`convex/projectHostedLandingBatchFinish.ts:108`). Full check pass/test failure/infrastructure failure; infrastructure retries are exactly 2. Split children are reduced to the existing serial solo fallback for these small cohorts. With `Isolation` (`isolation.cfg`), a failure may name suspects (released, never re-stacked onto) and a group stacked on an unpassed predecessor unstacks once (`src/hosted-landing-suspect.ts`). Larger parallel halves, contract diagnosis and admission-run reuse are not explored. No semantic conflict policy is invented. |
| standalone retry | `convex/projectHostedLandingCheckRetry.ts:14`, `src/hosted-landing-admission.ts:11` | Same two-retry budget and immutable Candidate proof. Individual provider states, cancellation vs timeout classification and complete shard validation collapse into check outcome. |
| `Check(g, "infra")` retry keeps receipt and dependents, `StackPinned` | `convex/projectHostedLandingStore.ts` (`retiresSolo` keep pins), `convex/projectHostedLandingPipelineInvalidation.ts` (`keep`), `convex/projectHostedLandingBatchSplit.ts` (`retryLandingBatchCheck`), `convex/projectHostedLandingBatchStore.ts` (`keepReceipt`) | Since ea86f3fb a platform retry re-checks the same base, members and head and keeps its receipt, so groups stacked on that (head, receipt) keep their checks. A stacked group's base is its pending predecessor, not main. A changed predicted head or receipt is `Rebase`/`Unstack`/`Released`, which still invalidate. `StackPinned`: while a predecessor slot reserves a dependent's pinned receipt it predicts the pinned head. |
| cancel/abandon | `convex/projectHostedLandingCancel.ts:35`, `convex/projectHostedBatchAbandon.ts:35` | One atomic target settlement and peer release; final publication wins or cancellation wins. Abandon discovery pages and Lane lifecycle are hidden. Shared check execution continues independently; only binding authority matters here. |
| `Claim`, `Publish`, `MoveMain` | `convex/projectHostedLandingControl.ts:293`, `convex/projectHostedLandingBatchPublish.ts:48`, `convex/projectHostedAcceptancePublish.ts:110` | Transactional OCC/CAS is atomic; includes main receipt equality, exact proof and member counters. Policy, contributor access, full shard evidence and registration are assumed validated; this is the automatic agent path, not explicit unchecked owner acceptance (which independently also makes unrestricted literal S2 false). Main contributions are append-only ancestry tokens; legitimate file edits/reverts are outside this property. |
| `Reuse` | `convex/projectHostedFinishCompose.ts` (`installFinishCompose`), `convex/projectHostedAcceptancePublish.ts`, `src/hosted-cross-head-analysis.ts` (`analyzeCrossHeadReuse`), `src/first-check-risk.ts`, `convex/projectHostedReuseStore.ts` (`reuseDecision`) | First-check landing (`clean-disjoint-v1`) on a disjoint synthetic main change. Path disjointness, risk list and clean composition are the constant `Independent`; red main and audit debt refuse it (`~q.red`). Original checked result stays different from applied result. `strict.cfg` disables this branch; the default enables it; `reuse-core` explicitly enables it. |
| `AuditRed`, `Revert`, `FixForward` | `convex/projectHostedMainAuditState.ts` (`noteMainLanding`, `promptAudit`, `onGateRunTerminal`), `convex/projectHostedCulprit.ts` (`startRedClassification`, `prepareSystemRevert`, `finishSystemRevert`, `fixForward`, `revertMessage`) | The audit run, bisect probes and the reverse Candidate's own full check are atomic steps; "sole break" stands for a single proven bisect boundary. The reverse's queue turn is abstracted to an atomic landing with a fresh receipt; in code it is a normal queued landing with `revertOf`. Re-landing a fixed culprit is outside this finite episode. |
| `LaneCheck`, `LaneAdopt`, `LaneRefused`, `Behind` | `convex/projectHostedLandingAdmission.ts` (`startLandingAdmission`, `settleLandingAdmission`, `admittedReuseFirst`), `convex/projectHostedLandingStore.ts` (`orderLive`, `batchable`), `convex/projectHostedLandingSuffix.ts`, `convex/projectHostedLandingOrder.ts` (`olderLandingAhead`) | Lane-check outcomes are fixed by `Red`; in-flight interaction failures stay nondeterministic in `Check`. Proof eligibility is the constant `Independent`, not the path/test analysis. A refused proof is reduced to returning to the pool; the code recomposes on current main first. The code walks the suffix only for entries that went through full admission: only they can enter the queue behind a younger group. |
| `EarlyRefusal`, `RefusableLane` | `convex/projectHostedLandingEarlyRefusal.ts` (`refuseStaleLaneProofNow`, `wakeAfterLaneRefusal`, `laneRefusalCohort`), `convex/projectHostedFinishControl.ts` (`finishStep`) | The code requires the retained train to be empty of live groups (a lane-bound entry is not in the train); the model requires no non-Lane active group. The cohort class stands for the code's cohort-size limit; urgent entries and the 16-row window are not modelled. |
| `Deciding`, `Held`, `HoldExpire` | `convex/projectHostedLandingCohortHold.ts` (`decidingSince`, `holdForPeers`, `releaseCohortHolds`, `end`, `redriveCohortHold`), `convex/projectHostedLandingStore.ts` (`writeLanding`), `convex/projectHostedLandingBatchCheck.ts` | The code waits only for peers whose admission ended before the hold began (`deciding` index), so later arrivals never extend it; the model starts with every entry admitted. A held entry outside the release window is released by its own wake. |
| check progress event, `CHECK_PROGRESS_WAKE_MS` | `convex/projectHostedLandingCheckWake.ts` (`notifyLandingCheck`, `throttled`), `convex/projectHostedLandingWake.ts` (`wakeLandingCheckPage`) | Non-terminal run events are stutter steps: they change no phase, order, eligibility or terminal evidence, only the progress timestamp the 15/60-minute stall events read. Only the terminal event and eligibility are modelled (`Check`); the `progresswake` litmus covers dropping the terminal wake. The throttle clock, wake pages and the version counter are not simulated. |
| crash/restart, fair driver | `convex/projectHostedLandingControl.ts:43`, `convex/projectHostedLandingControl.ts:123`, `convex/projectHostedLandingDriver.ts:46`, `convex/projectHostedFinishWake.ts:48` | Finite crashes between transactions; durable watchdog eventually runs, lease fence rises on restart. Expiry alone creates no new run. Timers become fair events; physical durations and stale worker payloads are not simulated. |
| stall/hold repair | `convex/projectHostedLandingWake.ts:112`, `convex/projectHostedLandingStall.ts:90`, `convex/projectHostedLandingStall.ts:157` | Fair source failure/fallback stands in for 5-minute hold release and 15/60-minute stall events. Real drop deadlines only cancel structurally ownerless work and eventually stop rearming live work. Permanent transaction faults are outside successful-driver fairness; the stranded litmus tests the missing-recovery shape, not all six historic incidents. |
| client observation | `src/hosted-agent-submission-wait.ts:164`, `src/hosted-agent-submission-wait.ts:267`, `src/hosted-agent-submission-wait.ts:392` | Separate litmus because client cache state does not authorize server acceptance. Only cached-ready/canonical-terminal/input-terminal interleaving is needed. |

Receipt UUIDs are abstract names from a finite pool of `3*N+3` names. Allocation
excludes current main, every active batch's observed/proposed receipt and the
base receipt retained in every passed proof, including a proof reused across
heads. The pool has at least one unused name because those records reference at
most `3*N+1` names. An old name may stand for a different UUID only after all
modeled references disappear. Only equality is observable; this removes spelling
and allocation-history differences, not a queue action. `UniqueReservations`
checks active reservations remain distinct from each other and current main.
This abstraction relies on the separately stated fence validation of discarded
late messages (`convex/projectHostedLandingControl.ts:123` and
`convex/projectHostedFinishControl.ts:241`); it does not verify historical receipt
lookup or introduce UUID reuse/deletion in Forge.

Phase names in `SourceEntryPhases`/`SourceBatchPhases` are mechanically compared
with the TypeScript schemas by `scripts/check-landing-model.mjs` in `npm run check`.
The guard parses syntax without executing queue modules. Mutation tests prove
that adding an unmodeled phase to either schema fails. It does not detect arbitrary
algorithm drift: changes to these code anchors require manual model review.

## Findings and counterexamples

1. **Literal S2 differs from implemented cross-head acceptance (design/contract
   mismatch, not evidence of an unsafe merge).** Check Candidate C on M0; main
   advances to disjoint M1; recomposition produces C1; the conservative-impact
   proof authorizes C1 using C's original passed run. `Reuse` then `Publish`
   violates literal S2. The real code deliberately validates the old
   `reuse.checked` Candidate/head at `convex/projectHostedAcceptancePublish.ts:175`
   after checking the reuse proof at line 125. Recommendation: lead/owner choose
   whether S2 means exact-run equality or the existing proved reuse contract.
   For exact equality, require a fresh check for C1 and explicitly scope S2 to check-required acceptance; owners can also explicitly accept unchecked Candidates. Do not disable reuse or add
   restrictions as part of this modeling task.
2. **Same-cohort conflict against work that never lands (6e587f06; design
   behavior).** A and B compose alone cleanly; B conflicts only with A's prefix.
   B becomes terminal conflict before A's check; A fails; neither lands and B
   still carries an unaccepted-prefix conflict in the pinned implementation. The `cohort` litmus violates
   `NoOrphanConflict`. The executable regression in `tests/landing-model-cohort.test.mjs` checks the actual implementation. This is real in `src/hosted-source-step-merge.ts:387` and
   `convex/projectHostedLandingBatchFinish.ts:168`, which defers only when there
   is a *separate pending predecessor*. `retainBatchConflict` checks the outer
   base against main (`convex/projectHostedLandingBatchConflict.ts:38`), not
   acceptance of the internal prefix. Recommendation: retain the prefix-dependent
   rejection as advisory until the contributing cohort settles; on failure retry
   B alone on actual main. Preserve prompt terminal conflicts proven against main
   itself. `cohort-fixed` guards the corrected behavior, including failed, cancelled and
   landed prefixes, no premature rejection, prompt independently proven main
   conflicts and eventual rejected-member settlement. The deterministic tests
   now require the rejected member to retry and land after a failed prefix.
   Both workers mark a drop `againstMain` only after composing that member
   against the outer base alone; conflict roots then pin that base. Other drops
   wait on the included tail using the existing advisory/order-settlement path,
   and recompose their immutable selection on actual main after settlement.
   Legacy unmarked drops also recompose. Clean landings add no RPC, source
   probe, DB record or byte storage. Only a conflicting prefix probes the
   resident merge inputs again in its existing source step; recovery uses the
   ordinary retry path. Metadata stays bounded by eight group members; new
   source/conflict bytes stay in R2. No idle calls or periodic wakes are added.
3. **Stale terminal wait payload (74017d1b; implementation/observation bug).**
   Cache Ready; canonical submission becomes terminal; input pages finish; the
   client exits with `status: terminal` and the older Ready payload.
   `FreshTerminal` fails in the historical `wait` litmus. The client now ends
   only on the current canonical submission's terminal observation. Input pages
   remain progress evidence, including superseded old attempts. A concurrent
   settlement reaches the cache through the existing canonical subscription or
   its register-then-reread path; no extra query is added per refresh. The final
   version emits once. `wait-fixed` models the fresh terminal payload, and
   `tests/hosted-submission-wait-races.test.mjs` holds old input pages across
   replacements before, during and after Ready, plus same-attempt settlement.
   Server S1–S3 remain unaffected; this is not false acceptance.
4. **Stranded entry (19328518; historical implementation failure shape).**
   Submit/claim, crash, lose the recovery event, then stutter forever; L1 fails in
   `stranded`. The corresponding recovery-enabled litmus passes. Current code
   schedules a watchdog atomically with claim (`convex/projectHostedLandingControl.ts:113`)
   and repairs orphaned membership (`convex/projectHostedLandingStall.ts:118`).
   This model does not establish that the six historic production failures still
   occur. Repeated permanent non-Forge exceptions can still abort the same step
   (`convex/projectHostedFinishControl.ts:218`), while structural ownership keeps
   an entry pending (`convex/projectHostedLandingStall.ts:173`). Weakly fair
   retries alone cannot promise L1 in that fault model. Recommendation: replay
   the six incidents with existing implementation fixtures and verify typed
   exhaustion/terminal settlement on permanent errors; no idle poller is proposed.
   **Follow-up (19328518, fixed).** `supervisor` keeps the head pending while
   its step is lost (`main = 0`) or its lease is held but every advance throws
   (`main = 1`); with a permanent fault the unfixed retries loop forever and
   `HeadSettles` fails. `supervisor-fixed` replays the lost step from the stall
   alarm's supervisor rounds and, after two failed repairs, ends the entry with
   `LANDING_DRIVER_EXHAUSTED`; `FailsOnlyPermanent` checks that it ends only on a
   permanent fault after exactly two repairs. Code: rounds and typed exhaustion in
   `convex/projectHostedLandingStall.ts` and `convex/projectHostedLandingExhaust.ts`,
   lease re-claim cap in `convex/projectHostedLandingControl.ts`
   (`LANDING_LEASE_RETRIES`). The rounds are timers that exist only after a stall
   alarm fired for a pending entry, so an empty queue schedules nothing.
   `tests/hosted-landing-supervisor.test.mjs` replays the incidents per driver.
   **Follow-up (d910db6b, fixed).** `checkround`: a checking entry whose run
   already ended loses its completion wake or the queue step after it. The stall
   alarm replayed it once inline but never armed a round for a checking entry (the
   run lease was assumed to own it), so a replay that failed again left the entry
   pending with nothing scheduled and `HeadSettles` fails. `checkround-fixed` arms
   the round when the alarm replayed a driver; it lands, or ends after two failed
   re-drives (`FailsOnlyPermanent`). A live check still gets no round. The step x
   fault matrix in `tests/landing-failure-injection.test.mjs` found it and checks
   the same invariants on the code: no entry stranded (L1), each landing accepted
   once (S3), a typed end only on a permanent fault, nothing left scheduled.
   **Follow-up (13c63abe, fixed; not modelled).** The receipt completion tick runs
   after publication (main has moved, so no model state changes): it completes the
   landed Lanes and their Intent. A lost tick used to stay lost. Its stall guard,
   retained on the acceptance plan and cancelled by a healthy tick, replays it once
   and then ends it with `ACCEPTANCE_COMPLETION_STALLED` and an owner alert
   (`convex/projectHostedAcceptanceCompletion.ts`). The fault matrix checks it.
5. **Moving-main starvation (51ff7e8e; historical scheduling defect and fairness
   boundary).** Recompose/check, another writer moves main, retry; repeat forever.
   The `moving` litmus finds an infinite cycle despite weakly fair driver steps.
   Current hosted ordinary ordering reserves older live entries' turn
   (`convex/projectHostedLandingOrder.ts:65`), and passed proofs are selected
   first (`convex/projectHostedLandingWake.ts:34`). Thus this litmus's overtaking
   action is excluded for ordinary same-priority queued publications in the
   current core model. Unbounded external owner publications or urgent arrivals
   still require an explicit fairness/environment assumption. Recommendation:
   retain order/ready-priority guards when adding queue mechanisms; the separate
   timing-flaky test in the Issue is outside this model.

6. **Lost order wake (c329d191; incident 2026-11-05, fixed).** A passed head B
   waits in submission order for an older entry A, with no timer while parked.
   A fails and wakes B's finish exactly once; that one drive fails (Convex OCC
   exhaustion) and nothing of it commits, so nothing re-drives B and every later
   passed entry waits on it. `orderwake` finds the liveness counterexample
   (`HeadLands`); `orderwake-fixed` arms B's stall alarm in the same transaction
   as the wake (`convex/projectHostedFinishWake.ts`), so a lost drive is re-driven
   while parked waiters still cost nothing. `tests/hosted-landing-lost-wake.test.mjs`
   replays the incident against the implementation.

7. **Write outage (72d50375; 2026-11-05, fixed).** An approved dev storage
   pause refuses every write for up to 30 minutes. A scheduled settlement step,
   queue wake or stall alarm that fires during it throws, and Convex never
   retries it; the old runner dropped a passed result after ~3 s. `Init`
   places the outage in the middle of CI (`main = 0`) or of settlement
   (`main = 1`). `outage` finds a liveness counterexample (`HeadLands`).
   `outage-fixed` keeps the runner's result until Forge accepts it
   (`src/hosted-actions-retry.ts`, about 35 minutes) and re-drives the lost step
   when writes resume (`convex/projectHostedLandingRedrive.ts`: the window end,
   the first write after expiry, or a waiting reader of a quiet Ready entry).
   No timer or poll is modelled or added. `tests/hosted-landing-write-outage.test.mjs`
   replays a 20-minute outage against the implementation. `expiry` is the
   remaining case: nobody ends the window, no reader waits and nothing writes,
   so no event re-drives B (`HeadLands` violated). `expiry-fixed`: beginning a
   window arms one task just after its expiry
   (`projectHostedLandingRedrive:expired`), which is that first write.

8. **Retry discards dependents (ea86f3fb; incident a7de3a93, fixed).** A platform
   retry (`interrupted`, `runner-unavailable`) of a check re-checks the same
   Candidate and receipt, yet it superseded every stacked group: in the incident a
   batch run with 75 test files passed was cancelled (~74 runner-minutes) and the
   replacement batch had the identical predecessor head and receipt. `Check(g,
   "infra")` used to apply `Invalidated(g)` and a `FreshReceipt`; it now keeps both,
   and the core safety configurations still hold S1/S3/`AuthorizedEvidence`/
   `UniqueReservations` plus the new `StackPinned` (and S2 in `strict`/`six-slots`).
   Incidents `retrykeep` (the old discard) violates `KeepsSameHead`;
   `retrykeep-fixed` keeps the dependent only when the predecessor's predicted
   generation is unchanged and holds `NoStaleStack` (no live dependent on a stale
   predecessor), `StackedExact` (none lands on one) and `StackSettles`. Keeping
   the dependent on every retry instead violates `NoStaleStack`. Replayed in
   `tests/hosted-landing-retry-keeps-stack.test.mjs` for a solo head, a batch head
   and a stacked batch.

9. **Holder lost every driver (c329d191 class; 2026-11-06, fixed).** A passed
   head B is parked in order behind an older checking entry A. A's run fails,
   but its completion wake and its supervisor tasks are all lost (two faults),
   so A never settles and never wakes B. B's waiting reader asks for a re-drive
   after a quiet period, but the ask only replayed B's own steps and a parked B
   has none. `orderchain` finds the liveness counterexample (`HeadLands`);
   `orderchain-fixed` follows B's order wait to each holder (at most 8) and
   replays only their lost steps (`convex/projectHostedLandingRedrive.ts`).
   Ask-only: a healthy landing and the resume sweep add nothing.
   `tests/hosted-landing-lost-wake.test.mjs` replays it against the implementation.

10. **Skipped progress wakes (7ecc4884; cost slice 2, 2026-11-06).** The model has
   no progress action: a running check's non-terminal events stutter. In code each
   one schedules a check wake (`convex/projectHostedLandingCheckWake.ts`,
   `notifyLandingCheck`) which, for a checking entry that retained progress inside
   `CHECK_PROGRESS_WAKE_MS`, reads the entry and the run, skips the entry
   unconsumed and retires. That wake now is not scheduled when the entry is a solo
   (non-batch) checking entry, the run's only waiter, and the throttle would skip it. Terminal events (and every
   event of an admission, queued or shared run) still schedule it in the same
   transaction. `progresswake` is the lost-wakeup litmus: applying the same skip
   to the terminal event drops the entry's only wake and `HeadLands` is violated.
   `progresswake-fixed` skips only non-terminal events and settles;
   `ProgressSkipIsNoop` holds in both. The same slice stops the desired-landing
   submit from driving at once while its source job still runs (the job's
   completion wakes it, `notifyDesiredCompose`; the watchdog armed instead is the
   one the empty drive's claim armed a moment later). Replayed in
   `tests/hosted-landing-controller-wakes.test.mjs`.

`isolation.cfg` checks the 51bbbd00 isolation semantics in the core model:
combined-failure evidence may name suspects (released with the reason, never
re-stacked onto: `NoStackOnSuspect`), and a group stacked on an unpassed
predecessor unstacks once before it splits. The other core configurations keep
`Isolation = FALSE` so their bounds and wall times stay comparable.

The litmus configurations intentionally fail properties and the runner reports
success only when the named expected violation is found. A parse error, unrelated
invariant failure, timeout, or unexpected pass is a failed run. `*-fixed` models
proposals/recovery contracts, not changes made to product code.

The original implementation characterization reproduced the finding against the pinned source: the rejected member retained its conflict attempt after surviving-prefix check failures, with no acceptance and unchanged main. The current regression instead requires automatic recovery, original-selection preservation, cancelled-run fencing and prompt main-proven rejection; it also checks a full-size cohort and transfer from an external predecessor to the internal settlement owner.

## TLC results

The default starts with three already-admitted entries, two cohort classes and one crash. Queue publications move main; advisory precompose, cancellation and unrelated external main movement are checked in `races.cfg` (two admitted entries, one crash, one external move). `submission.cfg` separately explores two durable preparing entries, arbitrary source-completion/canonical-admission order, source failure, a crash and an external main move. `strict.cfg` repeats the three-entry bound without cross-head reuse. Counts are TLC-generated and
distinct states, not a count of production requests. Failed litmus checks stop at
the first counterexample; those counts are partial explorations. No live provider
or production historical replay is implied.


| Configuration | Generated | Distinct | Java wall time (s) | Result |
| --- | ---: | ---: | ---: | --- |
| `small` | 60,565 | 22,509 | 30.991 | Passed |
| `strict` | 55,453 | 21,582 | 41.405 | Passed |
| `races` | 46,296 | 15,030 | 15.064 | Passed |
| `submission` | 378,895 | 124,875 | 115.238 | Passed |
| `six-slots` | 3,655 | 3,655 | 854.897 | Passed |
| `reuse-core` | 188 | 104 | 0.639 | Expected S2 |
| `isolation` | 123,429 | 33,252 | 118.289 | Passed |
| `wait` | 4 | 4 | 3.733 | Expected FreshTerminal |
| `wait-fixed` | 4 | 4 | 0.560 | Passed |
| `cohort` | 6 | 6 | 0.558 | Expected NoOrphanConflict |
| `cohort-fixed` | 22 | 22 | 0.569 | Passed; failed/cancelled/landed prefix and independent-main branches |
| `stranded` | 2 | 2 | 0.581 | Expected liveness violation |
| `stranded-fixed` | 4 | 4 | 0.603 | Passed |
| `orderwake` | 4 | 4 | 0.575 | Expected liveness violation |
| `orderwake-fixed` | 6 | 6 | 0.590 | Passed |
| `outage` | 8 | 8 | 0.585 | Expected liveness violation |
| `outage-fixed` | 10 | 10 | 0.567 | Passed; CI and settlement branches |
| `orderchain` | 4 | 4 | 0.667 | Expected liveness violation |
| `orderchain-fixed` | 6 | 6 | 0.623 | Passed |
| `expiry` | 4 | 4 | 0.704 | Expected liveness violation |
| `expiry-fixed` | 5 | 5 | 0.774 | Passed |
| `progresswake` | 4 | 4 | 0.707 | Expected liveness violation |
| `progresswake-fixed` | 5 | 5 | 0.565 | Passed |
| `moving` | 8 | 7 | 0.568 | Expected liveness violation |
| `reuse` | 4 | 4 | 0.550 | Expected ExactCheckedHead |
| `reuse-fixed` | 4 | 4 | 0.551 | Passed |
| `prequeue` | 65,653 | 19,168 | 48.217 | Passed |
| `prequeue-strict` | 50,744 | 15,902 | 37.222 | Passed |
| `prequeue-platform` | 633,316 | 210,876 | 237.478 | Passed |
| `prequeue-before` | 2 | 2 | 0.681 | Expected RedNeverQueued |
| `prequeue-suffix` | 134,297 | 62,028 | 63.863 | Expected liveness violation |
| `prequeue-solo` | 5 | 5 | 0.693 | Passed |
| `prequeue-solo-moved` | 20 | 18 | 0.744 | Expected NoQueueCheck |
| `cohorthold` | 12 | 12 | 0.623 | Expected liveness violation |
| `cohorthold-fixed` | 28 | 28 | 0.578 | Passed; lost release, stuck peer and outage branches |
| `prequeue-cohort` | 128,256 | 43,257 | 102.475 | Passed |
| `prequeue-cohort-mixed` | 619 | 276 | 1.436 | Passed |
| `prequeue-cohort-before` | 306 | 199 | 1.326 | Expected NoEarlyCohort |
| `prequeue-early` | 152,165 | 50,065 | 101.443 | Passed |
| `prequeue-early-mixed` | 625 | 276 | 1.485 | Passed |
| `prequeue-hold-order` | 112,613 | 53,104 | 246.360 | Expected liveness violation |
| `supervisor` | 13 | 10 | 0.564 | Expected liveness violation |
| `supervisor-fixed` | 15 | 15 | 0.578 | Passed; lost step and throwing advance branches |
| `lostdispatch` | 5 | 5 | 0.555 | Expected liveness violation |
| `lostdispatch-fixed` | 14 | 14 | 0.557 | Passed |
| `checkround` | 6 | 6 | 0.566 | Expected liveness violation |
| `checkround-fixed` | 9 | 9 | 0.551 | Passed |
| `retrykeep` | 5 | 5 | 0.556 | Expected KeepsSameHead |
| `retrykeep-fixed` | 15 | 15 | 0.554 | Passed; same-head and changed-head retries |
| `firstcheck` | 24,977 | 10,022 | 29.827 | Passed; 556 class, NoLostWork, MainRecovers |
| `firstcheck-revert` | 1,076 | 725 | 0.804 | Expected NeverReverted (witness) |
| `firstcheck-two` | 97 | 70 | 0.969 | Passed; two suspects, NeverReverted holds |
| `firstcheck-two-fix` | 90 | 67 | 0.760 | Expected NeverFixed (witness) |
| `firstcheck-mixed` | 19,103 | 7,447 | 29.493 | Passed; two breaks among three |
| `fast` | 43,266 | 16,169 | 612.835 | Passed; earned and fresh, one audit stall, FastSound, L1, L2 |
| `fast-witness` | 335 | 224 | 2.521 | Expected NeverFast (witness) |
| `fast-decision` | 12,923 | 6,372 | 2.882 | Expected FastSound |
| `fast-break` | 71,012 | 23,933 | 763.711 | Passed; relaxed-class break, FastSound, LostOnRed, NoLostWork, MainRecovers |
| `fast-earn` | 15,532 | 7,062 | 32.577 | Expected NeverFast (witness: the drill, then a fast carry) |
| `fast-strict` | 152,165 | 50,065 | 1,108.529 | Passed; policy strict, NeverFast holds; same states as `prequeue-early` |
| `fast-unearned` | 152,165 | 50,065 | 346.861 | Passed; policy fast, not earned, NeverFast holds |

All 18 configurations matched their expected outcomes on the registered Java 25.0.3 JDK (2026-11-05, Lane fefd80ee). The seven `prequeue` rows and every `LandingQueue` configuration were then re-run on the spec composed with that change (2026-11-05, Issue e7d27937): all matched, and the non-`prequeue` state counts were unchanged. The `prequeue` rows are from that run. The six positive queue configurations fully exhausted their state graphs; the negative cases stopped at the named counterexample. The default remained below five minutes (94.046 s); `isolation` took 290.953 s. The six cohort-hold rows were added with Issue 10b0a94b (2026-11-05, Lane 2881e6cc). With `Hold = "none"` the `prequeue` and `small` counts were re-run and unchanged. `prequeue-cohort` and `prequeue-cohort-mixed` use `MoveBound = 0`: queue publications move main, which is what refuses the Lane proofs. With one extra external move, `prequeue-cohort` had not finished after 18 minutes and is not counted. `prequeue-hold-order` keeps that move. The two `supervisor` rows were added with Issue 19328518 (2026-11-05, Lane d3a3c850); every Incidents configuration was re-run with them and matched, with existing counts unchanged.

The two `prequeue-early` rows were added with Issue 7fe54c7c (2026-11-06, Lane 6d62d7fe); all 41 configurations, Incidents included, were re-run with them and matched. `prequeue-cohort` and `prequeue-cohort-mixed` are from that run (the earlier counts predated later spec changes); `prequeue-early` explores a superset of `prequeue-cohort`'s states, as `"early"` only adds refusals.

All 48 configurations, Incidents included, were re-run with the first-check change (Issue 7fe54c7c, 2026-11-06, Lane a3fed1a0) and matched; every row above is from that run. `Breaks = {}` adds no states: `submission`, `reuse-core`, `prequeue` and `prequeue-strict` were also run on an unmodified copy of the main model with identical counts, so rows that changed here had predated earlier spec changes. `prequeue-suffix` and `prequeue-hold-order` stop at their liveness counterexample; their partial counts vary between runs (the unmodified copy stopped `prequeue-suffix` at 162,842 / 74,207).

The seven `fast` rows are from the landing-mode change (Issue 81d12a32, 2026-11-09, Lane 6ca68b15), run on a machine at load 30 to 45, so their wall times are not comparable with the rows above.

With ea86f3fb (2026-11-05, Lane c1759651) `small`, `strict`, `races`, `six-slots` and `isolation` were re-run with `StackPinned`; their rows are from that run. A platform retry no longer branches into invalidation, so `small`, `strict`, `races` and `isolation` explore fewer states. `six-slots` has no platform outcome and kept its count; its wall time on current main is ~17 min (an unmodified copy of the main model ran at the same rate, friction filed). The other rows predate this change.

Incomplete calibration explorations with allocation-history counters and arbitrary three-entry admission interleavings reached the five-minute limit and were not counted as passing checks. The delivered configurations use fresh symbolic names and the admission bounds described above; those incomplete variants are not a proof of broader bounds. No live provider replay, full six-incident historical replay, or proof of the source merge/fence implementation was performed. Peak resident memory was not measured; the Java heap was limited to 2 GiB. Disk stayed above the 40 GB reserve.
