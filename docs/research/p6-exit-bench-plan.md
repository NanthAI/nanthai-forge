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

- **Claude through Claude Code in both arms** (owner 2026-11-07): `claude -p`, model
  `claude-sonnet-5-5`, the CLI's default effort (no `--effort` flag), recorded as
  `DESIGN.agent` and `config.agent` = `{provider: claude, model: claude-sonnet-5-5,
  effort: cli-default}`. The bench tests Forge against GitHub, not a model: B1.5d ran GPT
  (`gpt-6.1-sol`, effort high) through the Codex CLI, so the comparison with B1.5d is
  Forge's % lead over GitHub per N (see Pass/fail), not absolute agent timings.
- **Same as B1.5d in both arms:** the prompt text, 45 min per task, working directory (the
  workspace root), PATH (the Forge relay shim, then `/usr/local/bin`), the macOS file
  sandbox, network open, web search off.
- **Tools:** an allowlist (`--tools`), Claude's equivalents of Codex's shell, patch and plan
  tools: `Bash`, `Read`, `Edit`, `Write` and `TodoWrite`. Everything else is off: sub-agents,
  workflows, web fetch and search, monitors, schedules, worktrees, skills, tool search and
  MCP servers (`--strict-mcp-config` with no servers). A built-in a later CLI adds stays off.
  The tools the session reported at start are recorded per task (`claudeHome.init`).
- **Isolation:** each task runs in a fresh, empty `CLAUDE_CONFIG_DIR`: no owner settings
  (`--setting-sources ''`), global CLAUDE.md, memory (`CLAUDE_CODE_DISABLE_AUTO_MEMORY`),
  skills, plugins, slash commands or past sessions. The sandbox denies the owner's
  `~/.claude`, `~/.claude.json`, `~/.codex`, every other task's home and the folder that
  holds this and earlier bench folders. The login is the owner's long-lived Claude Code
  token (`claude setup-token`), kept at `BENCH_ROOT/secrets/claude-oauth-token` (mode 600,
  unreadable to agents) and handed to the CLI once on an inherited pipe
  (`CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR`); it is never in the agent's environment, and
  every other credential variable is removed. The session transcript is kept next to the
  task's files and the home deleted. The repository's own files (`AGENTS.md`, `.claude/`)
  load only as far as Claude Code loads them with no setting sources and slash commands off,
  identically in both arms.
- **Usage gate:** before every batch the driver waits until Claude's weekly usage is below
  85% and, while a 5h window is open, that window is at 40% or less (a window the plan does
  not report has no use to wait for). An unreadable reading refuses.
- **Tokens:** Claude's `modelUsage` over every turn and model of the session (input,
  cached-read and cache-write input, output), turns and model API seconds.

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

Trade-offs count only for security or another user-facing improvement, each named with its
cost.

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

## Cost

The estimate for the owner (Claude tokens and share of the weekly limit, CI minutes, Convex
dollars, wall time) is given on Issue 8c9b84fc before the first scored cell, from the
unscored smoke cells and B1.5d. CI runs on GitHub-hosted runners of a public repository (no
minutes billed). The driver stops when the Forge arm's Convex spend reaches its budget.

## Runbook (replaces B1.5d's)

1. `scripts/bench-t3code/setup --dry`, then `--live` with the flags its output names; the
   owner connects the bench project to the runner repository once
   (`nforge github connect`, printed by setup) and saves the Claude token file.
2. `node scripts/bench-t3code/pin.mjs <landed SHA>` → `BENCH_ROOT/harness/<sha12>`; run every
   command below from that checkout.
3. `node scripts/bench-t3code/preflight.mjs` → must print `GO`.
4. Dry run (no model, scripted agents): `node scripts/bench-t3code/drive.mjs --dry --only n3-r1`;
   then set `config.qualifiedHarness`.
5. `node scripts/bench-t3code/drive.mjs` (resumable: re-run the same command after any stop).
   Its `CELL` lines (START, WAIT, DONE, BATCH, REP3, OUTLIER, ALL DONE) are the lead's
   Monitor feed.
6. `node scripts/bench-t3code/summarize.mjs`.
