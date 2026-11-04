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

`tasks.mjs` constructs the manifest; `plan.mjs` fixes digest/order/repetition rules; `deps.mjs` prepares shared dependencies; `oracle.mjs`, `oracle.sh` and `score.mjs` qualify and score; `drive.mjs` schedules `run-cell.mjs`; `github-arm.mjs` and `forge-arm.mjs` implement the arms; `preflight.mjs`, `versions.mjs`, `meter.mjs`, `samplers.mjs` and `summarize.mjs` capture conditions and results. `pin.mjs` still has machine-specific defaults: use its supported explicit root; its historical dependency-donor path still needs a portable replacement, and do not mistake it for the missing fixture.

`preflight.mjs --dry` and `drive.mjs --dry` are **live qualification**, not offline recovery: they inspect external services and can prepare workspaces. Recover private configuration through the owner, authorize its resources/spend, review those scripts and preconditions, and qualify the exact harness before using them. This handover runs neither a dry cell nor a scored cell. Future scored repeats need their own registered plan (including the agreed outlier rule); the historical result is unchanged.
