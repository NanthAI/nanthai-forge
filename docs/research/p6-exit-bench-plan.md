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

## Quiet rule and deploys (lead 2026-11-09, before the first scored cell)

This replaces two sentences of B1.5d's "Versions" section: "A batch does not start while
nanthai-forge has any workflow queued or running" and "Any difference between a batch's start
and end (a landing, a deploy, a CLI swap) voids the batch". Builders keep landing while the bench
runs; the bench project has its own queue, and dogfood checks run on another repository.

- **Batch start:** under the hold, a batch starts once no Convex deploy run
  (`config.forge.deployWorkflow`, Deploy dev Convex) is queued or running on nanthai-forge. The
  dogfood landing queue, Verify Forge and forge-check runs are not waited for. The 45 min drain
  timeout stays: a deploy still in flight then releases the hold and retries. The driver still
  brings the held CLI to main first, and the start record must still have the CLI at main and the
  deployed `convex/` equal to the CLI commit's.
- **Batch start, queued landing-path landings (lead acdbee8b, after batch n10-r1 a1 voided):**
  the hold keeps out only new submissions. A landing already queued at the start still lands
  during the batch, and its deploy follows. So a batch also waits while any queued or checking
  nanthai-forge landing changes `convex/` files on the landing path (the off-path list below; a
  landing whose changed paths cannot be read counts). The driver reads the queue once, then each
  submission's changed paths once (`drain.mjs landingPathQueue`). It checks before taking the hold
  and again under it. Landings that change only `src/`, `tests/`, docs or off-path `convex/` files
  do not block. What each start waited on is recorded in `batch.json startWaits`, and the summary
  lists it per batch.
- **During a batch:** the CLI stays held by `.freeze`, as before. GitHub main and the deploy head
  moving are **recorded, not voids** (`versions.moved`), with every deploy run that overlapped the
  batch and each cell (`deploys`: id, head, start, end, status). A change in **`forge-check.yml`**
  (the Forge arm's check) still voids the cell and its batch.
- **Landing path (amended 2026-11-09 after the dry on 5b707970, comment 8f8e049a):** when the
  **deployed `convex/` tree** changes during a cell or batch, the harness lists the changed files
  between the start and end deploy heads (one GitHub compare call) and records them
  (`versions.convexFiles`). The change voids the cell and its batch when any changed `convex/` file
  is **on the landing path**, that is, not under one of these off-path prefixes
  (`versions.mjs OFF_LANDING_PATH`): `convex/gitServe`, `convex/projectGithubImport`,
  `convex/projectGithubInbound`, `convex/projectPeople`, `convex/projectPurge`,
  `convex/projectR2Purge`, `convex/projectR2Sweep`,
  `convex/projectArchive`, `convex/projectBackup`, `convex/projectLegacy`, `convex/legacy`,
  `convex/archive`, `convex/backup`, `convex/account`, `convex/abuse`, `convex/sharing`,
  `convex/team`. It also voids when the list cannot be read or classified (void when unsure).
  Everything else is on the path, including `schema.ts`, `projectHistory*`, `projectHosted*`,
  `projectWork*`, `projectCheck*`, `projectLanding*`, `projectFinish*`, and `projectBoard*` and
  `projectBriefing*` (Forge-arm agents read board notices, claims and the start briefing during a
  cell; lead c75ed83f). A change that touches only off-path files is recorded, not a void. The
  bench report lists every deploy recorded during a scored cell that did not void it, with its
  changed `convex/` files (`summarize.mjs recordedDeploys`), so a reader can check the call. A cell inside a batch checks this against the
  batch's start record instead of requiring the CLI to equal main, or the deployed `convex/` to
  equal the CLI's, at its own start.
- **Runner actions (clarification, same comment):** "the resolved SHA for the same action
  repository changes within that arm" compares each job's set of SHAs per action repository. A
  job that uses one repository at two refs (a pinned SHA and a tag) in every job is not a change;
  jobs whose sets disagree still void.
- If more than 1 in 4 cells are voided this way, the lead names landing windows instead.

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
Each model response (turn) of a task's session (`<task>.transcript.jsonl`, else the
`stream-json` output) gets one phase from the source commands it runs (`nforge`, `git`, `gh`)
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
6. `node scripts/bench-t3code/drive.mjs --coordination` (resumable like step 5): the convoy and
   overlap cells.
7. `node scripts/bench-t3code/summarize.mjs`: `rework` holds lines 10-12 and the stacking A/B.
   `node scripts/bench-t3code/rework.mjs RUN_DIR...` re-reads retained cells offline.

## Deviation log

Plan changes after registration. Each was made before the first scored cell; no scored result
existed when it was decided.

- 2026-11-09, lead 8eab6c1c (Issue 8c9b84fc): the quiet rule. A batch start waits only for a
  Convex deploy in flight; GitHub main and the deploy head moving during a batch are recorded,
  not voids. Section "Quiet rule and deploys".
- 2026-11-09, comment 8f8e049a, approved by the lead in c75ed83f: a deployed `convex/` change
  voids only when a changed file is on the landing path (off-path list, void when unsure). The
  runner rule compares each job's SHA set per action repository. The lead removed
  `convex/projectBoard` and `convex/projectBriefing` from the proposed off-path list, and asked
  that the report list every recorded, non-voiding deploy with its files. Prompted by the dry
  run on harness 5b707970, which voided on an off-path deploy and on one action at two refs.
- 2026-11-09, lead acdbee8b on cf376b87 (amends 8eab6c1c): the batch start also waits while a
  queued or checking dogfood landing changes landing-path `convex/` files, checked before and
  under the hold, and the batch record logs what the start waited on. Prompted by scored batch
  n10-r1 a1: a landing queued before its hold landed during it, and its deploy (42625208565,
  `convex/projectHostedActionsVerdict.ts`) voided both cells. Those two cells are reported as
  "voided, start-gate gap, fixed by" this change's receipt. They do not count toward the 1-in-4
  void line.
