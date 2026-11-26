# Development

## Setup and checks

Requirements: Node 24.22.1+ (24.x), npm, and Git 2.38 or later for Git-backed Work. `tar` and `gzip` are needed for backups.

The CLI and standard check refuse other Node versions with `UNSUPPORTED_NODE`. This minimum includes the October 2026 Node security fixes; package engines use `>=24.22.1 <25`.

```sh
npm ci --ignore-scripts      # locked install, no lifecycle scripts
npm run verify               # check + documents + schema + Convex runtime imports + format:check + typecheck + lint + build + test, run concurrently
npm run format               # oxfmt --write; run before committing
```

| Command | What it does |
| --- | --- |
| `npm run check` | Validates JSON, Markdown links, license inventory freshness and required root files; rejects machine-specific home paths, JS/TS sources whose first line (after any shebang) is not the SPDX header, scripts/docs/workflows that print environment values or process listings, and live-query arguments or `refreshKey` values driven by the clock (idle tabs must cost nothing); rejects network calls in `src/` and `scripts/` that bypass `networkFetch`, `networkTimeout` or `deadlineConvexClient` (scripts import them from `dist/`) |
| `npm run typecheck` | Native TypeScript for all four scopes, including web JSX |
| `npm run typecheck:tsc` | Explicit tsc 5.9.3 fallback for all four projects |
| `npm run build:core` | Native TypeScript JavaScript and published declarations, the edit-hook bundle and the CLI bundle: `dist/cli-entry.js` and its `dist/cli-bundle-*.js` chunks replace the tsc output of that one entry (`scripts/build-cli-bundle.mjs`); every other `dist/*.js` file is the tsc output that tests, hooks and workers load |
| `npm run build:core:tsc` | Explicit tsc 5.9.3 build fallback |
| `npm run lint` | Oxlint with the explicit TypeScript rule map, no warnings allowed |
| `npm run format:check` | Oxfmt checks the existing JS/TS-only formatting scope |
| `npm run verify:sequential` | The same steps one after another (slower; use to read one step's output in order) |
| `npm test` | Builds, then runs `node --test tests/*.test.mjs` |
| `npm run build:web` | Hosted build into `hosted-web-dist`, then deploy smoke on every non-worker chunk; `build:hosted` aliases it |
| `npm run smoke:package` | Packs and installs the tarball offline, then checks its file list and notice hashes |

Tests use synthetic repositories and real Git, Node and MCP subprocesses. Pass-or-fail is the only result that counts: a skipped test is not a pass. Automatic cleanup tests control the working-directory probes through `tests/cleanup-process-fixture.mjs`, including the concurrent finish child, so unrelated host processes and unavailable `/proc` or `lsof` coverage cannot change lifecycle assertions. `tests/clean-processes.test.mjs` separately exercises both OS scanner branches, missing probes, unreadable processes and process-exit races with synthetic inputs; unknown coverage continues to retain local copies.

Each test file gets a private OS temporary root through `tests/check-runtime.mjs`.
Use `temporaryDirectory(t, prefix)` from `scripts/test-temp.mjs` before fixture setup;
it registers after-hook cleanup and a process-exit fallback. Helpers without a test
context can pass `null`. The shared `scratchDir` helper uses the same ownership.
On normal exit, any unowned `forge-*` or `scale-*` entry fails the file, and its
private root is reclaimed. `scripts/test-files.mjs` owns the outer root and reclaims
it after assertion failures, load failures, cancellation or a SIGKILL timeout.
Cleanup never scans another process's OS temp directories by age. Tests that intentionally
retain a spool or cache keep it inside their owned fixture and remove that fixture
in teardown. Cache and metrics companions share fixture ownership through file exit,
including deferred writes. Child processes reuse their parent's prepared module cache;
the enclosing file owner reclaims a terminated worker's runtime root. Explicit shared
precompiled-module caches retain their supervisor's ownership.

Compiled test modules (`tests/convex-module.mjs`) go to one cache per test run, named by
`FORGE_TEST_MODULE_DIRECTORY`. A hosted check job creates one for all its executor parts
(the kept files and every pool unit it claims); `scripts/test-files.mjs` (`verify`, any
other run) and `nforge heavy` create one when none is set; local preflight always creates
its own for all its groups. Each removes its cache when the run ends; an inherited
directory stays with whoever set it. A file then reuses the modules
earlier files of its run compiled instead of compiling its whole import reach again.
An output's name hashes the loader, the TypeScript version and options, and the path,
bytes and import resolutions of every module it can reach, so a changed module or another
checkout always gets a new name and an old output is never read. Writes are
temp-file-then-rename. Around an import cycle a writer publishes one member before the
other, so a cached output counts as present only when every cached module it imports
exists; otherwise the reader compiles the missing ones itself (same name, same bytes).
A file run on its own, outside any of these, keeps a private cache removed on exit.

Two guards keep hosted code on the intended path. `tests/hot-storage-invariant.test.mjs` fails any new use of Convex file storage in `convex/` (write, read, handle or `v.id('_storage')` field): bytes go to R2 ([data placement](data-placement.md)), and the few remaining uses are legacy-read allowlist entries with a count and an expiry date. `node scripts/check-convex-runtime.mjs` (a verify step) fails when a Convex module without `"use node"` reaches a `node:` builtin, a Node global, or any dynamic `import()` through its runtime graph (including `src/` and nested Convex modules). V8 helpers use static imports; only code isolated behind Node action roots may load modules dynamically. Type-only imports are erased. The same check resolves registered functions in isolated bundles and reports their reachable module count and output bytes.

The compact Work/detail and native companion fixtures close their MCP clients and HTTP servers before removing owner directories. CLI presence workers are detached; directory removal retries transient `ENOTEMPTY` errors while those workers release their queue files. A presence worker that stops on an error writes one line (code and message) to stderr and the stack to the diagnostics log, and exits 1; a normal stop exits 0. Test fixtures that listen on a Unix socket take their path from `tests/helpers/short-socket.mjs`, so a deep `TMPDIR` (local preflight) never exceeds the macOS 104-byte limit.

Interaction finish fixtures isolate the outer `FORGE_CHECK_FULL` override so their nested checks exercise the explicitly selected docs, scoped and interaction scenarios. The enclosing verification run keeps its full selection. Interaction and landing fixtures drain post-accept work and join spawned helpers before deleting their owners. Finish replay assertions compare recorded receipt fields separately from live peer observations, whose coverage can change when source becomes unavailable. Peer coverage is independent of machine speed; load regressions require complete reads without retries, while unavailable source remains incomplete. The running-output exchange fixture holds its writer at an explicit barrier during preparation, then verifies that later appended bytes do not change the pinned retry.

`npm run check` fails if `docs/dependency-licenses.md` is out of date. After changing dependencies, run `node scripts/render-dependency-licenses.mjs`.

### Lane dependency cache

Lane start/open and dependency refresh reuse sealed installs under
`$XDG_CACHE_HOME/forge/deps` (default `~/.cache/forge/deps`). The install cache has a
4 GiB soft budget, overridden by a positive `FORGE_DEPS_CACHE_MAX_GB` value in GiB.
Unused installs are evicted by last use during existing dependency work;
`nforge prune` previews eviction and `nforge prune --apply` removes eligible entries.
Active checkout links and running install/link locks are retained even above the
budget. Explicit prune measures the entire cache on disk and includes stale,
unused manager download stores in eviction. Ordinary sweeps reuse sealed-package
size metadata and count writable tool output.
There are no new calls, DB I/O, background workers or idle timers. Changed lockfiles
relink at preflight/open automatically, as do Forge links whose installs were pruned.
A clone root with its own `node_modules`
keeps that install on pull; run `npm ci --ignore-scripts` there after the lockfile
changes, including before `npm run build:web`. Lane installs include the web
development dependencies; a production-only CLI install does not. See [dependency sharing](parallel-work-defaults.md#sharedependencies)
for concurrency, read-only removal, download-cache scope and private-install details.

### Table registration diagnostics

`tests/table-registrations.test.mjs` reports all missing registrations together:
data placement, project purge inventory, owner entry-point classification, every
storage-budget phase and the generated agent-help block. It reads the existing
registries; it adds no runtime table or permission rule. The individual guards
still check their detailed contracts. Owner registrations are one JSON file per
Convex module in `tests/owner-boundary-guard.d/` (`actions` plus an optional review
`reason`); both guards read them as data and take no other permission input. A
permission map added back to `tests/owner-boundary-guard.test.mjs` is refused,
dotfiles in the folder are ignored, and an entry whose Convex module no longer
exists is a finding.

### Shared schema compatibility

`npm run check:schema` runs in both verification paths, independently of builds.
It statically reads the exported Zod schemas in `src/work-types.ts` and
`src/work-unified-types.ts`, including imported declarations, and compares them
with `scripts/schema-compat/released.json`. It never imports project modules.
Removed or renamed fields, required additions, optional-to-required changes,
removed enum values and structural or scalar-constraint narrowing fail with the
field path. Additive optional fields and wider types pass.

For an intentional breaking change, copy each reported `path` and `change` digest
into `scripts/schema-compat/declared-migrations.json` with a `reason` describing
the migration. Each declaration covers only that exact transition, including
its field path; it does not execute a migration. Before releasing, run
`npm run schema:snapshot` and commit the refreshed baseline with the release
source. Refresh refuses undeclared breaking changes and never runs in verify.
The initial baseline comes from the installed CLI release's matching schemas.

### Hosted reply compatibility

Hosted replies follow the other direction: released CLIs must accept what a newer
server sends. `tests/hosted-response-contract.test.mjs` compares the exported reply
schemas listed in `scripts/response-compat.mjs` with
`scripts/response-compat/released.json` (the released CLI) and with
`scripts/response-compat/main.json` (the contract of the current main, which agents'
always-main CLIs run between releases); unknown keys are ignored (the CLI's reply
boundary drops them), while new required fields, new enum values and narrowed types
fail, naming the field path and the fix. `main.json` is a committed snapshot that must equal the
Candidate's contract: a Lane that changes a reply schema runs
`npm run build:core && npm run response:main`, which refuses an undeclared break against the
previous `main.json` and then rewrites it; a Lane that forgot fails the check on the field
(break) or on a stale file. It needs no hosted call and adds about 0.1 s. Rule and declaration steps: [server replies](operations/cli-update.md#server-replies-cli-behind-the-deploy).

The extractor supports explicit Zod declarations, shapes, imports, unions and
standard scalar validators. Unknown expressions fail explicitly. Arbitrary
`refine`/`superRefine` predicates are not executed or compared; transforms and
other unsupported builders require extractor support. This check covers schema
structure and representable constraints, not every runtime predicate.

### Native TypeScript selection

The development compiler is the official Microsoft `typescript@7.0.2` package,
installed as the exact dev-only alias `@typescript/native`. The runtime
`typescript@5.9.3` dependency stays in place for source analysis and public
SDK consumers. Scripts use explicit compiler paths, so npm's shared `tsc` shim
cannot accidentally select the other compiler. No installation lifecycle scripts
are needed. The generated [dependency license inventory](dependency-licenses.md)
includes the compiler and its optional platform binaries (Apache-2.0).

All four scopes use the native compiler, including the landing verifier's web
step. Web keeps the same strict, unused and indexed-access checks in
`web/tsconfig.json`. Its Convex inventory action supplies the reconstructed
reference's generic type explicitly: native 7.0.2 otherwise infers the enclosing
`F` and reports TS2345 where tsc 5.9.3 accepts the call. This type-only change
preserves the reference, arguments and result without a cast or suppression.
Native core/web/Convex commands pass `--types "*"` to preserve tsc 5's automatic
ambient types; the site Worker's config (`site/tsconfig.json`) keeps its own empty types list. Native commands also pass
`--noUncheckedSideEffectImports false` to preserve the old side-effect import
behavior. Convex's config explicitly includes Node ambient types and sets
`noUncheckedSideEffectImports: false`, so direct compiler invocations have the
same compatibility settings. Verification retains a tsc 5.9.3 Convex compatibility
check after `build:core`.

`tests/native-web-typecheck.test.mjs` checks a scratch copy of the real web source
with both compilers, then seeds assignment, argument, property, nullable,
indexed-access, unused-local, unused-parameter, implicit-any and JSX-prop errors.
It requires identical diagnostic codes and locations; unresolved side-effect
imports retain their existing behavior. This covers the known disagreement and
representative strict/JSX errors, not every possible compiler diagnostic. Native
returns exit code 1 for these errors while tsc returns 2; both fail the check.

The installed Convex CLI prefers `@typescript/native/bin/tsc` over
`typescript/bin/tsc` when the native alias is present. Its `typecheck` and deploy
commands invoke the compiler directly, without npm's flags, so required options
must live in `convex/tsconfig.json`. `tests/native-toolchain.test.mjs` checks the
real Convex config with both compilers, without compatibility flags, after the
core build. This offline coverage runs in the landing check; the credentialed
native self-host smoke remains a separate GitHub Actions job.

`npm run typecheck:tsc` and `npm run build:core:tsc` select the original compiler
explicitly. Keep these commands while parity across every scope remains under
qualification. Use them to reproduce suspected native compiler regressions or
compare diagnostics after a compiler/configuration change. There is no automatic
fallback after an error. The archived
`@typescript/native-preview@7.0.0-dev.20260707.2` package was measured, but is not a
project dependency. Microsoft now ships the maintained native compiler in the
standard TypeScript package; see the [TypeScript 7 announcement](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/)
and the [preview staging repository](https://github.com/microsoft/typescript-go).

### Repeatable web compiler comparison

Run `nforge heavy node scripts/measure-web-typecheck.mjs` locally, or select that
script as an optional hosted check with locked dependencies installed. It measures
both the isolated landing `typecheck:web` command and the complete sequential
`npm run typecheck` body, before/after replacing only the web compiler. Both use
the same current source and compatibility options. No dependencies are added.

The script performs an unscored warmup per route, then eight interleaved pairs,
alternating AB/BA order. It emits every wall-time/peak-RSS sample and median ratios
with a paired percentile bootstrap 95% interval (10,000 resamples, fixed seed).
OS caches stay warm; checks are non-incremental. RSS comes from the platform's
`/usr/bin/time` and is the maximum child-process high-water mark, not concurrent
process-tree memory. Node/platform/CPU, lockfile and web-config pins accompany the
results. This is an opt-in benchmark and does not slow ordinary verification.
The isolated web measurement excludes concurrent build/test contention; the
landing verifier's timing table measures that contention separately.

### Toolchain measurements

Local wall-clock measurements use the source at State `3e593b83e00f4961014cef997a2f76edceaba676fc5039b2f2373c13e1b7414c`, Node 24.22.1 and an Apple M4 (10 logical CPUs, 16 GiB). Other agents were active; the host load varied substantially. These are not CI or idle-machine measurements. Native worker pools were set to four (`GOMAXPROCS=4`, `RAYON_NUM_THREADS=4`, Oxlint `--threads 4`).

Each cell lists all three samples in seconds. Cold removes tool caches and build outputs before a fresh process; warm immediately repeats the same command with its outputs retained. OS file caches were not flushed on the shared machine. Typechecks are full, non-incremental checks; the four repo configs have no project references. Different tools run sequentially. Complete transpiler builds include the time for native declaration generation and typechecking; no transpile-only timing is presented as a package build.

| Tool | Task | Cold seconds (3 runs) | Warm seconds (3 runs) | Parity / decision |
| --- | --- | --- | --- | --- |
| tsc 5.9.3 | Four-project typecheck | 76.138, 71.413, 101.897 | 104.873, 92.742, 81.318 | Reference; pass |
| tsgo preview 7.0.0-dev.20260707.2 | Four-project typecheck, unchanged options | 45.662, 48.101, 28.850 | 38.710, 35.468, 30.947 | Fail: ambient types; archived preview |
| Native TS 7.0.2 | Four-project typecheck, unchanged options | 27.005, 15.322, 18.256 | 18.128, 18.648, 16.835 | Fail: ambient types; web generic disagreement after compatibility flag |
| Native TS 7.0.2 + tsc web | Four-project typecheck, compatible options | 31.219, 48.732, 34.030 | 42.763, 44.896, 29.566 | Pass; adopted |
| tsc 5.9.3 | Core JS + declarations | 17.969, 15.617, 25.235 | 17.586, 15.315, 27.381 | Reference; pass |
| tsgo preview | Core JS + declarations | 6.727, 5.967, 5.407 | 6.065, 6.814, 4.078 | JS matches; archived preview, not adopted |
| Native TS 7.0.2 | Core JS + declarations | 4.724, 6.708, 6.801 | 7.203, 5.205, 6.144 | Pass; adopted |
| SWC 1.16.20 + native declarations | Complete core build | 13.741, 9.984, 7.652 | 10.109, 10.541, 6.835 | Runtime probe passes; repository JS equivalence unverified |
| oxc-transform 0.155.0 + native declarations | Complete core build | 6.796, 5.121, 5.356 | 7.434, 5.191, 4.514 | Runtime probe passes; repository JS equivalence unverified |
| esbuild 0.28.2 + native declarations | Complete core build | 4.846, 4.702, 4.193 | 4.099, 4.479, 4.887 | Runtime probe passes; repository JS equivalence unverified |
| ESLint 9.39.4 | Lint | 24.161, 12.133, 14.194 | 12.100, 23.345, 11.186 | Original reference |
| Oxlint 1.89.0 | Lint, 24 mapped rules | 0.266, 0.187, 0.137 | 0.131, 0.148, 0.128 | Original trial: no-unused-vars parameter handling differs |
| Oxlint 23 rules + ESLint no-unused-vars | Lint | 12.881, 12.975, 12.346 | 14.824, 11.369, 16.197 | Original mixed trial; superseded by compiler unused checks |
| Biome 2.6.2 | Lint, strict migrated rules | 0.901, 0.769, 0.749 | 0.617, 0.703, 0.781 | Fail; incomplete rule parity |
| Prettier 3.9.10 | Format check | 27.149, 21.077, 23.954 | 22.386, 22.306, 22.433 | Original reference |
| Oxfmt 0.74.0 | Format check | 0.330, 0.175, 0.192 | 0.176, 0.182, 0.186 | Original trial; adopted with a mechanical reformat below |
| Biome 2.6.2 | Format check | 1.365, 1.245, 1.176 | 1.332, 1.237, 1.188 | 76 changed files; not adopted |

The adopted typecheck medians are 34.030 s cold / 42.763 s warm versus 76.138 s / 92.742 s for the all-tsc reference (2.24× / 2.17× locally). Native core build medians are 6.708 s / 6.144 s versus 17.969 s / 17.586 s (2.68× / 2.86× locally). Measurements under contention do not establish the same speedup on the 4-vCPU CI runner.

Parity checks introduce assignment (TS2322), argument (TS2345) and missing-property (TS2339) errors into a scratch file in each of the four projects. The adopted routing matches tsc 5 on all 12 diagnostic codes and locations and reports no errors on the clean source. A synthetic two-project reference graph builds cold and warm and rejects a broken consumer with both tsc and the native compilers. The retained regression test also covers the existing unresolved side-effect import behavior.

Core emits contain 587 JavaScript and 587 declaration files, with no missing/extra files and no source maps (the config does not request them). Native JavaScript matches tsc token-for-token after ignoring trivia and literal spelling. Of 260 declaration files with token differences, 256 differ only in union/property order. Three internal files use an equivalent `typeof syncGitSleep` function alias, and `owner-acceptance-consumer.d.ts` adds optional `never` members to an internal inferred union. Those four files are outside the 12-file transitive declaration closure of the two public package exports. That public closure matches after union/property-order normalization; the entry declarations themselves are unchanged apart from trivia. The synthetic runtime probe checks enums, namespaces, parameter properties, ES2022 class fields/accessors, private fields and async behavior. It passes for every emitter. SWC/Oxc/esbuild produce different repository JavaScript; full semantic equivalence of those rewrites remains unverified, so their faster isolated figures do not justify adopting them. Oxc isolated declaration generation also requires `isolatedDeclarations`, which this project does not enable.

### Oxlint and Oxfmt

The standard scripts now use pinned Oxlint 1.89.0 and Oxfmt 0.74.0. The
[Oxlint configuration](../.oxlintrc.json) explicitly maps all 24 previously enabled
ESLint rules: `no-var`, `prefer-const`, `prefer-rest-params`, `prefer-spread`, and the
20 recommended TypeScript rules under their same names with the `typescript/`
prefix replacing `@typescript-eslint/`. Default extra correctness rules are off.
No enabled rule lacks an Oxlint equivalent, so there is no `lint:eslint` fallback
and the ESLint packages/config are removed. This is a tested mapping, not a claim
that the two implementations behave identically on all possible source.

All four TypeScript projects enable `noUnusedLocals` and `noUnusedParameters`.
The compiler checks parameters, allowing `_`-prefixed parameters, and accepts
used destructured parameters read through `void`. Oxlint's `no-unused-vars` has
`args: "none"` to avoid the parameter discrepancy found in the original trial;
it still checks locals, unused catch bindings and values used only in types
(`reportVarsOnlyUsedAsTypes: true`). The last two cases are not diagnosed by the
compiler. No source fixes were needed when enabling the remaining compiler flags.
The retained corpus exercises all 24 rules, these gaps, used destructuring,
underscore parameters and existing ESLint/TypeScript suppression comments. Both
the original ESLint and Oxlint rejected all 24 negative rule fixtures.

[Oxfmt configuration](../.oxfmtrc.json) preserves print width 110, single quotes,
trailing commas, arrow parentheses and the previous ignore patterns. Import and
package.json sorting are disabled. The migration mechanically reformats 21
existing source files. Prose, JSON records, CSS, HTML and fixtures retain their
bytes. Prettier remains a dependency because Convex uses it; it no longer runs
Forge's format checks.

`scripts/oxc.mjs` enumerates the same JS/TS scope using root ignore rules and
passes explicit file paths. This is necessary inside native Lanes: Oxc directory
walking otherwise skips the Lane beneath the owner's ignored `.forge/` ancestor.
An empty selection fails explicitly. `scripts/verify.mjs` calls this runner
directly, avoiding another npm launch for each static step. Public and exported
Forge CI checks use the same runner through verification.

The adoption measurements below use Node 24.22.1 on the same Apple M4 under
concurrent-agent load. Each entry is wall time for a fresh process; OS caches
were not flushed. Baseline source is State
`f9e030a6d60432876b650c0b6ece3fae202928b4eecad3786869725843755d6a`.
Baseline commands passed once; adopted commands passed all three repeats.

| Invocation | Baseline seconds | Adopted seconds (3 runs) |
| --- | --- | --- |
| `npm run lint` | ESLint: 18.065 | Oxlint: 0.824, 0.899, 0.723 |
| `npm run format:check` | Prettier: 42.042 | Oxfmt: 1.486, 1.551, 1.400 |
| Verification's `node scripts/oxc.mjs lint` | Not measured separately | 0.437, 0.354, 0.361 |
| Verification's `node scripts/oxc.mjs format:check` | Not measured separately | 0.813, 0.744, 0.856 |

Each direct verification step is below one second in these samples; the combined
steps and the npm-wrapped format command are not below one second. These local
measurements do not establish CI timings. Oxfmt checked 1,783 files during the
adopted timing runs, including the new runner and regression tests.

Candidate packages were fetched at exact versions from their official projects
with `--ignore-scripts`; SWC/esbuild postinstall scripts were not executed.
Only maintained native TypeScript and the Oxc check tools are adopted. Primary
references: [SWC compilation](https://swc.rs/docs/configuration/compilation),
[Oxc TypeScript/declarations](https://oxc.rs/docs/guide/usage/transformer/typescript),
[esbuild TypeScript caveats](https://esbuild.github.io/content-types/#typescript-caveats),
[Oxlint configuration](https://oxc.rs/docs/guide/usage/linter/config),
[Oxlint unused variables](https://oxc.rs/docs/guide/usage/linter/rules/eslint/no-unused-vars),
[Oxfmt configuration](https://oxc.rs/docs/guide/usage/formatter/config),
[Oxfmt ignored files](https://oxc.rs/docs/guide/usage/formatter/ignore-files),
[Biome migration](https://biomejs.dev/installation/migrate-from-other-tools/),
[Biome formatting differences](https://biomejs.dev/formatter/differences-with-prettier/).

### Targeted test preparation

Run `npm ci --ignore-scripts` and `npm run build:core` before focused core tests. Run `npm run build:web` as well before browser asset inspection or hosted UI checks; assets build into `hosted-web-dist`. The test preload resolves the installed Playwright browser cache before replacing HOME/XDG with private fixture directories, so browser tests run under `nforge heavy` too. An explicit `PLAYWRIGHT_BROWSERS_PATH` (including `0`) stays in effect. Run focused tests with the private queue preload:

```sh
node --import ./tests/check-runtime.mjs --test tests/agent-verbs.test.mjs
```

For new prose under `docs/`, add a matching JSON manifest under `scripts/package-documents/`: for example, `docs/operations/example.md` uses `scripts/package-documents/operations/example.json` with `{"path":"docs/operations/example.md","order":100}`. Existing order values preserve the installed documentation order; ties sort by path. Each document owns its manifest, so parallel additions do not edit one shared list. The explicit inventory avoids packaging private output. `node scripts/check-documents.mjs` validates the inventory without building.

`convex/_generated/api.d.ts` is disposable and ignored by source control. Core builds, typechecks and verification regenerate its exact module inventory locally with `node scripts/prepare-convex-api.mjs`, using filenames without loading or executing modules. Public verification test shards also run this preparation when reusing build artifacts, which omit the ignored declaration. Convex codegen can also regenerate it. Adding or deleting a Convex module requires no shared generated-file edit; direct compiler invocations should run the preparation script first.

`node scripts/web-bundle-report.mjs` uses Vite's manifest to report entry and immediate Hosted import bytes/gzip. Extra manifest entries after the output directory select screens. Optional screens and fonts (chosen by Unicode range) stay separate. Measurements exclude provider scripts, API responses and browser-selected icons; they are not a network trace. The browser-bundle test reuses its configured build for smoke.

### The standard check

`scripts/forge-check.mjs` installs locked dependencies, selects impact from the runner’s pinned Candidate comparison, and verifies with the Node that launches it. The existing `verify` check ID stays unchanged. Forge-launched checks share the machine queue and disk guards described in [operations](operations.md). Validated native standard-check docs-overlap retries classify immutable merged bytes with the installed selector before admission and run merged static checks outside the heavyweight queue; disk guards still apply. Unclassified changes and code interactions keep ordinary admission. Direct `npm run verify` / `node scripts/forge-check.mjs` invocations bypass Forge's queue; use recorded `save --check` / `land --save` to coordinate dogfood checks (hosted projects run them on GitHub-hosted Actions runners; the Mac no longer accepts or checks). Test execution preloads `tests/check-runtime.mjs` so synthetic fixture checks use a private queue per test process, separate from real dogfood checks. The automatic-cleanup tests also import that setup themselves, so direct focused runs stay isolated without a preload flag; their process coverage uses one mutable mock per test. Cross-process reliability tests explicitly share one queue. For focused check-run tests use `node --import ./tests/check-runtime.mjs --test tests/local-reliability.test.mjs`. No test assertion is bypassed.

`npm run verify` is `scripts/verify.mjs`. It runs the verification stages concurrently: `check`, `format:check`, the four project typechecks and `lint` start together with `build:core` then `build:web`, and the tests and tsc 5.9.3 Convex compatibility check start as soon as the core build finishes instead of after every static step. Static-step output is buffered; tests stream completed/failed counts and failure names as TAP results arrive. Each completed failing file also emits its file-attributed diagnostic block immediately, while other files and static steps continue. Passing steps print their totals and a timing table closes the run. The default test-file budget is `min(max(1, floor((available CPUs - 2) / check slots)), 8)`, where check slots is `FORGE_MAX_CONCURRENT_CHECKS` or the check queue default `max(1, floor(CPUs / 4))`, so concurrent checks together leave two CPUs free (4 workers per check on a 10-CPU machine with 2 slots). Set `FORGE_TEST_WORKERS` to a positive integer to compare or override it. The runner starts historically slow files first. Each test file has a 600000 ms wall-clock hang guard, covering module loading, tests, teardown and leaked child handles. Set `FORGE_TEST_FILE_TIMEOUT_MS` to a positive integer in milliseconds (up to 2147483647) to override it. A timeout names the file, kills its process group and fails verification; queued files get their own deadline when started. This is a suite scheduling budget; fixture queues remain private per test process and queue correctness tests keep their explicit overrides. `FORGE_GIT_TIMEOUT_MS` (default 20000, accepted range 1000 to 3600000) is the per-command ceiling for local Git, or the maximum time between progress reports for bundle creation and verification; the check sets it to 240000 because several checks usually share one machine.

Compare performance with the same Node version, source pins and machine load.
Per-file wall times include real Git subprocesses and filesystem work; a heavily
loaded or swapping machine does not provide a usable idle-machine floor. Git compatibility coverage uses local bundles and real clients. Contribution import/recovery fixtures
use local projected bundles instead of repeating transport setup; the dedicated
clone/fetch suites and the three contribution wire cases retain protocol coverage.

`workGit` gives Git inputs over 32 KiB through a private temporary file descriptor, preserving the exact bytes and removing the file afterwards. This avoids synchronous child-process pipe stalls for large inputs. History fixtures use the same file-descriptor approach for multi-megabyte synthetic commits.

```sh
nforge x ROOT configure-check '{"command":{"name":"verify","executable":"/abs/node","args":["scripts/forge-check.mjs"],"environmentLabel":"clean"}}'
```

The large Work-records round-trip test uses a 300-second hang guard so concurrent full checks can complete its unchanged size and restoration assertions. This is not a performance target.

`FORGE_TEST_TIMINGS=/absolute/path/timings.jsonl` records one JSON line per test
file, with `file`, `exitCode` and wall-clock `durationMs`, including module loading and teardown.
Use a fresh output file for each measurement. Recorded checks need these optional
settings in the check definition's `env` passthrough (`FORGE_TEST_WORKERS`, `FORGE_TEST_FILE_TIMEOUT_MS` and
`FORGE_TEST_TIMINGS`); direct verify reads them from the environment. Concurrent standard checks in one
workspace can race while `npm ci` replaces its dependency tree.

The MCP test clients use explicit 240-second request hang guards and 30-minute
guards for operations that wait for recorded checks (`finish`, `run`, `run-check`
and `run-playbook`). Production deadlines are unchanged. Asynchronous observations
use one elapsed-time polling helper with a 240-second completion deadline and
safe last-state diagnostics; final status assertions still determine pass/fail.
MCP fixtures explicitly forward their private `XDG_CONFIG_HOME`, queue and Git
settings, and use a synthetic HOME login to detect config-forwarding regressions.
No machine login files are used by these fixtures.
The in-memory hosted backend in `tests/hosted-fixture.mjs` keeps the provider rules
hosted code depends on: index fields and range order come from `convex/schema.ts`
(an undefined index or out-of-order range throws), `unique()` rejects several
matches, and a mutation run through `ctx.runMutation` (or `state().transaction`)
undoes its database writes and scheduled work when it throws. Storage operations
are not rolled back. Writes are checked against the schema, and every return value
against the function's declared `returns` validator: through the fixture's dispatch, and
for direct `fn._handler` calls through `tests/check-runtime.mjs`. Rows a test writes
straight into `s.tables` bypass the schema; build them with `schemaRow`, `projectRow`,
`backupRow` or `proposalRow` from the fixture. It has no OCC or subscriptions;
interleaved mutations are not isolated.
The heartbeat test advances mock interval time at the production interval; polling
unit tests inject a clock/sleep function. Fixtures that must stay running use
explicit cancellation rather than waiting for a 3- or 60-second timeout. The
unchanged-index pack equality regression also covers deterministic graph identity;
its provider-version assertion lives in that same test.

### Scope-aware standard check

The runner writes a complete immutable base/head comparison outside the check workspace
and supplies `FORGE_CHECK_CHANGES`, `FORGE_CHECK_BASE` and `FORGE_CHECK_HEAD` itself.
The comparison uses the `view.composedMain` pin, retained on the run as `comparisonBase`; legacy Candidates without this pin run full. Added, modified, deleted and mode-changed paths count. Missing/mismatched pins, empty
comparisons and unknown paths run full. The mutable Lane and current main are never
the diff source. Older runners without this input remain compatible and run full.

`scripts/test-impact.mjs` follows transitive reverse static imports, maps built
`dist/*.js` to `src/*.ts`, resolves extensionless web imports and `.mts` modules, and recognizes literal
source reads and CLI paths in tests. Type-only imports are covered by the full
TypeScript checks. Every scoped run adds `files`, `ci-scope`, `test-impact` and `check-path-scopes` smoke tests.
Erased type re-exports (`export type`, including star and namespace forms),
type-only import-equals declarations, interfaces, aliases and type annotations
do not create behavior-test edges. A type re-export hub therefore does not pull
in tests of its unrelated runtime exports. Literal source readers still count.
Value imports/re-exports, side-effect imports and inline `import/export { type T }`
shells retain conservative coverage: compiler settings can preserve an empty
runtime import/export and its module initialization. Class `extends` expressions
also retain runtime coverage. This applies to both `agent tests` and scoped
landing shards; the final full landing/main verification is unchanged. Runtime
hubs still select their transitive consumers; export names alone do not establish
independence when module initialization or shared state can affect another export.
The parsed import graph lives in `scripts/test-import-graph.mjs`. Directory-valued
expressions used only for membership or process-path comparisons do not create
module dependencies. `scripts/test-directory-path.mjs` follows aliases and local
function arguments; directory reads, escaping values, unsupported uses and unknown
consumers remain broad. This prevents directory names in the selector, foundation
ignore tables and cleanup helpers from turning those modules into catch-all hubs.
Unknown loaders include test and script helpers as well as product source. A known
literal branch never hides an unknown branch of a conditional loader. Unparseable
modules fail toward full coverage.
A recursive walk of named folders in a script or test helper (`sourceFiles()` reads `src/`,
`web/`, `convex/`, `site/`, `tests/` and `scripts/`) makes every file of those folders a
`runtime-path` dependency of the test code that may run the walk. Its base is the caller's argument
or working directory, so the walk reads this repository only from test code: its statements' taint
follows static imports through `scripts/` and `tests/` (a wrapper whose default argument is the
inventory carries it), and a dynamic import or spawn makes its importer a reader without going
further. Only a changed file's own bytes reach a reader this way, never a file it merely affects. A
folder read never replaces other evidence between two files, and it never makes those files part
of the walker's code, pipeline or by-name closure. The selector's own modules read no computed repository path: its Convex module
index is built from the inventory, since a `` `convex/${name}.ts` `` template there tied every
Convex file to every test that loads the selector (Item 196d5e4e; a guard in
`tests/hosted-scoped-recheck.test.mjs` checks the selector's import closure on the real tree).
Web edits also run the UI regression files. A computed path widens only to files its
literal skeleton can name (`head*mid*tail`, or a folder under it); source modules also
match by their built `dist/` name, so `` `../dist/${name}.js` `` still names every module
while a fixture template like `` `src/file-${i}.ts` `` names none. A `join` or `resolve`
whose trailing arguments are literal module names (`join(runtime, 'dist/x.js')`) names only
files ending with them, whatever the leading folder is. Unknown dynamic imports
widen to all source domains. The package's own name (`@nanthai/forge[/sub]`) resolves
through `package.json` `exports`, so package smoke depends on the exported entry
modules; an unmapped subpath stays unknown. A file that declares its own `require`
(function, parameter or non-`createRequire` variable) does not load modules through it.
A bare repository path in product source (`'convex/schema.ts'`, not `./worker.js`) is a
`workspace-path` edge: product code resolves it in a caller's workspace, so the chain
counts only when it reaches a test or script that makes this repository the workspace
(`process.cwd()`, the repo root from `import.meta.url`, or a child process spawned without
`cwd`). A path template in product source (`` `dist/${name}.js` ``) is a `workspace-path`
edge too; a template in a test or script stays a dynamic load. Any stronger edge between the
same files replaces it, and by-name Convex loader closures ignore it. A by-name Convex
reference whose module is a template (`` `${kind}:listRows` ``) names only the modules its
values can take: a conditional of literals, or a handler argument whose `args` validator
(from `convex/values`) is `v.literal`, a `v.union` of them or `v.optional` of those. The
definition must be the only argument of an imported Convex builder, with plain, unique `args`
and `handler` keys. A spread, computed or duplicate key, a default, a TS `this` parameter, any
write to the name (including destructuring, parenthesised and for-in/of targets), another
declaration of it in the handler, or a local declaration named like `v` or the builder makes
the value unknown, and any other value names every Convex module. A test calling
`fn._handler(ctx, args)` directly skips the validator; the narrowing still holds, since a
value the validator refuses is a call Convex never makes. A `moduleUrl`-style helper imported
from another test file resolves paths from that helper's folder, and every path the selector
accepts in its argument (branches, casts, enumerated templates) is an edge. A helper that only
re-exports the loader, a namespace member it cannot follow, or a local declaration that may
shadow the import leaves the home unknown, so the call widens. Node internals
(`require('internal/fs/watchers')`, only straight inside `require()` or `import()`) and paths
into `node_modules/` load no repository source; any other bare name the lockfile does not list
may be a local alias and still widens.
A script path or package command name that tests or scripts only compare
(`path === 'scripts/x.mjs'`, `[...].includes(name)`) runs nothing, so it adds no edge. The existing `tests/convex-module.mjs` adapter is modelled
through its callers' paths and the loaded sources' imports. Its recursive moduleUrl
implementation does not imply every module depends on every other module.

Selection follows exports, not only files (symbol-level reach, `scripts/test-symbols.mjs`). A
changed file is whole: the selector has no base bytes to tell which declaration changed, so
every importer of any of its exports is selected, and a static import of a whole module is
whole too. Further on, an edge reaches a module at a site. A site inside a function body, or
a value only bound to a name (`const f = g`, an object or array member, a method, a static
field), alters just the top-level declarations that refer to it, and an importer that uses
none of their exports is not reached. Named, default and namespace imports, re-exports and
`export *` carry the names they bind. A site that runs at load (a call, a callback or object
handed to a call, a property or destructuring read, a spread, a template, a decorator, a
static block) makes the whole module reach. Edges made outside a parse (by-name loader
closures, package commands) are whole, and `eval`, `new Function`, `with` or `export =`
make a module whole. A side-effect import therefore reaches a module only when its load
changed.

A `scoped` selection names its domain (`web`, `convex`, `core`, `site`, `tests`,
`scripts`, `tooling`, or `mixed`) and prints its reason and complete file list before tests.
Root non-Markdown files, non-Markdown `docs/` files and non-Markdown `evals/` files
select full coverage. Every top-level folder is listed, with its rule, in `topLevelFolders`
(`scripts/check-path-scopes.mjs`). A path in an unlisted folder keeps full coverage with the
reason `Unclassified top-level folder NAME/`, and `tests/check-path-scopes.test.mjs` fails
until the folder is listed. Markdown-only docs keep the fast path. Markdown in a top-level
folder without code (such as `evals/`) selects the code naming its path, or its folder
and file name; product code or the package manifest naming it or its folders keeps full. Nested TypeScript and Vite
configuration widen to their domain; every static check still runs. Convex functions, schema and generated API files widen to backend
consumers; generated API changes also include web consumers. Test helpers and data
fixtures follow their importing tests; an unreferenced, unclassified fixture stays
full. Known manual browser/QA fixtures select UI regressions and asset serving.
Scripts under `scripts/` with `.mjs`, `.js` or `.ts` extensions follow importing
and literal spawning tests, including `scripts/name` paths embedded in commands.
Package commands contribute script dependencies and `npm run` aliases; tests that
name those commands are consumers too. A standalone script runs static checks,
smoke and any exact basename test (`scripts/example.mjs` → `tests/example.test.mjs`).
Selection evidence states the changed script, whether it has consuming tests, and
basename coverage. Known manual UI capture scripts retain their UI regressions.
A workflow other than the landing check (no product source names its file) selects the
tests and scripts that name it or `.github/workflows`; the landing check stays full.
`plans/*.md` selects the tests and scripts that read `plans/`.

Check-runner dependencies stay full: the graph traces imports and literal paths
from `scripts/forge-check.mjs`, the selector/classifier, package `verify`, `test`,
`check`/`check:*` and `build`/`build:*` commands (including aliases and pre/post
commands), packaging scripts and build scripts. Behavior-test lists describe
coverage rather than runner implementation; preloaded runtime and helper imports
remain pipeline dependencies. Scripts imported by product code
also stay full. Package metadata is read as data; selection never runs scripts.
Missing/malformed package commands, unresolved pipeline paths, unparseable scripts
and unknown module loading in a changed script fail toward full coverage.
Package manifests/lockfiles, deleted source/scripts, unresolvable import aliases,
linked/local dependencies and unknown paths run full.

Markdown-only edits under `docs/` and root documents automatically run foundation,
format and package-document inventory/original-notice hash checks, without building
or running behavior suites. This docs fast path does not require a scope opt-in.
Packaging code or inventory changes still run full. CI uses the same packaged-document
checks on its docs path.

Behavior-suite scoping remains opt-in with **`FORGE_CHECK_SCOPED=1`**, after installing
the updated runner with post-accept full main checks active and writers supporting
Work format 13. The disjoint acceptance fast-path may remain off. Both switches enter
the runtime fingerprint.

Set **`FORGE_CHECK_FULL=1`** before launching `run`/`finish` to force full. This runtime
input is included in the environment fingerprint and forwarded by the clean runtime
allowlist. The automatic post-accept main worker must set this for every scoped
acceptance, independently of its disjoint acceptance fast-path setting. The acceptance path owns that trigger. A pinned `Candidate.mainCheck = { channel }` role is copied into the run and runner comparison; it always forces full, including manual reruns with no environment override. A direct `npm run verify` remains full by default.

The standard command writes `{scope, reason, tests, reasons}` to the runner-owned
`FORGE_CHECK_SELECTION` output. Each selected file's `reasons` entry identifies a
changed-path dependency chain (with import, runtime-path, workspace-path, package-command
or dynamic edges), a conservative domain rule, explicit coverage, smoke, audit recovery or full
fallback. The retained `selection.json` and command stdout include this explanation;
existing Work summaries retain their established scope/reason/test-list fields.
The runner retains the selection as command-reported
`checkSelection`, includes the scope in run details and agent receipts, and retains
the complete test-file list and reason in stdout. This describes selected coverage,
not proof of every possible runtime dependency. File fixtures, generated modules,
child processes and source loaded by path require conservative treatment; helper,
fixture and configuration paths without explicit ownership still take the full path. The full post-main
check remains the safety net for runtime relationships static imports cannot express.

Full standard runs on native local and Actions runners record V8 coverage in a
private temporary directory for each supervised test file, including inherited
worker/child-process coverage. The supervisor emits compact `__FORGE_COVERAGE__`
records into the retained check logs; those runners reconstruct
`coverage/test-impact.json` as a check artifact only when every selected file has
a successful complete report. Hosted checks collect none: their compact logs drop
the records, and V8 block coverage made test files 0.93 to 2.83 times slower
(median about 1.9) in an interleaved A/B.
The artifact pins the checked head, source SHA-256 digests and the test-to-source
execution map. Built core JavaScript maps to its TypeScript source by path.
Files loaded by custom loaders or children that replace their environment may be
absent; this evidence does not prove that unexecuted branches are irrelevant.

The selector and `agent tests` expose an additive `coverage` shadow comparison
with current/coverage counts, the recommendation, source head/age when usable,
and an explicit fallback reason. The actual test list and all static checks stay
unchanged; no coverage-enforcement switch is enabled by this implementation.
Only retained coverage from a passed full run on an accepted native main head is read.
Git-backed owners retain graph selection.
After more than ten accepted main moves it is stale. Source drift outside the
current changed paths, new/deleted files, missing test reports, malformed or
modified artifacts and files with no recorded execution use the existing graph
selection. Shadow narrowing applies only to ordinary `src/*.ts` implementations;
configuration, schema, fixtures, generated code, web/backend domains, scripts and
test changes retain graph coverage. Fixed smoke tests and full/docs/interaction
overrides remain intact. A lead must separately decide any future activation
using production shadow evidence; historical logs without traces cannot establish
a smaller sound test set or recording overhead.

For read-only selection replays, `node scripts/replay-test-selection.mjs CHECK_DIR...`
parses each retained `modal-source` without importing or executing its modules. It
compares the saved selection against the current selector on the same changed-path
and main-audit pins, counts literal import and runtime-path consumers, and estimates
aggregate shard minutes with two workers, preserving retained shard membership
and order while removing deselected files (newly selected files are appended). Complete
`__FORGE_TESTS__` file durations from these runs supply timing evidence; missing
observations are reported and use the sharder’s existing p75 estimate. Static,
build, startup and retry costs are excluded. This is a scheduling estimate, not a
new measured check run.

For recorded historical replays, `scripts/measure-test-impact.mjs` accepts explicit retained base/head/path pins, runs the same static/build/test pipeline, and reports command wall time and selected files. It also honors `FORGE_CHECK_FULL=1` for a matched full baseline. This measurement harness does not relax the standard wrapper's full fallback for legacy Candidates without a composed-main pin.

### CI

`.github/workflows/foundation.yml` compares exact Git pins. Markdown-only changes,
including packaged docs, run foundation and package-document checks on pull requests. Other changes
run full verification on pinned Node 24.22.1, plus native self-host.
One static job runs the non-test verify stages and package smoke. It shares its
builds and the exact test plan with eight parallel test shards on GitHub-hosted
`ubuntu-latest` runners (Node 24.22.1 is the only version in the matrices).
`scripts/public-verify.mjs` reuses Forge's full selection, partitioner and Actions
executor. Every test file is assigned to a shard, including newly added files.
Only the plan's browser shard restores or installs Chromium. The scope job sends
only the selected scope, so even a very large pull request passes no changed-path
list through a runner environment variable. Both matrices disable
fail-fast, and native self-host is independent. The final `verify` job always runs
and requires every selected job to succeed, including all shards; only jobs
excluded by the docs-only scope may be skipped. Branch protection can require
this single `verify` check. Verify Forge runs on pull requests and manual
dispatches. Manual dispatches select full verification. Forge checks the exact
Candidate before landing on its own main, so pushing that accepted State to the
GitHub mirror does not start Verify Forge. Eight test shards keep one full audit
within the org's concurrent-job allowance while preserving the full suite and
every static stage.
Separately, `.github/workflows/web-deploy.yml` deploys the [web site](#web-site) from main, only when what it serves changed and at most once per window. The deploy token is present only for the deploy step.

## Code map

| Path | Responsibility |
| --- | --- |
| `src/native-source.ts`, `src/native-work.ts` | Native objects, States, native workflow |
| `src/work-store.ts`, `src/work.ts`, `src/work-records.ts` | Indexed Work store and records |
| `src/native-exchange*.ts`, `src/exchange-client.ts` | Hosted exchange, restore |
| `src/native-backup.ts`, `src/work-backup*.ts` | Export and recovery |
| `src/agent-*.ts`, `src/mcp*.ts` | Agent commands and MCP tools |
| `src/snapshot.ts`, `src/analyze.ts`, `src/compiler.ts` | Capture and analysis |
| `src/work-run.ts`, `src/work-playbook.ts`, `src/work-evidence.ts` | Checks and evidence |
| `src/native-git*.ts`, `src/work-git*.ts`, `src/work-publish.ts` | Git compatibility, GitHub publication |
| `convex/` | Hosted schema, Work events, backups, exchange, coordination, access |
| `web/src/` | Hosted browser UI |
| `site/` | Web site Worker: static app, cached public reads, device sign-in |
| `tests/`, `scripts/`, `evals/` | Tests, tooling, measurements |

Keep modules narrow (about 300 lines) with one owner. Use TypeScript, pin dependencies through the lockfile, and add the SPDX header to source files. New storage formats need migration and recovery tests.

## Dogfooding

Forge develops Forge. The project's hosted `main` Channel is the only source of truth ([AGENTS.md](../AGENTS.md)). A local Git checkout is a mirror and can lag; never commit there. Hosted `main` and GitHub `main` may differ, so check exact pins. `$FORGE_OWNER` in the commands below stands for a local checkout directory holding the Convex configuration (used by the UI-bot scripts).

Work through `nforge agent ROOT start`, edit the returned Lane, then `land --save` (see [AGENTS.md](../AGENTS.md) and the [agent workflow](agents/workflow.md)). Start from a planning Issue (`start {planningItemId}`) so the Issue closes when the Intent completes. Publishing to GitHub and deploying are separate choices. Never overwrite another Lane to match the mirror. Put throwaway builds, exports and test owners under a local scratch directory such as `~/.forge-runtime`, not Documents or iCloud.

### Landing benchmark against Git+GitHub

The landing benchmark is the hosted B1.5d driver under `scripts/bench-t3code/` (see the [regression ladder](agents/regression-ladder.md)). The earlier `scripts/bench-landing.mjs` seeded both sides from a native owner. Forge now runs hosted projects only, so that script refuses to seed: it still prints `--dry-run` plans and runs `--forge-owner source --sides forge` against a hosted checkout. `scripts/public-verify.mjs` reuses its shard plan. `node scripts/bench-teardown.mjs WORK_DIR [--dry-run]` removes the checkouts, bare seeds and installed dependency trees under a benchmark work directory and keeps logs, JSON and summaries; a directory holding a `.bench-keep` file is skipped.

`node scripts/benchmark-t3code-import.mjs DIR '{"repository":"o/r","ref":"SHA","name":"..."}'` runs a live big-repository GitHub import under the [scheduled import guard](operations/import-benchmark-guard.md). `DIR` receives `journal.json`, `progress.jsonl` and `report.json`; run it again with the same `DIR` to resume the same import after a crash. It uses a Convex deployment login and the saved `nforge` login, and creates a project named by `name`; it deletes that project only when the guard trips. The import time that counts for Phase 5 is the no-Mac import: 2 min 31 s and 2 min 37 s in two runs on the t3code repository, until the project is agent-writable (target: 5 minutes or less; [status](status.md)).

Native capture skips filenames that begin with `secret` or `credential` followed by `.` or `-`. Do not give source files or docs such names. Use `protected-values.md`, not `secrets-guide.md`.

## Install a local package

```sh
npm ci --ignore-scripts && npm run build && npm run package:notices && npm run package:local
npm install --prefix ./forge-tools --ignore-scripts --offline .forge/packages/nanthai-forge-*.tgz
./forge-tools/node_modules/.bin/nforge host ./my-project
```

`package:local` stages only the package whitelist, bundles locked production dependencies and runs `npm pack --ignore-scripts`. The package stays private (no registry publish) and runs no lifecycle scripts. Linux and Windows execution of the packed CLI is untested; `node scripts/cli-platform-smoke.mjs` checks the built CLI's refusal of unhosted folders and the shared source kernel's file handling (CRLF, spaces, case-only renames, executable bits, symlinks) on any platform, and `.github/workflows/windows-cli.yml` runs it with the Windows platform tests on GitHub's free windows-latest runner when CLI code changes (Windows differences: [quickstart](quickstart.md#on-windows)).

When you add, move or delete a doc under `docs/`, add, move or delete its manifest under `scripts/package-documents/` (see Targeted test preparation). `package.json` ships `docs/`, and `smoke:package` fails on any listed file that is missing or any unlisted one that is present. Keep `docs/vendor-notices/` byte-exact because tests pin their hashes.

## Hosted development configuration

Convex is a separate Forge project, not Edge's.

```sh
npx convex dev --configure new --dev-deployment cloud --project nanthai-forge --once   # first time
npx convex dev --once                                                                  # later
npm run dev:hosted -- --port 5179
```

Configuration is written to the ignored `.env.local`.

**Browser variables** (root `.env.local`): `VITE_CONVEX_URL` and optionally `VITE_FORGE_DEMO_REPOSITORY`. Anything starting `VITE_` is public.

**Backend variables** (Convex dashboard only, never Vite):

- `GITHUB_APP_CLIENT_ID` and `GITHUB_APP_CLIENT_SECRET`: the Forge GitHub App. Private-repository access uses the person's GitHub App user token, saved sealed when they connect GitHub (see [Convex Auth](#convex-auth)).
- `GITHUB_WEBHOOK_SECRET`: set the App webhook to `/github/webhook` on the deployment's `.convex.site` URL, with SSL verification and the Push event. Deliveries are verified by HMAC-SHA256 over the original bytes. Webhooks only record diagnostics. Re-index stays an explicit action.
- `FORGE_CLI_PRIVATE_KEY`: RSA PKCS#8 private PEM for Forge-issued CLI credentials. Generate a dedicated RSA 2048-bit or larger key; keep it server-side, never under `VITE_`.
- `FORGE_CLI_ISSUER`: exact HTTPS Convex HTTP origin, e.g. `https://your-deployment.convex.site`, without a trailing slash. `/auth/jwks` publishes only its public RSA JWK; the custom JWT provider accepts audience `forge-cli`. A token from any other issuer is treated as signed out.
- `FORGE_WEB_URL`: HTTPS origin of the Forge web app serving `/device` (the earlier `/-/device` address redirects to it). Deploy the Convex auth config, HTTP actions, functions and schema together, then publish the hosted web build. For a custom HTTP origin, set `FORGE_HTTP_URL` in the CLI environment; standard `.convex.cloud` deployment URLs derive `.convex.site`.
- `FORGE_SECRET_KEYS` is retired: no code reads it and a deployment must not set it. Sealed secrets need no server key (see [operations](operations.md#sealed-secrets-and-the-retired-secret-objects)).
- `GITHUB_PUBLIC_TOKEN`: optional, for public GitHub API reads only.
- `GITHUB_APP_SLUG`: optional, the Forge GitHub App's URL slug. An import refusal for an owner without an installation links `https://github.com/apps/SLUG/installations/new` when it is set.
- `R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`: required. Every deployment, self-host included, writes source and artifact bytes to R2, with no opt-in and no Convex-storage fallback; missing settings fail writes with `R2_NOT_CONFIGURED`. `R2_ENDPOINT` optionally points at another S3-compatible store (https, or http on loopback). See [data placement](data-placement.md).
- The list above is the minimum for sign-in, import and R2; hosted checks, Actions and workers read further variables (for example `FORGE_HOSTED_CHECK_KEY_ID`, `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY`); see [GitHub App](operations/github-app.md) and [GitHub Actions checks](operations/github-actions-checks.md).

Imports store gzip JSON in R2 (`r2blob:` references, see [data placement](data-placement.md)) with a 128 MiB artifact budget. Functions never execute target repository code. After setup, `npm run smoke:hosted -- https://github.com/sindresorhus/is-plain-obj` checks live anonymous import.

### The app at the site root

The redesigned app (DESIGN.md frames) is served at the site root by `app.html`;
`/` stays the static public page (`web/index.html`), and `/docs/`, `/assets/` and
files are static. `web/src/main.tsx` starts only `web/src/app/App.tsx` (Item
b0704959); the earlier screens (`Hosted.tsx` and its imports) were removed
(Item 88a20e56). The app lived under `/-` before; every
`/-` and `/-/*` address moves for good (301, kept forever: mails, CLI output, board
text and GitHub statuses carry those links) to the same address without `/-`. The
site Worker answers them (`site/public-read.ts`, path `/-/*`) with an absolute
Location on this site, so `/-//evil.example` stays on this site. `main.tsx` does the same for a server that
does not. The cached public read
keeps its data at `/-/public/v1/`. `scripts/ds-build-guard.mjs` keeps the
design-system behaviour layer out of the first paint.

- Addresses: `web/src/app/paths.ts` is the one codec (`hrefFor` and
  `parseAppPath` are inverses). Project places are
  `/{handle}/{project}/{needs|lanes|plan|code|stats|settings}/{section}/…`,
  account places `/account/{projects|billing|people|devices|data}`, public
  pages `/signin`, `/signin/passkey` and `/device`. A first segment in
  `src/readable-urls.ts` reservedHandles is never read as a handle.
- Old addresses: `web/src/app/old-address.ts` maps every old address to its new
  one, built from `paths.ts`: `/projects`,
  `/settings`, project `activity`, `intents[/id]`, `planning`, `views`,
  `decisions`, `settings/{section}` and short `lanes/l-…` ids. A plain path
  redirects before any screen starts, with no read. A link that names only ids
  (`/?project=<id>&lane=…`, `decisions/<id>`, `review/<id>`) opens
  `OldAddress.tsx` in the rebuilt app, which asks `urlLegacy:resolve` once: the
  server checks access, then answers the current handle and slug plus the Lane
  or Item the id belongs to (a decision opens its Intent's Item, a review view
  its first Lane); only people with a role on the project learn those ids, and
  an Intent that is not an Issue's own (a reopened Issue's successor) opens no
  Item. A project the reader cannot see answers like a missing one, and never
  names its handle. An old `head=<State>` pin on a file link is the rebuilt
  `?at=`. Settings `general`, `backups` and `transfer` open Settings > Project;
  guidance opens Settings > Agents, contributions open Lanes, and zones and
  codescape open Explore. A saved view's id has no address of its own, so `views/<id>` opens
  the Plan.
- Evidence: `/{handle}/{project}/lanes/{laneId}/checked` loads its proof screen lazily.
  Optional `save` and `run` query parameters select exact retained records; the read
  never substitutes another supplied run. One bounded read gives the header and
  claim. Report files load only when opened, through the existing paged report
  action. Full-check requests reuse the original Candidate and check pins; linked
  Items derive their retry identity from the immutable save and line. See
  [run evidence](run-evidence.md) for attribution and declarations.
- Places: each screen folder registers its own addresses in
  `web/src/app/<folder>/route.ts`, a default-exported list of
  `{ place, section?, match?, load: () => import('./Screen') }`
  (`web/src/app/screen-route.ts`); account pages register `{ place, load }`.
  `screens.tsx` collects every `route.ts` with `import.meta.glob`, so a new
  screen adds files and edits no shared file. The entry with a matching `match`
  wins, then the exact `section` ('' is the place itself), then the place's
  catch-all; matches must not overlap. A route file is data: type imports only,
  screens behind `load` (`tests/app-screen-routes.test.mjs`), so screens stay
  out of the first paint. A place reads the frame's line feed from its props
  and never opens a second line read.
- Lanes (`web/src/app/lanes/`): the overview groups the line feed's Lanes into
  Held (every held Lane, so its count is the line's; Needs me counts only what
  waits on the reader), the landing queue,
  being worked on and quiet. Folded regions read nothing until opened (Region
  `foldState`). Each link goes to the screen its address is registered to: the
  head to Sessions (which links each Lane's holder), a row to its Lane, a row
  whose check failed to that check, shared files to `touching`. An address
  under Lanes that no screen serves says so and links back to the overview.
  `history` lists what landed, newest first, with per-account
  read marks (`convex/projectLandingReads.ts`: one row per account and
  project, a read line plus at most 500 one-by-one reads); it never counts
  toward Needs you. Its first page is read when the page opens and its empty
  state shows only when that read returned no rows. Earlier pages load once
  each on request (a `before` sequence cursor). Filters (`?unread=1`,
  `?by=handle` or `handle/run`, `?item=`) live in the address; `by` and `item`
  look through at most 120 receipts per page, since receipts carry no actor
  or Item index. Each row reads its finish, Lane head and Item head; a row
  whose Intent is not an Item's first (a reopened Item's follow-up, or
  unplanned work) also reads that Intent's goal for its title. The old
  `to-read` address opens History. `touching` shows shared saved files, who
  waits on whom and the queue with held Lanes apart, saved work only. Each
  wait is traced from the queue read alone: a Lane main moved under waits on
  its own update (naming the files), a Lane two or more places back names
  the front of the queue and why it has not landed, and a Lane held for a
  dependency names the Lane it lands after when the queue lists it. The
  yard row says the same from the same read, and Needs me names it from
  `projectNeedsMe:read` `dependsOn {laneId, title}` (four point reads, only
  for a Lane held for a dependency).
- Stats (`web/src/app/stats/`): reads `projectStats.read` over the chosen
  period's closed days of `projectStatsDays` (at most 92), one part at a
  time (`src/stats-period.ts`): the head on open, each fold once opened,
  all computed by `statsWindow` (`src/stats-estimate.ts`). A day closes once
  (`projectStats.closeDay`), scheduled by the project's first landing of a
  later UTC day, so an idle project costs nothing. Opening Stats on a period
  that holds today calls `projectStatsToday.refreshToday`, which schedules the
  same close over today as a provisional row at most hourly and only after a
  landing since the last; the real close replaces it. See
  [Stats](run-evidence.md#stats).
- Invitations: Home and `/account/people` load the recipient inbox lazily. The link carries no grant; the signed-in recipient accepts or declines. `FORGE_INVITATION_EMAIL=1` enables the separate sender. Keep it off, including on dev, until the [enablement requirements in Item c6629fda](https://dev.forge.nanthai.tech/?project=mh7aafndrxmj8c2q0931zbjk2n8h4ffs&projectTab=planning&planningItem=c6629fda-c29f-48e9-b677-5094e5cf0d9b) are met. See [access](access.md#invitations).
- Sign-in: one handle field (passkey sign-in or sign-up, browser autofill) and
  GitHub. After a first GitHub sign-in with no passkey, `/signin/passkey`
  offers one (`authPasskeys`), skippable. The return address is kept in
  session storage and only same-origin app paths are followed. The client is
  wrapped by `withRefreshHold` (rule 1) and the passkey hook is mounted only
  inside `WhileAwake` (rule 2).
- `/device` approves a terminal sign-in (`deviceActions`; page rules in
  docs/security.md, "CLI device credentials"). `nforge login` links to it; the
  address printed by builds before the switch to the root, `/-/device`, redirects
  to it. Only the stable device flow
  (`/auth/device/start-v2`) starts a sign-in; a CLI that still posts to
  `/auth/device/start` gets HTTP 426 telling it to run `nforge update`. With
  `FORGE_SITE_DEVICE_KEY` set, starts and renewals come through the site
  (`site/device-auth.ts`) for the per-visitor limit.
- One Lane, `/{handle}/{project}/lanes/{laneId}` (`web/src/app/lane/`, lazy
  with its route): one bounded read, `projectLaneReview.read`, names the pinned
  saved head and every changed path with its exact blobs from the Lane's overlap
  row (400 paths a page; about 7 documents a view; no State or file body). Files
  are grouped by `src/review-order.ts`, the same groups and reasons as
  `diff {summary:true}`. A file's body is read only when opened: one signed
  `describe`, the storage GETs, the reader's re-check; over 1 MiB it is named,
  never fetched. Read ticks stay in this browser (`localStorage`, keyed by the
  exact blob read), so a file saved again comes back unread. A Lane combined on
  top of the Lane ahead shows where each line came from (`line-origin.ts`:
  main, the Lane ahead's pinned save, this Lane), and only while that Lane still
  holds the pinned save.
- Code (`web/src/app/code/`, lazy): `/{handle}/{project}/code` lists what
  landed, newest first, one receipt per row (`projectCode:history`, 25
  receipts a page, receipt fields only); `code/{receiptId}` opens one receipt.
  `code?path={file}` narrows the list to one file: it reads that file's
  history one step at a time (`projectCode:fileHistory`, no subscription) and
  not the live page of every landing; steps already read stay for the visit.
  `code/files/{path}` reads files at main, and `?at={64-hex State}` pins any
  landing; `#L42` selects a line. `projectCodeBrowse:read` returns one folder
  page (200 entries) with the first page of each of its subfolders (at most
  64 KiB more), one 16,000-character file page, or a landing's changed paths.
  Opening a file also reads its landing history, newest first, from a page of
  receipts and the exact Candidate path lists retained during composition.
  Each page checks up to eight receipts, and older receipts can be read in
  place. Receipts without a retained list are reported as unavailable. The
  signed-in and public readers share the same lookup and do no State or R2
  reads for file history. The tab
  keeps every folder it was sent (`code/listing.ts`): a folder you can see opens
  with no read, and opening it fetches the level below in the background. The views take only a project id and a route, so signed-out public
  reading is a routing change.
- `/new` (`web/src/app/start/Start.tsx`) is the first-project page: the
  explain-first prompt (the same words as `web/index.html`), import, and the
  agent app steps (`start/agent-apps.ts`, each command checked against the CLI
  usage by `tests/app-getting-started.test.mjs`). No Convex call. Getting
  started (`start/GettingStarted.tsx`) is the setup checklist on Needs me while
  nothing is held: one `projectSetup.read` (at most 8 documents) when it opens,
  a subscription only while setup is unfinished, and no read once this browser
  has seen it settled (first landing plus the one "who approves" answer).
- `/new/import` (`web/src/app/start/ImportRepository.tsx`) is the GitHub
  import page: the pre-import report (one `projectGithubImportPreview.preview`
  action, no rows written), the visibility and mirror questions, one start, then
  one `projectGithubImportProgress.current` subscription (import writes only).
  The request is kept in the address, so a reload shows the same import.
- Settings > GitHub mirror (`web/src/app/mirror/Mirror.tsx`) is one
  `projectGithubMirrorRead.read` subscription (the same words as `nforge github
  status`); the two-way switch reads the policy once and writes one set-policy.
- Settings > Landing and checks (`web/src/app/checks/LandingChecks.tsx`) reads
  three queries once when it opens and again only after its own write; choosing
  a CI file writes the same ci-status runner setting `configure-runner` does.
  While the owner chooses a check (none chosen yet, or Change), it reads one
  page of main's root folder with `projectCodeBrowse.read` to see which CI's
  files the project has (`checks/ci.ts`), and only when the root has `.github`
  it lists `.github/workflows` with one folder read and reads the first page of
  at most six workflow files (`checks/use-workflows.ts`), kept for the visit;
  `checks/workflows.ts` reads only their `on:` key to say which can check a
  landing and to show the one trigger change. With a check chosen, the page
  makes one `projectHostedLandings.read` (the first three landings since the
  choice) to say whether a landing has been checked by it
  (`checks/FirstLanding.tsx`); while none has and the check is a CI file, it
  reads the first page of that one file. Non-owners make none of the chooser's
  reads, and a check that has decided a landing reads no source. "How a landing
  is checked" (`checks/LandingSettings.tsx`, `checks/landing-settings.ts`) draws
  one folded line per landing setting from the policy and landing view already
  read: no call of its own.
- Keys: `Mod+K` palette, `?` all keys, `1`–`6` project places; never inside
  fields or dialogs.
- The top-bar mark (`web/src/app/mark.ts`) follows the line feed the project
  frame already reads: no other read, one `visibilitychange` listener (`.mk-hidden`)
  and at most one timer, for the next hold end, calm (60 s) or still (5 min or
  live reads asleep). DESIGN.md "Brand mark states" has the rules.
- The Lane's Thread and the Plan Item's discussion draw board notes and session
  messages together. The scoped thread read takes one page of 20 entries;
  earlier pages subscribe when requested. Questions that hold work are pinned among the
  loaded entries. Answers use the same coordination acknowledgement from the
  thread and Needs you. Asked-ahead questions appear separately from the count;
  same-account rows carrying a recipient session stay in coordination and the
  thread rather than the human's Needs you or FYI, including questions, FYI notes
  and hand-backs. Account-directed questions still have live answer keys.
  Needs you reuses its existing page and resolves sender and recipient sessions
  together in one batch: at most one indexed read per distinct session, no
  session read for excluded rows, and no new client call or idle work. The
  existing identity projection resolves the reader's handle at most once for
  cross-account recipient labels on the page.
  At close, a session marked by a directed question scans its newest 20 incoming
  messages (not replies or hand-backs) and notifies askers of unanswered questions
  in that window. A question outside the window does not send a close notice.
  The thread reads delivery from recorded acknowledgements and offers the saved
  resume prompt to copy while an answer is waiting. Opening Changes alone does
  not subscribe to the thread.
- Needs me (`web/src/app/needs/`) is the project front page, in three
  sections. Needs you reads `projectNeedsMe:read`: the live line's held marks
  (at most 30, the rest counted), each with its title, holder and recorded
  hold reason (the landing's recorded cause wins over an overlap mark), the
  open approval requests (`openApprovalRequests`), questions with choices and
  hand-backs addressed to the reader, and the Lanes parked for the reader (one index range
  on `projectHostedPresence.by_project_and_parked_for`, at most 30; a park is
  one optional field on the Lane record, mirrored onto its presence row). A
  Lane parked with no one named shows once its stored last-activity time is 4 h
  old, compared when the page draws (`needs/count.ts` `parkShown`). Shared-state decisions come from rows the read
  already holds, for team members only: `notices` lists the project row's revert and fix-needed notices (at most 20, the
  rest counted by `noticesMore`) and, for the owner, the GitHub mirror when it stopped on a conflict (the Mirror
  screen's three status rows and words); they count in Needs you and leave when the state changes. A held Lane is in Needs you only when the reader
  decides it (an approval or a landing held for review, for the owner;
  `needs/count.ts` `waitsOnPerson`); every other hold is an FYI row naming who
  acts next. The top bar's Needs you count subscribes to the same read and
  applies the same rule, so the two always agree. FYI adds
  `projectNeedsFyi:read` (landings, main breaking, settings and access changes,
  messages that ask nothing; each bounded) and writes only on Dismiss or Clear
  all (`projectNeedsFyi:dismiss`, one row per account and project). A Main
  broke or Drill row names the culprit the bisect proved (from the audit events
  the read already holds) and its Why opens that red at `code/red/<sequence>`
  (`web/src/app/red/`): what failed, the log one press away, main's head, the
  landings since the last pass (candidates until the bisect proves one, or the
  landing that made never-passed tests run) and how
  it ended, from one read on open (`projectMainRed:read`, bounded: one event at
  the sequence, two pages of at most 20 events, the audit and run rows, at most
  21 receipts, and once it passed again at most 10 receipts and their landing
  rows to find a revert). Every Review and Why on Needs me opens the thing it
  names. Loose ends reads `projectLooseEnds:read` only while unfolded. Idle
  costs nothing. The CLI starts a tidy pass with
  `nforge agent . lanes '{"view":"loose-ends"}'`. Follow
  `groups.stopped.continueCursor` by passing it as `cursor` with the same view.
  Each continuation reads only the stopped group, up to 25 rows in activity order
  within the first page's time bounds. A null cursor ends the pass.
- Plan (`web/src/app/plan/`) is the hand-ordered list grouped by Initiative
  ([planning model](planning.md)). It adds one read, `projectPlanView:read`:
  the Initiatives, every live Item (at most 500 per status) and each live
  Initiative's done and dropped counts, all from the planning search roots'
  indexes, so no body is loaded and closed history outside live Initiatives is
  never read. Moves write one `order` between the new neighbours and New Item
  writes a Planned Item, both through `projectWorkCommand:command` (owner only).
  The Item page shows the plan's own row, compares and restores versions (the
  versions sheet reads `planningVersions` pages only while open) and links to
  the current Item screen for the body and comments. The view (scope, type,
  owner, Initiative, relation, order, list / tree / board, find) lives in the
  address; saved views are names for those addresses kept on one browser. On a
  phone the bar keeps Find and the filters already set, and one Filter and view
  sheet holds the views, filters, order, layout and folds as native pickers; each
  row shows its status under its name. The
  Closed and Everything scopes add `projectPlanSettled:page`, one page of 50
  done or dropped root rows each, subscribed only while that scope is shown.
  Ticked rows change together through `projectPlanningBatch:apply` with one
  Undo; a merge or split reads the full Items and comments once, at that
  moment. Each Initiative group folds to its header and stays as the viewer
  left it (this browser only, no server write); Collapse all turns the list
  into the Initiatives overview, whose rows are dragged or moved by keyboard
  into hand order with the same one `order` write as an Item. A group's name
  opens the Initiative page (`plan/<Initiative id>`): its open Items in hand
  order, its counted progress, its About text read once per version, an edit
  of name, About and status, and its done and dropped Items through
  `projectPlanSettled:page` with `initiativeId`, subscribed only while that
  fold is open. There is no separate Initiatives tab. Idle costs nothing.

Billing at `/account/billing` lazily loads `web/src/billing/Home.tsx`, replacing
its placeholder; `screen=plan|invoices|payment|limit` lazily loads each [billing screen](billing.md#billing-screens).
The shared [stub contract](billing.md) adds no accounting calls.
`tests/billing-home.test.mjs` and `tests/billing-screens.test.mjs` render the real frame with
synthetic data. Set `FORGE_BILLING_SHOTS` to a private output directory when running them to capture
both themes at 1440 and 390 px. It does not verify an authenticated account.

### Convex Auth

Convex upgrades must replay scheduler self-cancellation: use `cancelPendingTask` with request `scheduledFunctionId` and a pending-only check (running mutations still appear pending); pass an already-read task to avoid a second read.

The backend mounts Convex Auth 2.0.0 on Convex 1.50.0 as `auth`, `authGithub`,
`authPasskey` and `authUsername`. The app signs in with these functions only.

New deployment settings (names only; values stay in the deployment):

- `AUTH_GITHUB_CLIENT_ID` and `AUTH_GITHUB_CLIENT_SECRET`: reuse the existing
  Forge GitHub App's client credentials for GitHub sign-in; a separate OAuth App
  is unnecessary. The owner adds the auth callback to that App's callback URLs
  and enables read access to account email addresses. Set the credentials, then redeploy to refresh the
  component bindings. They are optional for deploying (including self-host and
  bench); without either setting, GitHub sign-in returns `AUTH_CONFIGURATION`
  naming the missing setting, with no credential values. Passkeys and CLI
  credentials do not depend on them. Callback:
  `https://<dev-deployment>.convex.site/oauth/github/callback`. This differs from
  the existing GitHub App repository-connection callback at
  `https://<dev-deployment>.convex.site/github/oauth/callback`.
- `FORGE_WEB_URL`: exact HTTPS browser origin and allowed `redirectTo` origin.
  Preserve the original invitation/task URL within that origin.
- `FORGE_AUTH_RP_ID`: optional explicit relying-party domain; otherwise the host
  of `FORGE_WEB_URL`. Native associated domains/origins await the native slice.
- `CONVEX_CLOUD_URL`: supplied by Convex. Tokens use its ES256 issuer and JWKS,
  audience `convex-auth`; no separate application signing key is needed.
- `FORGE_GITHUB_TOKEN_KEYRING`: independent AES-256-GCM service-token keyring,
  using the existing `{active, keys}` format. Configure before the new account's
  GitHub App connection. It is separate from `FORGE_SECRET_KEYS`, sign-in keys,
  and the device/passkey envelope protocol. Ciphertext is bound to its Forge owner.
  Generate 32 random bytes locally, encode them as base64 and use JSON of the
  form `{"active":"github-v1","keys":{"github-v1":"BASE64_32_RANDOM_BYTES"}}`.
  Pipe that JSON into `npx convex env set FORGE_GITHUB_TOKEN_KEYRING`; capture
  output and never echo the keyring. Read it into a private process for validation:
  `active` names a key, whose base64 decodes to exactly 32 bytes. Print only a
  boolean. Keep an existing valid keyring: replacing it discards access to
  existing encrypted credentials. Retain old key ids when rotating separately.

`auth.ts` exports GitHub sign-in, identifier-first passkey sign-in and library
passkey management. The identifier is the current Forge handle, using the same
2–39 lowercase ASCII letter/digit/hyphen rules and reserved destinations as
account settings. Registration refuses every retained handle owned by another
account and claims the chosen handle in the registration transaction. Typing an
existing handle cannot create another account. A handle change moves the passkey sign-in
name in that transaction; retained URL aliases do not become sign-in names. Passkey challenge starts share a fixed-minute deployment budget of 120 and an
exact per-handle budget of 6; sign-up finish attempts use 20 and 3 respectively.
Autofill shares the global start budget. The two counter rows reset in place on
use, retain at most 120/20 charged handle counters and schedule nothing. An
exhausted budget returns `RATE_LIMITED` before a challenge or account is created.
These interim defaults do not implement the phase 8 admission policy.

`authPasskeys:start/finish` adds a passkey, the first or a later one, and
`authPasskeys:remove` removes one. Each needs a recent sign-in of this browser: a
session minted within ten minutes, or the ten-minute proof that a passkey or GitHub
check records for it (`authSessions:confirmDeviceApproval`, a GitHub device check).
They compose the pinned component functions without a library patch. The library's
own add and remove flows are not used: they first ask for a sign-in with an existing
passkey, and a passkey made on an earlier site address belongs to another relying
party, so no authenticator can answer (Safari shows only the phone QR code, and the
phone treats it as a sign-in). Removing keeps a way in: another passkey or the
linked GitHub identity; otherwise it is refused with `BAD_ARGUMENT`. The component stores no relying-party id per
passkey, so a passkey from an earlier address still counts as a way in, as in the library; and an account whose only
way in is such a passkey has to be recovered by hand. The ten-minute window is the same recent-sign-in rule as
GitHub's sudo mode: a copied browser token inside it can change passkeys, and every other browser of the account then
shows the new-passkey notice. `finish` checks the 20-passkey cap again and answers a repeat for an already stored
credential with that passkey. Sign-in
ceremonies request no extensions; the secret-envelope PRF ceremony uses its own
relying party/origin.

The shared function builders apply `forgeIdentity.ts`: a live component session
and its `users` row resolve to a Forge account key. Revoked sessions become signed
out even with copied, unexpired tokens; actions recheck after external work.
CLI subjects and credential checks retain their path with zero new session/user
reads. Browser device approval issues the normal independent Forge CLI
credential; a CLI credential cannot approve another device.
The granting mutation checks the live browser account inside its transaction,
so revocation between inspection and approval leaves the device pending.

New account keys are `user_` plus the Convex user id. GitHub sign-in stores the
numeric GitHub id (`users.githubId`) and verified email only; accounts never link
by email. An identity that belongs to another account returns
`GITHUB_ACCOUNT_MISMATCH`; nothing is merged or reassigned. The OAuth sign-in
token itself is not retained. When a person connects GitHub through Forge's own
OAuth callback, their GitHub App user token is stored sealed in `users.githubToken`
under `FORGE_GITHUB_TOKEN_KEYRING`, and private-repository checks read it there.
With no saved connection the error says "Connect your GitHub account and selected
repositories." The schema keeps the auth link event kind `legacy-passkey` only so stored
receipts still validate.

Successful GitHub links write an `authLinkEvents` audit receipt with the granting
session, operation/request digest, method, identity and time, in the grant's
transaction. It contains no OAuth ticket, token or provider profile. GitHub
tickets stay single-use: a repeated completion makes no new binding, session or
audit entry and returns the library's `INVALID_CODE`.

Self-hosters set their own HTTPS `FORGE_WEB_URL`, GitHub App credentials/callback
and independent service-token keyring, and include the auth component data in
backups. Never copy another deployment's credentials or infer account ownership
from an email address.

Access tokens last one hour; session/refresh lifetimes retain library defaults.
Browser builders must apply both lifecycle rules:

1. Hold refresh while hidden **or dormant**, coalescing wake-up into exactly one
   refresh before authenticated reads resume.
2. Enable passkey autofill only while the sign-in tab is visible and active;
   focus-triggered autofill follows the same rule. Continuous mounting renews challenges
   about every eight minutes.

With those rules, idle clients add zero calls. No cron is added. The library's
finite challenge cleanup and sign-out token deletion drain, then stop: zero
scheduled calls per day at fully idle. A browser identity reads one component
session and one small user row per invocation; actions repeat this after external
I/O. Cost is constant at 7/14 accounts and 312/624 projects. Sign-in records occupy
a few KB; source/artifacts stay in R2. These are code-path budgets, not a new
dev billed-usage measurement.

#### Secrets screen interface

Settings › Landing and checks › Secrets is `web/src/app/secrets/` at
`/:handle/:project/settings/secrets` (the rail lists it directly under Landing and
checks; its page count is the number of Needs-you rows). The design is
`design/secrets-page/`. The page is value-free and changes nothing: every action is a
command a person copies and runs on a terminal, where the CLI verifies and signs.

**One names-only read.** `sealedSecrets:overview { projectId, kind?, part?, after? }`
(write role; a reader gets `{status:'reader'}`) returns names, kinds, versions, holder
handles and device codes, the take-out rows, the rotate list and the waiting proposals,
derived from the project's active set rows (at most three indexed reads), the
owner, direct writers and linked-team writers in one bounded listing (`planningMembers`) and one account row per matched holder. It
does not read the history row, a proposal row or a credential row. Its `returns`
validator (`convex/sealedSecretOverviewFields.ts`) has no bytes field. The web calls it
with `convex.query`, never `useQuery`: on open, on Refresh or Retry, and once per
"Show the next 100 / 25" page (`kind`, `part`, `after`). No subscription, timer or
polling, so an idle or hidden tab and any write by anyone cost this page nothing.
Guards: `tests/secrets-screen.test.mjs` fails if any web file references a sealed read,
write or proposal-bytes function, or the page uses a subscription;
`tests/sealed-overview.test.mjs` fails if the return shape carries bytes.

**Derivations.** `src/sealed-overview.ts` is shared by the server and the CLI: the
rotate list is the live names whose value epoch is at or below a former computer's
last epoch (`rotateList` in the CLI is this function), take-out rows group marked
person entries by account, and holders group a roster's device entries by account
(a computer's own name is shown only to its owner). A holder's handle comes from the
project's owner, direct writers or linked-team writers; anyone else shows "Not reported".

**Needs-you counter.** Each set row keeps `needs` (removed people still listed + names to
rotate + waiting proposals), zero included, and the project row keeps their sum,
`secretsNeeds` (`convex/sealedSecretNeeds.ts`). The writes that change them move it in
the same mutation: a head write, `propose`, `reject`, and every marker add or clear. A set
row with no `needs` was stored before slice 4 and has contributed nothing to the counter,
so its first write adds its whole total and never subtracts an uncounted one. The project
counter is absent at zero, adds one small number to the project row the Needs me read
already holds (no extra read on project load, no idle cost), and `projectNeedsMe:read`
returns it as `secrets` to write members only. The top-bar count and the Needs me page
include it, as one row pointing at Secrets.

**Rollout initialiser.** `sealedSecretNeedsInit:initialise { apply, after?, limit? }` is a
one-off internal mutation (delete it once every deployment has run it). It reads at most
`limit` set rows (default 8, at most 16) by index in project order, measures each active
row from its signed records, and sets each row's `needs` and each project's counter to the
measured sum. `apply:false` writes nothing and returns the counts it would change; a run
with nothing to change writes nothing, so replays are free. Repeat with `after` set to the
returned `next` until it is null. It is never scheduled, so idle costs zero.

**Secret Object purge.** The one-off job that deleted the retired Secret Object rows ran on dev and is gone from
`main`; production runs it from the pinned in-between release (steps in
[operations](operations.md#sealed-secrets-and-the-retired-secret-objects)). Delete `FORGE_SECRET_KEYS` from a
deployment by name once the code that read it is deployed.

**Command per set.** A copied rotate command carries the set it was listed under:
Development is the CLI's default, Checks adds `--set checks`, so a Checks row can never
overwrite the Development value of the same name. Production has no CLI selector and gets
no command.

**Access and stale replies.** Any access denial clears the page's rows: a `reader` reply
(on open, Refresh or a "Show the next" page) or an authorization error (`AUTH_*`,
`PROJECT_UNAVAILABLE`); any other failure keeps the last snapshot, marked stale. Every
read starts a new generation, and a reply of an older one is dropped. A "Show the next"
page joins only the snapshot that asked for it: when its set head or total differs, the
page reads the whole overview again instead of combining two snapshots.

**Kept beside markers.** A marker keeps when it was set and, when the person left the
project, their public Forge handle (`revokedNotes`; handles only, never names or
emails). A re-key moves the handles of the entries it removes to `formerHandles`, so
"after @handle left" survives the re-key. A removed CI machine's given name moves there
too (a signed former entry holds only an id), so the rotate list on the page and in
`nforge secret list` shows `“walk-ci” (id c876f11a)`, and a removed computer keeps its name
the same way (with its account, so the page shows it only to that account; the terminal shows
it to any holder, who can read it in the signed roster). An entry with no kept name is looked
up once, in the roster the write replaces and then in the history row the write already read,
and a miss is stored as an empty name so no later write decodes again. A device's own name comes
from its signed roster entry, written from the sign-in's device name when it first joins, and
the page shows a computer's name only to its owner. An older entry that still says "this
device" takes its sign-in's approved name in `entryNames` on the next write that device makes
(no read is added to a page load; until then the page shows its code). The terminal prints
every such label after control, escape and direction characters are removed (`safeLabel`). `propose` keeps the proposal's operation and
kind on the pending facts so the page names them without opening the sealed bytes. A
computer's sign-in ending and a person leaving the project are separate reasons: a marker
carries the handle only when the person left, so the holder list says "left the project"
only then, and a marker set for a signed-out computer takes the handle when its person
later loses project access.

See [trust boundaries and current check-secret guidance](security.md#secrets-for-checks).

### Signed-out landing review

`node scripts/ui-shots.mjs --base http://localhost:5295 --out /absolute/path/ui/s5 --pages landing --widths 1500,390 --themes dark,light` captures the public front door without reading bot credentials. It saves viewport/full-page shots, four live hero frames over roughly ten seconds, a composed strip, and `cpu.json`. CPU compares 30 seconds of animated idle with 30 seconds of the reduced-motion still, using headed Chromium renderer process CPU time and main-thread task time, expressed as percent of one core. Keep this manual measurement outside `verify`.

Now groups unacknowledged messages per Lane or Intent, shows the latest message with expandable earlier messages, and offers Acknowledge all. Message bodies start at two lines; recorded sender names and audience sit in the item metadata. Broadcast titles use the first sentence. Known Work ids and unique prefixes in message and session prose become named links using loaded records; unresolved or ambiguous ids stay short and unlinked. The situation counts and the people panel use the same loaded session observations, excluding automatic workflow duplicates and completed Lanes. Queued checks are static; preparing and running checks animate. Current Lane and session lists show five items with a disclosure for more; mobile people form a horizontal strip.

The project shell uses Now · Work · Code · Settings. Work switches Intents · Lanes · Candidates · Planning; Activity is under Now. The signed-in root is the project list. Retired collection, Explore, Agents and classic Work destinations normalize to these homes.

Project URLs are `/<owner>/<name-slug>~<project-id>`, followed by `/intents`, `/lanes`, `/views`, `/planning`, `/activity`, `/review/<id>`, `/code/<path>` or `/settings/<section>`. The stable project-id suffix makes slugs unique without backend migration and lets old names redirect after the current project loads. Work UUIDs are losslessly encoded as `i-`, `l-` or `v-` plus 22 URL-safe characters. Source revision, line, symbol and filter state remain query parameters. `shell/location.ts` decodes presentation state for existing page controls; it never supplies authority. The site Worker serves the app shell on project paths; assets and APIs retain their own routing. The shared codec in `src/project-routes.ts` still decodes older `/local/<name-slug>` links, but nothing serves them.

Application loading uses the smoothed orbiting lower arm (2200ms). Reduced motion renders a static mark. Capture seven frames with `node scripts/ui-loader-shots.mjs BASE_URL OUTPUT_DIRECTORY`.

The public page at `/` is static: `web/index.html`, one stylesheet (`web/src/landing/landing.css`, which imports the design system's one token source, `web/src/ds/tokens.css`) and two small scripts. It loads no app code and makes no Convex calls; the signed-in app is `web/app.html` (home `/projects`), which the site Worker serves for every other route. A browser that has been signed in, or a legacy app link such as `/?project=…`, is sent on to `/projects` by the page's one inline script (its CSP hash is in `site/headers.ts`, checked by `tests/web-headers.test.mjs`). Every section reads fully without JavaScript: the race and charts are written in their end state. The pricing section shows the plans of `web/src/billing/contract.ts` (monthly only; nothing is charged before launch), and the page test fails when its figures drift from the contract. `page.ts` (about 2 KB gzip) fills the copied prompt with the site's own `/llms.txt`, copies it, reveals the statement once, types the terminal while it is on screen, plays the race once and then rests, and draws the charts once on first view. The hero, Threads, is `hero.ts` (about 5 KB gzip), imported when the browser is idle after load: main is a vertical line on the left, three Lanes flow into it on a 21.6 s scripted loop (an overlap, a held Lane, three landings), and the close runs free Lanes beside its text when there is room. Both share the page's one requestAnimationFrame loop (`frames.ts`): 30 fps, 15 fps after 60 s without input, never stopping while visible; it stops off screen, in a hidden tab and under reduced motion, which draws one still. The dot floor is drawn once per layout into its own canvas. `tests/landing-page.test.mjs` derives every figure from `docs/research/p6-exit-bench-results.md` and checks every link. `node scripts/ui-shots.mjs --pages landing --base URL --out DIR` (against `vite preview`, not the dev server) saves stills per width and theme, keyboard focus, no-JS and a hero strip, and checks the motion lifecycle, cold-load bytes, main-thread time per frame and memory. Fonts: Atkinson Hyperlegible Next and Mono, self-hosted Latin subsets (`web/src/assets/NOTICE.md`).

The design system lives in `web/src/ds/` ([DESIGN.md](../DESIGN.md#using-the-system)). With `npm run dev:hosted`, `/ds.html` is its reference surface: one screen built from the shared parts, with a theme switch. It is not a build input. The behaviour layer (`web/src/ds/behaviour/`, React Aria Components) loads after first paint; `tests/ds-layer-bundle.test.mjs` builds the app with the reference surface and checks the layer stays out of first paint, within `web-ds-layer-gzip`, with English messages only.

### Device login verification

Local negative tests: `npm run build:core && node --test tests/device-login.test.mjs`. They use synthetic keys/identities and the existing in-memory Convex fixture; they do not deploy. Full `scripts/forge-check.mjs` remains the acceptance gate.

After the lead deploys/configures the backend and hosted browser, unset `FORGE_AUTH_TOKEN`, run `nforge login DEPLOYMENT --name "Test CLI"`, sign in at the printed URL and approve the code. Run `nforge auth status`, a coordination read, a hosted Work read and an exchange against a permitted synthetic project. Confirm another user's project remains unavailable. Repeat with `--scope coordination`: coordination works, hosted Work/exchange fail. Revoke in Account → Account & data and confirm status/reads fail. Login again and run logout; status has no saved credential. Repeat login with Deny and with an unapproved code after ten minutes; neither saves a credential. Verify the auth file mode is `0600` and no CLI output contains the JWT. HTTP JWT/JWKS acceptance and live browser interactions require this deployed manual pass.

### Performance budgets

After `npm run build:core` and `npm run build:hosted -- --manifest`, run:

```sh
node scripts/perf-harness.mjs --bundle hosted-web-dist \
  --work-owner /path/to/existing/native-owner --out private-artifacts/perf/result.json
```

Without flags beyond `--bundle`, this command records bundle sizes and nothing else; with `--work-owner` it also reads an existing accepted landing's Work records from a native owner. It never pushes, starts a check, finishes work, accepts, deploys or backfills. The one-file exchange push measurement was retired with exchange push: its result is always `unrun`, and hosted save and land metrics cover the current path. `--samples` (default 3) and `--timeout` (default 60000 ms) apply to the live browser measurements.

Add `--live --base DEV_URL --project PROJECT_ID --lane RETAINED_LANE_ID --build-hash DEPLOYED_HASH` for authenticated cold Now, Work and Lane first-diff measurements. Use a Vite development frontend or an explicit QA build with `VITE_FORGE_PERF=1`; normal production bundles omit the readiness markers. `--live` enables browser navigation only; push remains synthetic. Chromium and the existing user-owned `0600` UI-bot credential file are prerequisites. `--credentials` overrides its usual `~/.config/forge-ui-bot/credentials.json` location. Sign-in reuses `ui-shots`' real bot login. Cookies, tokens and browser storage remain in memory. The read-authorized project identity resolves canonical URLs before measurement; no project authority is bypassed.

Each navigation gets a fresh 1500 × 1000 browser context with only authenticated storage reused. HTTP caching is disabled and service workers are blocked. Durations start at document navigation: Now/Work end at their frozen `__forgeCritical` complete marks; Lane ends at `queries.sourceDiff`, with a populated diff required. Missing-State errors, alerts, runtime failures, route changes, an empty Lane or missing QA marks cannot pass. Critical completeness means the named reads' first results, not full retained history or presence. `firstContentMs` is the QA hook's first-effect mark, not a separate populated-DOM measurement. Use the same frontend build, backend, fixture, machine and sampling conditions for comparisons; fresh contexts do not flush backend caches.

The result records the browser auth mode. Passkey runs time the rebuilt Needs me and Plan screens for the Now and Work budgets. For the Lane budget, the harness opens the first changed file and waits for its highlighted diff. Use a retained Lane whose first file has a text diff. Compare runs made with the same auth mode and screen.

JSON includes machine/runtime identity, timestamps, all samples, medians and separate budget results: Now/Work ≤1500 ms, Lane first diff ≤1000 ms (the one-file push budget was retired with exchange push). A failed sample or exceeded median budget exits 1; omitted live runs are explicitly `unrun`, leaving overall status `partial`. Requested live setup failures also exit 1 and still write JSON. Results default to the ignored `private-artifacts/` directory and have mode `0600`; errors and browser source, credentials and payloads are not retained. `--samples` and `--timeout` select sample count and browser timeout.

`--bundle` requires the Vite manifest and records raw/gzip bytes, the largest JavaScript chunk, total JavaScript and the static import closure for the shell plus initial application module. Dynamic routes and workers remain in total bytes. Its content hash identifies those local assets; `--build-hash` separately identifies the source or deployed frontend supplied by the caller. Without that flag, the top-level hash covers local compiled core JavaScript and is explicitly not a deployed frontend identity.

Landing evidence is read-only from existing native Work. `--landing-id` selects a specific acceptance; otherwise the newest accepted main record is used. Full Intent lifetime runs from Intent creation to exact-Candidate acceptance and includes author time and waiting. Compose-to-accept, check queue and check execution durations are separate. Unrecorded finish invocation time stays `null`; the harness does not manufacture a landing to time it.

### Signed-in hosted UI review gate

Use the real signed-in app for hosted UI review. Isolated screen fixtures remain useful, but cannot reveal broken routing, legacy wrappers, missing live data or authentication integration. Before signing off a hosted UI change, capture and inspect desktop and mobile pages on the live site or local `npm run dev:hosted`. This is an on-demand review tool, **not part of `verify`**: it needs Chromium, network access and local bot credentials.

```sh
npm ci --ignore-scripts
npx playwright install chromium
node scripts/ui-shots.mjs --base https://<your-site>.workers.dev \
  --out /absolute/private/path/ui/live --pages now,intents,settings \
  --widths 1500,390 --themes dark,light
```

`--base` also accepts a draft origin or `http://localhost:5179`. `--project ID` overrides the project stored with the credentials; `--height` defaults to 1000. `--pages` accepts `landing` (alone), `home`, `now`, `intents`, `lanes`, `planning`, `stats`, `code`, `settings` (or `settings:checks`, `settings:access`, `settings:devices`, `settings:github`), `device`, `lane:ID` and `initiative:ID`. Include specific records with `--pages 'now,intents,lane:LANE_ID,settings,device'`. The tool seeds its route codec from the access-checked project identity before validating readable-URL redirects. Add `--diff-file src/example.ts` to select a specific file in Lane/Review screenshots. `settings` opens the shared Settings destination's Contributors page; owner-only lifecycle settings are unavailable to the reader. `device` captures the rebuilt code-entry screen without approving any login. Every capture needs the passkey credential below. A credentials file without a `passkey` entry is refused with "Bot credentials need a passkey. Run node scripts/ui-bot-setup.mjs --passkey."

Intent Review actions require a passing check matching the current Candidate head and exclude accepted or superseded Candidates. Intent detail work maps cluster dense save histories and show the latest five Candidates when more than six exist; the earlier link leads to the expandable Candidates list. Candidate detail uses Intent-relative numbering, and lists larger than 50 files group each loaded page by top-level folder. Folder rows count their visible files and show a diffstat when available. The final row expands the remaining paginated files; file/save provenance remains expandable. Hosted read models do not currently supply line diff totals, so those values remain absent rather than estimated.

Each selection produces `PAGE-WIDTH-THEME.png` (first viewport) and `PAGE-WIDTH-THEME-full.png` (whole page), plus a `manifest.json` with exact routes and dimensions. Inspect both: a legacy page above a cockpit can push meaningful content below the first viewport. A successful capture requires the bot's identity, project read access, rendered page content, completed loading and no visible alerts or uncaught JavaScript errors. Missing records, sign-in failures and inaccessible projects exit nonzero. This is screenshot evidence, not automatic visual approval or pixel comparison.

The dedicated bot is the Forge dev handle `forge-ui-bot`. Its passkey and project ID live only in `~/.config/forge-ui-bot/credentials.json` (user-owned `0600`, directory `0700`), outside repositories. The tool signs in with a Chromium virtual authenticator on the real sign-in page. It creates a fresh, in-memory browser context and never saves sessions or traces. No application auth state or backend authorization is mocked. Keep screenshots private and outside source control; they contain private project data.

Setup allows per-user `.forge` and `.nforge` directories directly in the resolved home directory. A home with Forge checkout or Work metadata is still refused, as are Git repositories, Forge Lanes and checkout caches in the resolved credential path.

Point either tool at the private file with `--credentials`. Its top-level `passkey` entry contains `origin` (the exact HTTPS site origin), `deployment` (the HTTPS Convex origin) and `credential` (Chromium's resident WebAuthn credential with `credentialId`, `privateKey`, `userHandle`, `rpId` and `isResidentCredential: true`). The binary fields use standard base64, as returned by Chromium. Keep the optional top-level `projectId` or supply `--project`. The tools verify the authenticated handle and keep the web session in memory.

Use `now,intents,settings` for Needs me, Plan and People and access. `lane:ID` takes an optional `--diff-file`; native project, device and account pages are supported too. A malformed or mismatched passkey file fails in the native flow. Signed-in runs disable Playwright wire logging because browser protocol frames carry credentials.

From a built checkout with Chromium installed and a current owner `nforge login` for dev, run:

```sh
node scripts/ui-bot-setup.mjs --passkey \
  --base https://dev.forge.nanthai.tech \
  --deployment https://benevolent-wildebeest-974.convex.cloud \
  --project mh7aafndrxmj8c2q0931zbjk2n8h4ffs --grant-reader
```

`--base` and `--deployment` must be the Forge dev values; setup refuses any other.

The command registers the bot's passkey when the dev handle is available, verifies it in a fresh browser and reuses the saved passkey on later runs. If the bot handle already has an account but no saved passkey matches, setup stops with "Restore the saved bot passkey." Keep a copy of the private file.

With `--grant-reader`, the saved owner login starts a Read invitation, and the native bot accepts it. The project’s existing membership policy may hold the request for owner approval. Approve in Forge and rerun the same command. On deployments without CLI membership approval requests, send a Read invitation to the bot's handle in **People and access** (on dev the account is `@forge-ui-bot-dev`; the setup names it when it stops), then rerun to accept it. An existing reader grant is verified and reused. The bot's browser session stays in memory.

**Rotate the bot's passkey** after its private file or a session log has been exposed: `node scripts/ui-bot-setup.mjs --passkey --rotate`. It signs in with the saved passkey, adds one new passkey from Sign-in and devices, removes every other passkey from the account, saves the new one and drops the old ones from the file, then proves in a fresh browser that the old passkey no longer signs in. It prints only the first eight characters of credential ids. The old passkeys are removed only after a fresh browser signs in with the new one, and a rerun resumes from the staged one. A rate limit or timeout while proving the old one refused is reported as inconclusive. A passkey belongs to one site address: set `FORGE_DEV_WEB_ORIGIN` after a site move; `--base` must equal it. `--passkey` retires a saved passkey for another address but cannot enrol on an account whose handle is taken. Once only: sign the bot in on the web by another way (GitHub link), add a passkey in Sign-in and devices, and put its credential in the private file as `passkey` for the new address.

**Idle read for one project tab:** `node scripts/idle-read.mjs --project PROJECT_ID --path HANDLE/SLUG --minutes 30` signs in as the bot, opens the project, and counts that project's Convex executions (from `convex logs`, keyed by `FORGE_PROJECT_EXECUTION`) for the open burst and the idle window, with documents and bytes read per function. Use a quiet scratch project that only this tab opens. The bot reads a public project without a grant; make a scratch project public only for the read. Add `--item FULL_ITEM_ID` with `--path HANDLE/SLUG/plan` to click that Item's row on the Plan after the open settles: the output then carries `itemOpen`, the billed read bytes per query for the Item open on top of `open` (the Plan open). `--minutes 0` skips the idle window, so a Plan click costs about two settle periods. `--settle` is seconds per window; read bytes use the provider-billed `databaseIoReadBytes`. Rows are keyed `function [caller]`: browser queries are `SyncWorker`, agents `HttpApi`, jobs `Scheduler`/`Action`, so other traffic on a busy project can be set aside. The log stream names the deployment the bot signs in to, so no project folder or `CONVEX_DEPLOYMENT` is needed. The browser uses Playwright's default 1280x720 viewport; compare only runs made with the same probe.

A reader can see project source, retained Work, policy and activity, but cannot write Work, publish coordination, run checks, return source, accept Channels or change project policy. Existing owner/contributor permissions are unchanged. A write-access bot cannot be made read-only by adding a reader grant.

Reader access is the normal Read invitation to the bot's handle. The setup script keeps one invitation operation id per deployment and project (`readerGrantOperationIds`), so switching `--project` requests a new invitation, and reuses a pending Read invitation instead of replacing it. It refuses a bot that already has write access. A bot without access makes either tool stop with `BOT_NO_READER_GRANT`. Readers open projects by direct project URL; they are not listed in the contributor-only “Shared with you” collection. Browser captures need only the bot credential file.

### Web site

The dev site is the Cloudflare Worker `nanthai-forge-dev` on the Workers Free plan, at its custom domain
https://dev.forge.nanthai.tech (a Worker custom domain on the `nanthai.tech` zone; Cloudflare keeps its DNS record
and certificate). It is the relying party for passkeys, so its passkeys never sign in to the future production site.
The Worker's own address, https://nanthai-forge-dev.nanthai-forge.workers.dev, answers the front door, every app
page and the CLI sign-in calls with a permanent redirect to `FORGE_WEB_URL`; other static files there (docs pages,
scripts, text files) still serve, free, and none of them signs in. The CLI refuses a redirect on device sign-in, so it
follows the origin the Convex deployment advertises: set `FORGE_WEB_URL` there before the redirect deploys. Static files from `hosted-web-dist` are served by the platform before the Worker runs,
so they cost no Worker request, and carry the headers of `site/headers.ts` as `_headers`; the front door `/` is the
one exception, run through the Worker first (one request per visit) so its redirect works too. A path with no file
runs the Worker (`site/worker.ts`): device
sign-in (`site/device-auth.ts`), the cached public read and the 301 for every earlier `/-` address
(`site/public-read.ts`), and the app shell for any other path. Every Worker response gets the same security headers.
The Worker reads the visitor's address from `CF-Connecting-IP` and forwards only its keyed hash.

`node scripts/build-site.mjs OUT --commit SHA --state HEAD --sequence N` writes the build (static files, the bundled Worker,
`worker.config.json` with its bindings and secret names, and `/_forge/build.json` with the Forge State, main sequence, commit, build time and a
digest of everything served), and stamps the build version into the public page footer (`index.html`) and `<html data-build-version>` on `app.html` (read synchronously by the signed-in app rail with no extra request). `cf deploy --prebuilt --no-provision`, run in `OUT`, uploads it. The `cf` CLI is
pinned with its own lockfile in `site/deploy/`, so only the deploy job downloads it.

The Worker's `PUBLIC_PAGES` R2 binding (the public snapshot bucket that site/public-read.ts reads, so a signed-out or crawler cache miss makes no Convex call) comes from the repository variable `FORGE_PUBLIC_PAGES_BUCKET`, which the dev web deploy passes to `build-site.mjs` (`scripts/site-worker-env.mjs`). The variable holds the same bucket the Convex snapshot writer writes to; the repo never names it. Unset or empty leaves the binding off and the Worker keeps its Convex read; a malformed name fails the build without printing it. Setting or changing the variable takes effect on the next web deploy, because the binding is part of the build's digest.

**When it deploys.** Forge's two dev targets are declared in [deploy-targets.json](../.nforge/deploy-targets.json).
Their workflows start straight from accepted Forge main landings via the configured adapter
(`convex/projectDeployDispatch.ts`). The landing schedules them independently of the GitHub mirror.
Neither workflow triggers on GitHub pushes. Each run
authenticates to `/deploy/actions` with GitHub Actions OIDC (`id-token: write`), reads Forge `main`'s newest `(head, sequence)`
and changed paths since the last recorded deploy, and overlays only the changed blobs from R2 (`scripts/forge-deploy-ci.mjs`),
keeping one deploy running and one queued per target (`cancel-in-progress: false`). Both workflows also keep a 3-hour disaster
catch-up schedule (`7 */3 * * *` for dev web, `17 */3 * * *` for dev Convex).

For the dev site, `scripts/site-deploy-plan.mjs` gates every build:

1. **Plan**, with no install: read Forge `main` (and changed paths since the last recorded web deploy) plus the live
   `/_forge/build.json`. If `main` is already live, or if none of the changed paths touches a served file (`web/`, `site/`,
   `docs/`, `skills/`, `README.md`, the package files, the workflow, the build scripts, the document manifests, the files the
   generated CLI, MCP and error references read, or any file the last web build read) and the public error codes are unchanged,
   the run ends here. A test-only landing dispatches nothing. Scheduled runs (`plan --deep`) count any `src/` or `scripts/`
   change too and let the digest decide.
2. **Window**: if the live site was built less than **5 minutes** (`DEPLOY_WINDOW_SECONDS = 300`, shortened from 20 minutes in
   Item 8b6efb50) ago, the run ends without waiting. When a landing arrives inside the window, Forge schedules a single
   trailing flush right after the 5-minute window opens (zero polling, zero idle cost), and the 3-hour schedule stays as
   disaster catch-up, so active-work lag falls from up to 20–180 minutes to at most 5 minutes.
3. **Compare, upload, smoke and report**: build, upload only when the digest is new (or the live record lacks a Forge `state`).
   The upload makes up to three attempts, 30 seconds apart, for Cloudflare HTTP 5xx or API error 10013.
   The job logs the next attempt number and error code before each retry. HTTP 4xx, authentication and configuration errors fail immediately.
   Then run `scripts/forge-deploy-ci.mjs smoke` against `https://dev.forge.nanthai.tech` checking `/_forge/build.json`
   (on upload, waiting up to 120 s with exponential backoff and a cache-busting query for the deployed State while failing fast
   on a newer-but-wrong state or non-200 and recording `live after Ns`; on an unchanged rebuild, checking live health so a
   prior smoke failure is never cleared without passing smoke), followed by one public-read JSON path
   (`/-/public/v1/explore/active.json`), `/sitemap.xml` and one old `/-/` 301 redirect (`/-/explore` → `/explore`, 3 attempts). `scripts/build-site.mjs` computes the content digest before stamping
   `Build #<seq> · <head8>` into `index.html` and `app.html` (`data-build-version`), so unchanged
   builds keep the same digest and skip Cloudflare upload. Every attempted deploy reports its outcome (`succeeded`, `failed`,
   or `smoke-failed`, keyed per `${run_id}:${run_attempt}`) back to `projectDeploys` via `/deploy/actions` (authorized only
   for the declared target and its configured CI adapter repository), so `landings {receiptId}` and `lane-history` show the first
   successful deploy whose head contains a landing (`deploy.sequence >= landing.sequence`, or the prior successful deploy
   marked `unchanged: true` when no paths affecting that target changed), `wait {"deploy": ...}` subscribes reactively
   without polling, and **Now** shows any deploy or smoke failure until the next attempt succeeds.
   An unowned failure becomes a **Needs you** request after the project's attention threshold.

Measured on the 100 landings of 2026-11-22 14:38 to 2026-11-23 04:45 UTC (85 of them changed a served file), which
reached GitHub in 56 pushes: the old push-per-landing rule made **56 deploys per 100 landings** (89 billed runner minutes, 61 actual);
the 20-minute window with a 3-hour catch-up made **23 deploys per 100 landings** (85 billed minutes, 51 actual, median 27 min,
max 133 min wait). Shortening the window to **5 minutes** (`300 s`) with 10-second burst coalescing and a single
Forge-scheduled trailing flush when a landing arrives inside the window keeps **zero idle polling** while keeping the
3-hour schedule (`7 */3 * * *` web, `17 */3 * * *` Convex; read-only plan query) only as disaster catch-up. Projected from
the path mix: ~30–40 web deploys and ~20–30 Convex deploys per 100 landings (~90–125 runner minutes/day on free public
runners; Cloudflare Workers deploys are unbilled). *Unrun until the GitHub mirror resumes and the updated workflow files
are approved and pushed to GitHub: live replay of frictions `c498d10a`, `82aa0201`, `659d778b`, `4af9bba4` and the
10-landing before/after timing sample.*

The Worker's settings are Worker secrets, never in the build: `FORGE_WEB_URL`, `FORGE_CONVEX_SITE_URL`,
`FORGE_PUBLIC_READ_SECRET`, `FORGE_CLIENT_HASH_KEY` and `FORGE_SITE_DEVICE_KEY` (every declared secret must
be set before a deploy succeeds). Set them with the signed-in `cf` CLI, piping each value. The GitHub environment
`cloudflare-dev` (deploys from main only) holds the deploy token `CLOUDFLARE_API_TOKEN` (Workers Scripts edit on
this account, nothing else), the variable `CLOUDFLARE_ACCOUNT_ID` and the public `VITE_` build variables.

A deploy by hand uses the same steps: `npm run build:web` with the `VITE_` variables, `build-site.mjs`, then
`cf deploy` from the output. To roll back, redeploy an earlier version from the Cloudflare dashboard
(Workers → nanthai-forge-dev → Deployments) or dispatch the workflow on an earlier commit.

Passkeys belong to their origin: a passkey made on an earlier site address does not sign in here. Sign in with
GitHub, add a new one in Sign-in and devices and remove the old one there; do the same for the UI bot's passkey for
[captures](#signed-in-hosted-ui-review-gate).

To attach the custom domain to another Worker, put `"domains": ["HOST"]` in a scratch Build Output's
`worker.config.json` and run `cf workers triggers deploy --prebuilt` there once; the site's own build declares no
domain, so a deploy with the Workers-only token leaves it in place. The move also sets `FORGE_WEB_URL` on the
Convex deployment and the Worker, and the R2 browser CORS origin ([R2 storage](r2-storage-plan.md)). GitHub
sign-in's callback is on the Convex site address and does not change.

Public-repository analysis runs in a Convex Node action (`convex/indexer.ts`). An import makes more than 2,000
GitHub reads, past the Workers Free plan's 50 subrequests and 10 ms CPU per request, while a Convex action may run
for 10 minutes.

### Diff performance diagnostics

Lane and Review changes read a file list, then the selected file. Selected `comparison` results include `beforeBlob` and `afterBlob`: exact blob hashes, or `null` for an absent side. Local summaries
prioritize the open Lane and publish progressively while other Lane summaries
load concurrently. Revisiting a file in the same pinned comparison reuses its
loaded result; changing the source pins or explicitly retrying invalidates that
view's cache. Large hunks retain their full scroll extent while only nearby rows
are mounted.

For React development profiling, set
`sessionStorage.setItem('forge-diff-profile', '1')` before opening a diff. The
`forge:diff-render` Performance measures contain React `actualDuration` and commit
phase, without source text. Production React builds do not supply profiler
measurements. Hosted source action responses also include `timings.manifestMs`
and `timings.totalMs`; use the browser's Convex Action/ActionResponse frames to
measure end-to-end time and response bytes separately. Neither server timing nor
payload bytes include browser rendering. The review server reuses verified raw
storage bytes and blob-pair hunk calculations; every request still checks current
project access and storage metadata, including cache hits. These process-local
caches are expendable and do not guarantee warm reuse across Convex instances.


### Interaction selection and retained evidence

When a native `finish` check passes and main advances, the disjoint fast path
continues to require exact immutable manifest independence. Graph edges select
behavior tests only. If the fast path refuses, finish pins the passing run,
its composed main M0, its checked candidate and the next main M1 before syncing.
The next attempt checks and accepts its exact merged Candidate through the ordinary
current-main compare-and-swap. Lost replies replay the same pins and run; another
main movement creates a separately pinned attempt.

With `FORGE_CHECK_SCOPED=1`, the runner validates the reused passing run, check
definition, runtime, Candidate inputs and dependencies, native ancestry and exact
clean composition. A composition whose only conflicts are Markdown docs counts
when the merged source equals the deterministic finish resolution
(`src/native-docs-resolve.ts`), recomputed from M1 and the checked candidate;
the evidence reason names the resolved paths. Code interaction needs an exact passing full run on pinned M1 (a full main audit
may differ only by its intentional `FORGE_CHECK_FULL` setting). Manual resolution,
changed or unavailable pins, uncertain external inputs, or unavailable main
coverage make interaction evidence ineligible. With scoped mode ON, well-formed
ineligible evidence uses ordinary selection on the merged comparison paths and
records the ineligibility reason. Checks declaring external passthrough,
credentials or declared inputs make this retry ineligible for interaction selection.

Both complete path sets come from immutable manifests: M0 to the checked
candidate, and M0 to M1. Exact paths and directory-prefix collisions contribute
to overlap. Both sets are classified before the documentation shortcut. Unknown,
deleted, packaging, inventory or other paths already requiring full selection
still require full. Explicit full, scoped OFF and pinned main audits override
interaction selection.

A nonempty Markdown-only overlap selects `docs`, with zero behavior files,
without requiring a passing full run on main. Reused-run, composition, ancestry
and applicability validations still apply, and both complete sides must classify
non-full.
This interaction docs path runs foundation/document checks, format, all
TypeScript typechecks and lint on the merged Candidate. Other eligible retries select
`interaction`: the intersection of both impacted test sets, plus tests impacted
by every overlapping path and fixed smoke tests. All ordinary merged static
checks also run. Missing or malformed interaction comparison data requires full,
never an ordinary scoped fallback. The runner sets
`FORGE_CHECK_INTERACTION=1` independently of the comparison file, so losing or
rejecting that file still preserves the full-check fallback. A passing main run
without command-reported full-selection metadata cannot support the code
intersection rule; ordinary merged-Candidate selection applies instead.

Work format 15 retains version-1 runner-derived interaction evidence: the reused
run id, M0, checked candidate, M1, merged head, exact sorted path sets, overlap,
optional main coverage run, basis (`docs-overlap` or `main-full-coverage`) and
eligibility/fallback reason. Command-reported selection
separately retains the scope, reason and exact sorted test list. Readers supporting
format 14 or earlier reject the new format before writing. Portable exports and
imports retain this evidence. Acceptance invariants are unchanged: a passing run
must cover the exact merged Candidate. Docs and interaction acceptances still request
full post-accept main verification and the existing fix-forward handoff on failure.


A synthetic selector example uses a 226-file behavior-test inventory (a fixed
example; the real suite is several times larger)
with a synthetic import graph: one shared-source consumer, one consumer of both
left and right sources, and the four fixed smoke files. With Lane changes to
`src/left.ts` plus `docs/status.md` and main changes to `src/right.ts` plus the
same Markdown path, the actual selector chooses 0 behavior files versus 226
under full selection. Replacing that Markdown overlap with `src/shared.ts`
selects 6 files versus 226. This is a synthetic selection-size example, not a
reconstruction of historical Lane heads or a timing measurement.

## Public source paths

The foundation check (`npm run check`, also part of verification) rejects machine-specific home paths in source text. Use relative paths, `~`, `<workspace>` or environment variables such as `$FORGE_OWNER` in documentation; derive executable paths from the environment or `import.meta.url`. It skips binary files and generated build/runtime directories. Diagnostics report only the file and line, never the matched contents.

The same check requires `SPDX-License-Identifier: AGPL-3.0-only` and the line `Copyright 2026 Ferdinando Valsecchi` as the first two lines (after any shebang, in the file's comment syntax) of every JS/TS, CSS, Python and shell source outside `convex/_generated/`, vendored notices and test fixtures, before any import, and rejects an Apache-2.0 header anywhere (HTML pages included); `node scripts/check-spdx.mjs --fix` moves, adds or converts it. It also rejects scripts, workflows and docs that run or instruct `env`, `printenv`, `npx convex env list`, `pgrep -fl`, `ps -E` or print `process.env` values (`scripts/check-env-print.mjs`). Sentences that forbid those commands pass. Tests are out of scope because their fixtures are synthetic. The same check runs the [test-signal ratchet](agents/lint-rules.md#test-signal) over changed test files: no file may add real sleeps, elapsed-time asserts or `docs/` reads above its committed baseline. A helper that prints names only carries a `forge-env-print: name-only` comment on or above the line. The same check runs the [growth guard](agents/lint-rules.md#growth-guard): Convex tables, public error codes, agent actions, CLI commands and glossary terms may not rise above `tests/growth-baseline.json` without a reason recorded through `node scripts/check-growth.mjs --update --reason`.

Synthetic test cases in `tests/*.test.mjs` or `tests/fixtures/` may exempt exactly one following line with a comment `// forge-path-fixture: synthetic` (`#` and HTML comment forms also work). This marker has no effect in application source or docs. Prefer constructing synthetic home paths from path segments so fixtures contain no literal machine paths.

## Resource-budget measurements

`agent-first-write-budget` and `self-metrics-hosted-inputs` assert work counts
independently of shared-runner scheduling. First-write checks exercise the hosted path against a synthetic HTTP server: one
bounded query per uncached path/session and zero cached or idle calls, with a
29,000-file marker whose identity prefix is read without loading its manifest.
Server-handler fixtures assert bounded projection windows at 30 and 560 Lanes,
zero writes and no full Work loads. Tests exercise both the real hook supervisor
and its worker protocol. The 200 ms
p95 guard measures CPU in the worker entry; supervisor and worker results must
agree. The supervisor keeps its 128 MiB peak RSS guard. Reader retained allocation
is measured after explicit GC in a fresh process, with the 64 MiB ceiling.

The 6,000-landing metrics fixture still runs the registered Convex query handlers
and document validators, enforcing at most 1,500 query/object calls, 200,000
documents, 100 records per page and zero writes. It records exact requests,
responses and immutable object batches, then replays them through the client in a
fresh process without the fake DB or TypeScript compiler. That process enforces
500 MiB peak and post-GC RSS, 30 seconds of client CPU, and less than 64 MiB of
retained allocation or growth across repeated reports. Wall time remains a
diagnostic: twelve CI shards share a runner, so descheduling is not reader work.
Planted doubled reads and an 80 MiB retained buffer must fail the same guards.
Large synthetic transcripts use private temporary files, with stdin ignored; a 32 MiB
transfer guard covers that boundary. These tests change no hook or reader behavior
and add no retries or timeouts.

Pure recovery preparation in `ui-now-recovery` counts exactly one indexed read of
each of 600 Intents and 600 notices. Its unchanged 5 ms budget measures main-thread
CPU in a fresh child after warm-up and GC, excluding descheduling and background
compiler work. A planted doubled preparation must fail the same work-count guard.

### Sign-in, devices and browser sessions

The rebuilt account devices place and project Settings → You share the same lazy
screen. `authSessions.list` reads one page of terminal credentials, the auth
component's bounded browser sessions and the passkey list together. The session
creation and last-refresh times are server facts; client names are not inferred.
Dormant reads use the existing app lifecycle, with no polling or idle calls.

Ending other browser sessions confirms a passkey for this account in the revoke
transaction, or uses a fresh GitHub exchange bound to the originating live session,
state and already linked numeric identity. Other accounts and the continuing
browser are excluded from the bulk revoke. Adding a passkey writes a next-visit
notice in the enrollment transaction; acknowledgement stays in the viewing browser and cannot hide the notice
in another browser. A newer key has its own notice identity. These flows never revoke terminal credentials implicitly.

`convex/accessPolicy.ts` owns the four provisional C1 policies independently.
Browser inactivity is `browserInactivitySeconds`, provisionally 14 days, separate
from the 30-day maximum and CLI lifetime. Owner confirmation remains open on the
relevant Issues. The Lane schema accepts optional holder metadata before its
writer rolls out, preserving earlier clients and saved source pins.

Terms and privacy drafts under `/terms` and `/privacy` render without a Convex
client. The sign-in line links both. New accounts retain the draft version once
in their existing creation write. These drafts need owner approval before public
launch; they do not settle the still-open public data-policy commitments.

## Documentation website

`/docs/` is a static section emitted by the hosted Vite build. It uses the design
system's `DocsFrame` and prose rules: a left tree and a 68-character column at
16 px/1.6. It needs neither sign-in nor the app bundle. Optional browser code
filters page titles, copies code and remembers the theme. The public page and
sign-in help link here. Cloudflare serves the built files from static storage.
Reading a page, Markdown twin or discovery file makes zero Convex calls and
database reads or writes. An idle tab makes zero calls.
The same build emits `/_forge/cli.json` when `VITE_CONVEX_URL` is set. It contains
only that public backend origin and ships with the site's static assets.
The CLI's built-in site is set in `src/forge-site.ts`. Current development builds
use the development site. Set the canonical public origin there when production
opens. For another site, use `nforge login APP_URL` and `nforge auth status APP_URL`;
`nforge host ROOT --site APP_URL`, `nforge import OWNER/REPO --site APP_URL`, and
`nforge clone OWNER/PROJECT DIR --site APP_URL` select it explicitly. A full project
URL selects its own site for clone. Existing backend-bound automation can keep
`--deployment` or `FORGE_DEPLOYMENT_URL`; a Checks job on a non-default mirror
can use `FORGE_DEPLOYMENT_URL` with its project ID.

### Scoped MCP source grants

For a scoped source grant issued by a Forge operator, start `nforge mcp-agent BACKEND_URL`
with the grant in `FORGE_AGENT_TOKEN`. Use the backend that issued the grant.

### Documentation pages

The existing explicit `packageDocuments` inventory supplies both HTML pages and
raw Markdown. New guides need a manifest under `scripts/package-documents/`, as
before. `scripts/docs-reference.ts` generates CLI help from `src/cli.ts` and the
enforced hosted help entries, and MCP help from the actual hosted tool
registrations without executing their handlers. Other MCP modes show their exact
source registrations through static syntax extraction, without opening an index
or authorizing a grant. Schemas are rendered at build
time; there is no checked-in reference copy to drift. A missing source or nav
page fails the build. Docs tests guard generated command/tool coverage, safe
Markdown rendering, links, keyboard interaction and both themes and widths.
Setup and how-to pages use `DocsAgentPrompt`. Put new guides under
`docs/guides/` and add a one-sentence first check in
`scripts/docs-agent-prompts.mjs`. The top level, `docs/agents/` and
`docs/operations/` also require a prompt unless the page is classified as
reference in that module. The shared prompt sends the agent to the page's Markdown twin
and asks it to use real IDs, keep secrets private and ask before external or
irreversible changes. Keep task steps and command examples in the guide. The
static build renders the prompt above the guide. The copy button uses the reader's
current origin, and the manual-copy fallback links to the Markdown on that same site.
The static docs check catches a guide without a prompt or
Markdown twin. Both discovery files list every guide. `/llms-full.txt`
links to guides beyond its curated full-text chapters. `robots.txt` allows the
guide pages, Markdown twins and both discovery files.

The static docs check runs the same discovery generator as the hosted build,
including when a docs-only landing skips the web build. It checks for source
drift and reports the full-text size. Sizes above 409,600 bytes emit a warning
and can still land.

This delivery does not change docs-only preflight or admission: configured
`docsPaths` keep their existing cheap path. The full suite belongs to the
landing runner, and there is no new runtime dependency in the CLI or MCP.


### Public discovery configuration

Set `FORGE_PUBLIC_READ_SECRET` to the same private service key on Convex and the site Worker. The key is never a
`VITE_` variable and never reaches a browser. Set `FORGE_WEB_URL` to the canonical HTTPS web origin on both. An
unset key closes the backend discovery route before DB I/O. An unset web origin closes share-tag generation and the
sitemap API. HTML front pages still serve the built app shell when settings or public reads are unavailable.

[Per-visitor limits](security.d/sections/0810-per-visitor-limits.md) need two more private keys, never `VITE_`
variables. Set `FORGE_CLIENT_HASH_KEY` (random, at least 32 bytes) on the site only; without it the site forwards no
visitor hash and answers device sign-ins with 503. Set `FORGE_SITE_DEVICE_KEY` on the site, then the same value on
Convex once the site is live; on Convex it moves device sign-in to the site.

For local browser development, set `VITE_FORGE_WEB_URL` to the deployed web origin; public reads go through that
site's cache and budget. A bare Vite server does not run the site Worker. The
[public discovery security contract](security.md) states rate limits, cache freshness and partial weekly coverage.

The site's own rate limit is Cloudflare's rate-limit binding, a best-effort backstop counted per location, not an
exact request-61 limit; measured, it refused almost nothing from one address. Do not test it for a 429; test the
backend's per-visitor windows instead.

To verify data queries after deploy, fetch `/-/public/v1/explore/active.json?forge_probe=61` and
`/sitemap.xml?forge_probe=61` before warming their entries, or after their 30-second expiry. Compare each
with its bare URL immediately afterward. Both requests should return the same 200 response with no Location,
and the repeat should be an edge hit with zero Convex executions (from the same location).

Raw dot paths need `curl --path-as-is`; `fetch` and browsers normalize them before transport. Cloudflare
normalizes `/./` before the Worker runs, so the request reaches the normalized page.
Populated public-project share metadata remains unverified until a public project exists on dev; follow-up
Issue 43d2f68d tracks that verification separately. Do not create one merely for this check.

`nforge heavy --no-build node --test TEST` runs against the existing `dist/`
for a failing-first regression check; the default still rebuilds stale core output.
Nested heavy commands share the live outer slot. Commands declared in `forge.json`
`preflight.static` (or the package fallback `forge.preflight.static`) run directly
rather than waiting behind long test batches, including silent npm script invocations.
`hosted-work ROOT JSON` resolves a Forge clone or Lane before opening any native
Work store; it uses the same current project access as explicit deployment syntax.
Legacy uppercase friction UUIDs can be read and triaged by their lowercase ids.
