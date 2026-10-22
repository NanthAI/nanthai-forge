# Development

## Setup and checks

Requirements: Node 22.12 up to 24 (Node 24 is the tested package runtime), npm, and Git 2.38 or later for Git-backed Work. `tar` and `gzip` are needed for backups.

```sh
npm ci --ignore-scripts      # locked install, no lifecycle scripts
npm run verify               # check + format:check + typecheck + lint + build + test, run concurrently
npm run format               # prettier --write; run before committing
```

| Command | What it does |
| --- | --- |
| `npm run check` | Validates JSON, Markdown links, license inventory freshness and required root files |
| `npm run typecheck` | Core, web, Convex and Netlify TypeScript |
| `npm run lint` | ESLint, no warnings allowed |
| `npm run verify:sequential` | The same steps one after another (slower; use to read one step's output in order) |
| `npm test` | Builds, then runs `node --test tests/*.test.mjs` |
| `npm run build:web` | Hosted browser build into `hosted-web-dist` (no deployment); `build:hosted` is an alias |
| `npm run smoke:package` | Packs and installs the tarball offline, then checks its file list and notice hashes |

Tests use synthetic repositories and real Git, Node and MCP subprocesses. Pass-or-fail is the only result that counts: a skipped test is not a pass. Automatic cleanup tests control the working-directory probes through `tests/cleanup-process-fixture.mjs`, including the concurrent finish child, so unrelated host processes and unavailable `/proc` or `lsof` coverage cannot change lifecycle assertions. `tests/clean-processes.test.mjs` separately exercises both OS scanner branches, missing probes, unreadable processes and process-exit races with synthetic inputs; unknown coverage continues to retain local copies.

The compact Work/detail and native companion fixtures close their MCP clients and HTTP servers before removing owner directories. CLI presence workers are detached; directory removal retries transient `ENOTEMPTY` errors while those workers release their queue files.

Interaction finish fixtures isolate the outer `FORGE_CHECK_FULL` override so their nested checks exercise the explicitly selected docs, scoped and interaction scenarios. The enclosing verification run keeps its full selection. Interaction and landing fixtures drain post-accept work and join spawned helpers before deleting their owners. Finish replay assertions compare recorded receipt fields separately from live peer observations, which may exhaust their read budget under load. The running-output exchange fixture holds its writer at an explicit barrier during preparation, then verifies that later appended bytes do not change the pinned retry.

`npm run check` fails if `docs/dependency-licenses.md` is out of date. After changing dependencies, run `node scripts/render-dependency-licenses.mjs`.

### Targeted test preparation

Run `npm ci --ignore-scripts` and `npm run build:core` before focused core tests. Run `npm run build:web` as well before browser asset inspection or hosted UI checks; assets build into `hosted-web-dist`. The companion HTTP fixtures no longer require the retired local explorer build. Run focused tests with the private queue preload:

```sh
node --import ./tests/check-runtime.mjs --test tests/agent-action-parse.test.mjs
```

For new prose under `docs/`, add its path to `packageDocuments` in `scripts/package-documents.mjs`; the explicit inventory avoids packaging private output. `node scripts/check-documents.mjs` validates the inventory without building.

### The standard check

`scripts/forge-check.mjs` installs locked dependencies, selects impact from the runner’s pinned Candidate comparison, and verifies with the Node that launches it. The existing `verify` check ID stays unchanged. Forge-launched checks share the machine queue and disk guards described in [operations](operations.md). Validated native standard-check docs-overlap retries classify immutable merged bytes with the installed selector before admission and run merged static checks outside the heavyweight queue; disk guards still apply. Unclassified changes and code interactions keep ordinary admission. Direct `npm run verify` / `node scripts/forge-check.mjs` invocations bypass Forge's queue; use recorded `run` / `finish` to coordinate dogfood checks. Test execution preloads `tests/check-runtime.mjs` so synthetic fixture checks use a private queue per test process, separate from real dogfood checks. The automatic-cleanup tests also import that setup themselves, so direct focused runs stay isolated without a preload flag; their process coverage uses one mutable mock per test. Cross-process reliability tests explicitly share one queue. For focused check-run tests use `node --import ./tests/check-runtime.mjs --test tests/local-reliability.test.mjs`. No test assertion is bypassed.

`npm run verify` is `scripts/verify.mjs`. It runs the verification stages concurrently: `check`, `format:check`, the four `tsc` typechecks and `lint` start together with `build:core` then `build:web`, and the tests start as soon as the build finishes instead of after every static step. Static-step output is buffered; tests stream completed/failed counts and failure names as TAP results arrive. Each completed failing file also emits its file-attributed diagnostic block immediately, while other files and static steps continue. Passing steps print their totals and a timing table closes the run. The default test-file budget is `min(max(1, floor((available CPUs - 2) / check slots)), 8)`, where check slots is `FORGE_MAX_CONCURRENT_CHECKS` or the check queue default `max(1, floor(CPUs / 4))`, so concurrent checks together leave two CPUs free (4 workers per check on a 10-CPU machine with 2 slots). Set `FORGE_TEST_WORKERS` to a positive integer to compare or override it. The runner starts historically slow files first. Each test file has a 600000 ms wall-clock hang guard, covering module loading, tests, teardown and leaked child handles. Set `FORGE_TEST_FILE_TIMEOUT_MS` to a positive integer in milliseconds (up to 2147483647) to override it. A timeout names the file, kills its process group and fails verification; queued files get their own deadline when started. This is a suite scheduling budget; fixture queues remain private per test process and queue correctness tests keep their explicit overrides. `FORGE_GIT_TIMEOUT_MS` (default 20000, accepted range 1000 to 3600000) is the per-command ceiling for local Git; the check sets it to 240000 because several checks usually share one machine.

Compare performance with the same Node version, source pins and machine load.
Per-file wall times include real Git subprocesses and filesystem work; a heavily
loaded or swapping machine does not provide a usable idle-machine floor. Git HTTP
coverage uses local servers and real clients. Contribution import/recovery fixtures
use local projected bundles instead of repeating transport setup; the dedicated
clone/fetch suites and the three contribution wire cases retain protocol coverage.

`tests/native-git-http.test.mjs` failed intermittently (about 1 run in 25, even on an idle machine, and far more often under load). Root cause: `workGit` passed large stdin (a 1 MiB blob for `git hash-object -w --stdin`) through `spawnSync`'s pipe, which sometimes stalled until the 20 s command limit and surfaced as a 400 from the Git endpoint. `workGit` now gives Git inputs over 32 KiB as a private temporary file descriptor (same bytes, removed afterwards); 0 of 48 concurrent runs failed afterwards, against 2 of 48 before. The history fixture also supplies synthetic commit bytes through a file descriptor so its multi-megabyte commit tests avoid the same synchronous pipe stall. The Git client and test time limits were also raised (600 s and 900 s) because they are hang guards; no assertion changed.

```sh
nforge agent ROOT define-check '{"name":"verify","executable":"/abs/node","args":["scripts/forge-check.mjs"]}'
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
are not rolled back. It has no OCC, validators or
subscriptions; interleaved mutations are not isolated.
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
Web edits also run the UI regression files. Computed module paths, including joined `dist/` paths, widen to their source domain; unknown dynamic imports
widen to all source domains. The existing `tests/convex-module.mjs` adapter is modelled
through its callers' paths and the loaded sources' imports. Its recursive moduleUrl
implementation does not imply every module depends on every other module.

A `scoped` selection names its domain (`web`, `convex`, `core`, `netlify`, `tests`,
`scripts`, `tooling`, or `mixed`) and prints its reason and complete file list before tests.
Known formatting/lint configuration still runs every static check. `.gitignore`
selects source-inventory/ignore regressions. TypeScript and Vite configuration widen
to their domain. Convex functions, schema and generated API files widen to backend
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

The standard command writes `{scope, reason, tests}` to the runner-owned
`FORGE_CHECK_SELECTION` output. The runner retains it as command-reported
`checkSelection`, includes the scope in run details and agent receipts, and retains
the complete test-file list and reason in stdout. This describes selected coverage,
not proof of every possible runtime dependency. File fixtures, generated modules,
child processes and source loaded by path require conservative treatment; helper,
fixture and configuration paths without explicit ownership still take the full path. The full post-main
check remains the safety net for runtime relationships static imports cannot express.

For recorded historical replays, `scripts/measure-test-impact.mjs` accepts explicit retained base/head/path pins, runs the same static/build/test pipeline, and reports command wall time and selected files. It also honors `FORGE_CHECK_FULL=1` for a matched full baseline. This measurement harness does not relax the standard wrapper's full fallback for legacy Candidates without a composed-main pin.

### CI

`.github/workflows/foundation.yml` compares exact Git pins. Markdown-only changes,
including packaged docs, run foundation and package-document checks. Other changes
run full verify and package smoke on Node 22 and 24, plus native self-host.

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
| `netlify/functions/` | Background analysis worker |
| `tests/`, `scripts/`, `evals/` | Tests, tooling, measurements |

Keep modules narrow (about 300 lines) with one owner. Use TypeScript, pin dependencies through the lockfile, and add the SPDX header to source files. New storage formats need migration and recovery tests.

## Dogfooding

Forge develops Forge. The canonical native owner is `$FORGE_OWNER` (set to your local native owner directory). A separate local Git checkout is a compatibility mirror and can lag. Native `main`, the hosted project and GitHub `main` may differ, so check exact pins.

Work through `nforge agent ROOT start`, edit the returned Lane, then `finish`. Accepting a Channel, publishing to GitHub and deploying are separate choices. Never overwrite another Lane to match the mirror. Put throwaway builds, exports and test owners under a local scratch directory such as `~/.forge-runtime`, not Documents or iCloud.

### Landing benchmark against Git+GitHub

`scripts/bench-landing.mjs` lands the same three changes both ways and times each phase: a docs-only edit (a marker line at the end of this file), one source file with a test, and four source files with a test. At least three runs per scenario; results go to JSON plus a markdown table with median and p90.

```sh
node scripts/bench-landing.mjs --source OWNER --dry-run                  # print the plan; runs nothing
node scripts/bench-landing.mjs --source OWNER --work ~/.forge-runtime/bench --max-minutes 9
```

- **Forge:** `agent start` → edit → `finish` with `accept:true` and `FORGE_CHECK_SCOPED=1` until main moves. Finish stderr progress lines split the time into prepare (checkpoint/sync/compose), queue wait, check and landing, by line arrival. The check runner's own queued/started/ended times are recorded beside them. By default this runs in a throwaway native owner imported from the source owner's `main`, with the standard check and the trusted preset. `--forge-owner source` lands into the real owner instead; `--hosted` then also times `nforge exchange ROOT push`, and `--github-mirror OWNER/NAME` times `github-sync --push` until that branch moves. There is no automatic GitHub push today.
- **Git+GitHub:** branch → commit → push → `gh pr create` → poll `gh pr checks` → `gh pr merge --squash` → poll until `main` moves. A repository `<owner>/forge-bench-YYYYMMDD-<pair>` is created from the same exported `main`. Its only workflow uses the same scoped selection and Actions check executor as `scripts/forge-check.mjs`, against the PR base/head on GitHub-hosted `ubuntu-latest`. The harness installs a required `bench-required` status check via a main ruleset (or branch protection); setup fails if neither is available. This aggregate check requires every check job to succeed. Check time is GitHub's started→completed span; queue wait is the rest of the wait.

Select `--pair P1|P2|P3|P4` for the fair compute matrix: P1 uses GitHub-hosted runners on both sides; P2 uses Blacksmith on both; P3 compares Forge Modal with 16 Actions shards on Blacksmith; P4 runs the GitHub side alone. Override labels with `--gh-runs-on LABEL` and `--forge-runs-on LABEL`, Actions workers with `--gh-shards N`, and Forge routing with `--forge-runner local|modal|github-actions`. The throwaway owner's check policy records the chosen route. The `github-actions` route requires a CLI supporting that policy. Every GitHub workflow runs one static job plus N test-shard jobs, including N=1, and one required aggregate check. Explicit shard counts use the selection's original order and round-robin membership, matching Forge's Actions plan. Both sides use the Actions check executor for static contracts, builds, test commands and worker budgets; warmed duration estimates are not copied between services.

`--gh-merge-queue` enables repository auto-merge before installing a main merge-queue ruleset when the repository supports it; otherwise it records the unavailable response and squash-merges after required checks. The selected `mergePath` is retained in setup and samples. The benchmark workflow checks pull requests, merge groups and main after landing. Existing unrelated rulesets remain in force.

`--burst 4,8` prepares disjoint source/test changes before releasing their landing operations together (default: 4). JSON retains each change and set timing, landings/hour, check counts, retries and red-main observations. Missing evidence is `null`. Forge red-main observations require passing exact-head acceptance evidence; GitHub observes the post-merge push check. Those diagnostics and cost collection happen after the recorded landing timestamp. Reports include per-pair median/p90 tables, runner labels, shards, visibility and machine load. Actions timing API billable minutes, rounded Blacksmith job minutes and Forge's Modal estimate are separate cost observations; unavailable timing is unknown. Blacksmith job minutes are measured usage, not an invoice.

```sh
node scripts/bench-landing.mjs --source OWNER --pair P1 --burst 4,8 --dry-run
```

`--github-owner ORG` selects the repository owner (default: the authenticated gh login); `--visibility public|private` defaults to private. P1/P2 automatically create a separate `forge-bench-YYYYMMDD-<pair>-forgecheck` target, register the generated Forge dispatch workflow on its default branch and configure the throwaway owner's runner policy. Build core before running the harness. Dry runs print exact repository names, visibility, workflow registrations, ruleset payload, policy, scenarios and burst plan without invoking subprocesses or the network; the default owner is shown as `<login>`. For the public org plan, add `--github-owner NanthAI --visibility public --gh-merge-queue`. Single samples include `doneToMain` from the completed edit/commit to landing, in addition to phase timings. Rerun with the same `--out` to resume; finished samples are kept. `--cleanup` is cleanup-only: it writes the current results and runs no setup or samples before deleting only repositories recorded as created by this run in `<out>.manifest.json` (needs the `delete_repo` gh scope). The manifest records creation times and deletion receipts. Missing or uncertain ownership evidence refuses cleanup; explicitly supplied existing repositories are never adopted as run-owned. Local work and results remain available. Private Actions runs consume account minutes. Seeds contain one parentless commit with the exact selected source main tree, preserving blob bytes and modes without exporting native history or applying Git attributes. Queue merges submit `gh pr merge --auto` without a method or branch deletion flag and wait for main to move. Real runs create repositories and push source; dry-run output is a plan, not measured benchmark evidence.

Native capture skips filenames that begin with `secret` or `credential` followed by `.` or `-`. Do not give source files or docs such names. Use `protected-values.md`, not `secrets-guide.md`.

## Install a local package

```sh
npm ci --ignore-scripts && npm run build && npm run package:notices && npm run package:local
npm install --prefix ./forge-tools --ignore-scripts --offline .forge/packages/nanthai-forge-*.tgz
./forge-tools/node_modules/.bin/nforge init-native ./my-project
```

`package:local` stages only the package whitelist, bundles locked production dependencies and runs `npm pack --ignore-scripts`. The package stays private (no registry publish) and runs no lifecycle scripts. Linux and Windows execution of the packed CLI is untested.

When you add, move or delete a doc under `docs/`, update `scripts/package-documents.mjs`. `package.json` ships `docs/`, and `smoke:package` fails on any listed file that is missing or any unlisted one that is present. Keep `docs/vendor-notices/` byte-exact because tests pin their hashes.

## Hosted development configuration

Convex is a separate Forge project, not Edge's.

```sh
npx convex dev --configure new --dev-deployment cloud --project nanthai-forge --once   # first time
npx convex dev --once                                                                  # later
npm run dev:hosted -- --port 5179
```

Configuration is written to the ignored `.env.local`.

**Browser variables** (root `.env.local`): `VITE_CONVEX_URL`, `VITE_CLERK_PUBLISHABLE_KEY`, and optionally `VITE_FORGE_DEMO_REPOSITORY`. Anything starting `VITE_` is public.

**Backend variables** (Convex dashboard only, never Vite):

- `CLERK_JWT_ISSUER_DOMAIN`: the Forge Clerk app's Frontend API domain, with its Convex integration set to audience `convex`. Leave it empty for anonymous public-only use.
- `CLERK_SECRET_KEY`
- `GITHUB_APP_CLIENT_ID` and `GITHUB_APP_CLIENT_SECRET`: the Forge GitHub App. Configure Clerk's GitHub connection with this same client.
- `GITHUB_WEBHOOK_SECRET`: set the App webhook to `/github/webhook` on the deployment's `.convex.site` URL, with SSL verification and the Push event. Deliveries are verified by HMAC-SHA256 over the original bytes. Webhooks only record diagnostics. Re-index stays an explicit action.
- `FORGE_CLI_PRIVATE_KEY`: RSA PKCS#8 private PEM for Forge-issued CLI credentials. Generate a dedicated RSA 2048-bit or larger key; keep it server-side, never under `VITE_`.
- `FORGE_CLI_ISSUER`: exact HTTPS Convex HTTP origin, e.g. `https://your-deployment.convex.site`, without a trailing slash. It must differ from the Clerk issuer. `/auth/jwks` publishes only its public RSA JWK; the new custom JWT provider accepts audience `forge-cli`.
- `FORGE_WEB_URL`: HTTPS origin of the Forge web app serving `/device` with the existing Clerk login. Deploy the Convex auth config, HTTP actions, functions and schema together, then publish the hosted web build. Existing Clerk/GitHub settings remain required. For a custom HTTP origin, set `FORGE_HTTP_URL` in the CLI environment; standard `.convex.cloud` deployment URLs derive `.convex.site`.
- `FORGE_SECRET_KEYS`: the Secret Object keyring (see [operations](operations.md)).
- `GITHUB_PUBLIC_TOKEN`: optional, for public GitHub API reads only.

Imports store gzip JSON in Convex file storage with a 128 MiB artifact budget. Functions never execute target repository code. After setup, `npm run smoke:hosted -- https://github.com/sindresorhus/is-plain-obj` checks live anonymous import.

### Signed-out landing review

`node scripts/ui-shots.mjs --base http://localhost:5295 --out /absolute/path/ui/s5 --pages landing --widths 1500,390 --themes dark,light` captures the public front door without reading bot credentials. It saves viewport/full-page shots, four live hero frames over roughly ten seconds, a composed strip, and `cpu.json`. CPU compares 30 seconds of animated idle with 30 seconds of the reduced-motion still, using headed Chromium renderer process CPU time and main-thread task time, expressed as percent of one core. Keep this manual measurement outside `verify`.

Now groups unacknowledged messages per Lane or Intent, shows the latest message with expandable earlier messages, and offers Acknowledge all. Message bodies start at two lines; recorded sender names and audience sit in the item metadata. Broadcast titles use the first sentence. Known Work ids and unique prefixes in message and session prose become named links using loaded records; unresolved or ambiguous ids stay short and unlinked. The situation counts and the people panel use the same loaded session observations, excluding automatic workflow duplicates and completed Lanes. Queued checks are static; preparing and running checks animate. Current Lane and session lists show five items with a disclosure for more; mobile people form a horizontal strip.

The project shell uses Now · Work · Code · Settings. Work switches Intents · Lanes · Candidates · Planning; Activity is under Now. The signed-in root is the project list. Retired collection, Explore, Agents and classic Work destinations normalize to these homes.

Project URLs are `/<owner>/<name-slug>~<project-id>`, followed by `/intents`, `/lanes`, `/views`, `/planning`, `/activity`, `/review/<id>`, `/code/<path>` or `/settings/<section>`. The stable project-id suffix makes slugs unique without backend migration and lets old names redirect after the current project loads. Work UUIDs are losslessly encoded as `i-`, `l-` or `v-` plus 22 URL-safe characters. Source revision, line, symbol and filter state remain query parameters. `shell/location.ts` decodes presentation state for existing page controls; it never supplies authority. Netlify serves the SPA on project paths; assets and APIs retain their own routing. The shared codec in `src/project-routes.ts` still decodes older `/local/<name-slug>` links, but nothing serves them.

Application loading uses the smoothed orbiting lower arm (2200ms). Reduced motion renders a static mark. Capture seven frames with `node scripts/ui-loader-shots.mjs BASE_URL OUTPUT_DIRECTORY`.

Netlify injects its badge at the edge rather than into this build. In the production project's Netlify UI, select **Project configuration → General → Powered by Netlify badge**, turn it off and save. The next request reflects the setting without redeployment ([Netlify documentation](https://docs.netlify.com/manage/projects/powered-by-netlify-badge/)).

The landing hero is a seeded plain 2D canvas: main is the trunk, Lanes branch/braid/land, agents use particles and square save nodes, people use solid threads and round nodes, and orange is your handoff. It uses the Fable defaults (1.15× speed, 40 fps cap, DPR capped at 2), fades behind copy, and pauses when the tab is hidden or less than 5% is onscreen. Reduced motion produces a still. The canvas allocates only the unmasked portion of the hero; line segments and particle fills are batched, and repainting clears only the previous drawing bounds plus the spine, without changing the simulated world. Local dev captures also compare retained pixels with full-clear rendering at DPR 2 for 45 seconds of desktop and mobile simulation. Theme/resize changes repaint the film; unmount releases its observers, timers and animation frame. `window.FORGE_ALIVE` accepts the numeric defaults from `web/src/landing/alive-world.ts` plus color overrides; `?t=NN` composes a deterministic still for visual review. The public Overlap mark arrives once in 620 ms and is static with reduced motion. The repository import, interactive graph, example Now and agent briefing tour retain their existing mechanics.

### Device login verification

Local negative tests: `npm run build:core && node --test tests/device-login.test.mjs`. They use synthetic keys/identities and the existing in-memory Convex fixture; they do not deploy. Full `scripts/forge-check.mjs` remains the acceptance gate.

After the lead deploys/configures the backend and hosted browser, unset `FORGE_AUTH_TOKEN`, run `nforge login DEPLOYMENT --name "Test CLI"`, sign in at the printed URL and approve the code. Run `nforge auth status`, a coordination read, a hosted Work read and an exchange against a permitted synthetic project. Confirm another user's project remains unavailable. Repeat with `--scope coordination`: coordination works, hosted Work/exchange fail. Revoke in Account → Account & data and confirm status/reads fail. Login again and run logout; status has no saved credential. Repeat login with Deny and with an unapproved code after ten minutes; neither saves a credential. Verify the auth file mode is `0600` and no CLI output contains the JWT. HTTP JWT/JWKS acceptance and live browser interactions require this deployed manual pass.

### Performance budgets

After `npm run build:core` and `npm run build:hosted -- --manifest`, run:

```sh
node scripts/perf-harness.mjs --bundle hosted-web-dist \
  --work-owner /path/to/existing/native-owner --out private-artifacts/perf/result.json
```

This one command measures a one-file delta through the real exchange CLI and loopback HTTP backend, reads an existing accepted landing's Work records, and records bundle sizes. It creates and removes only its temporary synthetic owner. It never pushes the real project, starts a check, finishes work, accepts, deploys or backfills. The synthetic fixture has 100 roughly 4 KiB files; the initial seed push is excluded. Its three default samples include CLI startup, preparation, upload and source return, but exclude WAN latency and durable provider storage. Do not interpret this result as hosted latency.

Add `--live --base DEV_URL --project PROJECT_ID --lane RETAINED_LANE_ID --build-hash DEPLOYED_HASH` for authenticated cold Now, Work and Lane first-diff measurements. Use a Vite development frontend or an explicit QA build with `VITE_FORGE_PERF=1`; normal production bundles omit the readiness markers. `--live` enables browser navigation only; push remains synthetic. Chromium and the existing user-owned `0600` UI-bot credential file are prerequisites. `--credentials` overrides its usual `~/.config/forge-ui-bot/credentials.json` location. Sign-in reuses `ui-shots`' real bot login. Cookies, tokens and browser storage remain in memory. The read-authorized project identity resolves canonical URLs before measurement; no project authority is bypassed.

Each navigation gets a fresh 1500 × 1000 browser context with only authenticated storage reused. HTTP caching is disabled and service workers are blocked. Durations start at document navigation: Now/Work end at their frozen `__forgeCritical` complete marks; Lane ends at `queries.sourceDiff`, with a populated diff required. Missing-State errors, alerts, runtime failures, route changes, an empty Lane or missing QA marks cannot pass. Critical completeness means the named reads' first results, not full retained history or presence. `firstContentMs` is the QA hook's first-effect mark, not a separate populated-DOM measurement. Use the same frontend build, backend, fixture, machine and sampling conditions for comparisons; fresh contexts do not flush backend caches.

JSON includes machine/runtime identity, timestamps, all samples, medians and separate budget results: Now/Work ≤1500 ms, Lane first diff ≤1000 ms, synthetic one-file push ≤3000 ms. A failed sample or exceeded median budget exits 1; omitted live runs are explicitly `unrun`, leaving overall status `partial`. Requested live setup failures also exit 1 and still write JSON. Results default to the ignored `private-artifacts/` directory and have mode `0600`; errors and browser source, credentials and payloads are not retained. `--samples` and `--timeout` select sample count and browser timeout.

`--bundle` requires the Vite manifest and records raw/gzip bytes, the largest JavaScript chunk, total JavaScript and the static import closure for the shell plus initial application module. Dynamic routes and workers remain in total bytes. Its content hash identifies those local assets; `--build-hash` separately identifies the source or deployed frontend supplied by the caller. Without that flag, the top-level hash covers local compiled core JavaScript and is explicitly not a deployed frontend identity.

Landing evidence is read-only from existing native Work. `--landing-id` selects a specific acceptance; otherwise the newest accepted main record is used. Full Intent lifetime runs from Intent creation to exact-Candidate acceptance and includes author time and waiting. Compose-to-accept, check queue and check execution durations are separate. Unrecorded finish invocation time stays `null`; the harness does not manufacture a landing to time it.

### Signed-in hosted UI review gate

Use the real signed-in app for hosted UI review. Isolated screen fixtures remain useful, but cannot reveal broken routing, legacy wrappers, missing live data or authentication integration. Before signing off a hosted UI change, capture and inspect desktop and mobile pages on the live site, a Netlify draft URL, or local `npm run dev:hosted`. This is an on-demand review tool, **not part of `verify`**: it needs Chromium, network access and local bot credentials.

```sh
npm ci --ignore-scripts
npx playwright install chromium
node scripts/ui-shots.mjs --base https://<your-site>.netlify.app \
  --out /absolute/private/path/ui/live --pages now,intents,settings \
  --widths 1500,390 --themes dark,light
```

`--base` also accepts a draft origin or `http://localhost:5179`. Lane captures also accept `--variants unified,split,inline,side-closed,files-closed`; each variant starts from an explicit diff/rail state and gets its own filename. `--project ID` overrides the project stored with the credentials; `--height` defaults to 1000. Include specific retained records with `--pages 'now,intents,lane:LANE_ID,review:VIEW_ID,settings,device'`. The tool resolves a Candidate's parent Intent through the same site's authorized Work query. It seeds its route codec from the access-checked project identity before validating readable-URL redirects. Add `--diff-file src/example.ts` to select a specific file in Lane/Review screenshots. `settings` opens the shared Settings destination's Contributors page; owner-only lifecycle settings are unavailable to the reader. `device` captures the signed-in code-entry screen without approving any login.

Intent Review actions require a passing check matching the current Candidate head and exclude accepted or superseded Candidates. Intent detail work maps cluster dense save histories and show the latest five Candidates when more than six exist; the earlier link leads to the expandable Candidates list. Candidate detail uses Intent-relative numbering, and lists larger than 50 files group each loaded page by top-level folder. Folder rows count their visible files and show a diffstat when available. The final row expands the remaining paginated files; file/save provenance remains expandable. Hosted read models do not currently supply line diff totals, so those values remain absent rather than estimated.

Each selection produces `PAGE-WIDTH-THEME.png` (first viewport) and `PAGE-WIDTH-THEME-full.png` (whole page), plus a `manifest.json` with exact routes and dimensions. Inspect both: a legacy page above a cockpit can push meaningful content below the first viewport. A successful capture requires the bot's identity, project read access, rendered page content, completed loading and no visible alerts or uncaught JavaScript errors. Missing records, sign-in failures and inaccessible projects exit nonzero. This is screenshot evidence, not automatic visual approval or pixel comparison.

The dedicated Clerk **DEV** user is `forge-ui-bot`, using `forge-ui-bot+clerk_test@example.com`. Its strong random password and user/project IDs live only in `~/.config/forge-ui-bot/credentials.json` (user-owned `0600`, directory `0700`), outside repositories. The tool signs in through Clerk's real password UI and uses the DEV email verification code when required. It creates a fresh, in-memory browser context, never saves sessions/traces, and redacts library errors. It selects the same token as the web app: the Clerk `convex` JWT template (10-minute lifetime). Chromium keeps its normal browser user agent and disables the automation-controlled Blink feature because Clerk otherwise reports uncached token refresh as offline even while network requests succeed. No application auth state or backend authorization is mocked. Keep screenshots private and outside source control; they contain private project data.

Provision/reconcile the bot idempotently with:

```sh
node scripts/ui-bot-setup.mjs \
  --deployment https://<your-deployment>.convex.cloud \
  --project PROJECT_ID \
  --convex-cwd "$FORGE_OWNER" --grant-reader
```

The setup reads `CLERK_SECRET_KEY` at runtime with `npx convex env get` from the configured directory and requires a DEV key. It never prints or persists the key. Existing users are matched by exact email; the password is retained when the local credential file exists. For an existing dedicated bot without local credentials, setup installs a fresh password. Omit `--grant-reader` to provision before the reader API is deployed.

After the lead deploys hosted reader support, `--grant-reader` uses the owner's existing `nforge login` credential from the private Forge auth store. It calls `projectReaderActions:set`, which checks the current owner, verifies the Clerk user and records an original operation UUID; it never writes tables directly or grants contributor access. A reader can see project source, retained Work, policy and activity, but cannot write Work, publish coordination, run checks, return source, accept Channels or change project policy. Existing owner/contributor permissions are unchanged. Owner and contributor grants cannot be made read-only merely by adding a reader grant.

Reader administration is currently API-based: owner action `projectReaderActions:set` accepts `{ projectId, reader, present, operationId }`; `present: false` revokes, using a new UUID. `projectReaders:list` is an owner-only paginated query. Replaying an earlier successful grant after revocation does not recreate access. Readers open projects by direct project URL; they are not listed in the contributor-only “Shared with you” collection. Browser captures need only the bot credential file; they never need the owner credential or Clerk backend key.

### Netlify

The dev site is `nanthai-forge-dev` on the Free plan. `netlify.toml` builds `npm run build:hosted` into `hosted-web-dist` on Node 24. Free plans have no function-scoped environment variables, so deploy the background worker with `node --env-file=.env.local scripts/deploy-forge-preview.mjs SITE_ID`. It passes `FORGE_WORKER_KEY`, `GITHUB_PUBLIC_TOKEN` and `FORGE_CONVEX_SITE_URL` as per-deploy secret overrides, so supply them again on every deploy. Then set `NETLIFY_WORKER_URL` in Convex to the ready deploy's function URL.

A 202 from the worker means dispatched, not succeeded. Verify that a new import is claimed and published. Handler tests do not prove the deployed package: build with `functions:build`, inspect the ZIP for symlinks, and cold-import `netlify/functions/analyze-background.mjs`. Rollback: unset `NETLIFY_WORKER_URL` to return to the Convex analysis path.

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


A synthetic selector example uses the current 226-file behavior-test inventory
with a synthetic import graph: one shared-source consumer, one consumer of both
left and right sources, and the four fixed smoke files. With Lane changes to
`src/left.ts` plus `docs/status.md` and main changes to `src/right.ts` plus the
same Markdown path, the actual selector chooses 0 behavior files versus 226
under full selection. Replacing that Markdown overlap with `src/shared.ts`
selects 6 files versus 226. This is a synthetic selection-size example, not a
reconstruction of historical Lane heads or a timing measurement.

## Public source paths

The foundation check (`npm run check`, also part of verification) rejects machine-specific home paths in source text. Use relative paths, `~`, `<workspace>` or environment variables such as `$FORGE_OWNER` in documentation; derive executable paths from the environment or `import.meta.url`. It skips binary files and generated build/runtime directories. Diagnostics report only the file and line, never the matched contents.

Synthetic test cases in `tests/*.test.mjs` or `tests/fixtures/` may exempt exactly one following line with a comment `// forge-path-fixture: synthetic` (`#` and HTML comment forms also work). This marker has no effect in application source or docs. Prefer constructing synthetic home paths from path segments so fixtures contain no literal machine paths.
