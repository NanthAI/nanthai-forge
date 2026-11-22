# Regression ladder

A full B1.5d-style bench takes hours of agent time, so it runs only at phase gates. Day-to-day
speed and cost regressions in the landing loop are caught by cheaper rungs, cheapest first.
Each alert or failure names its next step.

| Rung | What runs | When | Cost |
| --- | --- | --- | --- |
| 1. Per-landing speed budgets | Each landing's own timing against the [speed budgets](speed-budgets.md) | Inside the mutation that lands | No new Convex call; one indexed read and one write of a row under 16 KB per landing; idle 0 |
| CLI/MCP weight | [Installed bytes, startup CPU/modules and synthetic calls/DB reads](agent-weight.md) | Existing package smoke and command fixtures in each landing check | Under 60 s added locally; 0 production/idle calls |
| 2. Path-triggered dry micro-bench | A fixed no-model scenario on the hot-file clusters | Planned, not built: a change to landing-loop paths | Estimate below |
| 3. Incident replays | Normal-suite tests that replay each core-claim incident and B1.5d case study | Every check | Part of the suite; the registered replays take under 30 s together |
| 4. Full bench | The B1.5d repeat (exit bench 8c9b84fc) | Phase gates only | Hours of agent time |

## Rung 1: landing speed budgets

Source: `src/landing-speed-alerts.ts`, called from the landing's own accept mutation
(`convex/projectLandingSpeed.ts`). It reads only stamps the landed state already carries. The numbers, their
data and the break, recovery and Issue rules are in [speed budgets](speed-budgets.md).

- **Metrics.** Time to main: submit to commit. Check minutes: the accepted attempt's check, reserved to
  ended. Check-to-commit gap: check result to commit, in seconds (Issue 03a749a5). Pass to land (queue
  health, Issue 42200ce4): the first time the submission was ready (its check passed) to commit, in minutes;
  the request row keeps that first-ready time across recompositions in the write it makes anyway, so a pass
  discarded by a main move or held behind an older entry still counts. A landing that never waited ready
  counts from its accepted check's end, never from before its own submission (a reused check). At landing
  the row keeps the stamp only when it is over a minute before that end (a held, re-checked landing), so a
  landing that went straight in stores nothing extra. A landing that a person's review or a dependency held
  after it passed gives no pass-to-land sample: that wait is not queue health.
- **Budgets.** p50 and p90 of each metric over the last 20 landings that know it, against the numbers in
  `src/speed-budgets.json`. Fewer than 20 landings: no verdict.
- **Delivery.** One alert when a budget breaks and one when it recovers, through the project's
  [`stallAlerts`](../parallel-work-defaults.md#stallalerts) channels (email, ntfy and the other webhook
  presets), and one P0 Issue per budget (fixed id, reopened on a repeat break). With `stallAlerts` off,
  samples and Issues are still kept.
- **Next step, named in the alert.** Time to main: `nforge metrics ROOT --text` for waste by cause and
  main-race re-checks, then the rung 2 micro-bench on the latest landing-loop change. Check minutes:
  `nforge metrics ROOT --text` for check minutes and flaky files, then compare the slowest test files with the
  previous week and the latest verify script or runner change. Pass to land: the alert carries the
  [queue health alarm](lead.md#queue-health-alarm) rule (no new builders while broken), then `queue`
  (what each ready entry waits on) and `landings` (held after check, order waits) for the window.
  In metric 5.6, use `runCauses` to split checks started per landing and known runner minutes
  by recorded dispatch cause. Report unrecorded runs and unknown durations alongside the split.
- **Cost drift.** Attempts, landing-state writes, the R2 requests its composes signed and the runner
  minutes of its accepted, discarded and audit checks are stamped in the same row and judged as a
  20-landing mean ([cost budgets](../operations.md#cost-budgets)). Dollars and billed usage are not
  stamped on a landing; they stay with the live captures and metric 5.8.
- **Cost on change.** The landing check judges a scripted landing mix against the per-landing cost
  ledger (`tests/landing-cost-guard.test.mjs`): a rise over 15% fails before it lands.

## Rung 2: path-triggered dry micro-bench

Built; live qualification open. The committed baseline is `unmeasured`.
Unqualified for bd0f850e/e7e35328.

- Accepted main pushes match `landing-micro-bench.yml` paths; no landing gate/cron,
  idle zero. Failed starts/reruns count: one/6h, four/24h. Cooldown pushes are skipped;
  automatic trailing execution remains open.
- Existing no-model `scripted.mjs`, Forge only, N=3: t19456/t22302/t27456 then
  t23938/t23766. E3 (39942bfe) can reuse `micro-setup.mjs` and concurrency group
  `forge-shared-benchmark`.
- Compare last passing baseline: wall, each task's time to main, checks/task, Convex $.
  Strictly >1.5x alerts existing `stallAlerts`: inspect run/latest diff, fix in the same
  slice, repeat. Missing coverage/drift/failure never refreshes baseline.
- Owner setup: `FORGE_BENCH_TOKEN`, nonsecret `FORGE_MICRO_SETUP`, matching bench deploy.
  Run once, prove alerts, commit measured baseline. Approved $0.06/run, free runners.
  Forecast only: 15–25 min, ~34 check-minutes plus setup, ~$0.03; R2/storage unmetered.
- [CLI/MCP weight guard](agent-weight.md) 92dbde9d applies to every screen/agent-contract slice. Full close:
  0a9df3cd. Actor metrics: seven days after metrics works; comparable load: 24h ~2.4/h.

## Rung 3: incident replays

`tests/fixtures/incident-replays.json` lists each incident and the normal-suite test that
replays it. `tests/incident-replays.test.mjs` fails the check when a listed test is renamed,
removed, skipped or moved out of `tests/*.test.mjs`, or when this page stops naming an incident.

| Incident | Replayed failure |
| --- | --- |
| `ad80e037` | Convex 1.50 rejects self-cancellation of a running mutation whose system row still says pending; request ownership protects its successor |
| `08169467` | Completed compose stranded before admission by cancellation of a running desired wake |
| `n3-r3-a1` | B1.5d n3-r3 attempt 1: a stalled land, help hunting after resolve from the wrong folder, and a 3x slower cell that raised no alert |
| `t27456` | B1.5d conflict recovery: re-land with markers, resolve from a subdirectory, overtaken during its check |
| `a930de4c` | Core claim: an empty Lane reported LANDED |
| `779d17be` | A 22-minute legacy storage maintenance outage replayed with an online copy, switch and retry while all landings settle in order. |
| `c329d191` | Core claim: a lost finish wake stalled the queue about 30 min, and a holder that lost every driver stranded the Ready waiters behind it |
| `c7ad22b0` | Exact check reuse proof for an earlier landing attempt was unavailable after capsule relocation |
| `a7de3a93` | Core claim: a lost check dispatch left the queue head checking for up to 12 h (2026-11-05) |
| `9a04d916` | Core claim: a conflict known at once after a cancelled pre-queue check sat 921 s, because the one action that consumed its recompose was lost and only the 15-minute stall alarm owned it |
| `19328518` | Landing supervisor: each historical stall where one lost or crashing driver stranded an entry (10-26 to 10-31, and the 11-05 88-minute landing) |
| `f233bf1c` | Core claim: a batch mirror commit (normal Lane + resolution Lane) kept one member's message; the resolution landing named none (2026-11-07) |
| `95a0b4d` | A repeated resolution lost its landing note when the failed child Candidate differed from the original request Candidate; the mirror commit omitted that member. |
| `62033ba2` | Core claim: an owner-held predicted predecessor stranded a passed follower; followers now recompose and land while the owner decides |
| `stucktrain` | Core claim: a passed three-Lane cohort retained a future reservation-expiry wake after its holder failed; order release now replaces that obsolete timer |
| `10d253c6` | Core claim: a 130-path Lane on hot files starved in a composition-conflict loop (10 land operations, about 2.5 h; 2026-11-10) |
| `c01d5457` | Cohort retry/split and singleton-to-solo handoffs replace the retired finish timer; late retired compose callbacks cannot displace successor work. Running owners retain their descendants; the replay models Convex action cancellation and a fresh solo plan. Synthetic failure/split progression is replayed without watchdog execution; the historical long-running source action still needs live qualification |
| `5d690345` | Core claim: a docs-only main advance changed the full audit's source pin, causing a false audit-baseline refusal and discarding a passed check |
| `830ccd4b` | A protected-path edit invalidated an unrelated passing check, recurring on submission `81359837`. Adding or removing the pattern now affects only matching Candidates or those without path coverage. The preview and saved receipt name the affected submissions. |

| `27865bc4` | Red main: a new failing test has no predecessor report; later failed audits must retain one recovery and complete its automatic reverse |
| `438e9ace` | Red main: two landings pass alone but fail together; a later failed audit retains one checked pair recovery, with widening bounded at four |

| `1018d0f8` | An alert refresh overwrote an unticked measurement line and reconciliation closed an unmet Issue; refreshed alerts retain the existing body and reconciliation counts bare unticked checkboxes too |
| `f5c45985` | A missing accepted-run stamp hid 3,317 discarded runner seconds; projections use the independent discard stamp and existing maintenance repairs retained null samples |

| `025470bf` | A moved-main cohort records its actual hold release. The selected request and receipt agree, and old releases with no stamp stay unavailable. |
| `ced8e98f` | A replaced check retains its checked prefix, the mover receipt, provider times, and the exact attempt that followed it. A withdrawal is censored and missing older observations remain unrecorded. |
| `9829778c` | A stale conflict beside older board pages or a note already read in another Lane repeatedly interrupts a wait |
| `30b2efda` | A check harness change can turn identical Candidate source red. Main broke retains the harness change without assigning a landing as culprit. |
| `aad45785` | Overlapping full admissions spend checks before composing against an earlier pending predecessor; failed predecessors must preserve follower source |
| `70a9bd2f` | Zoo timing: a build input and disjoint source arrived together; the admission pipeline must check a follower with its predecessor on the exact combined head and keep the 1.5x solo timing bar. The deleted O3 queue switch broke this replay (Item 026ce0cf) |
| `2bf85ddf` | Core claim: the queue landed a parked Lane after its agent stopped and its Item heard nothing (2026-11-17); every landing now posts a system receipt comment to its Item |
| `43b51a5e` | Core claim: one older entry changing only a nightly workflow held 9 passed landings up to 80 min as `dependent` and re-checked on every main move (2026-11-19). A `.github/` file is CI configuration only when the check runs it, an older entry linked only by its own global risk is overtaken once (a parked Ready one too), handed waiters record their wait so the new-run wake finds them, a long park passes its followers on, and the queue view says a parked pass waits for order. Case 3 (17:54-18:24Z): a reservation holder parked on an entry that waited for a waiter on its reservation; the holder now goes ahead of such a disjoint entry, or its reservation ends |
| `687d1eda` | Core claim: a landing turned on browser tests its own check skipped; the skip counted as a pass, unrelated landings were blamed and reverted, and a docs-only audit cleared red (2026-11-19). A skip is not a pass, full checks run every browser test, and a newly covered failure names the coverage landing and reverts nothing. A check that fails only on main's red tests (admission, a cohort's shared run or one entry's exact check) parks and re-lands on green instead of failing the change |
| `fa2c1383` | Main moves threw away running checks that could still carry or seed a scoped recheck (2026-11-17: 57 cancels of landed work). The 11-17 trace replays today's sweep against the keep rule, recorded queue waits kept, without and with Lane B's clean overlap probe; wasted minutes fall and total runner-minutes, run wall and time to main do not rise. A conflicting probe always cancels, and every probe's Convex cost is priced in the per-1,000-landings table. Wired (switch `FORGE_QUEUE_KEEP_THE_RUN`): a mutant child proves the guards fail when the sweep throws a kept run away, when a follower is stacked on a kept run with the pipeline full (strict) or the kept run's settle, a main-red park included, wakes no queue tick (fast), when the cohort hold parks a kept run (its follower lands first, whichever passes first), when a kept run's platform end restarts a whole run on its old base and when an obsolete probe conflict is dropped (reviews a09af93a, 379d19f5, 018569e9) |
| `cd63bbe9` | Core claim: a shared check failed and its unattributed split recheck completed in GitHub but stayed at zero recorded shards in Forge. The checking alarm recovers the bound execution and verifies its original shard results. |
| `e62d834b` | Core claim: source steps fenced at the fixed 60 s worker lease were never retried, so landings sat in source preparation (2026-11-20). A step renews its lease from inside, a fenced or failed step retries server-side, and a dead step or a fan-out batch queued past its lease is repaired by its own wake at the lease end (no polling; a healthy step cancels its wake, so it never runs). The queue and a stalled `wait` name the failed step and its cause, and a runner source request answers slow object storage with 503 `reason: storage` inside the runner 30 s timeout |
| `39a68046` | A conflict handoff could leave the origin Lane's sync-required landing queued. Draft publication supersedes the landing for that exact saved head, including on retry. |
| `f65d8024` | A feed-backed wait could miss a stalled Ready transition or new sync advice. The exact selected operation wakes the wait for both, and the canonical baseline pins the start of live delivery. A current project writer can use a submission ID to read another member's pre-admission failure. |

| `3dfacaa4` | A measurement-held CLI replay submits the original operation once. Direct and desired retries preserve its first measured builder hold and legacy reply shape. |
| `9064e885` | Earlier passes parked behind unrelated solo checks waited across replacement generations. The replay covers six receipts, preserves exact predecessor and multi-member fences, and verifies that the re-pin wakes earlier independent passes without another holder check. |
| `65e2d743` | The passed landing waited behind an older submission. Individual and batch receipts record the elapsed order wait, and `landings` includes waits shorter than one minute. |
| `78a97771` | Withdrawal by Lane keeps the builder's saves and ends the pending check. An old withdrawal reader can still read a reply after a newer CLI stamps the submit. |

A new core-claim incident adds its replay to the registry and a row here in the Lane that fixes
it.

### Adding an incident replay

Every queue incident becomes a permanent gate (Guard 2, Item 2873b486), in the Lane that fixes it:

1. Rebuild the incident in the normal suite from its real shape: for queue incidents a scenario in
   `tests/queue-sim/` driven through the real landing code (`parked-incident.mjs` is the model),
   with a measurable ceiling on what went wrong (for `5e3c3a3c`, each passed follower's pass-to-land
   while its holder re-checks, `FOLLOWER_CEILING_MINUTES`).
2. Prove the gate catches the regression: run the pre-fix code in a child process with
   `FORGE_TEST_SOURCE_PATCHES` (and `FORGE_TEST_PRECOMPILED=0`), and assert there that the ceiling
   breaks; then assert in the main test that current code stays within it. Run the child with the
   TAP reporter and assert its output names the mutant test as `ok`: a name filter that matches
   nothing still exits 0.
3. Register the test in `tests/fixtures/incident-replays.json` and name the incident on this page.
   The landing check then runs every registered replay, the queue simulation and the cost guard for
   any change to a core queue path, whatever the change claims
   ([Guard 4](briefings.md#builder-decision-rules)).

`238b3573`: accepted dispatch startup failure with a lost webhook, and twelve signed passing shards whose provider run and eleven jobs remain in progress after every step completes; both replays are registered in `tests/fixtures/incident-replays.json`.

Queue incidents `5e3c3a3c` and `e4aee4fe` run in `hosted-landing-queue-sim.test.mjs`; the 5e3c3a3c
pass-to-land alarm replay runs in `landing-pass-to-land-alarm.test.mjs`.
The [invariant reference](../operations/landing-queue-invariants.md) states known violations;
the retained bench model is unqualified. The owner rollout decision requires switched rules and a live watch.
