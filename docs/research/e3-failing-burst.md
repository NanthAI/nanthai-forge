# E3: a failing change in a burst of four, Forge against a tuned GitHub merge queue (historical)

Status: **historical experiment, 2026-10-24, and an unfavourable one for Forge.** This page carries the full method and denominators behind the E3 summary in [why-forge](../why-forge.md). No later re-run is recorded; the re-run is tracked with the gate-time measurement in [gate-parity](../operations/gate-parity.md) (G8). E3 ran on local, pre-hosted Forge with an earlier landing loop and is **not** the final comparison: the final result is the real-agent [B1.5d report](b15d-report.md) (2026-11-04), which also reports where GitHub wins. Raw samples, run records and the harness are retained privately.

## Result in one paragraph

With one of four burst changes deliberately failing a test, **the tuned GitHub merge queue put the 3 good changes on `main` in a median 189 s (183, 189, 194 s; n = 3). Forge took a median 989 s (675, 989, 1,150 s; n = 3 valid).** GitHub was about 5.2× faster. The bad change never landed on either side and `main` was never red on either side. Forge used fewer check jobs (20 to 25 against 48 to 54) and a similar number of billed runner minutes (61 to 76 against 49 to 57). Forge needed two extra attempts to get three valid runs: one was a replay-harness defect, the other a Forge wedge in which nothing landed for 52 minutes. One valid Forge run made all three good agents re-submit after their finish came back `interrupted`. The success bar ("Forge still lands the 3 good changes faster than the tuned merge queue and never lands the bad one") was **not met on speed** and **met on never landing the bad change**.

## Method

**Common setup.**

- **Seed.** One parentless commit of the public repository's `main` tree at a named commit (2026-10-24), from a fresh read-only clone. Both sides start from the same tree. The live project was not used.
- **Runner.** Both sides used the same 4-vCPU Ubuntu runner label of a paid third-party runner service, with 4 test shards plus 1 static job, and Node 24.22.1 on the runner. That service trial has since ended; dollar figures below are history.
- **Changes.** The earlier P2 burst-4 `code` changes. Member *i* adds one source file and one test file. One member per run is bad: its test asserts a token with a deliberate-failure suffix, so it compiles and passes static checks but fails its test. The bad member rotated by run (0, 1, 2).
- **Release.** All four changes are prepared, then released at one barrier, as in P2.
- **Primary metric.** Time from release to the last good change on `main`, **read from the system of record**: the main Channel move `acceptedAt` on Forge, the PR `merged_at` on GitHub. Harness-observed times (finish return, harness poll) are listed too and agree within 1 to 7 s except where noted.
- **Bad change landed?** Forge: the bad token was searched for in `main` and every ancestor State of `main` (which would catch an optimistic land followed by a revert). GitHub: the bad PR's `merged` flag plus the token on `main`.
- **Red `main`.** Forge: the accepted head equals the checked head and that check passed. GitHub: every `push` run on `main` inside the burst window succeeded.
- **Cost.** Every workflow run in each side's repository, summed from the jobs API. Billed minutes are each job rounded up to a whole minute; dollars use the runner service's 4-vCPU list price of $0.008 per minute.
- **Machine.** One laptop (10 cores, 16 GiB), shared with other work. Its 1-minute load average was 26, 26, 50 and 42 during runs F1, G1, F2a and F2b, and 10, 10, 13, 13 for F2c, G2, F3, G3 (P2 ran at 2 to 3). High load mainly slows Forge's local compose and export, not GitHub's.

**Forge settings.** CLI 0.3.0 on pinned runtime "d57"; a fresh throwaway owner imported from the seed (F2c and F3 used a second fresh owner because the first wedged); `verify` defined as the repository's check script; the trusted preset with checks on GitHub Actions, 4 shards, scoped checks enabled. Each change runs `agent start`, the edit and `agent finish {accept:true}`; "waiting to land" is replayed until there is a terminal result.

**GitHub merge queue (settings read back from the stored ruleset).**

| Parameter | Value | Why |
| --- | --- | --- |
| Grouping strategy | `HEADGREEN` ("only merge non-failing pull requests" off) | A group merges as soon as its head entry passes. |
| Build concurrency (`max_entries_to_build`) | 10 | All entries build at once. |
| Maximum group size (`max_entries_to_merge`) | 10 | All passing entries merge together. |
| Minimum group size / wait | 1 / 0 minutes | Never wait for more entries (a larger minimum can only add waiting). |
| Merge method | `SQUASH` | As in P2. |
| Check response timeout | 60 minutes | As in P2. |
| Required status check | `bench-required`, strict off | As in P2. |

Auto-merge was allowed on the repository. GitHub builds one cumulative `merge_group` per entry, so no setting collapses entries into a single build, and it refuses to enqueue a PR whose own required check failed. Tuning differs from P2's ruleset only in `HEADGREEN` and the 10/10 limits (P2 used `ALLGREEN` with 5/5).

**Harness.** Derived from the P1c/P2 landing-bench harness. The burst logic, polling, workflow and Forge setup match P2; the additions are the failing member, the tuned ruleset, the bad-change audits, window cost collection and agent-style re-submission (a good change that comes back non-accepted is re-submitted and counted as an agent retry).

## Per-run results

Seconds from release; "record" means the system-of-record landing time.

| Run | Bad member (Forge batch position) | 3 good on `main` (record) | Harness-observed | Bad change landed | Red `main` | Agent-visible retries or errors | Workflow runs | Check jobs | Billed min | Valid |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **Forge F1** | 0 (3rd of 4) | **1,150.3** | 1,155.7 | no | 0 | 0 | 5 | 25 | 76 | yes |
| Forge F2a | 1 | (1,289.1) | n/a | no | n/a | 3 × `LANDING_ALREADY_SUBMITTED` | 5 | 25 | 74 | **VOID** |
| Forge F2b | 1 | none in 52 min | n/a | no | n/a | n/a | 2 (+2 stuck) | 10 | 28 | **VOID** |
| **Forge F2c** | 1 (4th of 4) | **675.2** | 678.7 | no | 0 | 0 | 4 | 20 | 61 | yes |
| **Forge F3** | 2 (1st or 2nd) | **988.5** | 995.8 | no | 0 | 3 × `interrupted`, re-submitted | 4 | 20 | 63 | yes |
| **GitHub G1** | 0 | **189.4** | 191.7 | no | 0 (2 push runs ok)¹ | 0 | 9 | 54 | 57 | yes |
| **GitHub G2** | 1 | **194.4** | 195.9 | no | 0 | 0 | 9 | 54 | 57 | yes |
| **GitHub G3** | 2 | **183.4** | n/a² | no | 0 | 0 | 8 | 48 | 49 | yes² |

¹ The first harness version waited for a push run per merge commit. Two PRs merged in one push, so that wait timed out and recorded `null`. Checked afterwards: both push runs on `main` in the window succeeded. The harness was patched to judge every push run in the window.
² The burst completed normally, then a GitHub API HTTP 502 hit the harness's cost step and it dropped its in-memory sample. Reconstructed from GitHub records: the three good PRs share one `merged_at`; the bad PR's check failed, it was never enqueued and was closed unmerged; `main` has no bad token; the single push run succeeded; costs come from the jobs API. Per-change harness times are not available.

**Medians (valid runs, n = 3 each).**

| | Forge | GitHub (tuned queue) |
| --- | --- | --- |
| 3 good changes on `main` (record) | **988.5 s** (675.2 to 1,150.3) | **189.4 s** (183.4 to 194.4) |
| Landings per hour (3 ÷ time) | 10.9 | 57.0 |
| Bad change landed | 0 of 3 | 0 of 3 |
| Red `main` | 0 | 0 |
| Check jobs per burst | 20 | 54 |
| Workflow runs per burst | 4 | 9 |
| Billed runner minutes per burst | 63 | 57 (43 to 45 without post-merge push runs) |
| Agent-visible retries | 0 (one run had 3) | 0 |

How long the bad change took to resolve: on GitHub its PR check failed at about 81 to 84 s and it never entered the queue. On Forge the bad agent's `finish` returned at 1,155 s (F1, `failed`), 679 s (F2c, `failed`) and 702 s (F3, `interrupted`, so no culprit was named).

**Comparison with earlier results (unchanged).** P1c burst-4 with all changes passing: 297 s against 702 s (2.36×). P2 burst-4: 310 s against 678 s (2.2×, GitHub n = 2). E3 with one failing change: 989 s against 189 s (GitHub 5.2× faster). Two caveats. E3 had no default-settings GitHub arm, and P2's GitHub check durations are gone, so GitHub's change from 678 to 189 s cannot be attributed to tuning alone (the seed, runner Node version and queue settings all differ). And Forge's own time went from 310 s with no failure to 989 s with one.

## Why Forge was slower (from the run records)

- **Serial check rounds.** Forge needed 2 rounds when the bad change was last in batch order (F2c: batch fails, then all proper prefixes in one parallel round) and 3 otherwise (F1: batch, prefixes, then a re-check of the change after the bad one; F3: batch, prefixes interrupted, then a fresh batch after the agents re-submitted). GitHub caught the bad change in its own PR check, in parallel with the good PRs, and never queued it.
- **Wider test selection on Forge.** Every Forge landing check ran Forge's scoped selection, which came to **325 to 328 test files**; GitHub's workflow used the same impact script and ran **46 to 47 files** for the same kind of change. Forge workflow rounds took 209 to 351 s; GitHub PR runs took 63 to 81 s. P2 labelled its GitHub step "same selection as Forge", which was not true here and may not have been in P2. The root cause was not found: the changed-path list was clean, so the difference lies in how Forge's local planner builds its file set or import graph. **This confound works against Forge.**
- **Per-round overhead.** Exporting and pushing the candidate to the check repository, plus dispatch, cost 60 to 145 s per round. Non-check overhead was 368, 207 and 209 s in F1, F2c and F3.
- **Sensitivity check.** If every Forge round had run as fast as a GitHub PR check (about 80 s), F1, F2c and F3 would come to 608, 367 and 449 s (median about 449 s) and GitHub would still be about 2.4× faster. The verdict does not depend on the selection confound.

## Voided runs (kept)

- **F2a, void (agent path, harness defect).** The P2 harness replayed "waiting to land" as a new finish request; Forge's receipt says to replay with `{operationId}`. While the batch was in diagnosis, Forge rejected the three good agents' replays with `LANDING_ALREADY_SUBMITTED` at about 1,258 s. It then landed all three about 31 s later in one `main` move (1,289.1 s) and the bad change was never on `main` or in its history, so nothing was lost, but each good agent got an error instead of its acceptance. The harness was changed to use the documented replay. Run 1 had not hit this path, and P2 never did because no change failed.
- **F2b, void (Forge wedge).** Same owner, straight after F2a. The batch check failed, and one prefix check failed. After that Forge **dispatched nothing for more than 40 minutes**, and 0 of 3 good changes landed in 52 minutes. Two post-accept main-audit re-runs of a head that an earlier audit had already passed sat in `running`; one had pushed its check ref but never dispatched a workflow, the other never pushed. The operator stopped the harness at its 45-minute limit, and F2c and F3 ran on a fresh owner. This matches the orphaned-check and duplicate-audit patterns found in the review's evidence audit.
- GitHub run 1 kept its data and was not re-run after the harness patch; run 3 is counted as valid and reconstructed (footnote 2).
- A setup artifact outside all windows: the GitHub repository's first push run (the seed commit) failed because its scoped diff errored and the unscoped suite ran in a bare environment. It cost 17 billed minutes, included in the total below.

## Other agent-visible observations

- F1: the two changes in the passing prefix were on `main` at 817.8 s, but their `finish` calls did not return until 1,155 s, when the remainder landed, so an agent waited about 5.5 minutes longer than it needed to.
- F3: all four finishes returned terminal `interrupted` (the prefix run was interrupted before dispatch). The bad change's agent was never told it was the culprit, and each of the 3 good agents had to re-submit.
- Forge also ran full post-landing `main` audits (481 to 482 tests, 18 billed minutes each) on the first owner: 2 ran and 2 duplicates got stuck. On the second owner the post-accept worker ran for 34 minutes without recording or dispatching an audit. Audit minutes are **not** in the per-burst figures above (GitHub's post-merge push runs, 6 to 13 minutes, are).
- The bench owner's presence worker ignored SIGTERM at cleanup and needed SIGKILL.

## Cost

| Repository | Workflow runs | Billed min | Job min |
| --- | --- | --- | --- |
| Forge check repository | 22 (including 2 audits and the voided attempts) | 338 | 299.3 |
| GitHub queue repository | 27 (including the seed push) | 180 | 94.4 |
| **Total** | 49 | **518** | 393.7 |

About **$4.14 at the service's list price** (history, not a current price; it may have been lower under a free tier). The throwaway repositories were deleted after the run and the local owners stayed on disk as evidence; no hosted compute or Convex use.

## Limits

n = 3 per side, one day, one seed. The bad change's batch position decides how many rounds Forge needs; the positions observed were 3rd, 4th and 1st or 2nd. The disjoint changes and the single standalone failure match the experiment spec; an interaction failure (two changes that pass alone but fail together) was not tested. Machine load was high for F1 and G1. The harness changed between samples (red-`main` check, replay form, fresh owner, wedge detection); each change is disclosed above. The test-selection gap works against Forge and is unexplained. Nothing here measures coding time, tokens, or coordination quality.
