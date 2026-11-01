# B1.5d Forge vs GitHub on t3code: pre-registered plan

This plan is fixed before the first scored cell. The driver (`drive.mjs`) follows it exactly
and refuses to run when `BENCH_ROOT/PLAN.md` differs from this file
(`docs/research/b15d-bench-plan.md` on main). Changing anything below
means a new plan, written down before any cell of it runs. Every cell is published, void or
not, including every measure on which GitHub wins.

## Question

How do Forge and Git + GitHub (pull requests and a merge queue) compare when 1, 3, 5 and 10
coding agents land the same 10 real changes on someone else's repository: time to main,
landings per hour, correctness, cost, and how each handles agents touching the same code?

## Design

- **Repository and tasks.** `pingdotgg/t3code` at `52f4ec6f` plus `.bench/ci.sh`; the 10 tasks
  are 10 later upstream PRs (title and description only), frozen in `tasks.json`
  (sha256 `b973140041a2…f4c403`). The table below is the task list for every cell.
- **Cells and batches.** N = 1, 3, 5, 10 agents; both arms. One cell = N concurrent workers
  of one arm taking the 10 tasks from one queue until it is empty. One **batch** = the Forge
  cell and the GitHub cell of one (N, rep).
- **Concurrency (owner, 2026-11-01).** Never more than 10 agents run at once across both arms.
  At N = 1, 3 and 5 the two cells of a batch run **at the same time** (2, 6 and 10 agents), so
  both arms share the same machine load, runner pool and time of day. At N = 10 the cells run
  one after the other; the first arm alternates between reps (rep 1 GitHub, rep 2 Forge, rep 3
  GitHub).
- **Task order.** Shuffled per cell with a recorded seed `b15d-rerun-2026-11-01/n<N>/r<rep>`
  (sha256 → mulberry32 → Fisher-Yates). Both arms of one (N, rep) use the same seed, so they
  get the same order (a paired comparison). The one same-file pair (t27514, t27521) is shuffled
  as one unit with a random inner order: they are dispatched back to back, so at N ≥ 2 they normally run at the same time (the record shows whether they did).
- **Reps (adaptive, pre-registered).** Rep 1 (N = 1, 3, 5, 10), then rep 2. Rep 3 runs for an N
  only when its reps 1 and 2 are "too different", decided by `plan.mjs rep3Decision` from the
  three primary metrics of each valid cell: **time to main** (median over the cell's landed
  tasks), **tasks landed**, and **strict score**. Too different means either:
  - the Forge-vs-GitHub winner **flips** on a primary metric: one rep has Forge strictly
    better and the other GitHub strictly better (a tie is not a win); or
  - a primary metric of either arm differs by **more than 25%** between the two reps:
    |a − b| / min(a, b) > 0.25 (any change from 0 counts; exactly 25% does not).
  An N whose rep 1 or rep 2 still has no valid batch after its re-run also gets rep 3. The
  decision is written once to `BENCH_ROOT/rep3-n<N>.json` before any rep-3 cell runs.
- **Batch order (owner, 2026-11-01).** Rep 1 runs N **descending** (10, 5, 3, 1), rep 2
  **ascending** (1, 3, 5, 10), and rep 3, where the rule selects it, descending again (over
  the selected N only). Why: the hardest batch (N = 10, the most load on Forge) runs first,
  so a Forge failure under load shows within the first hour rather than at the end, and
  reversing the order in rep 2 balances order effects (time of day, runner pool warmth,
  account state) across N.
- **Schedule.** Rep 1 batches, rep 2 batches, the rep-3 decisions, then the selected rep-3
  batches, each in the order above. A void batch (see Void rules) is re-run once, whole, at
  once, before the next batch starts, so the order holds and the pair stays paired; both
  attempts are published. No batch is skipped, added or repeated because of its result. There is no
  "continue only if Forge is fast" rule. **Every rep is published, void or not.**
- **Model and agent.** GPT through the Codex CLI in both arms: `codex exec`, model
  `gpt-6.1-sol`, reasoning effort `high` (`config.agent`), 45 min per task, the same prompt
  text, working directory (the workspace root), PATH (the Forge relay shim, then
  `/usr/local/bin`, so `node` is the patched `/usr/local/bin/node`; non-login shell) and
  macOS file sandbox in both arms; network open, web search off. Each task gets a fresh
  `CODEX_HOME` holding only a link to the owner's login: no owner config, global AGENTS.md,
  rules, skills, plugins, MCP servers or past sessions, and the agent cannot read the owner's
  Codex or Claude sessions. Tools: Codex's shell (through its code-mode `exec`), patch and plan
  tools; sub-agents, web search, browser, computer use, apps, plugins, hooks, image generation,
  goals and memories are disabled. The repository's own `AGENTS.md` and `.agents/` load as
  Codex loads them by default, identically in both arms. The Codex CLI version is recorded per
  cell. Claude Code (`claude-sonnet-5-5`) stays selectable (`config.agent.provider`) but is not
  this run's agent.
- **Fresh baseline.** GitHub N = 1 runs again in this schedule; the 2026-11-01 03:28 cell is
  not reused.

## Same conditions in both arms

- **Same tree.** Both arms start every cell from one base tree, fork commit `50edd7a7`
  (t3code@C + `.bench/ci.sh` + `.github/workflows/bench-ci.yml`, upstream workflows removed).
  Forge main is reset to exactly that tree (proved on a fresh Lane of main after the reset).
  Agents get the FULL tree in both arms, `.repos` included (t3code's AGENTS.md sends agents
  there): a Forge Lane, or a non-sparse clone of the fork's main. Only the CI checkout stays
  sparse, as upstream's CI is, and it is the same in both arms.
- **Same dependencies.** One shared install per lockfile, linked into every checkout the same
  way (`deps.mjs`); one writable toolchain copy per cell.
- **Same workspace-prep rule (lead, 2026-11-01).** Per-cell setup runs before the start
  barrier in both arms and is not timed: the reset of main (GitHub force push, Forge one
  landing), GitHub's one hub clone of the fork per cell (a developer's existing clone; Forge's
  counterpart is the machine object cache, disclosed below), the meter and the id floors.
  Per-task workspace prep runs after the barrier, inside the worker, in both arms: GitHub a
  `--shared` clone of the hub, config, `fetch` and `switch -c agent-<k>/<task> origin/main`;
  Forge `start` (new Lane) and `open` (materialise the Lane checkout), then the relay
  registration. Both then link dependencies the same way. Prep is therefore inside **wall time
  and landings per hour** in both arms (a worker cannot start its agent before its workspace
  exists, so slow prep costs throughput) and outside **time to main** in both arms (that
  clock starts at dispatch, when the agent starts). Every task records `prepSeconds` and its
  phases (`prep`), and the report shows prep per arm next to time to main. Measured in the
  N = 3 dry batch of 2026-11-01 (attempt 4, 3 workers per arm at once, 10 tasks each): Forge
  per-task prep median 129 s (106-192 s; 181-192 s for the first three, opened together), GitHub
  4.8 s (3.5-19.6 s). Forge's prep is almost all `open` (`start` takes 1.4-1.8 s): it
  materialises the full 28,881-file, 318 MB tree. GitHub's `switch` checks out the same tree
  from the hub in 2.3-3.0 s. That gap is a Forge product cost and stays in the wall-time
  comparison; it is filed as Forge friction, not adjusted for.
- **Same prompt** except the source-workflow paragraph. The full difference:

```diff
-SOURCE WORKFLOW (Git + GitHub): your workspace is a git clone of NanthAI/forge-b15d-t3code; you are on branch `agent-<k>/<task>` (already created from main). Commit, `git push -u origin agent-<k>/<task>`, open a pull request with `gh pr create --base main --fill`, then add it to the merge queue with `gh pr merge --squash --auto`. The required check `bench-check` runs on the pull request and again in the merge queue; the queue merges when it passes. Follow progress with `gh pr checks` and `gh pr view --json state,mergedAt,mergeStateStatus`. If the pull request is removed from the queue or a check fails, fix it (bring in main with `git pull --no-rebase origin main` if needed), push, and enqueue again. Only use NanthAI/forge-b15d-t3code; never open pull requests anywhere else.
+SOURCE WORKFLOW (Forge): your workspace is a Forge Lane of the hosted project b15d-t3code-hosted, already started for this task; run `nforge` commands from the workspace root. Land with `nforge agent . land --save '{"message":"<one-line summary>"}'`: it saves your edits, syncs with main, runs the project's check (`bash .bench/ci.sh`) on the project's runner and lands the change when it passes. Read the JSON receipt: `phase` `landed` means done. On a failed check it lists the failure (`nforge agent . log '{"operationId":"RUN_ID","stream":"stderr","tail":4096}'` reads more); fix and run `land --save` again. On a sync conflict it lists files with <<<<<<< lane / >>>>>>> main markers; resolve them and run `land --save` again. `nforge agent . status '{}'` shows your Lane. `nforge agent . land --help` lists options.
```

- **Same check.** `bash .bench/ci.sh` on GitHub-hosted `ubuntu-latest`. GitHub: PR CI, merge
  queue (HEADGREEN, up to 10 per group) and push CI. Forge: one check per landing through
  Forge's runner (`forge-check.yml`, a plan job and a run job). Runner image and resolved
  action SHAs are recorded from the first and last job of every cell in both arms.
- **Same samplers.** Mac load and memory every 30 s, the GitHub API budget before and after,
  and clock offsets to GitHub and Convex, identically in both arms.

## Versions (frozen per run, checked per cell)

**Dogfood landing hold.** The driver holds `forge-cli/.freeze` for each batch: from before its
first cell starts until its last cell is settled and graded (both concurrent cells, or both
sequential ones). While it exists `lane.sh finish` and the `nforge` wrapper wait, and the CLI
updater does not swap `forge-cli/current`. Bench agents call the CLI by path and are not held.
Between batches the hold is released, so builders land; before the next batch the driver
brings the CLI to main and waits until nanthai-forge has no workflow queued or running.

Recorded at the start and end of every **batch** (and of every cell inside it): the CLI build
and its commit (`forge-cli/current/.commit`), GitHub main of nanthai-forge, the deployed Convex
version (latest successful `convex-deploy.yml` head, whose `convex/` tree must equal the CLI
commit's), the check workflow (`forge-check.yml` at main; `bench-ci.yml` at the fork base),
the harness commit and a hash of its files, and the agent's provider, model, effort and CLI
version. Any difference between a batch's start and end (a landing, a deploy, a CLI swap)
voids the batch. Both arms of a batch therefore always ran the same versions; versions may
differ between batches and are reported per batch. A batch does not start while nanthai-forge
has any workflow queued or running. The harness runs from a clean pinned checkout of a landed
commit (`pin.mjs`), never a Lane root, and a scored cell needs a passing dry run of that exact
commit.

## Leak controls

- The fork holds `main` and this harness's `agent-*` branches only. Reference solutions,
  hidden tests and qualification branches are not in it. Grading pushes an `oracle/<cell>`
  branch only after every landing has settled (no agent is running), and deletes the branch
  and its workflow run as soon as the log is saved locally.
- GitHub workspaces fetch `main` and their own branch only (refspecs
  `+refs/heads/main:refs/remotes/origin/main` and `+refs/heads/<own branch>*:…`, no tags), so
  `git push -u` and `gh pr create` work as in a normal clone; the per-cell hub fetches `main`
  only.
- Forge main is reset and verified against the base before every cell.
- Earlier cells' PRs stay visible on the fork and earlier landings stay in Forge history, so an
  automatic audit reads every agent transcript (tool calls and what they returned) and every
  Forge relay call, and voids a task on: upstream references (`pingdotgg`, upstream PR URLs or
  task PR numbers in git/gh/curl commands), solution or grading refs (`q/…`, `oracle/…`,
  `oracle.sh`), bench data (`forge-bench`, `forge-cache`, `tasks.json`), listing other PRs
  (`gh pr list --state merged|closed|all`, `gh search`), all-refs history (`git log/fetch --all`,
  `git ls-remote`), GitHub history APIs (`/pulls`, `/compare`, `/events`, `/git/refs`,
  `/branches`), opening any fork PR but its own (`gh pr view|diff|checkout|checks N`,
  `pull/N`), a solution branch arriving in a fetch, and Forge history/export/receipt verbs or
  ids of Lanes/operations the agent was never shown.
- The pre-fix fork (all 42 branches) is archived locally under `BENCH_ROOT/archive/`; the
  qualification and oracle workflow runs that printed graded test names are deleted.

## Measures

- **Time to main** per task: landed time (GitHub `mergedAt`; Forge `committedAt`) minus
  dispatch. Prep (clone or Lane start and open, dependency links) is reported separately, with
  its phases (see Same workspace-prep rule). GitHub's
  stored times are corrected to real time by a per-cell clock probe (on 2026-11-01 GitHub
  returned objects created 08:00-09:00 UTC one hour late on every read); a cell is void if that
  offset moves by more than 5 s between its start and end. Which PRs and CI runs belong to a
  cell is decided by id, not time: only PR numbers and run ids above the highest ones at cell
  start count.
- **Wall time** per cell: cell start to the last landing (only when all 10 landed), and
  landings per hour.
- **Landings that finish after the agent exits** count: each task's landing is observed until it
  is terminal (bounded at 20 min), and grading waits for an empty queue (30 min).
- **Tokens**: totals over every model request of the session: input (uncached and cached),
  output and reasoning output from the Codex rollout's thread total (cross-checked against
  `codex exec --json` turn totals), the request count, and agent wall time per task. (Claude:
  `modelUsage` over every turn and model, plus model API seconds.)
- **CI**: runs, jobs, job seconds, billed minutes and queue wait per landing, the same shape for
  both arms; grading runs are excluded from both.
- **Convex** (Forge): project-attributed executions, DB I/O, egress and action compute from the
  log stream, at list price. R2 and storage are not metered here.

## Correctness (oracle)

The oracle overlays each task's original PR test files on the exact final main and runs the
full suites of the four packages on GitHub Actions, the same for both arms.

- **Case ownership.** A test file changed by one task belongs to that task (all its cases).
  A file changed by several tasks (only `provider-pi/src/server/adapter.test.ts`, t27514 and
  t27521) runs in its latest version, and each case goes to the last task, in merge order,
  whose PR added or changed it (the PR version against its parent). Cases no task owns are the
  existing suite.
- **Strict** (primary): a task passes when its test files ran and every case it owns passed.
- **Lenient**: per task, the share of its owned cases that passed; a cell's lenient score is the
  mean over tasks. Failures that only compare two string literals are flagged `wordingOnly`.
- **Existing suites green**: no case that no task owns failed, in all four packages (cases the
  base itself skips on the runner, 2 in `shell.test.ts`, are counted apart). A task's own case
  counts only when it passed.
- The file-level score used before this plan is kept as `fileLevelSuccess` for reference.

## Coordination (R3, folded in)

- **Forge, per cell at N ≥ 3**: overlap notices raised (time, task pair, file), delivered
  (returned to the agent in a CLI receipt; also checked in its transcript), acknowledged (ack
  and choice), and whether both tasks of a pair then landed clean. A land refused until the
  notice is answered (`OVERLAP_UNANSWERED`) counts as a delivered notice for its files. Per
  task: sync conflicts, failed checks, gate refusals (overlap, preflight; their time is in time
  to main, but answering one is not rework) and extra land attempts (re-lands after anything
  else). **Metric 4 = delivered and
  acknowledged** (acknowledged ÷ delivered). Forge's own `metrics` read for the cell window is
  saved next to the harness count.
- **Notice precision (useful vs noise).** Each notice keeps its class (`blocking` or `advisory`,
  with its reason, from the overlap-precision change; `unclassified` on an older server; a land
  refused with `OVERLAP_UNANSWERED` is blocking). Ground truth per notice: whether the task and
  the peer named by the notice **really changed the same hunks** of that file. Each task's
  changed files are copied when its agent exits; each pair is merged three-way over the base
  (`git merge-file`); a conflict = useful, a clean merge = noise. A task that synced its
  sibling's change in carries it on both sides, which merges clean, so only its own overlapping
  edits count. Per class: notices, acknowledged, useful, noise; plus real conflicts that no
  notice pointed at (missed). The report shows useful versus noise, not just counts.
- **Leftover land-gate cost (Forge).** Per task: preflight refusals (`PREFLIGHT_REQUIRED`
  after a save), preflight calls and seconds, and the time from each refused land to the next
  land (`preflightLostSeconds`, `overlapLostSeconds`). Any cost left after the
  preflight-survives-save fix shows up here; it is inside time to main.
- **GitHub, per cell**: per task, merge conflicts, rejected pushes, rebases, queue runs and
  failures, queue failures caused by a sibling (the queue run failed while the PR's own latest
  CI had passed), extra PR pushes, and rework because of a sibling.
- **Per overlap class and arm**: landed-clean rate (landed with no conflict, failed check,
  rejected push or extra attempt) and added minutes (time to main minus the same task's median
  time to main at N = 1 in the same arm).
- **How much overlap there is.** In the upstream window only t27514 and t27521 change the same
  files; no other merged PR in the four checked packages shares a file with any task (checked
  over every PR in `raw/merged-prs.json`). Adding tasks would also need new hidden-test
  qualification and a new usage estimate, so the task list stays at 10. Instead the pair is
  dispatched together in every cell (see Task order), which gives 9 concurrent same-file pairs
  per arm at N ≥ 3. Same-package groups (shared ×4, provider-pi ×4 including the pair) give
  package-level contact. With this few true overlaps, coordination results are reported per
  pair and as counts, not as rates with confidence intervals.

## Void rules

A **batch** is void (published, then re-run once, whole, before the next batch) when: any recorded version differs
between its start and end (a fake landing or deploy is tested to fire this guard); either of
its cells refused to start or is void; or the driver was interrupted. A **cell** is void when:
any recorded version differs between its start and end or from its batch's start record; the
Convex meter
lost coverage or closed early (Forge); runner image or action SHAs changed within the cell; a
landing was still in flight at grading; grading failed; any task hit a harness error; or the
cell was interrupted. A **task** is void (excluded from per-task numbers, cell kept) when the
contamination audit hits it, it hit a harness error, or its agent stopped on a usage or rate
limit (a quota error from the CLI, or a usage window at 100%). Before every batch the driver
waits (re-checking every 5 min, never stopping) until the agent's weekly usage is below 85%
(and a 5h window, where the plan has one, at 40% or less), nanthai-forge is idle and the disk
has room for both cells.

**Crash safety.** Every cell writes `result.json` on every exit it controls; a crash kills its
agents (they run in their own process groups), leaves any Lane whose landing is still in flight
to finish, and abandons the rest. A cell or batch whose process is gone without a result is
closed as `interrupted` by the next driver run and re-run once. Re-running the same driver
command resumes the schedule in the same order: it walks the batches in plan order, skips a
batch that has a valid attempt or two void ones, and continues at the first that has neither
(re-running its void attempt first).

## Analysis and reporting

- Only cells inside a valid batch are scored (both arms under one hold, same versions).
- Per arm and N: median and range over reps of wall time, landings per hour, strict and lenient
  correctness, tokens, CI minutes and Convex dollars (`summarize.mjs`). A difference is called
  real only when the ranges do not overlap; otherwise the report says "in this run".
- At N = 1: paired per-task differences (same task, same rep) with a bootstrap interval over tasks.
- Correctness: strict k/10 is binomial; differences of 2 tasks or fewer per cell are noise.
- Forge time breakdown per task from the landing receipt: prep, agent work before land, save and
  sync, compose, queue wait, check, settle.

## Disclosed differences

- Forge agents' `nforge` runs through a relay outside the file sandbox (macOS sandboxes cannot
  exec the setuid `/bin/ps` the CLI needs); the relay is a separate process, logs its own
  overhead per call, and passes the agent's PATH and toolchain environment. Output arrives when
  a call ends (no progress stream). This is a product gap.
- GitHub uses the merge queue for a green-main guarantee like Forge's; upstream t3code itself
  uses PR + push CI without a queue.
- Forge reuses a machine object cache across cells; GitHub clones a fresh hub per cell, outside
  timing.
- Both arms have network access and the owner's GitHub credentials; the leak rules above are
  enforced by the audit.
- The GitHub arm's actions are recorded, not pinned by SHA: pinning them would change the base
  commit that both arms share.

## Schedule

Batches in run order, with the task order (both arms), from `node scripts/bench-t3code/plan.mjs json`:

| # | Batch | Mode | Agents at once | Cell order | Seed | Task order |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | n10-r1 | sequential | 10 | github then forge | `b15d-rerun-2026-11-01/n10/r1` | t27097, t27069, t27513, t27521, t27514, t27539, t27372, t26563, t27101, t26770 |
| 2 | n5-r1 | concurrent | 10 | forge + github | `b15d-rerun-2026-11-01/n5/r1` | t27097, t27513, t27521, t27514, t26563, t27539, t27372, t26770, t27069, t27101 |
| 3 | n3-r1 | concurrent | 6 | forge + github | `b15d-rerun-2026-11-01/n3/r1` | t27372, t27521, t27514, t27513, t26770, t27539, t27069, t27101, t27097, t26563 |
| 4 | n1-r1 | concurrent | 2 | forge + github | `b15d-rerun-2026-11-01/n1/r1` | t26563, t27069, t27514, t27521, t26770, t27372, t27097, t27513, t27539, t27101 |
| 5 | n1-r2 | concurrent | 2 | forge + github | `b15d-rerun-2026-11-01/n1/r2` | t27539, t26770, t27101, t27372, t27514, t27521, t27097, t26563, t27069, t27513 |
| 6 | n3-r2 | concurrent | 6 | forge + github | `b15d-rerun-2026-11-01/n3/r2` | t27539, t26563, t27372, t27097, t26770, t27514, t27521, t27069, t27101, t27513 |
| 7 | n5-r2 | concurrent | 10 | forge + github | `b15d-rerun-2026-11-01/n5/r2` | t27069, t27514, t27521, t27101, t26770, t27539, t27372, t27097, t26563, t27513 |
| 8 | n10-r2 | sequential | 10 | forge then github | `b15d-rerun-2026-11-01/n10/r2` | t27521, t27514, t27101, t26563, t27539, t27069, t27372, t27097, t26770, t27513 |

Rep 3, only for an N the rep-3 rule selects, run in this order (N descending):

| Batch | Mode | Agents at once | Cell order | Seed | Task order |
| --- | --- | --- | --- | --- | --- |
| n10-r3 | sequential | 10 | github then forge | `b15d-rerun-2026-11-01/n10/r3` | t27097, t27069, t26770, t27101, t27514, t27521, t27539, t27513, t27372, t26563 |
| n5-r3 | concurrent | 10 | forge + github | `b15d-rerun-2026-11-01/n5/r3` | t27539, t27372, t26770, t27069, t27514, t27521, t27101, t27513, t26563, t27097 |
| n3-r3 | concurrent | 6 | forge + github | `b15d-rerun-2026-11-01/n3/r3` | t27069, t27513, t27539, t27101, t27372, t27097, t26770, t27521, t27514, t26563 |
| n1-r3 | concurrent | 2 | forge + github | `b15d-rerun-2026-11-01/n1/r3` | t27521, t27514, t27372, t27513, t27097, t26563, t27539, t27101, t26770, t27069 |

## Cost estimate

From the no-model dry batch n3-r1 (attempt 4, 2026-11-01, both arms at once, 10 tasks each,
scripted agents that save, sync, resolve and land for real) and the real-model N = 1 checks:

| Per task | Forge arm | GitHub arm |
| --- | --- | --- |
| Convex (metered: function calls, database I/O, egress, action compute) | $0.0056 (dry N = 3: $0.0558 per cell, 627 executions, 6.7k document reads, 9.7 MB database read, 14.2 MB egress); $0.0026 real-model N = 1 | none |
| GitHub Actions billed minutes | 5.3 (1.5 runs, 3 jobs; real-model N = 1: 4) | 6.6 (3.3 runs: PR, merge queue, main push) |

Whole run, Forge tasks × Convex per task, with a 2× margin for N = 10 contention and real
agents' extra reads (status, logs, retries) on the dry rate:

| Scope | Forge tasks | Convex | Actions minutes (both arms) |
| --- | --- | --- | --- |
| Reps 1-2 (8 batches) | 80 | $0.45 ($0.90 with margin) | ~950 |
| Plus rep 3 for every N | 120 | $0.67 ($1.34) | ~1,430 |
| Worst case: every batch re-run once, rep 3 for every N | 240 | $1.34 ($2.69) | ~2,850 |

Every case is under the $5 Convex stop (`drive.mjs` BUDGET_USD, checked before each batch
from the scored cells' metered spend). Not metered: R2 operations and bytes, and Convex
storage (disclosed in every Forge cell's `convex.notMetered`). GitHub Actions minutes cost $0:
both repositories are public and the organisation is on the Team plan; they matter for the
60-concurrent-job limit (N = 10 peaks near 30 jobs). Agent tokens are the owner's Codex plan
quota, not dollars; the driver waits on its usage windows (Void rules). Each no-model dry run
cost under $0.10 of Convex ($0.0558 for the N = 3 pair, $0.0026 for N = 1).

## Tasks

| Task | Upstream PR | Overlap class | Test files |
| --- | --- | --- | --- |
| t27097 | #27097 | same-package:shared | `shared/src/nodeSqliteClient.test.ts` |
| t27101 | #27101 | disjoint:client-runtime | `client-runtime/src/connection/registry.test.ts`, `client-runtime/src/connection/supervisor.test.ts` |
| t27513 | #27513 | same-package:provider-pi | `provider-pi/src/server/status.test.ts` |
| t27372 | #27372 | same-package:shared | `shared/src/filePreview.test.ts`, `shared/src/video.test.ts` |
| t27514 | #27514 | overlap:pi-adapter (same files as 27521) | `provider-pi/src/server/adapter.test.ts` |
| t27521 | #27521 | overlap:pi-adapter (same files as 27514) | `provider-pi/src/server/adapter.test.ts` |
| t27539 | #27539 | same-package:provider-pi | `provider-pi/src/server/mcpExtensionSource.test.ts` |
| t26563 | #26563 | same-package:shared | `shared/src/changedFileKind.test.ts` |
| t26770 | #26770 | disjoint:source-control-forgejo | `source-control-forgejo/src/server/ForgejoSourceControlProvider.test.ts` |
| t27069 | #27069 | same-package:shared | `shared/src/schemaJson.test.ts` |

## Runbook

1. The driver holds `forge-cli/.freeze` per batch (no manual freeze). Builders' finishes wait
   during a batch and land between batches.
2. `node scripts/bench-t3code/pin.mjs <landed SHA>` → `BENCH_ROOT/harness/<sha12>`; run every
   command below from that checkout.
3. `node scripts/bench-t3code/preflight.mjs` → must print `GO`.
4. Dry run (no model, scripted agents): at least the concurrent N = 3 batch,
   `node scripts/bench-t3code/drive.mjs --dry --only n3-r1`; then set `config.qualifiedHarness`.
5. `node scripts/bench-t3code/drive.mjs` (resumable: re-run the same command after any stop).
   Its `CELL` lines (START, WAIT, DONE, BATCH, REP3, ALL DONE) are the lead's Monitor feed.
6. `node scripts/bench-t3code/summarize.mjs`.
