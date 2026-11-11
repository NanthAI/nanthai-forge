# Pre-queue Lane checks

Decision record for running each Lane's own full check before the hosted landing
queue, on whatever runner the project configured. Behaviour lives in
[landing batches](operations/landing-batches.md#pre-queue-lane-checks); the model
is [`models/landing-queue`](../models/landing-queue/README.md).

Landing documentation calls the accepted destination Channel `main`; a receipt's target Channel refers to that same destination, including when the project names it differently.

## Context

With 12 builders in parallel, each change's first full check ran inside the serial
queue: builders skip the near-full suite locally, and a check-only pass counts only
while main is unchanged, which never holds at that rate. The queue became the place
where broken changes were first found. In one wave, 44 of 51 check runs failed or
were cancelled, isolating one culprit took about 75 minutes, and a passing check
takes about 22 minutes. Merge-queue tools avoid this by running each change's CI
before it enters the queue, so the queue mostly sees green.

The owner kept two constraints: **bring your own CI** (any runner configured
through `configure-check` / `configure-runner`: GitHub Actions, other hosted CI,
self-hosted machines, the local runner; nothing GitHub-specific in the core path)
and **proved reuse** as the S2 contract for acceptance across a main move.

## Decision

`acceptance.admissionCheck: "full"` turns the existing admission run into a
pre-queue Lane check. It is the default: a project without the setting gets it,
and `false` opts out (owner decision, 2026-11-05). A finish that carries no
configured check (no `configure-check`) skips it and queues as before.

1. **Lane check.** When a batchable owner-agent finish is submitted (`land`,
   `land --save`), Forge enqueues the project's configured check, with its
   configured gate, for that change alone on the main it composed on. Every
   arrival's check runs at once, in parallel, on the project's own runner through
   the ordinary `enqueueHostedCheck` path, so every runner provider is eligible.
   WIP saves never start a check; `land --save --check-only` keeps its existing
   reuse.
   A strict-mode arrival with known, disjoint paths that have an unplaceable
   global-risk interaction with a pending full admission uses the existing
   predicted-head pipeline instead of spending a solo run that cannot carry the
   combination. It checks the exact union on the predecessor's reserved head and
   receipt while that predecessor is still checking. The same actor, authority,
   policy, priority and check pins must agree, and a pipeline slot must be free.
   Independent arrivals, overlapping paths, placeable manifests, fast mode and
   unknown evidence retain their ordinary Lane checks. Publication still waits
   for the exact predecessor to land; failure, a review hold or changed pins
   retire the dependent generation and restore its original selection. A failed
   speculative combination cannot reject that fresh selection.

2. **Admission rules.** The submission is not in the queue while its Lane check
   runs: it is not runnable, not batchable and holds no queue order.
   - A failing test ends it with `CHECK_FAILED` and its failing files. A change
     known to be red never enters the queue.
   - A run that ends without a failing test (runner unavailable, cancelled,
     timeout) starts a new Lane check, at most twice; then the change enters
     unadmitted. Unknown is not red.
   - A pass enters the queue. Queue order is the time a change entered the queue,
     not its submission time: an older submission still checking, or one that
     re-entered after a refused proof, never holds back a change that entered
     before it.
   - **Reservation after a supersession** (Issue 10d253c6). Because a checking
     submission holds no order, small changes to the same files can land while a
     large change checks, and its passed check then fails `COMPOSITION_CONFLICT`
     when it composes onto the moved main. The next submission of the same Intent
     after one such supersession (a passed check, then the conflict) reserves the
     files it changes for 30 minutes: a passed landing that changes any of them
     waits for it (order wait `reason:"reservation"`) instead of taking main
     first, and the holder never waits for an older entry its reservation holds
     back. The reservation ends when its landing lands or fails, or at its time,
     whichever is first; nothing extends it. Urgent owner landings, members of the
     holder's own group and an earlier holder never wait; unknown paths count as
     overlapping. `status`, the finish wait and the land summary show
     `reservation {until, live, superseded}`. Cost: the count and the end are
     stored on the new submission's own row (no extra write); a claim reads one
     indexed window of live reservations and, only while one is live, the paths.
     The landing-queue model checks it (`reserve`, `reserve-fixed`: within two
     attempts, no deadlock, every reservation ends).
3. **The queue re-verifies only the combination.** An admitted change first tries
   its own Lane run, once:
   - on unchanged main, that run is the exact acceptance evidence and the change
     lands with no second run;
   - on a moved main, it **lands on that first check** when all of these hold
     (rule `clean-disjoint-v1`, Issue 7fe54c7c): the run passed the project's
     whole check (or, for a docs-only change, its docs selection) on its base;
     the change recomposes onto current main byte-exactly with no text conflict;
     the paths main gained since that base are disjoint from the change's paths;
     no path on either side is a [global-risk file](#global-risk-files); and no
     changed path is a symlink or submodule on any side (links the change and main
     leave alone, anywhere in the tree, do not count). The
     rule reads only Forge data (manifests, the run's selection, receipts), so it
     works with any CI and any check command. The coalesced [main audit](workflows.md#hosted-acceptance-gate)
     is armed at once and covers the new head with one full run.
     Rule `clean-disjoint-v2` also lands a change whose only overlap with main is a
     clean text merge of Markdown that no test or script reads: the runner pins
     those files in its selection (`testedDocs`, any Markdown whose file name a code,
     JSON, HTML or YAML file mentions); a missing list means every Markdown is tested.
     Paths whose blob and mode (or deletion) are identical in the checked, current
     main and recomposed trees are recorded as `identicalPaths`: both checks already
     saw that change, so it contributes no overlap. The complete changed-path
     lists still decide global risk, declared check inputs, package placement and
     shared sequence/fixture folders: identical configuration does not prove the
     new combination passes under it. Differing entries keep the usual rules.
     If the entire recomposed file tree equals the checked tree, the existing
     `exact-tree-v1` proof carries the full pass, including for ancestry-only main
     moves outside the pipeline path. All current policy, check and audit gates remain.
     A docs-only landing after a full green run advances that run's coverage frontier,
     while retaining the exact source head its full run checked. Consecutive docs-only
     landings therefore preserve a usable full audit baseline. They cannot cover an
     intervening unaudited code landing, clear red main or erase audit debt.
   - Otherwise (any doubt: overlap, global-risk file, text conflict, a scoped
     first run, red main or audit debt, unreadable evidence) the proof is refused,
     the change re-enters the queue as a new entry and joins a cohort for one
     combined check.
   The receipt's `firstCheck` says which path it took: `{"landedOn":"admission-run","mainMoved":…}`
   , `{"landedOn":"scoped-intersection","reason":…,"selection":…,"tests":…}` for a
   [scoped recheck](workflows.md#hosted-acceptance-gate) (the tests that can see both
   changes, own tests and smoke)
   or `{"landedOn":"recheck","reason":…}` with the recheck reason (`path-overlap`,
   `tested-doc`, `global-risk`, `unsupported-mode`, `text-conflict`, `checked-not-full`, `main-red`, `audit-debt`,
   `cohort`, `reuse-policy`, …); `metrics` counts every code and flags the limitations
   ([fallback reasons](operations.md#fallback-reasons)).
   Cohorts of admitted changes use the admitted failure prior, so they are larger.
   A refused change waits for peers still deciding their own Lane run (bounded by
   the train hold, holding no queue order, with one armed wake), so the refused
   changes of one wave share one cohort check (Issue 10b0a94b).
   A Lane run that a moved main has made stale is refused before its turn when
   every older change holding order is itself refused or stale and nothing else
   can move main first, so the wave recomposes in one pass instead of one change
   after another. It is the same one refusal and recomposition, earlier: no new
   check and no added Convex calls (Issue 7fe54c7c).

### Global-risk files

One list, in `src/first-check-risk.ts` (rule `first-check-risk-v6`; a proof pins the
rule it was decided under, so older receipts keep their v1 to v5 decisions). The
same list decides which older landing a newer one may overtake. A change or a main
delta touching any of these always rechecks, except a placed manifest (below). When a
shape is in doubt it is on the list: a wrong match costs one recheck, a miss lands a
change on a check that never ran the new harness.

- package manifests and lockfiles (npm, pnpm, Yarn, Bun, Cargo, Go, Python,
  Ruby, Composer, Maven, Gradle) and `.npmrc`/`.yarnrc`;
- TypeScript, build, lint, format and test-runner configuration (`tsconfig*.json`,
  `*.config.{js,ts,…}`, Oxlint/Oxfmt/ESLint/Prettier/Babel/SWC configs,
  `.editorconfig`, `.nvmrc`, `.node-version`, `.tool-versions`, `Makefile`,
  `Dockerfile`);
- CI configuration on any provider (`.github/`, GitLab, CircleCI, Buildkite,
  Forgejo, Woodpecker, Jenkins, Azure Pipelines, Bitbucket Pipelines);
- every repository file the project's check command or its Actions setup command
  (`actions.setup`) names: its executable, its arguments and any path inside a shell
  string such as `bash -c "./ci/run.sh"` (the check contract's own entry points;
  `checkRunEntryPaths`). Forge's own standard check
  (`node scripts/forge-check.mjs`, `isStandardForgeCheck` in `src/standard-check.ts`)
  also declares its extra inputs there: its check scripts, check contract and
  shared test runtime (`scripts/verify`, `check-contract`, `check-path-scopes`,
  `test-*`, `tests/check-runtime.mjs`, …). Other repositories' files of the same
  names are ordinary files, except `scripts/check-contract.mjs`, which the Actions
  executor reads from every Candidate;
- from v2, build inputs of other ecosystems at any depth: Rust (`build.rs`,
  `.cargo/config(.toml)`, `rust-toolchain`), Python (`conftest.py`, `pytest.ini`,
  `tox.ini`, `noxfile.py`, `mypy.ini`, `.python-version`), .NET (`*.csproj`,
  `*.fsproj`, `*.vbproj`, `*.sln(x)`, `Directory.Build.props/targets`,
  `Directory.Packages.props`, `packages.lock.json`, `global.json`, `nuget.config`),
  Gradle (`gradle/libs.versions.toml`, `*.versions.toml`, `gradle-wrapper.properties`,
  `buildSrc/**`), Bazel (`BUILD(.bazel)`, `WORKSPACE`, `MODULE.bazel`, `.bazelrc`,
  `*.bzl`), CMake (`CMakeLists.txt`, `CMakePresets.json`, `*.cmake`) and `go.work.sum`;
- database schema (`convex/schema.ts`, `schema.prisma`, and from v2 `schema.rb`,
  `schema.sql`, `structure.sql`);
- from v2, a **sequence folder** both sides changed: when the change and main each
  changed a file under the same `migrations`/`migration` folder, `db/migrate` or
  `alembic/versions` (Django, Rails, Flyway, Prisma, Alembic), the change rechecks even
  though the paths are disjoint (`0005_a.py` and `0005_b.py` would leave two leaf
  migrations on main). Reads paths only; folders in different places do not interact;
- from v5, a **shared test folder** both sides changed, by the same rule: `fixtures`,
  `__fixtures__`, `__snapshots__`, `snapshots`, `testdata`/`test-data`, `golden`/`goldens`,
  golden-file and `cassettes` folders at any depth (the outermost one is the key). Tests
  often list or glob such a folder, and a snapshot runner fails on an obsolete or
  unexpected snapshot, so two disjoint files in one folder can still break a test that
  neither side ran with the other's file. A fixture changed on one side only stays
  reusable;
- from v6, Apple, Android and Dart build inputs v1 to v5 do not name: Xcode project and
  workspace contents (`*.xcodeproj/**`, `*.xcworkspace/**`, shared schemes), `*.xcconfig`,
  `*.xctestplan`, Gradle script plugins (`*.gradle`, `*.gradle.kts` at any depth),
  `proguard-rules.pro`, `dart_test.yaml` and `build_runner`'s `build.yaml` (Issue 870791c3);
- from v4 (`src/first-check-risk-v4.ts`), test-harness, runner and build files of every
  ecosystem by shape, at any depth: runner setup files (`vitest.setup.ts`,
  `jest.preset.js`, `vitest.workspace.ts`, `setupTests.ts`, `global-setup.ts`,
  `karma.conf.js`), harness-named files and `support/` or `setup/` folders inside a
  test folder (`spec/spec_helper.rb`, `spec/rails_helper.rb`, `spec/support/**`,
  `test/test_helper.exs`, `tests/bootstrap.php`, `test/setup.ts`), Jest `__mocks__/`,
  dot-rc files (`.mocharc.yml`, `.nycrc`, `.coveragerc`), `.rspec`, `phpunit.xml(.dist)`,
  `.env*`, compose files, and the build and dependency files of Ruby, Elixir, Swift,
  Dart, Scala, Deno, Bun, Nix, Haskell, OCaml, Zig, C/C++ (Meson, `*.mk`, Conan, vcpkg)
  and JS workspace tools (`turbo.json`, `nx.json`, `project.json`); a test file itself
  (`*.test.*`, `*_spec.*`) is not harness;
- every path matching the check definition's declared `globalRiskPaths` (below);
- any other root-level file that is not `.md` or a prose `.txt` (`README`, `LICENSE`,
  `NOTICE`, `CHANGELOG`, `llms.txt`, …; before v4 every root `.txt`).

A project declares what Forge cannot recognise by shape (a custom harness folder, a
fixture corpus every test reads) as `globalRiskPaths` on its check definition:
repository-relative globs (`**`, `*`, `?`, `{a,b}`; at most 64), part of the definition
digest. They are risk for first-check reuse and for overtaking only; unlike the command's
entry files they need no owner approval.

```sh
nforge x ROOT configure-check '{"command":{"name":"verify","executable":"bash","args":["ci/check.sh"],"environmentLabel":"","globalRiskPaths":["test/harness/**","fixtures/shared/**"]}}'
```

From v3 (Issue 5cfcca4b), a package manifest or lockfile inside a package is
**placed**: the checked run pins its manifest package graph in the selection
(`packagePlacement`, rule `package-placement-v2`: each package's ecosystem, folder
and dependencies, the packages with references the graph cannot place, and whether
forge.json declares the cross-ecosystem edges, at most 128 KiB; `src/package-placement.ts`).
Its reach is that package plus every package that depends on it, widened like the
package graph's selection (unresolved packages, other ecosystems). The change lands on its first check
when the other side's paths all lie outside that reach (a path outside every package
counts only when it is Markdown or under `docs/`); the proof records `placedRisk`
(each placed path and its reach). Root and workspace files (`pnpm-workspace.yaml`,
`.npmrc`, `.yarnrc`, `go.work`, `settings.gradle`, `gradle.properties`), every other
risk file, a missing pin, and placed manifests on both sides keep the recheck. Works
for every ecosystem the [package graph](workflows.md#check-command-scope) reads (npm, Cargo, Go, Gradle, …).

The Lane check never re-runs because main moved. Re-running it would race main
again (model finding 5, moving-main starvation) and add a full run per move; the
combined check verifies the same interaction once per cohort.

## Landing modes

`acceptance.landingMode` chooses what a moved main costs. Absent is `strict`. The rule is
`src/landing-mode.ts`, one derive shared by the server, the CLI and the web.

| Mode | What it promises | When a moved main needs the second check |
| --- | --- | --- |
| `strict` (default) | A change lands on a check of exactly its content, or on its own check when it is proved disjoint from what main gained. With `hostedCrossHeadReuse:false` only the exact check lands. | Every refusal of the first-check rule above. |
| `fast` | A change lands on its own check; main is verified after the landing and recovers fast: the audit finds a break, Forge reverts the one proven culprit or opens a fix. Fast mode does not promise that main is always green. | `path-overlap`, `order-sensitive`, a text conflict, a scoped first run, a changed link, unreadable evidence, and any time fast mode is not in effect. |

Fast mode relaxes two refusal classes and nothing else: `tested-doc` (a clean text merge of a
Markdown file that a test reads) and `global-risk` that is not order-sensitive (manifests,
lockfiles, build and test-runner setup, other root files). The receipt's proof is
`fast-first-check-v1`; it names the classes it relaxed (`relaxed`) and the risk paths.

**Order-sensitive risk always gets the second check**, in both modes, and is recorded as
`order-sensitive`: database schema files; a migration, fixture or snapshot folder both sides
changed; the check's own entry files, check contract and declared `globalRiskPaths`; CI
configuration; lint, format and type-rule configuration (`tsconfig*.json`, ESLint, Oxlint,
Prettier, Biome, Ruff, RuboCop, Clippy and similar). To keep any other path on the second
check, declare it in the check's `globalRiskPaths`.

**Fast follows the owner's policy, with a circuit breaker.** No earning count or drill is
required. Fast carries a landing while all of these hold:

1. the policy is `fast`;
2. a green main audit is on record (an accepted exact full check also establishes this baseline);
3. main is not red and the audit is fresh: no audit newer than the last green ended without a
   verdict, at most 10 landings are unaudited and their oldest is at most 60 minutes old;
4. fewer than 3 real red audits occurred in the last 50 audited landings, and fewer than 3 of
   the last 50 audits ended without a clean verdict (flaky or stalled).

Freshness and the breaker are checked when the proof is decided and again in the publication
transaction. A proof based on main's own exact full check has no audit lag to bound. Otherwise
it gets the second check; a passed full second check audits main too. A single recovered red
pauses fast only until main is green and audited again. A new project can use fast after its
first green main audit. Repeated trouble pauses fast and advises the owner and next agent to
switch to strict; it resumes automatically when the window clears, if policy remains fast.
Forge never edits that policy automatically.

The existing main audit row retains at most 50 compact verdicts, updated only in transactions
that already write the row. Each compact slot pairs a red count at an audited landing position with a recent audit
verdict. The two horizons advance independently: a coalesced green audit advances the red
horizon by its covered landings, while unclear verdicts count once per audit, including its
retry. At most 50 landing positions and 50 audit verdicts fit in those 50 slots. A flake replaces the failed verdict with one unclear
verdict. A missing window starts empty; no history recount or backfill runs. Retired earning
fields have no readers and are removed by the next verdict write; their schema validator
only tolerates existing rows during deployment. Older CLIs' recount requests return an inert
compatibility reply: nothing is scheduled and the window stays unchanged.

**Optional red-audit drill.** To exercise detection and recovery, the owner can start a drill.
It is advice, never an eligibility condition. From an agent sign-in, the existing owner
approval still applies:

```sh
nforge x ROOT configure-runner '{"mainAudit":{"drill":"start"}}'
```

The drill claims the first red main audit within 2 hours of its start and cannot start while
main is red. Normal recovery still applies. A deliberate drill recovered within 2 hours of its
red is recorded as a drill rather than a real red; a late drill counts as real. A flake-cleared
red counts as unclear. Events retain start, red, recovery and end times and the outcome
(`recovered`, `late` or `flake`); `check-settings` `mainAudit.drill` shows a drill in progress.

**Flake policy.** A failed audit re-runs its failing files once on the same head. A pass there
vouches for the audit, records a `flake` and clears main red; its verdict counts as one unclear
audit. The retry count stays fixed at one.

**Advice.** `check-settings` (`mainAudit.landing`), web project settings and the next land
receipt show the policy mode, effective mode, reason when paused and one next step. The
receipt retains the observation from check selection, without another status call. Live
trouble resumes automatically after a green, fresh audit. The circuit breaker advises switching
to strict after 3 real reds or 3 unclear audits in the stated windows. To choose fast:

```sh
nforge x ROOT set-policy '{"acceptance":{"landingMode":"fast"}}'
```

Switching the mode never invalidates a queued landing: it is read when a proof is decided. From an
agent sign-in, switching fast on is held for the owner person, like any edit that changes what may
land; switching back to strict applies at once.

## Three test tiers

Each tier answers a different question. None depends on a particular CI provider.

1. **Local (builder machine): a quick first answer.** Preflight runs the tests
   closest to the change first (the changed tests, then direct and nearer
   transitive consumers), with a measured time estimate instead of a fixed cut.
   Issue c14f4065 replaced the former fixed 25-file cap for nearby consumers with
   this: tiers in order (changed tests, explicit coverage and smoke; tests that
   failed for these paths before; direct tests, which run a changed module
   themselves, through a test fixture or through one module that imports it;
   hub consumers, recent landing failures within two modules, name-watch and
   two-module consumers), with only the last four trimmed by a local time budget
   (180 s by default, `budgetSeconds` overrides). The budget is also a wall-time
   cap: the run starts no file once it is spent and names those files in
   `stopped`, with `stoppedRerun` to run just them. The plan, the receipt and
   the builder output name the rule, the trimmed tier and files, the one command
   that runs them (`trim:false`), the estimate and the number of tests left for this
   pre-queue tier. The local tier **may leave out** any hub, name-watch or farther
   consumer of the change, plus the near-full set that preflight already hands to
   the runner. It never decides acceptance. A docs-only change parses no import
   graph: the local tier runs only the tests that read a changed document, beside
   the static checks. Tiers 2 and 3 select the same readers (one shared selector,
   `scripts/docs-readers.mjs`) beside the documents checks, and nothing more: a document
   no test reads still runs no test file, and the docs scope keeps its rules (no full
   re-check, the main-audit skip: a docs-only pass that also passes its readers still
   inherits a green parent).
   A repo-wide guard (a rules or lint-style test that lists a folder and checks every
   file in it) is explicit coverage of each file in that folder, in every tier and for
   code and documents alike: `scripts/test-tree-scanners.mjs` finds tests whose
   `readdir`, `opendir` or `glob` argument is built from the repository base
   (`import.meta` or `process.cwd()`) and takes the folder names that flow into it.
   No import edge reaches such a test, so before this a new literal in a scanned
   file could fail only the landing check.
2. **Pre-queue Lane check (project runner, any CI): the complete consumer set,
   off the builder's machine.** It runs the project's configured check on the
   project's runner. Forge's `verify` selects either the full suite or every
   transitive test importer of the change plus fixed smoke coverage, all static
   checks included. That is the same selector with no closeness cut, so it contains
   every test the local tier left out. **Guarantee:** with
   the pre-queue check on (the default), every test left out locally runs on the Lane's own
   Candidate before it can enter the queue, unless one of these is true:
   - the Lane check ended without a verdict after two restarts (unknown): the left-out
     tests then run first in the change's queue check;
   - the project configured a check whose selection is narrower than the consumer
     set (a custom command that declares `selection.scope` and scopes itself, or a
     contract gate that declares fewer tests): the pre-queue tier then covers only
     what that check selects. A custom command without that declaration runs in full;
   - a disjoint global-risk interaction uses the pending full admission's exact
     predicted head in the pipeline: the left-out tests run in the combined full
     check before publication, rather than in a separate solo admission;
   - the project opted out (`admissionCheck: false` or `true`): there is no
     pre-queue tier, and left-out tests run first in the queue check.
3. **Landing (queue check of the combination): the authority.** It checks the
   exact combined head, or accepts by exact or proved reuse of tier 2, and the
   post-accept main audit runs the full suite on the new head. Tiers 1 and 2 never
   accept anything by themselves.

## Why not the alternatives

- **Check on every save:** most saves are checkpoints, not candidates; it multiplies
  runner minutes by the save count.
- **Scoped admission only (`admissionCheck: true`):** GitHub Actions only, and an
  affected-set selection misses failures outside the selector's view.
- **Re-check the Lane on each closure-touching main move:** see above; the cohort
  check is the cheaper and bounded re-check.
- **Proved reuse for whole cohorts:** a batch publishes several same-head receipts,
  which the existing recovery proof does not cover. Members try reuse one at a
  time instead, before cohorts form.

## Consequences

- Every submitted change costs one full check on the project's runner, in parallel,
  before the queue. A single Lane on unchanged main pays nothing extra: its Lane
  run is the landing check (one run, as without the Lane check). Queue checks run only for changes that are not independent of
  what landed meanwhile, or for unadmitted changes.
- Proved reuse works with any configured check command on any runner: the rule
  reads paths, manifests and the run's selection, never the command's own test
  selection. Every command receives the same changed-paths file
  ([check command scope](workflows.md#check-command-scope)); a scoped run of a command
  that declares `selection.scope` is scoped evidence, so it rechecks (`checked-not-full`)
  instead of landing on its first check, exactly like Forge's own scoped runs. It needs owner-agent automatic acceptance. A Markdown overlap lands
  on its first check only when the runner pinned a tested-docs list. Forge's own
  selector writes one; any other command writes it from its check's opt-in
  [`docsPaths`](#docs-only-paths) and otherwise rechecks such an overlap.
- Changes that land on their first check publish one by one, each proved against
  the main it lands on. A wave of k such changes makes up to k(k+1)/2 proof
  analyses (one action each, reading six small objects) and gives up the shared
  cohort publication, so it uses more Convex calls per landing than one cohort
  recheck (5-change fixture wave: 51 to 65) while it saves a full check per change.
- No polling: a Lane check wakes its submission only when its run reaches a
  terminal state, as admission did before. Idle costs nothing.

## Docs-only paths

A check definition may declare `docsPaths`, repository-relative globs of files that
no test or build reads (`**/*.md`, `docs/**`, `LICENSE`; same glob syntax as
`acceptance.protectedPaths`; at most 32). It works like GitHub's `paths-ignore` and
is **off by default**: a check without it always runs its whole command, and every
Markdown overlap rechecks. Declare it with `configure-check`:

```sh
nforge x ROOT configure-check '{"command":{"name":"verify","executable":"bash","args":["ci/check.sh"],"environmentLabel":"","docsPaths":["**/*.md","docs/**"]}}'
```

- **Docs-only change.** When every path a Candidate changes against its base matches
  `docsPaths`, the Actions runner runs no command and no install; the plan has the
  static job alone and the receipt records `skipped: tests not-affected`, as for
  Forge's own docs-only changes. Any other changed path runs the whole command.
  Audit runs, failed-file probes and composed Intent contract tests always run it.
- **Docs-only overlap.** A Markdown file matching `docsPaths` is pinned as untested,
  so a text-clean overlap of it after an overtake lands on its first check; every
  Markdown file outside the globs counts as read and rechecks. Overlaps of
  non-Markdown files always recheck. The Mac and self-hosted runners run the full
  command either way but pin the same list.
- **Forge's own check** (`node scripts/forge-check.mjs`) ignores the setting: its
  selector already knows which tests read which document, which is strictly
  better than a path list.
- The globs are part of the definition digest. Declare only paths nothing reads: a
  glob such as `**` skips every check, and a change to the check's own entry file
  under a declared path would run nothing.

## When to turn it off

Set `acceptance.admissionCheck: false` when one full check per change costs more
than the queue saves:

- the runner bills per minute and changes rarely fail their first check;
- the check is very long and the queue rarely holds more than one change, so
  there is nothing to run in parallel with;
- the runner has fewer free slots than changes arrive at once, so Lane checks
  would wait for each other anyway.

A solo user does not need to turn it off: a single Lane on unchanged main
lands on its Lane run with no second run.

## Measured effect

On the synthetic 12-Lane wave with 3 red changes, no queue check contained a red
change (before: 8 of 19) and no queue run was thrown away (before: 0.67 per
landing). With the cohort hold, the 8 changes that missed proved reuse share two
cohort checks instead of 7 groups: runner minutes per landing fell from 46 to 34,
landings per hour rose from 6.1 (8.2 without the hold) to 12.3 and Convex calls
per landing from 121 (99) to 77. A single Lane uses one run (22 runner minutes) with or without the Lane check.
Details are in [landing batches](operations/landing-batches.md#pre-queue-lane-checks).
The live effect on the project's runner is not yet measured.
