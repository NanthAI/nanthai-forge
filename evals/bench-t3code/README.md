# Recover the B1.5d benchmark

Main retains the harness in `scripts/bench-t3code/`, the [registered plan](../../docs/research/b15d-bench-plan.md) and the [published report](../../docs/research/b15d-report.md). It does **not** retain a complete runnable fixture. Raw evidence is private, held off-repo by the owner; ask before relying on it. Recovery and proof belong to Issue 8c9b84fc; this recipe contains no task data or private configuration.

## What to recover

Ask the owner for the frozen ten-task `tasks.json` (prompts, ordered IDs and oracle metadata), original saved PR metadata if rebuilding it, CI/oracle scaffolding (`.bench/ci.sh`, `.bench/oracle.sh`, `.github/workflows/bench-ci.yml`), and qualified-base/reference reconstruction inputs. Preserve upstream attribution and licenses. Do not copy private Git history, bindings, runtime configuration or archived source into this repository. Only public-upstream or synthetic inputs can become public fixtures after review.

The known gap is explicit: synthesized base **fa3b7349 is not in the retained upstream objects and its reconstruction is unproven**. Retained research includes source base a2f901ef and prerequisite commit 2d1f007f, not the normalized qualified base. An available source base or matching task digest alone does not prove the benchmark tree.

## Offline rebuild and verification

1. Select an exact accepted Forge harness commit and a separate disposable recovery directory. Set `BENCH_ROOT` to that directory explicitly so scripts never select a historical machine default. Keep all recovered private inputs there. Copy `docs/research/b15d-bench-plan.md` byte for byte to `BENCH_ROOT/PLAN.md`.
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
4. Reconstruct upstream C (`52f4ec6f`) plus the six preview prerequisites (#21745, #22739, #25436, #22062, #25028, #24244). Replace upstream workflows with the exact recovered bench CI scaffolding as described in the registered plan; retain the oracle separately from agent workspaces. Compare file modes, paths, complete tree digest and workflow bytes with retained qualification evidence for fa3b7349. Record every patch/reference port and its provenance. This step currently lacks a proven recipe/tree comparison; do not declare recovery complete until 8c9b84fc proves it.
5. Re-run the qualification matrix in a separately authorized environment: same base tree and check in both arms; base green three times; each task with hidden tests red in its owned scope and with its reference green. Verify that no solution or hidden test appears in the agent base. Restore the exact toolchain/lockfiles and runner scope from the plan, then record harness, source, CLI, runner and backend pins.

## Rebuild the environment with one script

`scripts/bench-t3code/setup` builds everything a bench needs outside the harness code; `scripts/bench-t3code/teardown` removes it. Both need an explicit `--dry` (reads only) or `--live`.

```sh
export BENCH_ROOT=...   # holds the owner's config.json, tasks.json; setup copies PLAN.md
scripts/bench-t3code/setup --dry     # every step, its state, its cost (repos, CI minutes, Convex calls, disk); creates nothing
scripts/bench-t3code/setup --live --base-source BASE_REPO_OR_BUNDLE --dogfood-project PROJECT_ID
scripts/bench-t3code/teardown --dry  # then --live [--keep deps]
```

Steps, in order: `prereqs`, `inputs`, `pin`, `meta`, `base`, `base-checkout`, `deps`, `fork` (temporary **public** repo, outward), `forge-project` (hosted Convex spend, outward), `dogfood`. Each is idempotent: a step whose check passes is skipped, so a rerun resumes. Everything setup creates is written to `BENCH_ROOT/setup-manifest.json` before the call that creates it. Teardown reads only that manifest and re-checks each entry first: a repo is deleted only if it still has the id setup recorded, a path only if it is inside `BENCH_ROOT`, a `config.json` key only if it still holds setup's value. A repo that exists without a manifest entry is never adopted or deleted. `preflight.mjs` names the setup step for every missing piece.

What setup cannot do for you, and says so: it cannot rebuild base **fa3b7349** (see above), so `base` needs `--base-source` (a repo or bundle that holds the commit; `--new-base` accepts a different commit as a new base, which the plan must register before any scored cell). It stops at the Vite+ installer and prints its sha256; you read it and pass `--installer-sha256`. It does not define the Forge project's check command (`bash .bench/ci.sh`) and its ruleset follows the plan's stated fields only; the exit bench dry run's base-green qualification is the proof. `forge-project` hosts a one-commit snapshot of the base tree, not the B1.5d full history, and its Convex cost is unmeasured until it runs once.

**Harness pin.** `pin.mjs` takes a Forge State head (the CLI's `.commit`, the default) and maps it to a Git commit through the project's own mirror record (`capabilities.githubMirror`: `mirroredHead` to `gitHead`). It never waits silently: when the mirror has not reached that State it exits `BENCH_PIN_WAITS_FOR_MIRROR` naming the State it needs, the State the mirror has, and when the next attempt is due (`nforge github-sync ROOT --push` pushes now). The version record uses the same mapping, so a State-head CLI commit is compared with GitHub main correctly. `FORGE_CLI_HOME` overrides the dependency donor; by default it is the CLI build next to `config.forge.cli`.

## What each harness file does

`tasks.mjs` constructs the manifest; `plan.mjs` fixes digest/order/repetition rules; `deps.mjs` prepares shared dependencies; `oracle.mjs`, `oracle.sh` and `score.mjs` qualify and score; `drive.mjs` schedules `run-cell.mjs`; `github-arm.mjs` and `forge-arm.mjs` implement the arms; `preflight.mjs`, `versions.mjs`, `meter.mjs`, `samplers.mjs` and `summarize.mjs` capture conditions and results. `pin.mjs` takes `BENCH_ROOT` and `FORGE_CLI_HOME` explicitly.

`preflight.mjs --dry` and `drive.mjs --dry` are **live qualification**, not offline recovery: they inspect external services and can prepare workspaces. Recover private configuration through the owner, authorize its resources/spend, review those scripts and preconditions, and qualify the exact harness before using them. This handover runs neither a dry cell nor a scored cell. Future scored repeats need their own registered plan (including the agreed outlier rule); the historical result is unchanged.

## Harness rules that scoring and batching depend on

- **Contamination audit** (`contamination.mjs`): a task is void when its agent reaches for the answer. Reads of the agent's own fork (its PRs, branch list, branch rules and protection, named refs), its own cell `bin/` and `vp/` and the shared `deps/` toolchain cache, `git ls-remote` of its own branch or main, and issue links written into its own PR or commit text are not reaches. `gh api` writes (POST/PATCH/PUT/DELETE, or fields given) to the own fork, such as creating its own PR or branch, are not reads. PR lists, other PRs and branches, `compare`, repo events, other repos, upstream reads or fetches (`gh`/`git`/`curl` on `pingdotgg`, or an interpreter script with a heredoc body or `-c`/`-e` code that names upstream and can reach the network), and any specific other bench path (another cell, `runs/`, `tasks.json`, the oracle) still void the task. A recursive search or listing of the bench root itself voids only when its tool result shows a bench path outside the agent's own workspace and tools (or listed entries of the root). Every rule reads the real command whatever the client sent: raw shell text, Claude/Codex JSON, or Codex code-mode `exec` JavaScript (`command-text.mjs` extracts the command strings, resolves quotes, `bash -lc`, `$(…)` and heredocs). `tests/bench-t3code-contamination.test.mjs` (synthetic fixtures), `…-formats.test.mjs` (every case in every wire format) and `…-bench-root-outcome.test.mjs` cover both sides.
- **Grading branches** (`oracle-branches.mjs`): `oracle/<cellId>` is deleted with backoff after grading and its outcome is recorded in the cell result (`oracle.branchCleanup`). A reset removes only such a branch whose cell id is in the runs ledger and whose cell has ended; any other extra branch still fails with `BENCH_FORK_NOT_CLEAN`.
- **Setup-only attempts**: a batch whose every cell crashed before any agent ran (`result.agentsStarted: false`) is marked `setupOnly` in `batch.json`, is disclosed in the driver log, and does not consume one of `DESIGN.maxAttempts`; at most `DESIGN.maxSetupRetries` such re-runs happen per batch.
- **Freeze coordination** (`drain.mjs`): under its hold the driver also waits for the dogfood project's hosted landing queue to be empty, so a submission admitted before the hold finishes first. It only reads (one bounded `queue` read per poll) and never cancels or restricts anything. `config.json` names that project in `dogfood: { projectId, url? }`; preflight reports it missing.
