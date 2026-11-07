# Regression ladder

A full B1.5d-style bench takes hours of agent time, so it runs only at phase gates. Day-to-day
speed and cost regressions in the landing loop are caught by cheaper rungs, cheapest first.
Each alert or failure names its next step.

| Rung | What runs | When | Cost |
| --- | --- | --- | --- |
| 1. Per-landing self-metric alert | Each landing's own timing against the project's 7-day median | Inside the mutation that lands | No new Convex call; one indexed read and one write of a row under 16 KB per landing; idle 0 |
| 2. Path-triggered dry micro-bench | A fixed no-model scenario on the hot-file clusters | Planned, not built: a change to landing-loop paths | Estimate below |
| 3. Incident replays | Normal-suite tests that replay each core-claim incident and B1.5d case study | Every check | Part of the suite; the registered replays take under 30 s together |
| 4. Full bench | The B1.5d repeat (exit bench 8c9b84fc) | Phase gates only | Hours of agent time |

## Rung 1: landing speed alert

Source: `src/landing-speed-alerts.ts`, called from the landing's own accept mutation
(`convex/projectLandingSpeed.ts`). It reads only stamps the landed state already carries.

- **Metrics.** Time to main: submit to commit. Check minutes: the accepted attempt's check,
  reserved to ended. A missing stamp (for example a reused check) leaves that metric unknown for
  the landing.
- **Baseline.** The median of the previous 7 full UTC days, today excluded, with at least 10
  landings. A new or quiet project has no baseline and never alerts.
- **Sustained jump.** The median of the last 3 landings, all today, is over the threshold, so
  one slow landing never alerts.
- **Threshold.** The larger of baseline x 1.5 and baseline + 5 min (time to main) or + 2 min
  (check minutes).
- **Delivery.** At most one alert per metric per UTC day, sent the moment the jump becomes
  sustained, through the project's [`stallAlerts`](../parallel-work-defaults.md#stallalerts)
  channels (email, ntfy and the other webhook presets). With `stallAlerts` off, samples are still
  kept and nothing is sent.
- **Next step, named in the alert.** Time to main: `nforge metrics ROOT --text` for waste by
  cause and main-race re-checks, then the rung 2 micro-bench on the latest landing-loop change.
  Check minutes: `nforge metrics ROOT --text` for check minutes and flaky files, then compare the
  slowest test files with the previous week and the latest verify script or runner change.
- **Not covered.** Convex calls and dollars per landing are not stamped on a landing, so rung 1
  cannot alert on them. They stay on metric 5.8 (billed dollars per landing) in
  `nforge metrics`, read when bills are recorded.

Change a threshold in `LANDING_SPEED_BASELINE` and this section together.

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

A new core-claim incident adds its replay to the registry and a row here in the Lane that fixes
it.
