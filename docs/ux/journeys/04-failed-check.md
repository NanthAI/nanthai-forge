# Journey 4: a failed check, a flaky check and recovery

The landing check fails, or fails for a reason that is not the code, and the work has to get back on track.

Walked: `help check`, `help retry`, `help wait`, `help queue`, `capabilities`, `check-settings`, `metrics` and its report, the landing-summary source and the Needs you and queue-model sources. **Not walked:** a real failed landing.

## Steps today

| # | Moment | Agent sees | Person sees |
| --- | --- | --- | --- |
| 1 | The check fails | `FAILED CHECK_FAILED: …`, each failing file with its first error, then `Retry: COMMAND`. Exit 2. "Nothing landed." (source, ran: help) | Needs you: "Check failed" with **Open failing run**, **Repair in Lane** and **Hand to an agent**. Lane: "Not ready to accept: the check failed". (source) |
| 2 | Reading the output | `log '{"runId":"RUN_ID","tail":8192}'`. The full log stays with the CI provider; stderr names its link. Where the owner accepted public logs, every outcome adds a notice that anyone who can see the runner repository can read them. (ran) | **Open run**. While a check runs, the page says output appears when the check finishes. |
| 3 | Fixing | Fix in the same Lane, save, `land --save` again. `preflight '{"laneId":"…"}'` runs the affected tests locally first. "Never skip or weaken a test to pass." (ran: help) | The Lane row keeps the earlier result: "Check failed · fixed in a later Candidate (passed)". |
| 4 | A required preflight | `PREFLIGHT_REQUIRED` names the exact command after a failure or an exhausted budget; then replay the same landing. (ran: help) | n/a |
| 5 | The check could not run | A run that ends without a failing test (runner unavailable, cancelled, timeout) is started again, at most twice. (docs) | "Waiting for a machine. No check machine has picked this up yet. Not a failure of the code." or "The check could not run. Forge retries when capacity returns; the code was not judged." (source) |
| 6 | A flaky failure | After a terminal failure on unchanged source: a new attempt with `retry:true` and `reason:"flake"`, `"main-moved"`, `"infra"` or `"other"`. "A flaky retry that passed is listed under retry." (docs, ran: help) | No flaky-check surface found on the web. |
| 7 | A failure in a file the agent did not touch | "may be main's: check queue '{}' and status before changing it." (ran: help) | n/a |
| 8 | Main breaks after a fast landing | The main audit re-runs failing files once (a pass is recorded as a flake), then reverts the one proven culprit or opens a fix. (docs) | Needs you: "Reverted from main" or "Fix needed", with **Start a fix** ("Opens a sibling Lane from the reverted head with the failing tests, the diff and the undo command in its brief.") or "Close without a fix?". (source) |
| 9 | Nothing moves | After 15 minutes without progress a stall alert goes out; after 60 minutes the landing ends as `LANDING_STALLED`. (docs) | The alert, by the configured channel. |

## Findings

| Id | Severity | Finding | Evidence |
| --- | --- | --- | --- |
| J4-1 | S1 | **The receipt owns stall recovery.** Follow the exact repair command in the `LANDING_STALLED` receipt. Item c24edcb2 removed conflicting advice to start a new landing. | Item c24edcb2 |
| J4-2 | S2 | **The agent is asked to name the cause of a failure it cannot diagnose.** A retry takes `reason:"flake"`, `"main-moved"`, `"infra"` or `"other"`. Nothing in the failure reply says which applies. In the two-day report the waste table shows 0 attempts under `flake` and 13 under `check-failed`. | docs, ran |
| J4-3 | S2 | **"Is main broken right now?" has no single answer for an agent.** The help sends it to `queue` and `status`. The fact is in `check-settings` under `mainAudit` (`result`, `redSince`, `redMinutes`), which the help topic does not mention. | ran |
| J4-4 | S2 | **Half of recent landings needed a second agent or a second attempt.** Of 16 landings in one day: 6 first try, 1 after a retry, 1 after a recompose, 8 "after fixer". Recovery is the common path, not the exception, so its replies deserve the same care as the happy path. | ran |
| J4-5 | S2 | **No output while a check runs.** A person or agent waiting on a ten-minute check sees nothing until it ends. Open Issue 42b8bf0e covers live logs. | source |
| J4-6 | S2 | **Full logs live with the CI provider.** On a private project a teammate needs access to the runner repository to read them; on a public runner the logs are public, which the notice states on every outcome. | ran |
| J4-7 | S2 | **A person has no view of flaky checks.** Flake evidence and the weekly flaky list are operator documents. Nothing on the web says "this check failed and passed on retry 4 times this week". | docs, source |
| J4-10 | S3 | **A Lane's status opens with other people's old failures.** `status '{}'` in a new Lane began with three project-wide `needsFix` notices from four days earlier (receipt ids, 64-character heads, run ids), before anything about the Lane itself. | ran |
| J4-8 | S3 | **Six words for "the check did not judge the code".** "Waiting for a machine", "Check didn't run", "Not run", "Check outcome not recorded", "recovery pending" and "could not run" appear across the Lane and queue states. Each is accurate; together they read as six different situations. | source |
| J4-9 | S3 | **Recovery commands differ in name by path.** `Retry: …` after a check failure, `Continue recovery: …` after a conflict or a source failure, `waitCommand` while in progress, `next` in an error. An agent must follow four field names. | source |

## Dead ends

- A failure that is not the agent's (main is red) leaves the agent to investigate; the reply does not say "main is red since TIME, wait or tell the owner" (J4-3).

## Naming and tone

- The web says a failed check "comes back to you with the failing test, not a red wall" (landing page). The CLI delivers that: failing files and first errors come first.
- "the code was not judged" is a good, plain phrase the CLI could share; the CLI says "unknown is not red" only in docs.

## What each persona needs

- **Agent, not person:** the failing test and first error (present); whether the cause is its change, main or the machine; one field name for "do this next".
- **Person, not agent:** whether anything needs them. A failed check an agent is already fixing should not ask for attention; a reverted landing should. The Needs you kinds make this split.

## Decisions

- For a stalled landing, follow the exact repair command in its receipt; do not start another bare `land` (Item c24edcb2).
- Forge is to classify failures with rules checked against real incidents. If none matches, say the cause is unclassified. Agents do not choose the cause (Item 154f3399, Phase 8).

## Questions for the owner

- Do owners get a flaky-check view on the web, and does it sit with checks, with cost or in Now?
