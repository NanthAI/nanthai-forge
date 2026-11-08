# Zoo mini-run: five ecosystems through Forge (first run)

Date: 2026-11-08. Issue 85d26a8b (Phase 6). Dev deployment, free GitHub-hosted runners, CLI on
main. The runner is [`scripts/bench-zoo/`](../../scripts/bench-zoo/run.mjs). Everything below
is **one run per repository**: every number is an observation, not a claim (see
[perf-claims](../agents/perf-claims.md); N = 1, no interval).

## What ran

Five public repositories were forked to the NanthAI org and imported from GitHub into one Forge
project each. Each project's check is the repository's own CI command, run on GitHub Actions
through Forge's runner workflow:

| Fork | Upstream | Ecosystem | Check (the upstream CI steps) |
| --- | --- | --- | --- |
| NanthAI/bench-zoo-go | prometheus/client_golang | Go module | `make test` |
| NanthAI/bench-zoo-python | tree-sitter/py-tree-sitter | Python + C extension, git submodule | `pip install -e .[tests]`, `python -m unittest` |
| NanthAI/bench-zoo-rust | BurntSushi/ripgrep | Cargo workspace | `cargo build --workspace`, `cargo test --workspace` |
| NanthAI/bench-zoo-jvm | square/kotlinpoet | Gradle multi-module (Kotlin) | `./gradlew build` |
| NanthAI/bench-zoo-mixed | pydantic/jiter | Cargo + Python (uv) monorepo | `make build`, `cargo test --workspace`, `uv sync`, `pytest` |

The scenario is the same for every repository. Nothing in it is repository-specific: probe files
are picked from the file list (two non-test sources of the main language, in different
directories), and every edit is a comment in that language.

1. **Import and clone**: Forge GitHub import and `nforge clone`, next to `git clone`.
2. **Four Lanes.** A and B add different trailing comments to the same line (a forced
   conflict). C appends a comment line to a file in another directory. D adds a new file.
3. **A and C land together.** C is submitted 2 s after A, so A's landing overtakes C's check.
   This tests whether C's first check is reused.
4. **D syncs** over the two landings (a clean sync).
5. **B lands, conflicts with A, is resolved by keeping both tags, and lands.** The runner follows
   the receipts' `next` steps: sync, then resolve, then land the resolution Lane.
6. **The same steps with plain git** on a scratch branch of the fork: push, pull, conflict,
   resolve, push. The git column has no CI.
7. **Check minutes**: Forge's runner jobs for the project, against one measured GitHub full
   run of the same CI command. The GitHub equivalent for the scenario counts a pull-request run
   per pushed head (4) and a merge-queue run per merge (3).
8. **Convex meter**: project-attributed usage over the run.

## Results (run 2, 17:26Z)

Seconds per operation. Forge `land` includes the hosted check; the git column does not include any CI.

| Repo | import | clone | start | save | sync | land A | land C (overtaken) | conflict | resolve + land |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| go | 26 | 3.3 | 3.7 | 5.1 | 6.3 | 284 | 259 | 12 | 266 |
| python | 27 | 2.5 | 2.7 | 5.3 | 6.1 | check failed (submodule, since fixed) | check failed | – | – |
| rust | 30 | 2.8 | 3.4 | 4.7 | 6.1 | 167 | 68 | 13 | 88 |
| jvm | 29 | 3.4 | 3.2 | 4.5 | 6.5 | 510 | 534 | refused: preflight | – |
| mixed | 23 | 2.4 | 2.8 | 4.8 | 7.4 | 93 | 256 | refused: preflight | – |
| **git** | 0.8-1.3 (`clone --bare`) | 0.8-1.3 | – | 1.4-1.6 (commit + push) | 0.6-1.5 (pull) | 1.4-4.7 (push) | 2.0-2.3 (pull + push) | 0.6-0.7 | 1.4-1.7 |

- **Every ecosystem imports, clones, saves and syncs.** There are no ecosystem-specific failures
  in these steps. Clone is 2-3x slower than `git clone` and save 3-4x slower than commit + push.
  Sync is about 10x slower than `git pull` (6-7 s against under 1 s).
- **The full conflict path works on Go and Rust.** The conflict is reported in 12-13 s. The
  resolution, guided by the receipts, lands in one more check.
- **First-check reuse after a clean overtake works on Go and JVM.** The overtaken landing landed on
  its own first run (`clean-disjoint-v2`), with no second check. On Rust and Mixed the
  overtaking change was a Cargo `build.rs`, so Forge re-checked as `global-risk`: correct for a
  build script.
- **Hosted check selection is still full on every repository** (gate `full`, "Intent has no
  contract"). The manifest package graph (1f2121cb, step 1 landed during this run) already
  selects packages for preflight. It does not yet scope hosted checks.
- **Lockfile digests are empty** in every run plan (`go.sum`, `Cargo.lock`, Gradle). The plan
  records no dependency identity for non-JS projects.

### Check minutes

| Repo | Forge runner jobs | Forge job minutes | GitHub full run | GitHub-equivalent (7 runs) | Scenario completed on Forge |
| --- | --- | --- | --- | --- | --- |
| go | 4 | 13.1 | 209 s | 24.4 min | yes |
| rust | 4 | 3.6 | 31 s | 3.6 min | yes |
| jvm | 2 | 15.3 | 477 s | 55.7 min | no (B refused) |
| mixed | 3 | 4.7 | 74 s | 8.6 min | no (B refused) |
| python | 4 | 1.7 | 19 s | 2.2 min | no (checks failed) |

- **Only Go and Rust are like for like.** On Go, Forge used about half the GitHub-equivalent
  minutes, because each change is checked once and reuse saved one run. On Rust the totals are
  equal: each Forge check job carries roughly 25 s of fixed cost (Forge source fetch and plan),
  which matters when the CI itself takes 30 s.
- On slow checks (Go, JVM) a Forge check job takes about as long as the plain GitHub job. On
  fast checks the fixed cost dominates.

### Convex cost

The meter was valid on all five repositories (0 failures): 408-613 project executions per
repository, **$0.021 in total** at list price, against a $0.50 per-run budget. R2 operations
and Convex storage are not metered here.

### First run (16:27Z, before the fixes)

The first run of all five used an end-of-file append on both A and B. Forge landed both appends
in order with no conflict, where Git conflicts. That flow is replaced by the same-line edit
above. Its timings matched run 2 (save 5-7.5 s, sync 6-7 s). Every Python landing failed on the
submodule (below).

## Results (run 3, 18:17Z, after the submodule, package-graph and inferred-preflight fixes)

Same scenario, same five projects, N = 1. The CLI was the build of State e4a6f011 (the one that
carries the inferred-preflight fix d95d9b41); the install directory shows no newer build until
after the last Forge operation. The runner recorded no CLI id (`cliCommits` was empty because no
receipt holds one), so that is inferred from build times; the runner now reads the installed
CLI's `release-number.json` before and after the run.

**All five repositories complete the whole scenario with no refusal**: import, clone, save,
sync, forced conflict, resolve and land. Seconds per operation:

| Repo | clone | start | save | sync | land A | land C (overtaken) | conflict | resolve + land |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| go | 2.6 | 3.8 | 4.8 | 8.9 | 205 | 219 | 15 | 222 |
| python | 2.8 | 4.3 | 4.9 | 7.5 | 60 | 73 | 16 | 78 |
| rust | 2.7 | 3.5 | 4.8 | 8.2 | 137 | 67 | 16 | 79 |
| jvm | 2.6 | 3.6 | 4.8 | 7.7 | 588 | 486 | 14 | 516 |
| mixed | 2.7 | 3.0 | 5.2 | 9.5 | 92 | 216 | 15 | 132 |
| **git** | 0.8-1.2 | – | 1.7-2.1 | 0.6-1.0 | 1.5-2.2 | 2.1-2.4 | 0.6-1.3 | 1.4-1.8 |

### Run 2 against run 3

| Expectation | Run 2 | Run 3 |
| --- | --- | --- |
| Python lands | check failed (submodule pointer) | lands; A, C and the resolution Lane all pass. C reuses its first check (`clean-disjoint-v2`). |
| JVM and mixed conflict Lane B | refused `PREFLIGHT_REQUIRED` | conflict reported (14-15 s), resolved and landed under the default policy. The land receipts carry `status: advised` (jvm 2, mixed 1). No local toolchain setup. |
| Hosted gate where the package graph narrows | `full` / "Intent has no contract" on every run | **Not met.** Admission checks are still `full` / "Intent has no contract" on all five. The only scoped gate is a recheck after main moved: rust and mixed record `mode: scoped`, but `effective: full`, because the zoo check command declares no `selection` and so runs everything. Same as run 2. |
| Overtaken-landing reuse | go and jvm `clean-disjoint-v2`; rust and mixed `global-risk` recheck | the same, and python `clean-disjoint-v2` |
| `metrics.byReason` | `contract-none` on every run | unchanged: `contract-none` on every run, plus `global-risk` on rust and mixed |
| Lockfile digest | empty everywhere | empty everywhere (the digest of empty input) |
| Convex meter | valid, $0.021 | valid, **$0.027** ($0.0051-0.0057 per repository). The rise is the three repositories that now run more steps (python, jvm, mixed). Go and rust are within about 3%. |

Clone and save did not regress (clone 2.6-2.8 s, save 4.8-5.2 s). Sync was 1.2-2.6 s slower on
all five (7.5-9.5 s against 6.1-7.4 s), and the conflict report on go and rust 2-3 s slower
(15-16 s against 12-13 s). One run cannot say whether that is the CLI or load on the machine
(about twelve builders were working in parallel), so it is a watch item, not a finding.

### Check minutes (run 3)

| Repo | Forge runner jobs | Forge job minutes | GitHub full run | GitHub-equivalent (7 runs) |
| --- | --- | --- | --- | --- |
| go | 4 | 13.1 | 218 s | 25.4 min |
| python | 4 | 2.4 | 18 s | 2.1 min |
| rust | 4 | 3.2 | 22 s | 2.6 min |
| jvm | 4 | 32.7 | 524 s | 61.1 min |
| mixed | 4 | 5.8 | 74 s | 8.6 min |

All five now finish the scenario, so these are like for like. Forge used 52% (go), 54% (jvm)
and 67% (mixed) of the GitHub-equivalent minutes, because each change is checked once and
reuse saves a run. On the fast checks (python, rust) the fixed cost of about 25 s per job
dominates and Forge uses 114-123% of the GitHub-equivalent minutes. The mixed total includes
the scoped recheck, which still ran everything.

### What this run says about scoped checks

Preflight selection works (evidence on 1f2121cb). On hosted checks the package graph reaches
the check command only on a scoped recheck, as `FORGE_CHECK_PACKAGES`, and only when the check
declares `selection: changed-paths`. The zoo checks are the repositories' own CI commands and
declare none, so they run in full. First checks stay full by design (the contract gate scopes
only with a contract, a probe or a recheck). So on these five repositories hosted check minutes
are the same as before the package graph.

## Limitations found (filed under Phase 6)

| Issue | What the zoo hit | State |
| --- | --- | --- |
| 32715651 | Imported submodules were pointer files, so the Python C build failed in every check. | Fixed for checks: run 3 lands all Python Lanes. Clone and Lane checkouts still hold pointers (33b1b4f8). |
| 17cce1b3 | A check-only wait during compose reports "produced no check run". The runs are dispatched 10-15 s later (5/5). | Builder assigned. The runner no longer uses check-only. |
| 77fa4412 | The runner repository must carry Forge's control code, and each project needs its own operator binding. | Open. |
| 72ac4315 | Deleting a born-hosted project needs a Git worktree root, and a re-import's slug is not shown. | Open. |
| e89be958 (comment) | Preflight declarations only in package.json. | `forge.json` landed during the run. |
| d95d9b41 | With the package graph live, the default `preflight: require` makes inferred package commands mandatory. Mixed's `cargo test -p jiter` fails locally without the corpus its CI fetches, and land is refused although the hosted check passes. JVM's 4-module Gradle test is estimated at "about 1 min". | Fixed: run 3 lands the jvm and mixed conflict Lanes under the default policy (`advised`). |

Also observed, not filed:
- Recovering from a conflict takes three Forge steps (sync, resolve, land the resolution
  Lane), against Git's two (pull, push). All three are named by the receipts.
- The 5.6 reuse metric (`metrics`) reports "reuse rate unknown" on these projects.
- Run 3: the recorded `cliCommits` list was empty; no receipt names the CLI build. The runner now
  reads the installed CLI's `release-number.json` before and after (fixed in this change).
- Run 3: the run plan's lockfile digest is still empty for Go, Rust and Gradle (slice C, 721cd45c).
- On Rust, an edit to one leaf crate selects the whole workspace, because the root package is a
  dependent (comment on 1f2121cb).

## Re-running

```sh
cp scripts/bench-zoo/zoo.example.json ZOO_ROOT/zoo.json   # fill in deployment, forks, runner
node scripts/bench-zoo/run.mjs ZOO_ROOT [--repos go,rust] [--no-github-run] [--keep-checkouts]
```

The runner needs:
- a Forge login for the deployment;
- `gh` authenticated for the forks;
- each fork's `zoo-ci.yml` (workflow_dispatch running its CI script);
- a runner binding for each project.

It writes per-step receipts and a `RESULT.json` per run.

The second cross-language run (8c867d0d) reuses the same forks and projects.
