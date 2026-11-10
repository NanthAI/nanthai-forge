# Recover the B1.5d benchmark

Main retains the harness in `scripts/bench-t3code/`, the [registered B1.5d plan](../../docs/research/b15d-bench-plan.md) (frozen as run), the [published report](../../docs/research/b15d-report.md) and the [Phase 6 exit bench plan](../../docs/research/p6-exit-bench-plan.md), which amends the B1.5d plan and is the one the harness now checks. It does **not** retain a complete runnable fixture. Raw evidence is private, held off-repo by the owner; ask before relying on it. Recovery and proof belong to Issue 8c9b84fc; this recipe contains no task data or private configuration.

## What to recover

Ask the owner for the frozen ten-task `tasks.json` (prompts, ordered IDs and oracle metadata), original saved PR metadata if rebuilding it, CI/oracle scaffolding (`.bench/ci.sh`, `.bench/oracle.sh`, `.github/workflows/bench-ci.yml`), and qualified-base/reference reconstruction inputs. Preserve upstream attribution and licenses. Do not copy private Git history, bindings, runtime configuration or archived source into this repository. Only public-upstream or synthetic inputs can become public fixtures after review.

Synthesized base **fa3b7349 is not in the retained upstream objects, but its reconstruction is proven by object ids** (Issue 8c9b84fc, 2026-11-07): its tree is upstream C (`52f4ec6f`) with the nine preview-prerequisite files of source base a2f901ef, `.github/workflows/` holding only the bench `bench-ci.yml`, and `.bench/` holding only the plan's `ci.sh` (mode 100755). Computing that tree from the owner-held inputs gives the tree id recorded for fa3b7349, and `git commit-tree` with its recorded parent (2d1f007f), identity, date and message gives the commit id itself. Online, the meta repo fetches upstream C's public blobs and, through partial-clone fetches, the parent commits (2d1f007f, 50edd7a7, df7f4325), which GitHub still serves from the upstream fork network. A matching task digest alone still does not prove the benchmark tree; the tree and commit ids do.

## Point the harness at a restored input set

Every bench script reads the bench folder from `BENCH_ROOT` and refuses to run without it (`BENCH_ROOT_REQUIRED`, exit 2); it must be an absolute path and there is no default. Put the owner's restored private inputs (`config.json`, `tasks.json`) in one folder outside this repository, then run from the Forge checkout:

```sh
BENCH_ROOT=/absolute/path/to/restored-inputs scripts/bench-t3code/setup --dry
```

That one command checks the inputs, copies `PLAN.md` if absent and prints every remaining step and its cost; it creates nothing else. `export BENCH_ROOT=...` once to use the other scripts in the same shell.

## Offline rebuild and verification

1. Select an exact accepted Forge harness commit and a separate disposable recovery directory. Set `BENCH_ROOT` to that directory (see above). Keep all recovered private inputs there. Copy the plan the harness checks (`docs/research/p6-exit-bench-plan.md`) byte for byte to `BENCH_ROOT/PLAN.md`.
2. Restore the frozen manifest. If reconstructing from saved metadata instead, put `pr-<number>.json` and `files/<number>.json` in a private raw directory and run `node scripts/bench-t3code/tasks.mjs RAW_DIR OUT.json`. This rebuilds prompts from titles/descriptions, not diffs. Preserve frozen base metadata separately: the generator's source-base constant and new `frozenAt` are not proof of the final qualified manifest. Do not edit task contents to make a digest pass.
3. Check the exact task-array digest (not pretty-printed file bytes) from the Forge checkout:

   ```sh
   node --input-type=module - "$BENCH_ROOT/tasks.json" <<'JS'
   import { readFileSync } from 'node:fs';
   import { createHash } from 'node:crypto';
   import assert from 'node:assert/strict';
   import { DESIGN } from './scripts/bench-t3code/plan.mjs';
   const manifest = JSON.parse(readFileSync(process.argv[2], 'utf8'));
   assert.equal(manifest.tasks.length, 10);
   const digest = createHash('sha256').update(JSON.stringify(manifest.tasks)).digest('hex');
   assert.equal(digest, DESIGN.tasksSha256);
   console.log(digest);
   JS
   node scripts/bench-t3code/plan.mjs check
   node scripts/bench-t3code/plan.mjs json
   ```

   Expected task digest: `dc4346af484794cc181a953b37a42c132b9bf57abcd4b6a0b871e3f84c7b52f1`. Keep order and all oracle fields exact. `plan.mjs check` verifies the copied plan and digest; `json` derives the schedule offline.
4. Reconstruct upstream C (`52f4ec6f`) plus the six preview prerequisites (#21745, #22739, #25436, #22062, #25028, #24244). Replace upstream workflows with the exact recovered bench CI scaffolding as described in the registered plan; retain the oracle separately from agent workspaces. Compare file modes, paths, the tree id and the commit id with fa3b7349 (above): equal ids prove every path, mode and byte. Check every reference port's pre-image blob ids against that tree and its files against the task's `oracle.referenceFiles`. Record every patch/reference port and its provenance.
5. Re-run the qualification matrix in a separately authorized environment: same base tree and check in both arms; base green three times; each task with hidden tests red in its owned scope and with its reference green. Verify that no solution or hidden test appears in the agent base. Restore the exact toolchain/lockfiles and runner scope from the plan, then record harness, source, CLI, runner and backend pins.

## Rebuild the environment with one script

`scripts/bench-t3code/setup` builds everything a bench needs outside the harness code; `scripts/bench-t3code/teardown` removes it. Both need an explicit `--dry` (reads only) or `--live`.

```sh
export BENCH_ROOT=...   # holds the owner's config.json, tasks.json; setup copies PLAN.md
# Run setup from a built checkout (it imports dist/): the pinned harness or the installed CLI build.
scripts/bench-t3code/setup --dry     # every step, its state, its cost (repos, CI minutes, Convex calls, disk); creates nothing
scripts/bench-t3code/setup --live --base-source BASE_REPO_OR_BUNDLE --dogfood-project PROJECT_ID [--replace-forge-project]
scripts/bench-t3code/teardown --dry  # then --live [--keep deps]
```

Steps, in order: `prereqs`, `inputs`, `pin`, `meta`, `base`, `base-checkout`, `deps`, `fork` (temporary **public** repo, outward), `forge-project` (hosted Convex spend, outward), `forge-check` (outward), `dogfood`. Each is idempotent: a step whose check passes is skipped, so a rerun resumes. Everything setup creates is written to `BENCH_ROOT/setup-manifest.json` before the call that creates it. Teardown reads only that manifest and re-checks each entry first: a repo is deleted only if it still has the id setup recorded, a path only if it is inside `BENCH_ROOT`, a `config.json` key only if it still holds setup's value. A repo that exists without a manifest entry is never adopted or deleted. `preflight.mjs` names the setup step for every missing piece.

What setup cannot do for you, and says so: it cannot rebuild base **fa3b7349** (see above), so `base` needs `--base-source` (a repo or bundle that holds the commit; `--new-base` accepts a different commit as a new base, which the plan must register before any scored cell). It stops at the Vite+ installer and prints its sha256; you read it and pass `--installer-sha256`. Its ruleset follows the plan's stated fields only; the exit bench dry run's base-green qualification is the proof. `forge-project` imports the public fork at the base commit with Forge's GitHub import (`forge-import.mjs`, the web import's actions with the CLI login; resumable from `work/forge-import.json`), so the project is born hosted with a server-authority main agents can land on, then clones it to `work/forge-main`. Measured 2026-11-07: 28,881 files / 333 MB in about 2 min 10 s and 8 action calls, clone 61 s. (`nforge host` of a Git checkout is not used: it seeds in Git format and leaves no ready main.) `meta` and `base-checkout` record their folders as `config.meta` and `config.baseCheckout`, which the gates read. `forge-check` then gives that project the plan's check: `verify` = `bash .bench/ci.sh` (`BENCH_CHECK` in `env.mjs`), Forge's GitHub Actions runner on `NanthAI/nanthai-forge` (`ubuntu-latest`, where the Forge arm reads its CI evidence) and agent acceptance on a pass (`preset: trusted`), each only if `check-settings` reports it missing. The runner needs the bench project connected to `NanthAI/nanthai-forge` once, in the owner's browser: setup stops with `BENCH_SETUP_OWNER_STEP` and the exact `nforge github connect PROJECT_ID --url URL --repo NanthAI/nanthai-forge` command, then a rerun finishes the step. It changes only a project setup hosted itself (manifest entry); for any other project it prints the commands and stops. Deleting the project in teardown removes its check settings with it.

**Harness pin.** `pin.mjs` takes a Forge State head (the CLI's `.commit`, the default) and maps it to a Git commit through the project's own mirror record (`capabilities.githubMirror`: `mirroredHead` to `gitHead`). It never waits silently: when the mirror has not reached that State it exits `BENCH_PIN_WAITS_FOR_MIRROR` naming the State it needs, the State the mirror has, and when the next attempt is due (`nforge github-sync ROOT --push` pushes now). The version record uses the same mapping, so a State-head CLI commit is compared with GitHub main correctly.

**Installed CLI.** The harness finds the Forge CLI the way the product installs it (`cli-install.mjs`, [CLI updates](../../docs/operations/cli-update.md)): `FORGE_CLI_HOME` (an installation directory or one build), else the build of `config.forge.cli`, else the installation the `nforge` launcher on `PATH` enters, else `~/.local/share/forge-cli`. The pin links its `node_modules` to that installation's selected build. The batch hold is that installation's measurement hold, `.freeze`: while it exists the CLI holds its own updates and other projects' `land`/`finish`, and between batches the driver updates the CLI with `nforge update --directory INSTALLATION --bin INSTALLATION/bin/nforge`. The bench runs on an installation of its own, `BENCH_ROOT/cli` (setup step `bench-cli`, which installs it from Forge main and points `config.forge.cli` at it), so the hold never reaches builders: `benchCli` refuses (`BENCH_CLI_SHARED`) an installation that the `nforge` on `PATH`, `~/.local/bin/nforge` or the product default uses, and `BENCH_CLI_MISMATCH` when `FORGE_CLI_HOME` and `config.forge.cli` name different installations. The driver and each cell write the bench project (`config.forge.projectId`) into the hold as a `project ID` line, so the bench agents' own landings run on the held build while dogfood landings wait; preflight's `landing hold` check refuses a CLI build without scoped holds.

## What each harness file does

`tasks.mjs` constructs the manifest; `plan.mjs` fixes digest/order/repetition rules; `deps.mjs` prepares shared dependencies; `oracle.mjs`, `oracle.sh` and `score.mjs` qualify and score; `drive.mjs` schedules `run-cell.mjs`; `github-arm.mjs` and `forge-arm.mjs` implement the arms; `preflight.mjs`, `versions.mjs`, `meter.mjs`, `samplers.mjs` and `summarize.mjs` capture conditions and results. `bench-root.mjs` and `cli-install.mjs` hold the folder and CLI rules every script shares. `phases.mjs` classifies each turn of an agent session (coding, landing, rework, waiting, done) and `rework.mjs` turns that into rework tokens per landing, the convoy pass rule and order waits; `cells.mjs` generates the coordination cells (convoy, overlap with the stacking A/B) from the base's workspace manifest. Both are in the [exit bench plan](../../docs/research/p6-exit-bench-plan.md).

`preflight.mjs --dry` and `drive.mjs --dry` are **live qualification**, not offline recovery: they inspect external services and can prepare workspaces. Recover private configuration through the owner, authorize its resources/spend, review those scripts and preconditions, and qualify the exact harness before using them. This handover runs neither a dry cell nor a scored cell. The Phase 6 exit repeat has its own registered plan (the outlier rule, Claude Code in both arms); the historical result is unchanged.

**Agent.** The P6 exit bench runs GPT `gpt-6.1-sol` (effort high) through the Codex CLI in both arms (`plan.mjs DESIGN.agent`, owner decision cfe33f2c), B1.5d's agent: each task gets a fresh `CODEX_HOME` holding only a link to the owner's Codex login, with sub-agents, web search and the other extras disabled (`agent.mjs CODEX_DISABLED`).

**Claude agent.** With `config.agent.provider: claude` each task runs Claude Code in a fresh `CLAUDE_CONFIG_DIR` (no owner settings, memory, sessions, skills or MCP) with the tools `Bash`, `Read`, `Edit`, `Write`, `TodoWrite` only. A fresh home has no login, so the owner saves a long-lived token (`claude setup-token`) at `BENCH_ROOT/secrets/claude-oauth-token` (mode 600; `config.agent.tokenFile` overrides the path). The harness hands it to the CLI on a pipe, never in the agent's environment, and a real cell refuses with `BENCH_CLAUDE_TOKEN_REQUIRED` without it.

## Harness rules that scoring and batching depend on

- **Contamination audit** (`contamination.mjs`): a task is void when its agent reaches for the answer. Reads of the agent's own fork (its PRs, branch list, branch rules and protection, named refs), its own cell `bin/` and `vp/` and the shared `deps/` toolchain cache, `git ls-remote` of its own branch or main, and issue links written into its own PR or commit text are not reaches. `gh api` writes (POST/PATCH/PUT/DELETE, or fields given) to the own fork, such as creating its own PR or branch, are not reads. PR lists, other PRs and branches, `compare`, repo events, other repos, upstream reads or fetches (`gh`/`git`/`curl` on `pingdotgg`, or an interpreter script with a heredoc body or `-c`/`-e` code that names upstream and can reach the network), and any specific other bench path (another cell, `runs/`, `tasks.json`, the oracle) still void the task. A recursive search or listing of the bench root itself voids only when its tool result shows a bench path outside the agent's own workspace and tools (or listed entries of the root). Every rule reads the real command whatever the client sent: raw shell text, Claude/Codex JSON, or Codex code-mode `exec` JavaScript (`command-text.mjs` extracts the command strings, resolves quotes, `bash -lc`, `$(…)` and heredocs). `tests/bench-t3code-contamination.test.mjs` (synthetic fixtures), `…-formats.test.mjs` (every case in every wire format) and `…-bench-root-outcome.test.mjs` cover both sides.
- **Grading branches** (`oracle-branches.mjs`): `oracle/<cellId>` is deleted with backoff after grading and its outcome is recorded in the cell result (`oracle.branchCleanup`). A reset removes only such a branch whose cell id is in the runs ledger and whose cell has ended; any other extra branch still fails with `BENCH_FORK_NOT_CLEAN`.
- **Setup-only attempts**: a batch whose every cell crashed before any agent ran (`result.agentsStarted: false`) is marked `setupOnly` in `batch.json`, is disclosed in the driver log, and does not consume one of `DESIGN.maxAttempts`; at most `DESIGN.maxSetupRetries` such re-runs happen per batch.
- **Quiet rule** (`drain.mjs`, exit plan "Quiet rule and deploys"): under its hold the driver waits only until no Convex deploy (`config.forge.deployWorkflow`) is queued or running on nanthai-forge (2 `gh` reads per poll); dogfood landings, Verify Forge and forge-check runs are not waited for. GitHub main and the deploy head moving during a scored batch are recorded (`versions.moved`, with every overlapping deploy run in `deploys` per batch and cell), not voids; a `forge-check.yml` change still voids, and a deployed `convex/` change voids only when a changed file is on the landing path (outside `versions.mjs OFF_LANDING_PATH`, one GitHub compare call; unreadable voids), with the files recorded in `versions.convexFiles`. It only reads and never cancels or restricts anything. `config.json` names the dogfood project in `dogfood: { projectId, url? }` (its mirror maps the CLI commit; preflight reports its queue).
