# Forge-only rules

Forge must work the same for every repository and every CI. Product code (`src/`, `convex/` and the
`scripts/*.mjs` files the package ships) may give Forge's own recipe extra speed, but only behind
the one predicate for it, and never at another project's expense:

- **Forge's standard check** is `node scripts/forge-check.mjs`. `isStandardForgeCheck` in
  [`src/standard-check.ts`](../src/standard-check.ts) is the only place that decides it; its extra
  inputs are `STANDARD_CHECK_INPUTS` in the same file.
- **Forge's Node test layout** is Node's test runner over `tests/*.test.mjs`
  (`layout: 'forge-node'` in [`src/project-test-runner.ts`](../src/project-test-runner.ts)). Its
  import-graph selector (`scripts/test-impact.mjs` and the `scripts/test-*.mjs` it uses) reads that
  layout. The layout is chosen only when the project declares that runner (`preflight.tests`) or has
  Forge's own check entry; an outside project with `node --test` over `tests/*.test.mjs` is not it. Any other project uses its own test runner and, in local preflight, the generic JS/TS
  import graph ([`src/js-import-graph.ts`](../src/js-import-graph.ts)).

Every other project gets the same fast paths through configuration (check definition, `docsPaths`,
`forge.preflight.tests`) or inference that never runs repository code. The
[BYOCI parity test](#byoci-parity) proves the landing fast paths do.

## The guard

`tests/forge-only-rules.test.mjs` runs in `npm run verify`. It scans product code for the literals
that have hidden Forge-only fast paths before, and fails on a hit that this page does not list, on a
listed file whose hit count changed, and on a stale row. To add one, route the branch through
`isStandardForgeCheck` or the project test runner first; list it here only when it is Forge's own
recipe, with why and what other repositories get instead.

| Rule | Matches |
| --- | --- |
| `check-entry` | the literal `scripts/forge-check.mjs` |
| `standard-from-args` | deciding Forge's check from `check.args[0]`, `args.length === 1` or `executable === 'node'` |
| `tests-folder` | a regular expression anchored on `^tests/`, a `startsWith('tests/')` prefix test, or a `.test.mjs` string or pattern |
| `docs-folder` | a regular expression anchored on `^docs/` or a `startsWith('docs/')` prefix test |
| `forge-folders` | an alternation or list of Forge's top-level folders (`src`, `web`, `convex`, `netlify`, `scripts`, `tests`, `dist`) |
| `npm-lockfile` | the literal `package-lock.json` |
| `node-test` | the argument `--test` (Node's test runner) |
| `build-folders` | product code and shipped scripts: a folder list or alternation with `dist`, `build` or `coverage`, as used to skip or drop paths |
| `js-extension` | product code and shipped scripts: a JavaScript/TypeScript extension pattern such as `/\.[cm]?[jt]sx?$/`, as used to gate a feature |
| `package-json-config` | product code and shipped scripts: `package.json` read as a config source |

The last three come from the JS/Node/npm audit (875a57cc). A gate on them must hold for every
ecosystem; rows that name an "any-ecosystem slice" Issue are live cases that slice fixes.

## Allowlist

| File | Rule | Hits | Why it is Forge-only | Other repositories get |
| --- | --- | --- | --- | --- |
| `src/standard-check.ts` | `check-entry` | 2 | defines the standard check entry | — (the predicate itself) |
| `src/standard-check.ts` | `standard-from-args` | 2 | the one predicate for Forge's check | — (the predicate itself) |
| `src/public-governance.ts` | `check-entry` | 1 | a default owner-approval path for Forge's own check script | their own check and setup entries, protected the same way (`definedCheckEntryPaths`) |
| `src/github-actions-workflow.ts` | `check-entry` | 2 | the workflow Forge generates for its standard check | their own configured command and workflow |
| `src/hosted-actions-export.ts` | `check-entry` | 1 | the marker inside that generated workflow | their own configured command |
| `scripts/script-impact.mjs` | `check-entry` | 1 | Forge's selector treats its check entry as global | their check entries are global-risk (`checkRunEntryPaths`) |
| `scripts/script-impact.mjs` | `forge-folders` | 1 | Forge's selector maps scripts to its own product folders | the project runner and the generic import graph |
| `scripts/test-impact.mjs` | `forge-folders` | 4 | Forge's selector inventory and product folders | the project runner and the generic import graph |
| `scripts/test-impact.mjs` | `tests-folder` | 9 | Forge's selector reads `tests/*.test.mjs` | their runner's test globs |
| `scripts/test-impact.mjs` | `npm-lockfile` | 2 | Forge's selector classifies installed packages from its npm lockfile | declared dependencies of every manifest (`src/js-import-graph.ts`) |
| `scripts/test-import-graph.mjs` | `forge-folders` | 4 | Forge's import graph: its folders, Convex names and loaders | the generic JS/TS import graph |
| `scripts/test-import-graph.mjs` | `tests-folder` | 4 | Forge's import graph: test-to-test edges in `tests/` | the generic JS/TS import graph |
| `scripts/test-import-graph.mjs` | `npm-lockfile` | 4 | Forge's import graph: external packages from its npm lockfile | declared dependencies of every manifest |
| `scripts/test-directory-path.mjs` | `forge-folders` | 2 | Forge's selector: directory reads in its tests and scripts | the generic JS/TS import graph |
| `scripts/check-path-scopes.mjs` | `docs-folder` | 1 | Forge's own repository path-scope check treats `docs/` as documentation | not run |
| `scripts/control-build-key.mjs` | `package-json-config` | 1 | the build key of Forge's own CLI | not used |
| `scripts/docs-readers.mjs` | `js-extension` | 1 | Forge's tested-docs reader scan matches JS/TS importers | declared `docsPaths` on their check definition |
| `scripts/script-impact.mjs` | `tests-folder` | 4 | Forge's selector maps scripts to named tests in `tests/` | the project runner and the generic import graph |
| `scripts/script-impact.mjs` | `build-folders` | 1 | an npm script-name pattern (`build`), not a folder | — |
| `scripts/script-impact.mjs` | `package-json-config` | 1 | Forge's selector reads its own npm scripts | the project runner and the generic import graph |
| `scripts/test-directory-path.mjs` | `js-extension` | 1 | Forge's selector: directory reads in its JS tests and scripts | the generic JS/TS import graph |
| `scripts/test-directory-path.mjs` | `package-json-config` | 1 | Forge's selector reads its own package manifest | the generic JS/TS import graph |
| `scripts/test-impact.mjs` | `js-extension` | 2 | Forge's selector names modules and test files by JS/TS extension | the project runner and the generic import graph |
| `scripts/test-impact.mjs` | `package-json-config` | 2 | Forge's selector treats its own manifest as global | the project runner and the generic import graph |
| `scripts/test-import-graph.mjs` | `build-folders` | 3 | Forge's import graph resolves its built `dist/` to `src/` | the generic JS/TS import graph |
| `scripts/test-name-watchers.mjs` | `js-extension` | 1 | Forge's selector: JS/TS modules a test names | named tests by module stem (`runnerSelection`) |
| `scripts/test-tiebreak.mjs` | `js-extension` | 1 | Forge's preflight ranking strips JS/TS extensions from test names | changed, named and imported tests in that order |
| `src/agent-cli.ts` | `tests-folder` | 2 | help-text examples of an explicit test list, not behavior | — |
| `src/explicit-test-runner.ts` | `tests-folder` | 1 | an explicit test list for Forge's standard check names `tests/*.test.mjs` files | their runner's test files (`resolveTestRunner`) |
| `src/project-test-runner.ts` | `tests-folder` | 1 | `FORGE_TEST_GLOB`, the glob of Forge's Node test layout | a declared runner or inferred vitest, jest and pytest globs |
| `scripts/docs-readers.mjs` | `forge-folders` | 1 | Forge's tested-docs reader scan over its tests and scripts | declared `docsPaths` on their check definition |
| `scripts/docs-readers.mjs` | `tests-folder` | 1 | Forge's tested-docs reader scan | declared `docsPaths` on their check definition |
| `scripts/selection-guard.mjs` | `tests-folder` | 1 | Forge's selection guard over its test layout | their command's own selection |
| `scripts/test-closeness.mjs` | `tests-folder` | 4 | Forge's preflight ranking over its test layout | changed, named and imported tests in that order |
| `scripts/test-coverage.mjs` | `tests-folder` | 5 | Forge's per-test coverage records | full checks; no per-test coverage |
| `scripts/test-shards.mjs` | `tests-folder` | 1 | Forge's standard-check shards | their command in one job |
| `scripts/test-name-watchers.mjs` | `tests-folder` | 1 | Forge's selector: modules a test names | named tests by module stem (`runnerSelection`) |
| `scripts/convex-function-names.mjs` | `tests-folder` | 2 | Forge's selector: Convex functions its tests call by name | the generic JS/TS import graph |
| `scripts/check-path-scopes.mjs` | `forge-folders` | 10 | Forge's own repository path-scope check (`npm run check`) | not run; their checks are their own |
| `scripts/check-path-scopes.mjs` | `tests-folder` | 5 | Forge's own repository path-scope check | not run |
| `scripts/control-build-key.mjs` | `npm-lockfile` | 1 | the build key of Forge's own CLI | not used |
| `scripts/control-deps-key.mjs` | `npm-lockfile` | 1 | the dependency key of Forge's own CLI | not used |
| `scripts/github-actions-check.mjs` | `npm-lockfile` | 1 | the Actions executor installs with `npm ci` only for npm-locked or standard plans | their own `actions.setup` command |
| `src/agent-preflight.ts` | `forge-folders` | 1 | the Forge-layout preflight inventory | the project runner over every path, with the generic import graph |
| `src/agent-preflight.ts` | `tests-folder` | 1 | the Forge-layout runner fallback inventory | their runner's test globs |
| `src/agent-preflight.ts` | `npm-lockfile` | 1 | the Forge-layout selector inventory | declared dependencies of every manifest |
| `src/agent-preflight.ts` | `node-test` | 1 | Forge-layout preflight runs Node's runner | their runner's command (`runnerCommand`) |
| `src/agent-lane-tests.ts` | `tests-folder` | 1 | the Forge-layout tests read | their runner's test files |
| `src/junit-coverage.ts` | `tests-folder` | 1 | Cargo's own `tests/NAME.rs` test-binary layout, not Forge's (JUnit coverage of Rust union tests) | — (Cargo's convention for every Rust crate) |
| `src/intent-test-contract.ts` | `tests-folder` | 1 | `standardTestPath`: the files Forge's selector and shards read | `contractTestPath`: any test path |
| `src/scoped-recheck.ts` | `tests-folder` | 1 | the scoped recheck of the standard plan | their whole command, or the selection their command reports |
| `src/semantic-check-command.ts` | `node-test` | 1 | Forge's layout runs union tests with Node's runner | their runner's command, or `SEMANTIC_TESTS_UNAVAILABLE` |
| `src/test-script-runner.ts` | `node-test` | 1 | recognises `node --test` in a package.json test script | the same inference for vitest and jest |
| `src/test-script-runner.ts` | `js-extension` | 1 | a JS test-script path argument names a file, not a folder | the same |
| `src/package-graph-dotnet-js.ts` | `js-extension` | 1 | JS/TS test file names: a JS package with tests but no `test` script makes the package graph's selection full | each ecosystem's own test sources (Gradle `src/test`) |
| `src/package-graph-dotnet-js.ts` | `npm-lockfile` | 1 | npm's lockfile among the JS workspace's lockfiles in the package graph | pnpm, Yarn and Bun lockfiles beside it |
| `src/project-test-runner.ts` | `node-test` | 2 | recognises `node --test` in any project's test script | the same inference for vitest and jest |
| `src/heavy-slots.ts` | `node-test` | 1 | `nforge heavy` refuses an unscoped `node --test` | the same guard for any project |
| `src/work-docs-admission.ts` | `forge-folders` | 1 | docs admission of a native standard-check run | declared `docsPaths` |
| `src/work-docs-admission.ts` | `npm-lockfile` | 1 | docs admission of a native standard-check run | declared `docsPaths` |
| `src/integration-preview-checks.ts` | `npm-lockfile` | 2 | integration previews install with `npm ci` only for npm-locked projects | their check sets up its own dependencies |
| `src/actions-toolchains.ts` | `npm-lockfile` | 1 | npm's row in the per-ecosystem Actions cache table (slice C, 721cd45c) | each ecosystem's own lockfile row |
| `src/npm-install.ts` | `npm-lockfile` | 1 | npm's own install reads its lockfile for scripted packages (slice H, 4ce67b9a) | pnpm, Yarn and Bun use their own (src/package-manager-install.ts) |
| `src/package-manager.ts` | `npm-lockfile` | 1 | npm's row in the per-manager lockfile table (slice H, 4ce67b9a) | each manager's own lockfile row |
| `src/package-manager.ts` | `package-json-config` | 5 | JS package managers keep `packageManager` and `workspaces` in package.json (slice H, 4ce67b9a) | non-JS repositories install with their own tooling |
| `src/package-manager-install.ts` | `package-json-config` | 1 | reads the JS install scripts the package manager would run (slice H, 4ce67b9a) | the same for every JS package manager |
| `src/shared-dependencies.ts` | `npm-lockfile` | 2 | Lanes share an npm install keyed by the exact lockfile | each Lane installs with its own tooling |
| `src/project-lockfile.ts` | `npm-lockfile` | 2 | the lockfile list, npm first so Forge pins the same bytes as before | their own lockfile (pnpm, Yarn, Bun, Cargo, Go, Python, Ruby, PHP) |
| `src/agent-clean.ts` | `build-folders` | 3 | Lane cleanup reclaims JS build folders only (any-ecosystem slice H, 4ce67b9a) | after H: gitignored folders named in an ecosystem list |
| `src/agent-cli.ts` | `build-folders` | 1 | a runner-label example (`["linux","build"]`) in help text, not a folder | — |
| `src/gh-cli-options.ts` | `build-folders` | 1 | a `gh` JSON field named `coverage`, not a folder | — |
| `src/js-import-graph.ts` | `build-folders` | 1 | reads a JS package's built `exports` target as its `src/` source | the same for every JS/TS repository |
| `src/maintainer-release-schema.ts` | `build-folders` | 1 | Forge's own release stage names | not used |
| `src/maintainer-release-stages.ts` | `build-folders` | 1 | Forge's own release runs `npm run build` | not used |
| `src/agent-preflight.ts` | `package-json-config` | 6 | preflight config, guards and the Forge-layout inventory live in package.json (any-ecosystem slice F, e89be958) | after F: a neutral root file, package.json as fallback |
| `src/cli-update.ts` | `package-json-config` | 1 | Forge's own CLI package manifest | not used |
| `src/explicit-test-runner.ts` | `package-json-config` | 2 | the project test runner declaration (any-ecosystem slice F, e89be958) | after F: a neutral root file |
| `src/heavy-build.ts` | `package-json-config` | 1 | Forge's own CLI build | not used |
| `src/hosted-mac-execute.ts` | `package-json-config` | 1 | the project test runner declaration for union tests (any-ecosystem slice F, e89be958) | after F: a neutral root file |
| `src/integration-preview-checks.ts` | `package-json-config` | 2 | native integration previews infer static checks from package.json scripts (audit 875a57cc finding 14) | explicitly marked static checks |
| `src/intent-contract-selection.ts` | `package-json-config` | 2 | the project test runner declaration (any-ecosystem slice F, e89be958) | after F: a neutral root file |
| `src/js-import-graph.ts` | `package-json-config` | 1 | every package.json is data for the JS/TS import graph | the same for every JS/TS repository; others keep path selection |
| `src/landing-environment.ts` | `package-json-config` | 1 | Forge's own runtime manifest pins the landing runtime | not used |
| `src/maintainer-release-stages.ts` | `package-json-config` | 2 | Forge's own release | not used |
| `src/remote-check-plan.ts` | `package-json-config` | 1 | the project test runner declaration (any-ecosystem slice F, e89be958) | after F: a neutral root file |
| `src/shared-dependencies.ts` | `package-json-config` | 6 | Lane dependency sharing is npm-only (any-ecosystem slice H, 4ce67b9a) | each Lane installs with its own tooling |
| `src/workspace-test-runner.ts` | `package-json-config` | 1 | the project test runner declaration (any-ecosystem slice F, e89be958) | after F: a neutral root file |
| `src/change-map.ts` | `js-extension` | 2 | the change map reads JS/TS only (any-ecosystem slice J, 348730cd) | path-level map |
| `src/code-imports.ts` | `js-extension` | 1 | contract import signals are JS/TS-only (any-ecosystem slice E, 7e97573d) | after E: contract unknown, never independence |
| `src/contract-exports.ts` | `js-extension` | 1 | contract export facts are JS/TS-only (any-ecosystem slice E, 7e97573d) | after E: contract unknown, never independence |
| `src/first-check-risk.ts` | `js-extension` | 1 | labels nested JS build configs as global-risk (any-ecosystem slice G, 6af95601 adds the other ecosystems) | root configs; after G nested build inputs too |
| `src/code-files.ts` | `js-extension` | 1 | one code-file name pattern for every listed language, JS/TS among them | the same |
| `src/hosted-overlap-text.ts` | `js-extension` | 1 | symbol overlap facts (and the JS parse that reads them) are JS/TS-only (any-ecosystem slice E, 7e97573d) | line-range overlap only; no parse |
| `src/intent-test-contract.ts` | `js-extension` | 2 | contract test names are JS/TS shapes (any-ecosystem slice F, e89be958) | after F: any test name shape |
| `src/js-import-graph.ts` | `js-extension` | 1 | the JS/TS import graph parses only JS/TS files | path and package selection |
| `src/junit-report.ts` | `js-extension` | 1 | labels code files of every listed language, JS/TS among them | the same |
| `src/native-import-merge.ts` | `js-extension` | 1 | duplicate-import fix-up is JS/TS-only (any-ecosystem slice D, 60ff8adb) | after D: Go, Rust, Python, Java, C# |
| `src/native-merge-syntax.ts` | `js-extension` | 1 | the merge syntax gate is JS/TS-only (any-ecosystem slice D, 60ff8adb) | after D: Python, Java, Rust, JSON |
| `src/project-test-runner.ts` | `js-extension` | 2 | node, vitest and jest runner inference and module-name matching for JS runners | a declared runner; per-ecosystem inference in 1f2121cb |
| `src/tested-docs.ts` | `js-extension` | 1 | Forge's standard selector scans these files for Markdown readers | declared `docsPaths` |
| `src/dependency-link.ts` | `package-json-config` | 1 | reads the `bin` field of a JS workspace package to link its bins into the Lane's `node_modules/.bin` (de6620eb) | non-JS repositories have no `node_modules` link |
| `src/hosted-actions-job-plan.ts` | `package-json-config` | 1 | the project test runner declaration for the Actions shard plan (any-ecosystem slice F, e89be958) | `forge.json` first, then package.json |
| `src/install-script-allowlist.ts` | `package-json-config` | 5 | reads npm/pnpm/Bun install-script allowlists where those tools keep them | the same; other ecosystems run no install scripts here |
| `src/package-graph-dotnet-js.ts` | `package-json-config` | 5 | the JS workspace part of the any-ecosystem package graph reads its manifests as data | each ecosystem's own manifest |
| `src/package-graph.ts` | `package-json-config` | 1 | names package.json among every ecosystem's manifests | the same |
| `src/project-test-runner.ts` | `package-json-config` | 1 | names where a runner was declared (`forge.json` or package.json) | `forge.json` |
| `src/project-config.ts` | `package-json-config` | 2 | package.json `forge.preflight` is the fallback after a neutral `forge.json` (slice F, e89be958) | `forge.json` |
| `src/package-graph-jvm.ts` | `build-folders` | 3 | Maven's `<build>` XML tag, not a folder | — |
| `src/package-graph-python.ts` | `build-folders` | 1 | the Python package finder skips Python build and virtualenv folders | each ecosystem skips its own |

## BYOCI parity

`tests/byoci-parity.test.mjs` runs each landing fast path twice on the same pnpm-style tree
(`packages/*/src`, a linked folder and a submodule, the shape of the repository behind 05df5aed):
once with Forge's standard check and once with a project command (`bash ci/check.sh`). Each pair
must reach the same outcome. That includes a shared check that passes late, after main moved: the
cohort recomposes on the new main (over several source steps for large States) and checks once more
as one cohort; no member rechecks alone. Listed differences:

| Fast path | Standard check | Project command |
| --- | --- | --- |
| Global-risk inputs | its entry plus `STANDARD_CHECK_INPUTS` | the files its command and setup action name |
