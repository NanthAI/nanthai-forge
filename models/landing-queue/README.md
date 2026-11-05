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
names changes the conservative-impact proof accepts after any main move.
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

## Model-to-code map and simplifications

Line references are to the pinned source above. Every abstraction below is a
scope limitation; passing TLC does not verify the omitted implementation.

| Model action/state | Code anchor | Abstraction and reason |
| --- | --- | --- |
| `Submit`, `Admit`, `AdmissionFailure`, `Gate` | `convex/projectHostedLandingDesired.ts:27`, `convex/projectHostedLandingDesired.ts:189`, `convex/projectHostedLandingDesired.ts:204`, `convex/projectHostedLanding.ts:209`, `convex/projectHostedLandingPins.ts:28` | One entry per Lane/operation. The durable desired handle enters `composing`; source completion admits it or retains a structured failure. Canonical queue order is assigned at enqueue, so a later source job may enter first. Source cursor/transport work and selection validation are hidden; aliases stutter. Multi-Lane selections and access revocation remain outside the state space. |
| needs action | `src/agent-default-gates.ts:28`, `convex/projectHostedLandingControl.ts:315`, `src/hosted-landing.ts:117` | Blocking overlap/review/dependency is an observable result, not a new stored terminal phase. Advisory overlaps never gate. Answer/resubmit is outside this finite episode. |
| `Form`, `SmallCohorts` | `convex/projectHostedLandingBatchStore.ts:83`, `convex/projectHostedLandingOrder.ts:43` | Fixed cohort compatibility and one actor/priority/policy; rank is allocated at canonical admission. Dynamic cohort sizing, actor fairness and urgent preemption are reduced to finite selection. Membership and source-completion/admission order can differ in `submission.cfg`; the default starts after three admissions to keep the exploration small. |
| `Precompose`, claim in `Form` | `convex/projectHostedLandingPrecompose.ts:50`, `convex/projectHostedFinishPrecompose.ts:13`, `convex/projectHostedFinishCompose.ts:268` | An advisory marker, never a queue claim. Useful selection detaches its advisory work. Peer markers may physically survive until attempt/shared-run validation; this model hides them at logical cohort selection, and merge outcomes remain nondeterministic. Byte-cache hit/miss, metadata uploads and late advisory callbacks are hidden; they grant no check/publication authority. |
| `Compose(g,dropped)` | `src/hosted-compose-worker.ts:78`, `src/hosted-compose-worker.ts:175`, `src/hosted-source-step-merge.ts:342`, `src/hosted-source-step-merge.ts:387` | Arbitrary rejected subsets overapproximate merge outcomes. Dependencies and ordered prefix source merges become provenance-set union; hashes, manifests, ancestry traversal and R2 I/O are assumed correct. No claim that conflicting file bytes are proven preserved. The cohort litmus separately represents an earlier-member-only conflict. |
| `q.train`, width | `src/hosted-landing-batch.ts:16`, `convex/projectHostedLandingPipeline.ts:23`, `convex/projectHostedLandingWake.ts:28` | Width is 6; a fixed checked tail supplies its predicted head and final receipt. Reusable active record slots, with distinct fresh symbolic receipt names, stand in for historical batch UUIDs. The small bound exercises fewer than six slots; `six-slots.cfg` separately reaches six occupied slots with seven entries, pass/fail invalidation and no unrelated environment branching. |
| trim rejected members, `Settle` | `convex/projectHostedLandingCohortConflicts.ts:18`, `convex/projectHostedLandingCohortConflicts.ts:39`, `convex/projectHostedLandingBatchFinish.ts:132`, `convex/projectHostedLandingSpeculativeConflict.ts:18` | Rejected members leave the train. Speculative rejection waits for predecessor settlement; exact-main rejection retains a terminal conflict; moved main releases it for solo recomposition. Per-member evidence failures become ordinary terminal reasons. |
| `Invalidated`, `Rebase` | `convex/projectHostedLandingPipelineInvalidation.ts:24`, `convex/projectHostedLandingBatchStore.ts:267` | Bounded predecessor closure identifies transitive dependents; an ordinary solo recovery can coexist with a later train. Descendants revert to original selections; independent groups remain. Inactive historical batch bodies are forgotten (the active record slot becomes `idle`); no transition reads their outcome. Entry outcomes/reasons, counts and current-main receipt are retained, and fresh symbolic names prevent record-slot reuse from impersonating any referenced old generation. Generation-bound delayed callbacks stutter; source-job callback validation itself is not proved. |
| `Check`, `SourceFailure`, `Release`, `Fallback` | `convex/projectHostedLandingBatchCheck.ts:43`, `convex/projectHostedLandingBatchSplit.ts:65`, `convex/projectHostedLandingBatchRelease.ts:16`, `convex/projectHostedLandingBatchFallback.ts:18` | Source retry exhaustion terminalizes its members (`convex/projectHostedLandingBatchFinish.ts:108`). Full check pass/test failure/infrastructure failure; infrastructure retries are exactly 2. Split children are reduced to the existing serial solo fallback for these small cohorts. With `Isolation` (`isolation.cfg`), a failure may name suspects (released, never re-stacked onto) and a group stacked on an unpassed predecessor unstacks once (`src/hosted-landing-suspect.ts`). Larger parallel halves, contract diagnosis and admission-run reuse are not explored. No semantic conflict policy is invented. |
| standalone retry | `convex/projectHostedLandingCheckRetry.ts:14`, `src/hosted-landing-admission.ts:11` | Same two-retry budget and immutable Candidate proof. Individual provider states, cancellation vs timeout classification and complete shard validation collapse into check outcome. |
| cancel/abandon | `convex/projectHostedLandingCancel.ts:35`, `convex/projectHostedBatchAbandon.ts:35` | One atomic target settlement and peer release; final publication wins or cancellation wins. Abandon discovery pages and Lane lifecycle are hidden. Shared check execution continues independently; only binding authority matters here. |
| `Claim`, `Publish`, `MoveMain` | `convex/projectHostedLandingControl.ts:293`, `convex/projectHostedLandingBatchPublish.ts:48`, `convex/projectHostedAcceptancePublish.ts:110` | Transactional OCC/CAS is atomic; includes main receipt equality, exact proof and member counters. Policy, contributor access, full shard evidence and registration are assumed validated; this is the automatic agent path, not explicit unchecked owner acceptance (which independently also makes unrestricted literal S2 false). Main contributions are append-only ancestry tokens; legitimate file edits/reverts are outside this property. |
| `Reuse` | `convex/projectHostedFinishCompose.ts:402`, `convex/projectHostedAcceptancePublish.ts:125`, `convex/projectHostedAcceptancePublish.ts:175`, `src/hosted-cross-head-proof.ts:46` | Eligible owner-agent cross-head proof on disjoint synthetic main change. Analysis/audit eligibility is assumed; original checked result stays different from applied result. `strict.cfg` disables this branch; the default enables it; `reuse-core` explicitly enables it. |
| `LaneCheck`, `LaneAdopt`, `LaneRefused`, `Behind` | `convex/projectHostedLandingAdmission.ts` (`startLandingAdmission`, `settleLandingAdmission`, `admittedReuseFirst`), `convex/projectHostedLandingStore.ts` (`orderLive`, `batchable`), `convex/projectHostedLandingSuffix.ts`, `convex/projectHostedLandingOrder.ts` (`olderLandingAhead`) | Lane-check outcomes are fixed by `Red`; in-flight interaction failures stay nondeterministic in `Check`. Proof eligibility is the constant `Independent`, not the path/test analysis. A refused proof is reduced to returning to the pool; the code recomposes on current main first. The code walks the suffix only for entries that went through full admission: only they can enter the queue behind a younger group. |
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
| `small` | 191,567 | 69,393 | 94.046 | Passed |
| `strict` | 170,707 | 64,056 | 122.612 | Passed |
| `races` | 91,367 | 29,151 | 22.937 | Passed |
| `submission` | 957,613 | 306,753 | 363.927 | Passed |
| `six-slots` | 3,655 | 3,655 | 9.027 | Passed |
| `reuse-core` | 205 | 115 | 0.830 | Expected S2 |
| `isolation` | 415,924 | 107,090 | 290.953 | Passed |
| `wait` | 4 | 4 | 0.695 | Expected FreshTerminal |
| `wait-fixed` | 4 | 4 | 0.758 | Passed |
| `cohort` | 6 | 6 | 0.562 | Expected NoOrphanConflict |
| `cohort-fixed` | 22 | 22 | 0.731 | Passed; failed/cancelled/landed prefix and independent-main branches |
| `stranded` | 2 | 2 | 0.662 | Expected liveness violation |
| `stranded-fixed` | 4 | 4 | 0.640 | Passed |
| `orderwake` | 4 | 4 | 0.630 | Expected liveness violation |
| `orderwake-fixed` | 6 | 6 | 0.638 | Passed |
| `moving` | 8 | 7 | 0.613 | Expected liveness violation |
| `reuse` | 4 | 4 | 0.604 | Expected ExactCheckedHead |
| `reuse-fixed` | 4 | 4 | 0.637 | Passed |
| `prequeue` | 88,190 | 25,434 | 67.409 | Passed |
| `prequeue-strict` | 70,443 | 21,720 | 55.943 | Passed |
| `prequeue-platform` | 1,190,037 | 377,715 | 592.230 | Passed |
| `prequeue-before` | 2 | 2 | 0.630 | Expected RedNeverQueued |
| `prequeue-suffix` | 129,008 | 59,606 | 63.990 | Expected liveness violation |
| `prequeue-solo` | 5 | 5 | 0.797 | Passed |
| `prequeue-solo-moved` | 20 | 18 | 1.033 | Expected NoQueueCheck |

All 18 configurations matched their expected outcomes on the registered Java 25.0.3 JDK (2026-11-05, Lane fefd80ee). The seven `prequeue` rows and every `LandingQueue` configuration were then re-run on the spec composed with that change (2026-11-05, Issue e7d27937): all matched, and the non-`prequeue` state counts were unchanged. The `prequeue` rows are from that run. The six positive queue configurations fully exhausted their state graphs; the negative cases stopped at the named counterexample. The default remained below five minutes (94.046 s); `isolation` took 290.953 s.

Incomplete calibration explorations with allocation-history counters and arbitrary three-entry admission interleavings reached the five-minute limit and were not counted as passing checks. The delivered configurations use fresh symbolic names and the admission bounds described above; those incomplete variants are not a proof of broader bounds. No live provider replay, full six-incident historical replay, or proof of the source merge/fence implementation was performed. Peak resident memory was not measured; the Java heap was limited to 2 GiB. Disk stayed above the 40 GB reserve.
