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

## Run 4 (mixed only, scoped first checks, 22:54Z)

One run on the mixed project after the opt-in line in its `.forge-zoo/ci.sh` (`uv sync`, then
`[ -z "${FORGE_CHECK_PACKAGES_RUN:-}" ] || exec "$FORGE_CHECK_PACKAGES_RUN"`, before the full
steps) and `configure-check` with `selection: {scope: "changed-paths"}`. N = 1. Preflight was clean
(main audit passed, no debt, runner set).

- Lanes A and B (`crates/jiter/build.rs`): the package graph selects 3 of 5 testable packages, so the
  first check stays full (`graph-full`, over 50%), as expected.
- Lane C (`crates/fuzz/...`): the gate was `graph-first` scoped, but the planner kept it full
  (`graph-full`): the graph also selects the virtual Python root `jiter-workspace` (`package = false`,
  dependency groups only), because `fuzz` is not a Cargo workspace member and the fallback widens to
  every enclosing testable package. Without that root package the same graph selects 1 of 4 and
  scopes (checked offline on the project's manifests). Effective scope: full on every run.
- Hosted check minutes were not lower than a full run: C 77 s, A 88 s plus a 75 s full recheck
  (`global-risk`), all full.
- The runner followed the asynchronous `land` receipt (`SUBMITTED`, exit 0) as if it had settled, so
  land timings in this run are submit times and the conflict recovery did not start. Fixed in
  `scripts/bench-zoo/run.mjs` (`landPending`); not re-run live.

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

## Wave 2: eleven more ecosystems and an npm-workspaces monorepo (2026-11-09)

Issue 8c867d0d. Dev deployment, free GitHub-hosted runners, CLI on main (builds 5f840dc7 to 5d7e8ce4 over the day; each
RESULT.json names its CLI). N = 1 per repository unless a row says it was re-run. Same scenario as above, same
harness, one public repository per new ecosystem, imported from a NanthAI org fork, **every project's runner configured
by a runner grant only** (no operator binding, no stored binding, no owner step). Two or fewer repositories ran at a
time.

### Repositories and checks

Each fork carries `.forge-zoo/ci.sh` (the upstream CI test command) and `zoo-ci.yml` (the GitHub-equivalent full run). Every
command was first run on plain GitHub to be sure it passes there. The Forge check is `bash .forge-zoo/ci.sh` with the
declared toolchains and cache preset below (`actionsToolchains`, `actionsCache`; the generated `forge-check.yml` runs the
setup steps).

| Id | Ecosystem | Upstream | Check command | Declared toolchain, cache | Why this repository, and changes to its CI |
| --- | --- | --- | --- | --- | --- |
| csharp | C# | ardalis/GuardClauses | `dotnet test` (net8.0, xunit) | dotnet 8.0.x, nuget | small library, active |
| electron | Electron | sindresorhus/electron-store | `node --test` under `xvfb-run`, `ELECTRON_DISABLE_SANDBOX=1` | none (Forge's Node), npm | a module whose tests launch Electron; one source file. Plain `npm test` also runs `xo`, which rejects the lowercase probe comment |
| elixir | Elixir | elixir-plug/plug | `mix deps.get`, `mix test` | elixir 1.18 / OTP 27, hex | as proposed |
| ruby | Ruby | sinatra/sinatra | `bundle install`, `rake test:core` | ruby 3.4, bundler | as proposed; full `rake test` has 5 markdown errors on plain GitHub with current gems |
| php | PHP | guzzle/psr7 (branch 3.2) | `composer install`, phpunit | php 8.4, composer | as proposed |
| swift | Swift | apple/swift-argument-parser | `swift test` | none (runner image's Swift), swiftpm | as proposed |
| android | Kotlin/Android | JakeWharton/timber | `./gradlew test` | java 26 (zulu), gradle | kotlinpoet is already in the five (jvm); timber is an Android library |
| dart | Dart | felangel/equatable | `dart pub get`, `dart test` | dart stable, pub | as proposed |
| flutter | Flutter | rrousselGit/flutter_hooks | `flutter test` in 3 packages | flutter stable, pub | no small, active Flutter app with tests was found; this is a 3-package Flutter repository |
| cpp | C/C++ | fmtlib/fmt | cmake + Ninja build, `ctest` | cmake 3.31.6 | as proposed |
| zig | Zig | Hejsil/zig-clap | `zig test clap.zig`, `zig build examples` | zig 0.17.1, zig | master needs Zig 0.17 |
| npmws | npm workspaces | Quramy/npm-ts-workspaces-example | `npm ci`, `npm run compile`, `npm test` | none, npm | added for e0c3ac90: two packages, `@quramy/x-cli` imports `@quramy/x-core` |

### Harness changes (same Lane)

- Comment syntax and test-path rules for the new languages (C#, Swift, Dart, PHP, Zig, Elixir, C++ headers, `.mjs`/`.cjs`);
  a probe never falls in a submodule path (`.gitmodules`); a one-module library gets a test file as its second probe.
- A repository can declare its own check (toolchains, cache) and runner; `--prepare-only` imports and configures
  without landing.
- The conflict tag goes on the last line short enough to take a trailing comment (a formatter such as spotless rejects a long line
  with a comment appended, which failed the jvm check once).
- `PREFLIGHT_REQUIRED` is followed by its named recovery (run the Lane's preflight, land again once), and both are recorded.
- Recorded per run: the runner grant in check-settings, lane A's preflight plan (the land receipt of an asynchronous land
  carries none), GitHub run times, and where the runner workflow gets the control code.
- Plain-git clones recurse into submodules, as the Forge clone does now.

### Results

Seconds are submit to commit of each landing (A and C are submitted 2 s apart; B is the forced conflict, resolved and
landed). "Landed" counts landings on accepted main; every landed edit was checked on main by a fresh clone (both conflict
tags on one line, the C line present, no markers). Rows marked (replay) are from the zoo re-run by the builder of the Candidate
sandbox fix (Lane 44a6c027, Issue f325cede) after its change deployed, in the same ZOO_ROOT; they are not my measurements.

| Repo | Landed | A / C / B (s) | Conflict reported (s) | Refusals | Declared setup steps (ran before the check command) |
| --- | --- | --- | --- | --- | --- |
| csharp | 3 | 68 / 53 / 52 | 13 | none | setup-dotnet, nuget restore |
| electron | 3 (first run 2) | 59 / 128 / 51 | 16 | `PREFLIGHT_REQUIRED` on the test-file Lane, recovered | none declared |
| elixir | 3 (replay; first run 0) | 74 / 66 / 60 | 14 | first run `CHECK_FAILED`: `erlexec: not found` | setup-beam |
| ruby | 3 (replay; first run 0) | 116 / 141 / 90 | 13 | first run `CHECK_FAILED`: `bundle install` EPERM | setup-ruby |
| php | 3 | 72 / 109 / 48 | 12 | none | setup-php, composer restore |
| swift | 3 | 122 / 280 / 396 | 13 | none | runner image Swift, swiftpm restore |
| android | 3 | 138 / 200 / 166 | 13 | none | setup-java, gradle restore |
| dart | 3 | 54 / 66 / 346 | 14 | none | setup-dart, pub restore |
| flutter | 0 | – | – | `CHECK_FAILED` (first run `Permission denied` in the SDK; later `Failed to update packages`) | flutter-action |
| cpp | 3 (replay; first run 0) | 235 / 219 / 174 | 15 | first run `CHECK_FAILED`: `EROFS` chown in the sandbox; last wait `HOSTED_PROTOCOL_INVALID` | get-cmake |
| zig | 3 | 152 / 299 / 146 | 13 | none | setup-zig, zig restore |
| npmws | 3 (+1 proof Lane) | 43 / 54 / 35 | 14 | none | none |

The five original repositories, re-imported as new projects with grants only (Issue 77fa4412):

| Repo | Landed | A / C / B (s) | Conflict reported (s) | Refusals |
| --- | --- | --- | --- | --- |
| go | 3 | 245 / 260 / 239 | 13 | none |
| python | 3 | 379 / 362 / 51 | 18 | none (first two runs: probe fell in the submodule, `NOTHING_TO_LAND`: harness fixed) |
| rust | 3 | 69 / 159 / 64 | 13 | none |
| jvm | 3 | 477 / 515 / 536 | 19 | last wait `HOSTED_PROTOCOL_INVALID` (all three had committed); earlier run: `CHECK_FAILED` on spotless, harness fixed |
| mixed | 3 | 611 / 442 / 146 | 13 | none |

B on dart (346 s) and swift (396 s) includes the roughly 300 s commit lag of Issue 03a749a5.

Reading the table:

- **Seven of the twelve new repositories landed 3 changes on their first run** (csharp, php, swift, android, dart, zig, npmws).
  Electron did on its third run (after a lint rule in the repo's own `npm test` and the preflight refusal below), and elixir,
  ruby and cpp after the sandbox fix. Flutter does not yet.
- **Four of the seven late toolchains failed for the Candidate user at first use**: elixir, ruby, flutter and cmake
  all ran their setup step and then failed when the check command ran as `forge-check` (toolchain homes the sandbox
  did not bind, or that the toolchain writes into). Dart, PHP and Zig (the other late tools) and .NET, Java and Swift worked as installed. One
  root cause Issue for each is below; one Lane (44a6c027) fixed three of them.
- **Every refusal carried a reason.** `PREFLIGHT_REQUIRED` named the test file and the preflight to run; after the
  preflight failed, its next message said only "last run failed" (9ab983fd, fixed).
- **Check reuse after a clean overtake**: `clean-disjoint-v2` on csharp, php, android, dart, go, python, npmws (the overtaken change landed
  on its first run). `global-risk` rechecks on swift (`Package.swift`), zig (`build.zig`), rust and mixed (`build.rs`): the probe's shallowest
  file there is a build input, so the recheck is the intended rule. Electron's C Lane also rechecked as `global-risk`; I did not investigate why.
- **Gates**: every first check is `full` / "Intent has no contract". The scoped recheck gate recorded `effective: full`
  on all of them (the checks declare no selection), as in run 3.

### Affected-test selection

Lane A's preflight plan, from the CLI at the time:

| Repo | Plan | Selected / why |
| --- | --- | --- |
| csharp | scoped | `dotnet test test/GuardClauses.UnitTests/...csproj`: 1 changed and 1 dependent package of 2 |
| android | scoped | `gradle :timber-sample:test :timber:allTests`: 1 changed and 2 dependent of 3 |
| flutter | scoped | `flutter test` in `packages/cupertino_hooks` only: 1 changed, 0 dependent of 5 |
| npmws | scoped | `npm run test --workspace=packages/x-cli`: 1 changed and 0 dependent of 2 |
| go | scoped | 3 package commands (changed package plus 2 dependents of 4) |
| php, ruby, swift, dart, elixir | full | the probe file belongs to the root package, which is affected, so the whole suite is the selection ("the landing check runs every package") |
| electron | none | 0 changed test files, no test named for or reaching the changed module; the other tests run in the landing check |
| cpp, zig | unavailable | no package graph for CMake or Zig and no declared runner; the message names the `forge.json` `preflight.tests` declaration |

The hosted checks run the whole `ci.sh` in every case: none of these checks declares `selection`, so the package graph never
reaches the hosted command (as in run 3).

### Runner grants and control code (Issue 77fa4412)

17 projects (the five, eleven ecosystems and npmws) were configured with `configure-runner` and nothing else. Each
check-settings shows `runnerGrant` for the same installation and `agentLandsOnPass: true` with no blockers. The runner workflow still
checks out control code with `ref: ${{ github.sha }}` of the runner repository itself (read from GitHub at the end of
every run: not fetched by digest). That is P7 Issue 0eccbd31.

### Check minutes and cost

| Repo | Forge job min | GitHub full run (s) | GitHub-equivalent min (7 runs) |
| --- | --- | --- | --- |
| csharp | 3.3 | 24 | 2.8 |
| electron | 3.6 | 24 | 2.8 |
| php | 2.6 | 9 | 1.1 |
| swift | 8.0 | 129 | 15.1 |
| android | 10.8 | 118 | 13.8 |
| dart | 3.3 | 21 | 2.5 |
| zig | 9.4 | 116 | 13.5 |
| npmws | 2.3 | 9 | 1.1 |
| go | 16.0 | 199 | 23.2 |
| python | 3.3 | 21 | 2.5 |
| rust | 4.5 | 28 | 3.3 |
| jvm | 23.9 | 415 | 48.4 |
| mixed | 8.1 | 81 | 9.5 |

Forge used 49-85% of the GitHub-equivalent minutes on the slower checks (jvm 49%, swift 53%, go 69%, zig 70%, android 78%,
mixed 85%) and 118-236% on the fast ones (csharp, electron, dart, python, rust, npmws, php), where the roughly 25 s fixed
cost per job dominates. GitHub job queue time was 6-743 s per
repository: the shared runner repository was busy with other work, and Forge's landing time includes it (python 743 s,
flutter 650 s).

Convex (project-attributed meter, 31 valid runs including voided ones): **$0.088 in total** over about 11,000 project
executions; $0.002-0.012 per repository run; the npm-workspaces project was not metered (new project). R2 and storage are
not metered here.

### Measurement holds

A bench driver held landings four times in the day (08:28-09:13Z, 09:57-11:08Z, 12:19-13:06Z, 13:22-about 13:54Z). A held `land`
waits; one of my runs hit the 40-minute command bound and was repeated (the bound is 120 minutes now), two others were stopped
before any submission and re-run. A landing's own check runs are not affected. The land seconds above are submit to commit and
exclude the hold wait.

### New Issues (Phase 6)

| Issue | What it found |
| --- | --- |
| f325cede | Elixir: setup-beam's OTP and Hex are not visible to the Candidate user (`toolchainReadable()` binds the PATH leaf only). |
| 1f67da41 | Ruby: `bundle install` cannot write the setup-ruby gem home as `forge-check` (EPERM). |
| 868ebd92 | Flutter: the SDK writes into its own directory (Permission denied). |
| 68632a64 | CMake: EROFS in the sandbox mount plan (`candidate-sandbox.mjs:59`). The four above share the Candidate-sandbox Lane 44a6c027. |
| 9ab983fd | A changed test file is refused `PREFLIGHT_REQUIRED` when the preflight fails only because dependencies are not installed in the Lane. Fixed. |
| 03a749a5 | The last landing committed about 300 s after its check result was reported (dart, swift). Fixed (receipt caa934a7, deployed 13:25Z); commit-lag evidence is on the Issue. |
| 71ef0a66 | A running `wait` fails `HOSTED_PROTOCOL_INVALID` on its final read, 1 s after the landing committed (jvm, cpp). |

### npm workspaces: a Lane's sibling import (Issue e0c3ac90)

`@quramy/x-cli` imports `@quramy/x-core`. `nforge start` (3.0 s cold, 1.8 s for two further Lanes, no install) links
`node_modules/@quramy/x-core` to the Lane's own `packages/x-core`. A Lane that changed `x-core` and asserted it in
`x-cli`'s spec passed locally and in the hosted check (receipt dae1202a); a control Lane with the same spec and no `x-core` edit failed the hosted check
with `'Hello' == 'Hello from the Lane'`. The `.bin` limit was not exercised.

### Limits of this run

- N = 1 per repository; the replays of elixir, ruby, cpp and dart are by another builder and use a later CLI.
- Flutter has no landed change. Electron and Elixir cover a module and a library, not an application.
- The probe edits are comments; they show landing, conflict and check behavior, not correctness of a code change.
- Teardown status is in the Issue 8c867d0d comments.

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

A repository may carry its own `check` (toolchains, cache) and `runner` in `zoo.json`; `--prepare-only` imports and
configures without landing. The original five were re-imported as new projects in wave 2.
