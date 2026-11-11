# Regression ladder

A full B1.5d-style bench takes hours of agent time, so it runs only at phase gates. Day-to-day
speed and cost regressions in the landing loop are caught by cheaper rungs, cheapest first.
Each alert or failure names its next step.

| Rung | What runs | When | Cost |
| --- | --- | --- | --- |
| 1. Per-landing speed budgets | Each landing's own timing against the [speed budgets](speed-budgets.md) | Inside the mutation that lands | No new Convex call; one indexed read and one write of a row under 16 KB per landing; idle 0 |
| 2. Path-triggered dry micro-bench | A fixed no-model scenario on the hot-file clusters | Planned, not built: a change to landing-loop paths | Estimate below |
| 3. Incident replays | Normal-suite tests that replay each core-claim incident and B1.5d case study | Every check | Part of the suite; the registered replays take under 30 s together |
| 4. Full bench | The B1.5d repeat (exit bench 8c9b84fc) | Phase gates only | Hours of agent time |

## Rung 1: landing speed budgets

Source: `src/landing-speed-alerts.ts`, called from the landing's own accept mutation
(`convex/projectLandingSpeed.ts`). It reads only stamps the landed state already carries. The numbers, their
data and the break, recovery and Issue rules are in [speed budgets](speed-budgets.md).

- **Metrics.** Time to main: submit to commit. Check minutes: the accepted attempt's check, reserved to
  ended. Check-to-commit gap: check result to commit, in seconds (Issue 03a749a5). A missing stamp (for example a reused check) leaves that metric unknown for the landing.
- **Budgets.** p50 and p90 of each metric over the last 20 landings that know it, against the numbers in
  `src/speed-budgets.json`. Fewer than 20 landings: no verdict.
- **Delivery.** One alert when a budget breaks and one when it recovers, through the project's
  [`stallAlerts`](../parallel-work-defaults.md#stallalerts) channels (email, ntfy and the other webhook
  presets), and one P0 Issue per budget (fixed id, reopened on a repeat break). With `stallAlerts` off,
  samples and Issues are still kept.
- **Next step, named in the alert.** Time to main: `nforge metrics ROOT --text` for waste by cause and
  main-race re-checks, then the rung 2 micro-bench on the latest landing-loop change. Check minutes:
  `nforge metrics ROOT --text` for check minutes and flaky files, then compare the slowest test files with the
  previous week and the latest verify script or runner change.
- **Cost drift.** Attempts, landing-state writes, the R2 requests its composes signed and the runner
  minutes of its accepted, discarded and audit checks are stamped in the same row and judged as a
  20-landing mean ([cost budgets](../operations.md#cost-budgets)). Dollars and billed usage are not
  stamped on a landing; they stay with the live captures and metric 5.8.
- **Cost on change.** The landing check judges a scripted landing mix against the per-landing cost
  ledger (`tests/landing-cost-guard.test.mjs`): a rise over 15% fails before it lands.

## Rung 2: path-triggered dry micro-bench (planned)

Not built. Design and cost estimate for the lead:

- **Trigger.** An accepted change to the landing-loop paths: `convex/projectHostedLanding*`,
  `convex/projectHostedFinish*`, `convex/projectHostedCompose*`, `convex/projectHostedAcceptance*`,
  `convex/projectHostedOverlap*`, `src/hosted-agent-finish*`, `src/hosted-conflict*` and Lane
  start/open. It runs after the landing, never blocks it, coalesces to at most one run per 6 hours
  and never runs when nothing changed.
- **Scenario.** The B1.5d no-model driver (`scripts/bench-t3code/scripted.mjs`), Forge arm only,
  N = 3, on the two hot-file clusters: the preview triple (t19456, t22302, t27456) and the pair
  (t23938, t23766), 5 tasks.
- **Baseline.** The stored result of the last passing run; report wall time, time to main per task,
  check runs per task and Convex dollars, flagging any over x 1.5.
- **Estimated cost per run.** About 15-25 min wall time (5 tasks across 3 workers, about 1.5
  checks of 2-3 min per task, plus about 5 min setup). About 34 GitHub Actions minutes (1.5 runs x
  4.5 min per task), $0 on public repositories. Convex about $0.03 (5 x $0.0056 per dry task from
  the B1.5d dry batch), $0.06 with a 2x margin. At most 4 runs a day: about $0.24 a day at the cap,
  $0 on days without landing-loop changes.

## Rung 3: incident replays

`tests/fixtures/incident-replays.json` lists each incident and the normal-suite test that
replays it. `tests/incident-replays.test.mjs` fails the check when a listed test is renamed,
removed, skipped or moved out of `tests/*.test.mjs`, or when this page stops naming an incident.

| Incident | Replayed failure |
| --- | --- |
| `n3-r3-a1` | B1.5d n3-r3 attempt 1: a stalled land, help hunting after resolve from the wrong folder, and a 3x slower cell that raised no alert |
| `t27456` | B1.5d conflict recovery: re-land with markers, resolve from a subdirectory, overtaken during its check |
| `a930de4c` | Core claim: an empty Lane reported LANDED |
| `c329d191` | Core claim: a lost finish wake stalled the queue about 30 min, and a holder that lost every driver stranded the Ready waiters behind it |
| `a7de3a93` | Core claim: a lost check dispatch left the queue head checking for up to 12 h (2026-11-05) |
| `19328518` | Landing supervisor: each historical stall where one lost or crashing driver stranded an entry (10-26 to 10-31, and the 11-05 88-minute landing) |
| `f233bf1c` | Core claim: a batch mirror commit (normal Lane + resolution Lane) kept one member's message; the resolution landing named none (2026-11-07) |
| `62033ba2` | Core claim: an owner-held predicted predecessor stranded a passed follower; followers now recompose and land while the owner decides |
| `stucktrain` | Core claim: a passed three-Lane cohort retained a future reservation-expiry wake after its holder failed; order release now replaces that obsolete timer |
| `10d253c6` | Core claim: a 130-path Lane on hot files starved in a composition-conflict loop (10 land operations, about 2.5 h; 2026-11-10) |
| `5d690345` | Core claim: a docs-only main advance changed the full audit's source pin, causing a false audit-baseline refusal and discarding a passed check |

| `27865bc4` | Red main: a new failing test has no predecessor report; later failed audits must retain one recovery and complete its automatic reverse |
| `438e9ace` | Red main: two landings pass alone but fail together; a later failed audit retains one checked pair recovery, with widening bounded at four |

A new core-claim incident adds its replay to the registry and a row here in the Lane that fixes
it.
