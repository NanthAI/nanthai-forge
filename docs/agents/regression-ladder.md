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
| `c329d191` | Core claim: a lost finish wake stalled the queue about 30 min, and a holder that lost every driver stranded the Ready waiters behind it |
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

| `27865bc4` | Red main: a new failing test has no predecessor report; later failed audits must retain one recovery and complete its automatic reverse |
| `438e9ace` | Red main: two landings pass alone but fail together; a later failed audit retains one checked pair recovery, with widening bounded at four |

| `1018d0f8` | An alert refresh overwrote an unticked measurement line and reconciliation closed an unmet Issue; refreshed alerts retain the existing body and reconciliation counts bare unticked checkboxes too |
| `f5c45985` | A missing accepted-run stamp hid 3,317 discarded runner seconds; projections use the independent discard stamp and existing maintenance repairs retained null samples |

| `9829778c` | A stale conflict beside older board pages or a note already read in another Lane repeatedly interrupts a wait |
| `aad45785` | Overlapping full admissions spend checks before composing against an earlier pending predecessor; failed predecessors must preserve follower source |
| `70a9bd2f` | Zoo timing: a build input and disjoint source arrived together; the admission pipeline must check a follower with its predecessor on the exact combined head and keep the 1.5x solo timing bar. The deleted O3 queue switch broke this replay (Item 026ce0cf) |
| `2bf85ddf` | Core claim: the queue landed a parked Lane after its agent stopped and its Item heard nothing (2026-11-17); every landing now posts a system receipt comment to its Item |
| `687d1eda` | Core claim: a landing turned on browser tests its own check skipped; the skip counted as a pass, unrelated landings were blamed and reverted, and a docs-only audit cleared red (2026-11-19). A skip is not a pass, full checks run every browser test, and a newly covered failure names the coverage landing and reverts nothing |
| `fa2c1383` | Main moves threw away running checks that could still carry or seed a scoped recheck (2026-11-17: 57 cancels of landed work). The 11-17 trace replays today's sweep against the keep rule, recorded queue waits kept; wasted minutes fall and total runner-minutes, run wall and time to main do not rise |

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
