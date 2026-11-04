# B1.5d: Forge vs GitHub on t3code, real-agent results

Date: 2026-11-04. Harness `0383f90d` (qualified 2026-11-04 00:09Z), product deploy `ead2f465`,
CLI `0383f90d`. Plan: [b15d-bench-plan.md](b15d-bench-plan.md), fixed before the first scored
cell. Every cell is listed below, void or not, including every measure where GitHub wins.

## What we compared

Ten real upstream changes to `pingdotgg/t3code` were landed on a fork of the repository by 1,
3, 5 and 10 coding agents at once (GPT `gpt-6.1-sol` through the Codex CLI, reasoning effort
high, identical prompts and sandbox). One arm landed through Forge. The other used Git + GitHub
pull requests with a merge queue. Both arms were checked for a green main.

Five tasks touch the same files on purpose. Three pairs conflict for real, in two clusters.
Correctness is graded after the run: each task's original upstream tests, hidden from the
agents, run on the final main.

## Headline

- **Time to main per task: Forge is 24-35% faster at every N.** By the plan's test (a
  difference is real only when the ranges over reps do not overlap), this holds at N = 1, 3
  and 10. **At N = 5 Forge won every rep on both time to main and wall time** (wall
  13%, 27% and 41% faster in reps 1-3). Its slowest rep is just above GitHub's fastest *other*
  rep (434 s against 421 s), so the plan's unpaired range test calls it "in this run".
- **Same task, same rep, N = 1 (20 pairs): Forge is 178 s faster per task**, with a 95%
  bootstrap interval of 166-213 s.
- **Wall time to all 10 landed:** Forge is faster for real at N = 1, by 26%. At N = 3, 5 and
  10 the ranges overlap. At N = 5 Forge won all three paired reps. **GitHub's median is lower at
  N = 10, and at N = 3 under the pre-registered count.** A few Forge tasks stuck in long
  conflict or overtake loops set the wall time. That loop is the Phase 6 work.
- **Correctness: no difference overall.** Strict medians per N and the strict total match.
  Single cells differ by one task either way (n5-r2: Forge 6, GitHub 7; n5-r3: 7 against 6).
  Lenient medians differ slightly at N = 3 and 5. The task that varies most, t26770, passes
  4/10 strict in both arms. Three tasks
  (t19456, t23938, t27514) never pass strict in either arm. These are model limits, not tool
  effects.
- **CI: Forge uses about a third of the minutes:** 331 billed minutes against 910, and 116
  jobs against 336, over 11 scored cells each.
- **Agents use fewer tokens on Forge.** Over 11 cells: 257M cached input tokens against 386M,
  0.97M output against 1.23M, and 3,982 turns against 5,912. Uncached input is about equal
  (8.5M against 8.2M).
- **Convex cost (Forge only): $0.86 for the 11 scored cells.** That is $0.03-0.04 per N = 1
  batch and $0.11-0.13 per N = 10 batch, about $0.01 per landing. Action compute is 42% of it.
  The whole bench, including dry runs and void attempts, cost $3.11 by the harness rate card.

## Results per N (pre-registered count)

Medians over reps, with the range in brackets. Time to main: each cell's median over its
landed, non-void tasks, then the median over cells. "Pooled" is the median over all such
tasks.

| N | Arm | Cells | Wall s | Landings/h | Time to main s (cell) | Pooled | Strict /10 | Lenient | CI min |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Forge | 3 | 4100 [3877-4797] | 9 [8-9] | 324 [285-329] | 324 | 6 [6-7] | 0.757 | 30 |
| 1 | GitHub | 3 | 5575 [5293-5993] | 6 [6-7] | 496 [470-535] | 496 | 6 [6-7] | 0.757 | 76 |
| 3 | Forge | 2 | 3054 [1676-4432] | 15 [8-21] | 386 [355-417] | 358 | 6.5 [6-7] | 0.760 | 38 |
| 3 | GitHub | 2 | 2322 [2142-2503] | 16 [14-17] | 597 [544-651] | 566 | 6.5 [6-7] | 0.757 | 79 |
| 5 | Forge | 3 | 1202 [1081-1630] | 30 [22-33] | 352 [316-434] | 380 | 6 [6-7] | 0.757 | 27 |
| 5 | GitHub | 3 | 1871 [1490-2027] | 19 [18-24] | 512 [421-566] | 508 | 6 [6-7] | 0.760 | 84 |
| 10 | Forge | 2 | 1198 [1082-1313] | 30 [27-33] | 350 [343-358] | 352 | 6.5 [6-7] | 0.760 | 26 |
| 10 | GitHub | 2 | 1045 [838-1251] | 36 [29-43] | 460 [433-486] | 469 | 6.5 [6-7] | 0.760 | 72 |

Do the ranges overlap (by the plan's test, overlap means the difference is "in this run")?

| N | Wall time | Time to main |
|---|---|---|
| 1 | no | no |
| 3 | yes | no |
| 5 | yes | yes |
| 10 | yes | no |

### Every cell

| Batch | Forge wall / strict / TTM / CI / Convex | GitHub wall / strict / TTM / CI |
|---|---|---|
| n10-r1 | 1313.4 / 7 / 343 / 27 / $0.131 | 837.9 / 7 / 433 / 64 |
| n5-r1 | 1630.4 / 6 / 352 / 27 / $0.096 | 1871.1 / 6 / 421 / 75 |
| n3-r1 a1 | void (network loss during grading) | void |
| n3-r1 a2 | void (start barrier; fork not clean at reset) | void |
| n1-r1 | 3877.1 / 7 / 324 / 30 / $0.031 | 5575.2 / 7 / 496 / 74 |
| n1-r2 | 4099.8 / 6 / 285 / 31 / $0.037 | 5292.6 / 6 / 470 / 76 |
| n3-r2 | 1676.0 / 6 / 355 / 30 / $0.086 | 2141.7 / 6 / 544 / 79 |
| n5-r2 | 1080.7 / 6 / 316 / 27 / $0.075 | 1490.1 / 7 / 566 / 85 |
| n10-r2 | 1081.7 / 6 / 358 / 25 / $0.111 | 1251.3 / 6 / 486 / 79 |
| n5-r3 | 1201.6 / 7 / 434 / 29 / $0.083 | 2027.3 / 6 / 512 / 84 |
| n3-r3 a1 | 4432.5 / 7 / 417 / 46 / $0.107 | 2502.5 / 7 / 651 / 78 |
| n1-r3 | 4797.0 / 6 / 329 / 29 / $0.035 | 5992.5 / 6 / 535 / 82 |
| n3-r3 a2 (extra, see Deviation) | 1503.7 / 6 / 349 / 30 / $0.064 | 2363.1 / 6 / 486 / 134 |

All 10 tasks landed in every scored cell of both arms.

Rep-3 decisions (`plan.mjs rep3Decision`, written before any rep-3 cell):

| N | Rep 3 | Reason |
|---|---|---|
| 10 | skipped | |
| 5 | ran | GitHub time to main 421 s against 566 s, more than 25% apart |
| 3 | ran | rep 1 had no valid batch |
| 1 | ran | GitHub tasks counted 8 against 6 |

The N = 5 and N = 1 triggers come from task voids (see below).

## Deviation: an extra N = 3 attempt (owner, 2026-11-04)

Rep 3 at N = 3, attempt 1, was much slower on Forge than any other N = 3 cell: 4432 s against
1676 s. The owner asked for an equal rerun to check whether it was a blip. `drive.mjs --only
n3-r3` ran attempt 2 with the same seed and task order. It was decided before its result was
known.

The plan says no batch is "added or repeated because of its result", so this is a deviation.
The pre-registered N = 3 numbers above exclude it. Including it:

| N = 3, with the extra attempt | Forge | GitHub |
|---|---|---|
| Wall time, s | 1676 [1504-4432] | 2363 [2142-2503] |
| Time to main, s | 355 [349-417] | 544 [486-651] |

Attempt 2 ran at Forge's normal pace (1504 s, against GitHub's 2363 s), so attempt 1 looks
like an outlier. It stays in the record either way. Its cause is a real product weakness under
contention (next section), not noise in the harness.

## Why Forge loses wall time: the landing loop under contention

**n3-r3 attempt 1 (4432 s).**
- t23938's `land --save` ran for 1555 s and ended `LANDING_STALLED`, then landed.
- t19456 took about 46 minutes: resolve, cancel, re-land, and many `docs` and `--help` calls
  while the agent tried to work out what state its landing was in.
- Forge's check CI was healthy throughout: runs of about 2.5 min, no queue. But there were
  gaps of 9-11 minutes between checks, which is time spent on the server between composes and
  re-checks after overtakes.
- At N = 3 only three workers run, so one stuck task holds up the queue behind it.

**t27456 on the hot preview files (n10-r1, n5-r1).** After `COMPOSITION_CONFLICT`:
- the agent landed again while conflict markers were still present (about 80 s wasted);
- it ran resolve from the wrong directory (`HOSTED_CHECKOUT_REQUIRED`);
- it was then overtaken during its check.

In n10-r1 this one task set Forge's wall time (1264 s, against 540 s on GitHub).

**Workspace prep is outside time to main but inside wall time.** Median per task: Forge
15.3 s, GitHub 4.5 s; p90: 33.8 s against 17.3 s. Forge's Lane `start` + `open` is slower
than a shared local clone.

These go to Phase 6 stage 6.2 (landing loop under contention): 36a087ea (conflict recovery),
1ef05eea (overtakes and CI bundling), d910db6b (no dead ends) and 11ba7bb9 (push events).

## Coordination (R3)

Method note: overlap notices have been delivered since d43863b7 (2026-10-30). Before that fix, the
overlap read checked only the 51 oldest of 125 active heads, so no notice was delivered that day.
Every scored cell ran on a build with the fix.

Notices across the scored Forge cells at N ≥ 3, before the extra attempt:

| Class | Notices | Useful (real conflict) | Noise | Acknowledged |
|---|---|---|---|---|
| Blocking | 45 | 13 | 31 (1 unknown) | 42 |
| Advisory | 21 | 0 | 21 | 1 |

- 22 real conflicts had no notice. All are in test files: `client.test.ts` for
  t23938/t27521/t27514, and `ServerBrowser.test.ts` for t19456/t23938.
- Gate cost: 1-4 overlap refusals per cell, costing 28-184 s of lost time per cell. That time
  is inside time to main.
- Landed-clean rate (no conflict, failed check or extra attempt) on the overlap classes:
  - Preview cluster: Forge 0.88/0.88/1.00 at N = 3/5/10; GitHub 0.67/0.57/0.50.
  - Codex pair: Forge 0.67/1.00/0.75; GitHub 0.50/0.60/0.67.
- Samples are small (three real pairs, two of them sharing t19456), so these are counts, not
  rates with intervals.
- Added minutes against the same task's N = 1 median are mostly 0-2 min in both arms. The tail
  is Forge 22-24 min at N = 3 (the n3-r3 a1 case) and GitHub up to 11 min at N = 10.

Phase 6 Issue ee9d5738 (owner-agreed) targets this. Blocking notices should fire only for real
collisions, advisory notices should earn their place or go, and test-file conflicts should be
caught. It replays this run's notices as fixtures.

## Would push have helped? (11ba7bb9, post-hoc)

For each notice with timing (71), "raised" is estimated as the later of the two tasks' first
save or land call. Forge can only know of an overlap once both changes have reached it.
"Delivered" is when the agent got the notice.

| | Notices | Median raised → delivered | Agent calls in between |
|---|---|---|---|
| Useful blocking | 14 | 20 s (max 151 s) | 1 (median) |
| Noise blocking | 34 | 22 s (max 1151 s) | |
| Advisory | 23 | 27 s (max 1578 s) | |

- Upper bound on time a push could have saved on useful notices: **8.5 minutes across the
  whole run**. 6 of the 14 useful notices were followed by rework (conflict episodes).
- **So pushing notices faster gains little on its own today.** Agents save only when they
  land, so Forge learns of the overlap late, and delivery is already within about 20 s of
  that.
- The bigger gains would come from learning of overlaps earlier (agent edits visible before
  landing) and from precision. Pushing today's notices would mostly push noise.
- This reshapes 11ba7bb9: earlier detection plus precision first, push delivery second.

## Task voids: the contamination audit (disclosed; bench finding d8cf81b4)

The pre-registered contamination audit voided 34 tasks in the registered cells: 26 GitHub,
8 Forge, from 53 hits. The extra N = 3 attempt adds 3 GitHub voids and 5 hits (37 voids, 58
hits in all). The lead read all 58. Every one is a false positive:

- **github-history-api (28 hits).** Agents read their own fork's merge rules or their own PR
  (`rules/branches/main`, `branches/main/protection`, own `pulls/<n>` and `issues/<n>/events`).
  The pattern matches `/branches` anywhere on the line.
- **bench-data (21 hits: 19 Forge, 2 GitHub).** The pattern matches `forge-bench`, which is in
  every workspace path. Agents read their own `nforge` CLI or the shared toolchain cache, or
  used their own workspace's absolute path. One GitHub agent searched the whole bench folder
  for a file name and found nothing.
- **upstream (6 hits).** Agents wrote "Closes https://github.com/pingdotgg/t3code/issues/<n>"
  or "Refs pingdotgg/t3code#<n>" into their own PR body, using the issue link from their task.
- **git-history-all (3 hits).** `git ls-remote` of the agent's own branch or merge-queue refs.

A scan of every tool call in the scored cells found no read of another cell's workspace, the
harness or the oracle.

The rule is pre-registered, so the official numbers above drop these tasks. All-tasks
sensitivity (cell time to main median, every landed task counted):

| N | Forge | GitHub |
|---|---|---|
| 1 | 348 [324-353] | 496 [478-535] |
| 3 | 556 [355-757] | 570 [489-651] |
| 5 | 362 [352-434] | 530 [492-542] |
| 10 | 371 [364-377] | 510 [487-533] |

N = 3 here uses the pre-registered count. With the extra attempt it is 355 [349-757] against
550 [489-651].

Forge's median is lower at every N under both counts. Under the all-tasks count one cell goes
the other way: n3-r3 attempt 1 (Forge 757 s, GitHub 651 s). The registered N = 3 gap is small
without the voids, and its ranges overlap. Read the 24-35% headline next to this table. The fix
(own-fork endpoints, own paths, mentions against reads) is for the next harness, with these 58
excerpts as tests.

## Cost

| | Forge | GitHub |
|---|---|---|
| Convex, scored cells | $0.86 (calls $0.09, DB I/O $0.21, egress $0.19, action compute $0.36) | n/a |
| Convex, whole bench (dry + void + extra) | $3.11 | n/a |
| CI billed minutes (11 cells) | 331 | 910 |
| CI jobs | 116 | 336 |
| Tokens: cached input / uncached input / output | 257M / 8.5M / 0.97M | 386M / 8.2M / 1.23M |
| Agent turns | 3,982 | 5,912 |
| GPT (owner's weekly window, both arms plus dry runs) | 24% used at the end of the run | (shared) |

Notes:
- Convex is about $0.01 per landing. At public scale that is the first Phase 6 cost target
  (9db58ca6, about 10x cheaper).
- The GitHub CI minutes ran on free public-repo runners. The comparison is the minutes
  themselves, which are paid on private repositories.

## Disclosures (everything that went wrong or differs)

**Attempts on 2026-11-03, before the qualified harness.**
- Real batches were aborted and archived:
  - the hosted `..forge-client` cache path (fixed in ead2f465);
  - a GitHub GraphQL 504 at reset in n5-r1 a1;
  - a runner image/action change in n5-r1 a2 (void).
- The owner stopped, fixed and restarted. Their cells are kept in `runs/` and are not scored.

**In-flight abandon.**
- In the 4e88eb4b run, a provider-capacity error killed an agent while its landing was in
  flight. The harness then abandoned the Lane.
- Fixed in 0383f90d: settle waits for in-flight landings, and a capacity error is a task
  void. Then the bench restarted from scratch.

**Harness and plan changes before the real run.**
- The sequential N = 10 runner fairness rule was changed to the same >50% exclusive-image
  rule (4e88eb4b, owner-approved). This happened after a dry run voided during a GitHub image
  rollout.
- Qualification used dry N = 3 a11 on 0383f90d, plus dry N = 10 a2 on the ead2f465 product.
  The owner chose not to repeat dry N = 10 when only bench code changed.

**Dry-run intervention.** In dry N = 3 a11, GitHub PR 294 never entered the merge queue,
although it was clean and green. The lead disabled and re-enabled auto-merge. This was a dry
run only, not scored. There was no intervention in any real cell.

**n3-r1 voids.**
- Attempt 1: the Mac lost internet during grading (about 02:35-02:42Z).
- Attempt 2: the harness crashed at reset because two leftover oracle branches from attempt 1
  were still on the fork (`BENCH_FORK_NOT_CLEAN`). The lead deleted those two harness-owned
  branches.
- Bench finding 02ee5788: the harness should clean them itself.

**Runner pools.** Mixed image versions within the 50% rule are listed in `summary.json`
(`runnerDisclosures`). No scored batch failed the rule.

**Mac-only test failure.** `PortScanner.test.ts` fails on the bench Mac and passes on runners.
Agents in both arms could see it fail locally. It was kept in scope.

**Workspace prep gap.** Forge prep is 15 s against GitHub's 4.5 s (median), inside wall time
and outside time to main, as above. Phase 6 Issues a245bcf0 and 766eced8 own it.

**Task swap (2026-11-01, before any scored cell).**
- Five no-contact tasks were replaced by five that really conflict, because the first set had
  no real conflict.
- The task file hash is frozen (`dc4346af…`).

**fseventsd.**
- On 2026-11-03 macOS `fseventsd` wedged and blocked landings (preflight watcher probes
  failed). It was restarted.
- No scored cell ran while it was wedged.

**Forge serialisation.** Generation-based ancestry cuts (48ba68ed, commit 3f3fbc11) were in
this build. Per-Lane local locking (69bcb285) did not qualify and was not. The overtake results
reflect that.

**Driver behaviour.** The driver's rep-3 logic reads "the last valid attempt". For N = 3 this
report counts attempts as stated above, not by that rule.

## What this means

1. **Agents land each change 24-35% faster through Forge**, with no overall correctness difference,
   a third of the CI minutes and fewer model tokens. This is real at N = 1, 3 and 10 by the
   plan's test, and held in every N = 5 rep.
2. **Whole-batch throughput is not yet a clear win at high contention.** A few tasks in
   conflict or overtake loops cost more than the per-task gain. Fixing conflict recovery,
   overtakes, dead ends and notice precision is the Phase 6 landing-loop stage. A repeat of
   this bench is part of Phase 6's exit.
3. **Convex cost per landing (about $0.01) must come down before public use** (9db58ca6).
