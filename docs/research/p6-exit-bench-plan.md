# Phase 6 exit bench: Forge vs GitHub on t3code, pre-registered plan

This plan is fixed before the first scored cell of the Phase 6 exit bench (Issue 8c9b84fc).
The driver (`drive.mjs`) follows it exactly and refuses to run when `BENCH_ROOT/PLAN.md`
differs from this file (`docs/research/p6-exit-bench-plan.md` on main) or when
`config.agent` differs from the agent below. Changing anything here means a new plan,
written down before any cell of it runs. Every cell is published, void or not, including
every measure on which GitHub wins.

It repeats B1.5d. **Everything in the frozen B1.5d plan
([b15d-bench-plan.md](b15d-bench-plan.md), as run) applies unchanged unless this plan says
otherwise**: the question, tasks and task set, cells and batches, concurrency, task order
and dispatch groups, the same conditions in both arms, versions, leak controls, measures,
correctness oracle, coordination counters, void rules, analysis and disclosed differences.
The sections below are the only changes.

## Agent (replaces B1.5d "Model and agent")

- **GPT through the Codex CLI in both arms** (owner 2026-11-09, cfe33f2c; replaces the
  2026-11-07 Claude Sonnet choice): `codex exec --json`, model `gpt-6.1-sol`, reasoning effort
  `high`, recorded as `DESIGN.agent` and `config.agent` = `{provider: codex, model: gpt-6.1-sol,
  effort: high}`. This is B1.5d's exact agent, so the comparison with B1.5d is like for like:
  absolute timings (seconds) as well as Forge's % lead over GitHub per N. The pass/fail lines
  below are unchanged; the report gives both readings.
- **CLI version:** Codex CLI 0.166.0 (B1.5d ran 0.164.0). It is recorded per cell and checked
  per batch like every version. All flags and disabled features the harness passes exist in
  0.166, and its rollout keeps the records the token and phase parsers read.
- **Same as B1.5d in both arms:** the prompt text, 45 min per task, working directory (the
  workspace root), PATH (the Forge relay shim, then `/usr/local/bin`; non-login shell), the
  macOS file sandbox, network open, web search off.
- **Tools:** Codex's shell, patch and plan tools. Sub-agents, web search, browser, computer use,
  apps, plugins, hooks, image generation, goals, memories, tool suggestions and skill search are
  disabled (`agent.mjs CODEX_DISABLED`); `--ignore-user-config` and `--ignore-rules` apply.
- **Isolation:** each task gets a fresh `CODEX_HOME` holding only a link to the owner's Codex
  login (`~/.codex/auth.json`, never read by the harness; a refreshed token is moved back): no
  owner config, global AGENTS.md, rules, skills, plugins, MCP servers or past sessions. The
  sandbox denies the owner's `~/.codex` (except that login file), `~/.claude`, `~/.claude.json`,
  every other task's home and the folder that holds this and earlier bench folders. The rollout
  is kept next to the task's files and the home deleted. The repository's own `AGENTS.md` and
  `.agents/` load as Codex loads them by default, identically in both arms. Claude Code
  (`claude-sonnet-5-5`) stays selectable (`config.agent.provider`) but is not this run's agent.
- **Usage gate:** before every batch the driver waits until the Codex weekly usage
  (`codex-usage`) is below 85% and, when a 5h window is reported, that window is at 40% or
  less. An unreadable reading refuses. A usage, rate or capacity stop voids that task.
  Amendment 2026-11-13 (owner, after the first three batches): the owner pays past the weekly
  limit with Codex credits, so `config.usageGate.weeklyStopPercent: null` lifts the weekly stop
  from batch 4 on; the 5h window and the unreadable-reading rule stay. Agent, model, effort and
  the measured path are unchanged.
- **Tokens:** totals over every model request of the session from the Codex rollout's thread
  total, cross-checked against `codex exec --json` turn totals: input, cached input, output,
  reasoning output and the request count. Codex input includes its cached part and output
  includes reasoning; the harness reports uncached input as input minus cached. Codex reports
  no model API time, so agent time is wall time per task. Rework tokens per landing (lines
  10-12) use the same per-request records (`phases.mjs`).

## Base (adds to B1.5d "Repository and tasks")

The base commit is `fa3b7349` (tree `69b02a96`), the B1.5d base, rebuilt exactly from its
recorded recipe (README "Recovering the B1.5d base"). Its objects came from upstream C's
public blobs and, through partial-clone fetches, the upstream fork network (parents
`2d1f007f`, `50edd7a7`, `df7f4325`). The Forge arm's project is a **GitHub import of the
bench fork at that commit** (born hosted, server authority), then a clone; B1.5d hosted the
full history with `nforge host`. Both arms start from the same tree, as before.

## N values, reps and the setup-only rule (unchanged, restated)

N = 1, 3, 5, 10; both arms; reps 1 and 2 always, rep 3 for an N only when the B1.5d rep-3
rule selects it (`plan.mjs rep3Decision`). The same seeds (`b15d-rerun-2026-11-01/n<N>/r<rep>`)
give the same task orders as B1.5d, so cells pair with B1.5d's too. A void batch is re-run
once, whole (`DESIGN.maxAttempts = 2`). A batch whose every cell crashed in setup before any
agent ran is not an attempt; it is re-run up to `DESIGN.maxSetupRetries = 2` times and
disclosed as setup-only in its `batch.json`.

## Separate bench deployment and versions

The bench uses its own Convex deployment, configured by `config.forge.url` and
`config.forge.deployment`, deployed deliberately from the pinned harness commit through
`config.forge.deployWorkflow` (`convex-bench-deploy.yml`). Setup and the meter target that
deployment. Builders keep landing and deploying dev independently; no dev queue or deploy
drain runs before a bench batch.

The measurement hold (`.freeze`) lives only in the bench's CLI installation
(`BENCH_ROOT/cli`), which refuses to share the builders' installation. The driver brings
that CLI to main at batch start and checks that its `convex/` matches the bench deployment.
The CLI stays held through grading. GitHub main moving is recorded, not a void; a change
to the bench deployment, CLI, harness, agent or check workflows still voids a scored batch.
Idle costs zero calls: the bench has no cron jobs or clients between runs. The shared
GitHub runner pool and local CPU load remain recorded by the existing samplers.

The runner action rule compares each job's set of SHAs per action repository. A job
using one repository at two refs in every job is not a change; differing sets still void.

## Outlier rule (new, 8c9b84fc)

- After the regular reps of an N (reps 1-2 and rep 3 where it ran), each **valid** cell is
  compared with the other valid reps of the same N and arm. A cell whose wall time to all
  landed (`wallSecondsToAllLanded`) is **more than 2x the median wall of those other reps**
  is an outlier (`DESIGN.outlierFactor = 2`, `plan.mjs outlierDecision`). A cell with no wall
  (not all 10 landed) is an outlier when the others have one. With no other valid wall there
  is no reference and no extra rep.
- Each outlier gets **exactly one extra batch**: the same N, rep, seed and task order, both
  arms, the same mode (`plan.mjs extraBatch`, key `n<N>-r<rep>x`). Both arms run so the
  extra cell has the same machine load as the original. Extra batches are never judged by
  the outlier rule again. They follow the B1.5d void and re-run rules like any batch.
- The decision is written once per N to `BENCH_ROOT/outlier-n<N>.json` before any extra
  batch runs, and the extra batches run after all regular reps, N descending.
- **Both cells are reported**: the outlier and its extra rep, each with its wall, the
  others' median and the reason.
- **Headline rule:** the headline per arm and N is the median (and range) over **all** valid
  reps, extra reps included (`summarize.mjs byArmN`). A sensitivity view without the extra
  reps is reported next to it (`withoutExtraReps`). A pass/fail line that holds in one view
  but not the other is reported as such, not as a pass.

## Contamination rule (fixed first, d8cf81b4)

B1.5d's leak audit applies, with the d8cf81b4 refinement already in `contamination.mjs`
(landed 2026-11-05, receipt in 6a7236df): these are **not** voids:

- reads of the agent's own fork through the API: its own PRs (and their issue events), its
  branch list, branch protection and rules, refs of named branches, and any write (creating
  its own PR or branch is no read of history);
- the agent's own workspace, its own CLI and tool paths under the bench root;
- issue-link mentions in text the agent writes (PR, issue and commit bodies, fields of an
  API write).

Everything else in the B1.5d leak list still voids the task. The 58 B1.5d audit hits are the
rule's test cases: each is re-classified offline from the retained B1.5d transcripts
(`scanTask`), and the replay is published with the results.

## Pass/fail: the owner exit bar (8c9b84fc, 2026-11-07, binding)

The bench passes only if every line holds; a line that fails is a Forge bug, fixed at the
root for every user (never bench-tuned), and the affected cells re-run. "Ranges do not
overlap" uses the per-cell medians over reps, as in B1.5d's analysis.

Against GitHub, in this run:

1. **Time to main per task:** Forge is faster at every N (1, 3, 5, 10), and the ranges do
   not overlap at N = 1, 3 and 10 (where B1.5d's did not).
2. **Wall time to all landed:** Forge is no slower at every N.
3. **Single landing (N = 1):** time to main and per-step latency within margin of error of
   GitHub, or better.
4. **Correctness:** strict and lenient scores equal to GitHub's or better.
5. **CI minutes and agent tokens** (cached input, output, turns) lower than GitHub's.

Against B1.5d ([b15d-report.md](b15d-report.md)), as Forge's % lead over GitHub per N:

6. Each B1.5d lead is kept within 10 points or improved: time to main 35 / 35 / 31 / 24%
   faster at N = 1 / 3 / 5 / 10; wall 26% faster at N = 1 and 36% at N = 5; CI minutes about
   a third of GitHub's (331 vs 910); cached input tokens 33% fewer, output 21% fewer, turns
   33% fewer.
7. The two B1.5d wall losses (32% slower at N = 3, 15% slower at N = 10) become wins.
8. Timings that do not depend on the model do not regress by more than 10% in absolute
   terms: CI minutes per cell (30 / 38 / 27 / 26 at N = 1 / 3 / 5 / 10), CI jobs (116 over
   11 cells), check wall per landing, queue-to-accept time and Convex $ per landing (about
   $0.01 or lower).
9. Every metric above is reported against both GitHub and B1.5d, in seconds as well as %,
   next to the B1.5d report: time to main, wall, workspace prep (B1.5d: Forge 15.3 s,
   GitHub 4.5 s median), per-step CLI latency, queue wait and notice delivery.

Coordination lines (owner 2026-11-08, binding), from the sections below:

10. **Rework tokens and turns per landing:** Forge lower than GitHub at every N (1, 3, 5, 10),
    on rework cached input, rework output and rework turns per landing.
11. **Convoy cell passes at N = 16** in the Forge arm: every landing's time to main is at most
    1.3 x the cell's median Lane check wall + 2 min.
12. **Order waits against independent entries = 0** in every Forge convoy cell.

The stacking A/B (offer against auto-stack) is reported, not judged: it chooses the default.

Trade-offs count only for security or another user-facing improvement, each named with its
cost.

## Rework tokens per landing (new, bf130503)

Every cell, both arms, is classified offline by `phases.mjs` (deterministic; no product calls).
Each model response (turn) of a task's session (`<task>.transcript.jsonl`: the Claude transcript
or the kept Codex rollout; else the `stream-json` output) gets one phase from the source commands it runs (`nforge`, `git`, `gh`)
and the results of the source commands before it:

- `coding`: before the first save, push, pull request or landing request;
- `landing`: from then to acceptance; the turn that sends a landing attempt is landing;
- `rework`: after a result that reports a conflict (`COMPOSITION_CONFLICT`, `WORK_CONFLICT`,
  conflict markers, `CONFLICT (`, `mergeStateStatus DIRTY`), `CHANNEL_CHANGED`,
  `CHECK_FAILED` or a failed run, a removal from the merge queue, a failed rebase or a
  rejected push, until the next landing attempt (Forge `land`/`finish`; GitHub `git push`
  or `gh pr merge`);
- `waiting`: a landing-phase turn whose only commands are status reads or polls (`status`,
  `wait`, `observe`, `queue`; `gh pr view|checks|status`, `gh run`, read-only `gh api`;
  `sleep`);
- `done`: after acceptance (a `LANDED` receipt, a merged pull request).

Help output, docs pages (`nforge docs`) and non-source commands (file reads, local tests) never
start rework; a timeline event or failed-run line shown again on a later read counts once. A
landing the agent cancels itself, or one that ended in a conflict, is not a failed check. A
relay-logged code of a command that keeps running (a Codex exec session the agent polls) counts
in the turn that reads the command's end, not the turn that started it: polls before then are
waiting. In the Forge arm the relay's
call log is joined to the session's `nforge` commands by order and verb, so structured error
codes count even when the agent printed only part of a receipt; the join coverage is reported
per task. Per cell (`result.rework`, `rework.mjs`): per landing, the median of rework cached
input, rework output, rework turns, waiting turns and rework episodes with a 95% bootstrap
interval (seed 1, 10,000 resamples); sums; and the mean per landing (cell sum / landings, so a
task that never landed still counts against its arm). Line 10 compares the mean per landing,
Forge minus GitHub, paired by rep (an extra rep is its own pair), with the
[perf-claims](../agents/perf-claims.md) interval; with fewer than 11 pairs it is an observation.
Re-syncs per task are counted from the same sessions; rechecks come from the Forge metrics
read the cell already makes (`forgeFallbacks`) and GitHub's merge-queue runs (`coordination`).

## Coordination cells (new, bf130503)

Run after the ten-task batches with `drive.mjs --coordination` (or `--only convoy-n16-r1`),
under the same holds, version guard, void and re-run rules. Tasks are generated from the base
checkout's workspace manifest (`cells.mjs`, `package.json` workspaces or
`pnpm-workspace.yaml`): N distinct packages chosen by the seed
`p6-coordination-2026-11-08/<kind>/n<N>`, the same for every arm and rep of that N, one task
per agent. Each task adds a new module and its unit test to its package and changes no existing
file there. All N workspaces are prepared first; the agents then start on one signal
(`result.startSignal`), so every task's time to main runs from the same moment. The cells
measure landing, so they are graded by scope (landed, changed paths inside the package plus the
hot file, the function present), not by hidden tests. Arms run one after the other (never 2N
agents at once), the first arm rotating with the rep.

- **Convoy:** N = 16, 8 and 4, reps 1 and 2, arms GitHub and Forge. Different packages and new
  files only, so every pair of entries is independent. Pass (line 11): every task landed and
  each time to main <= 1.3 x the median Lane check wall + 120 s. The Lane check wall is the
  landed submission's check (`checkReservedAt` to `ciEndedAt`) in Forge and the pull
  request's last passing `pull_request` run in GitHub. Line 12: the relay records every order
  wait an agent was shown (`orderWaits`, from the receipt's `orderWait`) and the submissions a
  call names as its own; a wait behind another task's submission is a wait against an
  independent entry, and a wait the cell cannot attribute counts against the pass too.
  Receipts do not yet record order waits (D1, Issue c6b81429); until they do, a wait the agent
  never read is not seen, and the post-check hold (`ciEndedAt` to `committedAt`) is reported
  next to it.
- **Overlap:** N = 8 and 4, reps 1 and 2, arms GitHub, Forge with the stacking offer and Forge
  with auto-stack. Each task also adds one line at the end of one shared hot file
  (`README.md` at the repository root), so every pair edits the same lines. Reported: rework
  tokens, turns and conflict repairs per landing, each Forge arm against GitHub, and auto
  against offer (the stacking A/B; it picks the default). The Forge arms set the project's
  stacking setting before the cell, outside its timing, with the CLI action and body in
  `config.forge.stacking.offer` / `.auto` (or `{"default": true}` for the mode the project
  already has); a cell without them stops (`BENCH_STACK_SETTING_MISSING`). The auto-stack
  setting comes with D2 (Issue 1eb42254); until it lands only the GitHub and offer arms can run.

## Convex per-function attribution (moved here from the B1.5d plan copy)

The same result also retains `convex.perFunction`, grouped by provider function
identifier and type: executions, cached executions, failures, DB read/write and
egress bytes, action GB-hours/GB-seconds, missing fields and the same dollar
components. Its components sum to the project meter, using the same request-tree
attribution, retry counting and transport replay exclusion. Cached invocations
remain in the existing execution estimate and are identified separately for
provider-bill reconciliation. Unknown identifiers have an explicit bucket;
missing usage stays null per function. These are usage-based estimates, not bills.
The extra counters consume local memory only, bounded by the existing retained
execution capacity; they add no provider pull, Convex call or database work.

## Weaker-model arm (new, 7e2f5efe)

Our evidence comes from frontier models; end users may run weaker ones. This arm asks whether
cheaper models can use Forge's core loop unaided. It is **reported, not gated**: it adds no
pass/fail line to the owner exit bar and does not change any cell above.

- **Kit:** the w30 trial kit kept with the bench folder: five scripted tasks on a small
  synthetic repository (no dependencies, a style check as the landing check) that a model gets
  with only the `forge-agent` skill and `nforge agent --help`: start a Lane, edit, save and land;
  resolve a conflict another Lane caused; fix a failing check; submit a landing without blocking
  and wait for it; answer an overlap notice. Each model run imports a fresh dev project from the
  repository (no state shared between models), with the check on a GitHub-hosted runner and
  auto-accept on pass, and the project is deleted afterwards.
- **Models:** Claude Haiku 5.5 (`claude -p --model claude-haiku-5-5`), one small non-Claude model
  through Pi on an existing subscription (a small open model installed locally replaces it when
  one exists), and Claude Sonnet 5.5 once as the control. Run once per exit-bench pass, after the
  scored batches and with the machine otherwise idle, never during a batch hold.
- **Recorded per task:** success on accepted main (the function or file is on main and the
  reported receipt id is real), turns, tool calls, wall time, and every error code the model met.
  The report lists every message or next step a model misread or ignored, with the text it saw.
- **Flag, do not gate:** a task a cheaper model fails, or one that takes it three times the
  control's turns, is filed as an Issue with the transcript. The GitHub arm is not run for these
  models (the question is whether Forge's own surface is usable, not Forge against GitHub).
- **Baseline (2026-11-09, before the exit bench):** 20 of 20 task runs landed correctly:
  Sonnet 5.5 5/5 (56 turns), Haiku 5.5 5/5 twice (94 and 95 turns), Gemini 3.8 Flash through Pi
  5/5 (185 turns). The dominant cost of a weaker model was detours (project-folder commands,
  exploring other Lanes), not failures.

## Cost

The estimate for the owner (GPT tokens and share of the Codex weekly limit, CI minutes, Convex
dollars, wall time) is given on Issue 8c9b84fc before the first scored cell, from the
unscored smoke cells and B1.5d. CI runs on GitHub-hosted runners of a public repository (no
minutes billed). The driver stops when the Forge arm's Convex spend reaches its budget.

## Runbook (replaces B1.5d's)

1. `scripts/bench-t3code/setup --dry`, then `--live` with the flags its output names; the
   owner connects the bench project to the runner repository once
   (`nforge github connect`, printed by setup). The Codex agent uses the owner's Codex login
   (`~/.codex/auth.json`); only a Claude agent needs the Claude token file.
2. `node scripts/bench-t3code/pin.mjs <landed SHA>` → `BENCH_ROOT/harness/<sha12>`; run every
   command below from that checkout.
3. `node scripts/bench-t3code/preflight.mjs` → must print `GO`.
4. Dry run (no model, scripted agents): `node scripts/bench-t3code/drive.mjs --dry --only n3-r1`;
   then set `config.qualifiedHarness`.
5. `node scripts/bench-t3code/run.mjs`: plan check → preflight (stop on NO-GO) → scored
   `drive.mjs` → `drive.mjs --coordination` → summarize to `BENCH_ROOT/summary.json`.
   Resumable: re-run the same command after any stop. It never invokes setup or teardown.
   The existing drivers retain scheduling, holds, retries, rep-3 and outlier decisions.
   Their `CELL` lines stream to the terminal. In a second terminal pointed at the same
   `BENCH_ROOT` and pinned checkout, `node scripts/bench-t3code/progress.mjs` reads a finite
   local snapshot (per arm/N counts, current cells, waits, voids/failures and ETA).
   [Run the bench](../../evals/bench-t3code/README.md#run-the-bench) gives the exact commands,
   stop/resume behavior and result paths. This runbook consolidation changes no registered
   cells or scoring rules.
6. `node scripts/bench-t3code/rework.mjs RUN_DIR...` re-reads retained cells offline;
   the summary's `rework` holds lines 10-12 and the stacking A/B.

## Deviation log

Plan changes after registration. Each was made before the first scored cell; no scored result
existed when it was decided.

- 2026-11-09, owner decision cfe33f2c (Issue 8c9b84fc): the agent of both arms becomes GPT
  `gpt-6.1-sol`, effort high, through the Codex CLI (B1.5d's exact agent; CLI 0.166.0 against
  B1.5d's 0.164.0), replacing the 2026-11-07 Claude Sonnet choice. No scored cell was valid when
  it was decided. Section "Agent"; the B1.5d comparison becomes absolute as well as % lead.
- 2026-11-10, Issue 7e2f5efe: a reported, ungated weaker-model arm (section "Weaker-model arm").
  No scored cell exists yet; it changes no cell, measure or pass/fail line above.
