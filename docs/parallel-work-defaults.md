# Parallel-work defaults

These defaults support parallel work. They are configurable except for the always-on rules below.

## Client settings (this machine)

Machine-wide settings are in `$XDG_CONFIG_HOME/forge/client.json` (default
`~/.config/forge/client.json`); `FORGE_CLIENT_SETTINGS=FILE` overrides it.
Read: `nforge settings`; set: `nforge settings KEY VALUE`; reset:
`nforge settings KEY --reset`.

| Setting | Default | Why | Change |
| --- | --- | --- | --- |
| `autoPruneHours` | `3` | Finished Lanes left full checkouts behind. On the dogfood Mac, 127 Lane roots used 38 GB, and the disk filled at 1.2 GB free. `start` removes the local roots of your landed or abandoned Lanes once they have had no Forge action and no file change for this long. | `nforge settings autoPruneHours 0` turns it off. `nforge prune` still works on demand. |
| `activeLanePruneHours` | `168` | A builder waiting on a long landing or review must keep its Lane folder; a 3-hour limit removed idle open Lanes. An open (`active`) Lane's root is removed only after this long with no Forge action and no unsaved edits. | `nforge settings activeLanePruneHours 0` never removes an open Lane's root. |
| `idleLaneHours` | `1` | Agents forgot open Lanes, which kept counting as active work and kept their disk. `start` lists the open Lanes this agent run started on this machine that have had no Forge action for this long. | `nforge settings idleLaneHours 0` stops the list. |
| `localHeavySlots` | `auto` | About 20 agents shared a 16 GB laptop. Unlimited parallel builds and test runs swapped the machine; 3 at a time kept it responsive. `auto` allows one heavy command per 5 GB of RAM, capped at half the cores and never below 1 (16 GB with 8 cores gives 3). | A number sets the slots; `0` turns the limit off. |
| `shareDependencies` | `true` | Each Lane needs `node_modules` (261 MB for Forge itself), and every agent ran the install. When a Lane opens, its `node_modules` becomes a link to one install per exact lockfile and package manager (npm, pnpm, yarn or bun). | `nforge settings shareDependencies false`. |
| `installScripts` | `false` | A repository's own files could switch on dependency install scripts at `start`, so opening a Lane ran code its authors chose. A repository's declaration is a request: `start` shows it, and only you decide. | `nforge settings installScripts true` accepts repository requests on this machine; `start {"installScripts":true}` runs all scripts for one Lane. |
| `clientCacheMaxGB` | `2` | `ROOT.forge-client/lanes` collected full ~100 MB copies of other Lanes that nothing removed (262 copies, 5.8 GB in one client directory). They are a cache now: past this size, the least recently used copies are removed. | `nforge settings clientCacheMaxGB 0` removes the size cap. |
| `clientCacheMaxAgeHours` | `24` | The same cache: a copy nobody used for this long is removed. | `nforge settings clientCacheMaxAgeHours 0` removes the age limit. |
| `landWait` | `true` | Agents wrapped `land --save` in a polling loop to learn the outcome. `land --save` now waits by default and prints a compact summary. | `--no-wait` on one command, or `nforge settings landWait false`. |

### autoPruneHours and idleLaneHours

- The client keeps a small local index of the Lane checkouts it opened, at
  `$XDG_STATE_HOME/forge/lanes` (default `~/.local/state/forge/lanes`). It writes one small file
  when it opens a Lane and when an agent action touches one. Nothing runs in the background.
- `start` reads the state of the Lanes that are due in one server call, which covers up to 100
  Lanes. When nothing is due, `start` reads nothing. An idle machine costs nothing.
- A root is removed only when all of these hold:
  - the server says the Lane is `completed` or `abandoned`;
  - there has been no Forge action and no file change for `autoPruneHours`;
  - the root is not where the command runs;
  - the root holds no other Lane roots;
  - the checkout marker still names that Lane.
- An `active` Lane with no Forge action for `activeLanePruneHours` (7 days) is also removed, but only when no
  Forge command of this machine runs in it and its
  checkout has no unsaved edits: every file is hashed in place against the Lane's baseline
  State and nothing is written. At most 8 such checks run per pass; an edited root stays and is
  listed as idle. `open` restores a removed root from the saved head.
- Every removal appends one JSON line (time, Lane, root, server state, reason, idle hours, bytes) to
  `$XDG_STATE_HOME/forge/lane-prune.jsonl` (default `~/.local/state/forge/lane-prune.jsonl`) before the
  root is deleted; the file rotates to `lane-prune.jsonl.1` past 1 MB.
- Pruning removes the root, its `ROOT.forge-client` cache and its `ROOT.forge-metrics.jsonl`.
  A `node_modules` link is removed as a link; the shared install stays.
- A deployment without the batched read prunes nothing.
- The idle list on `start` is per agent run (Issue d730121f). Each index entry records the agent
  session slug of the run that started or resolved the Lane (`null` for a person). Only Lanes of the
  calling run are listed with the `abandon` command. Idle Lanes that other runs of the same account
  started, and older entries with no run recorded ("unknown run"), get one line naming them, with
  no abandon offer. `nforge prune` (the operator asking) still lists every idle Lane.
- `nforge prune` is a dry run (it lists `wouldPrune` and changes no registry, pin, link or checkout);
  `--apply` removes and lists `pruned`. `--scan DIRECTORY` with `--apply` first registers existing
  checkouts in DIRECTORY and in its `*.forge-client/lanes/`; a dry scan only reads them. With `--apply` it also removes links
  in DIRECTORY whose target was a `*.forge-client/lanes/` copy that no longer exists. An explicit
  prune with `autoPruneHours` set to 0 uses 3 hours.
- One root per Lane: `open` at a new path moves the copy `start` made in
  `ROOT.forge-client/lanes/LANE_ID` there instead of downloading a second tree. It reports
  `movedFrom`. A copy whose client lock is held, or one on another volume, is left alone.

### clientCacheMaxGB and clientCacheMaxAgeHours

- Other Lanes materialized by a call (conflict checkouts, `with:` inputs, overlap reads) land in
  `ROOT.forge-client/lanes/LANE_ID`. Each use refreshes usage/size bookkeeping at `LANE_ID.forge-client/cache-use.json`, beside
  the copy. Touch, inventory and eviction share this location; checkout replacement leaves it intact.
  Earlier `.forge/cache-use.json` records are read as known bookkeeping and preserved beside the
  copy before replacement. Unknown metadata is preserved and prevents eviction or replacement.
- At most once an hour, from the CLI start, one local pass removes copies over the age limit and
  then least recently used copies until the directory is under the size cap. It reads no server
  and runs no timer. A pass that runs out of its 15-second budget continues on the next start.
- A copy is kept when it is the caller's own Lane, holds the work lock or was used in the last ten
  minutes, is the target of a symlink beside ROOT (conflict checkouts), or has unsaved edits.

### Local disk

- Forge temp output goes to `$TMPDIR/forge-tmp/PURPOSE-PID-RANDOM`. Any CLI start removes entries
  there not written for 2 hours, at most once an hour, unless their process is still alive.
- Forge writes an empty `.metadata_never_index` (Spotlight exclusion) into each `ROOT.forge-client`,
  `$TMPDIR/forge-tmp`, the peers cache root and runtime release directories. Lane roots get none:
  the file would be an untracked source file. Keep Lane roots in a directory you exclude from
  Spotlight, for example with `touch DIRECTORY/.metadata_never_index`.

### localHeavySlots

- `nforge heavy CMD [ARGS...]` runs one heavy local command (build, typecheck, lint, tests). It
  waits for a free slot, which every Lane and agent on the machine shares.
- Slots are granted first come, first served. A caller that finds anyone waiting joins the back of
  the queue (one small ticket file per waiter); only the caller at the front tries the slots, so a
  newer short command never overtakes an older waiter. Waiters are woken by every release and
  re-check every 3 seconds.
- A waiting caller prints its queue position and, after three finished heavy commands on this
  machine, an estimate: the median of the last 32 hold times, applied to the earliest slot to free
  for each waiter ahead. It is a rough guide, not a promise.
- A slot or ticket whose process died is reclaimed at the next check. Liveness compares the
  process start time as well as the pid, so a reused pid cannot hold a slot or a place in line.
- `nforge heavy --status` lists holders and waiters by Lane id, executable name and time; it never
  prints folders, arguments or environment.
- The exit code is the command's exit code. The slots, tickets and hold-time history live in
  `/tmp/forge-heavy-slots`; `FORGE_HEAVY_DIR` selects another directory.
- Example: `nforge heavy npm run build:core`.

### shareDependencies

- Forge runs only the package manager the repository declares: the `packageManager` field in
  `package.json`, then the lockfile (`package-lock.json` npm, `pnpm-lock.yaml`, `yarn.lock`,
  `bun.lock`/`bun.lockb`). Several lockfiles with no `packageManager`, a declared manager without its
  lockfile, or a manager that is not installed report `dependencies.status` `none` with a `reason`;
  Forge never installs a package manager for you. pnpm and Yarn run through corepack at the declared
  version when corepack is available (it may fetch that version into its own cache); otherwise the
  manager on `PATH` runs. Bun always runs from `PATH`.
- The install key is a hash of the lockfile, `package.json`, every workspace `package.json`, the platform,
  the Node major version and, for pnpm, yarn and bun, the manager and its version plus the install
  settings (`.npmrc`, `pnpm-workspace.yaml`, `.yarnrc.yml`, `bunfig.toml`, `patches/`). A Lane with a different
  lockfile or manager version never shares another Lane's install.
- The first Lane with a new key runs the frozen-lockfile install once, in the shared cache, under a heavy
  slot (the same as the Actions executor): `npm ci`, `pnpm install --frozen-lockfile`,
  `yarn install --immutable` (Yarn classic: `--frozen-lockfile`) or `bun install --frozen-lockfile`, with
  install scripts off. Concurrent opens of the same key wait for that one install. A later Lane links
  without running anything.
- The install runs in the [clean check environment](security.md#clean-check-environments), built once
  per install and removed after it: a private HOME, XDG and temp directories, private npm user and
  global configuration, only the allowlisted environment variables, the shared check caches (npm
  uses `check-npm-cache`) and corepack's own home when it exists.
  Your npm, pnpm, Yarn or Bun configuration and credentials are not read, so a project that needs a
  private registry login fails with a line saying so; run its install in the Lane yourself.
- Where the install fetches from: when the lockfile (npm `resolved`, Yarn classic `resolved`, pnpm `tarball`,
  git and tarball dependencies) or, for pnpm, Yarn and Bun, the copied install settings (`.npmrc`,
  `.yarnrc.yml`, `bunfig.toml`) name a host other than `registry.npmjs.org` or `registry.yarnpkg.com`, `start`
  prints one line on stderr before the install runs and the receipt carries `dependencies.registryHosts`
  (`hosts`: at most 20 host names with any port, `more`, `sources`: the files that named them). Only host
  names are read from those files, never users, tokens or paths. The install still sends none of your
  credentials. One bounded read of files already on disk, no Convex call.
- Download cache: script-less pnpm and Yarn Berry installs of one project share one download cache
  (`downloads/pnpm|yarn/PROJECT` in the dependency cache, mode 0700, refused if any part is a link or not
  yours), so a new lockfile fetches only what the project's earlier installs did not. Both caches are
  addressed by content: pnpm's store keys packages by the lockfile's integrity and re-verifies files before
  linking, and Yarn Berry's archives are named by the lockfile checksum and verified when used. pnpm
  copies or clones from the store (`--package-import-method=clone-or-copy`), so the sealed install
  shares no file with it. Installs that run package scripts (`installScripts:true`, or an accepted
  allowlist) keep a private cache, because package code could write the shared directory. Bun's cache is
  addressed by name and version, and Yarn classic's is not shared either, so those keep a private one.
  A new project's first install is as slow as before. Delete `downloads` any time.
- Install scripts are your decision, never the repository's. What a repository declares is a request:
  `{"install":{"scripts":true}}` in a root `forge.json` or Yarn `enableScripts: true` in `.yarnrc.yml`
  (all scripts), or a build-script allowlist: pnpm `onlyBuiltDependencies` or `allowBuilds`
  (`pnpm-workspace.yaml`, or `pnpm.*` in `package.json`), bun `trustedDependencies` and yarn
  `dependenciesMeta.<name>.built` (those packages only). The request is part of the install key.
- By default no dependency install script runs. When a skipped package (or the root `preinstall`,
  `install`, `postinstall` or `prepare`) declared one, `start` prints one line on stderr naming the
  command (`npm rebuild`, `pnpm rebuild`, `bun pm trust --all` or `yarn rebuild` in the Lane), the
  repository's request if it made one, and how to accept it. The pnpm lockfile records which packages
  need a build and gives a count; the yarn and bun lockfiles do not, so their line says only that
  dependency scripts were skipped. Nothing is printed when no skipped package declared a script.
- To run them at install: `"installScripts":true` on `start`
  (`nforge agent ROOT start '{"planningItemId":"ID","installScripts":true}'`) runs every script for that
  Lane; `nforge settings installScripts true` makes this machine accept each repository's request (all
  scripts, or the allowlisted packages after the script-less install: `npm rebuild`, `pnpm rebuild`,
  `bun pm trust` or `yarn rebuild NAME…`). An explicit `installScripts:false` on `start` wins over the
  setting. When scripts run, `start` prints one line saying which and why. Each mode (none, allowlisted,
  all) is cached apart, so a Lane that did not accept scripts never links an install that ran them.
- Workspaces: the workspace folders the lockfile records (npm `packages`, pnpm `importers`, Yarn Berry
  `@workspace:` entries, `bun.lock` `workspaces`; Yarn classic and `bun.lockb` use the `workspaces`
  field of `package.json`) are copied to the install stage with their `package.json`, and their manifests
  are part of the key. If one has no `package.json` or lies outside the repository, `dependencies.status`
  is `none` with a `reason`, and the Lane opens without `node_modules`.
- A repository with workspaces gets real `node_modules` directories of links into the shared install
  (the root for npm; the root and each workspace package for pnpm, yarn and bun), and a link to a sibling
  workspace package points at that package's source in your Lane, not at the cached manifest. The same
  holds for `node_modules/.bin`: a bin of a workspace package runs your Lane's file (the install sees only
  manifests, so Forge adds the bins each workspace `package.json` declares beside the workspace link),
  while third-party bins stay shared. A cache hit only relinks (local symlinks and small shim copies, one
  per `.bin` entry, no install). The root `node_modules` is one link when the repository has
  no workspaces.
- Not shared, with a `reason` and no install: a repository whose install runs repository code (a pnpm
  `.pnpmfile.cjs`, Yarn plugins in `.yarnrc.yml`) and Yarn Berry Plug'n'Play, which has no `node_modules`
  (set `nodeLinker: node-modules` to share). Forge never runs the `yarnPath` release a repository commits.
- A failed install leaves no partial cache, and the Lane opens without `node_modules`.
- An existing `node_modules` that the agent installed is never replaced.
- A `node_modules` that Forge linked follows the lockfile. After `start`/`open`, and after `sync`, `resolve`,
  `revert`, `compose`, `preflight` and `nforge pull`, Forge compares the link's key with the current
  lockfile key (one hash of files already on disk, no Convex call). On a mismatch (a sync brought a package,
  or the manager version or install settings changed) it relinks to the install for the new key, installing
  it once into the shared cache if no Lane has yet, and prints one line on stderr (`start`/`open` also report
  `dependencies.relinked.from`). Lanes linked by older builds follow the same rule. If the new install
  fails the previous link is put back. If the directory holds packages Forge did not link, it is kept
  and reported (`dependencies.status` `stale`, or a stderr line); delete it to relink. A Lane with no
  `node_modules` is not given one by these commands.
- The cache is `$XDG_CACHE_HOME/forge/deps` (default `~/.cache/forge/deps`) and is safe to delete. A finished
  install is read-only (the folder, each `node_modules` root and its tool-cache folders such as `.cache` and
  `.vite` stay writable), so a tool in one Lane cannot change the packages other Lanes run; `rm -rf` needs
  `chmod -R u+w` first. A hosted Lane's install is keyed by its project as well as its lockfile, so a fork
  never shares one. To change packages, replace the link first (next item).
- If your Lane changes the lockfile, replace the link before installing:
  `rm -r node_modules && npm ci` (or the same with your manager's frozen install). Removing the links does not
  touch the shared install; for a workspace repository remove each workspace `node_modules` the same way.

### landWait

- `land --save` (and the old `finish` spelling) on a hosted Lane first submits. It then waits for
  the outcome through the existing live subscription, with no polling.
- It prints one line: `LANDED receipt …`, `CHECK PASSED (not landed)`, or `FAILED CODE: message`.
  A failure is followed by each failing file and its first error, when the check reported one.
- Exit codes: 0 landed or passed, 2 failed, 3 still running after 90 minutes. Run the same command
  again to keep waiting.
- Ctrl-C stops waiting, never the landing.
- In an agent client that wakes on background exit (Claude Code, or
  `FORGE_AGENT_WAKE=background-exit`) land returns once submitted and names one background
  settle wait instead; `--wait` or `FORGE_AGENT_WAKE=off` keeps the foreground wait. See
  [asynchronous land](agents/workflow.md#asynchronous-land-one-wake-no-waiting-turns).

## Project settings

Project policy stores `agentDefaults`. `nforge hosted-work ROOT '{"action":"policy"}'`
(native: `nforge policy ROOT`) shows effective defaults; `nforge agent ROOT capabilities`
includes their generated `rules`. The owner changes named fields with `set-policy`:

```sh
nforge hosted-work ROOT '{"action":"set-policy","operationId":"UUID","agentDefaults":{"preflight":"advise"}}'
```

Only named fields change. `agentDefaults` edits do not invalidate queued landings: their
acceptance-policy pins exclude these settings.

Capabilities and the policy read carry a frozen key set (`preflight`, `preflightMaxMinutes`,
`urgentRoles`, `overlapGate`, `checkpointNudgeMinutes`, `stallAlerts`) because CLIs before
2026-11-06 parse that object strictly. `autoClaim` and `dormantAfterDays` are stored-only: the server
reads them itself, the policy read shows them only when set, and capabilities never carry them. A
later key that agents must read goes to capabilities only for CLIs that ask for contract feature
`agent-defaults-extended`; current CLIs drop keys they do not know. Adding `autoClaim` to the
frozen set on 2026-11-06 broke capabilities across CLI/server versions with `HOSTED_PROTOCOL_INVALID`.

| Setting | Default | Why | Change |
| --- | --- | --- | --- |
| `preflight` | `require` | About 30% of first landing checks failed (2026-10-30), and every failure costs a full landing round on the project runner. A local run of the affected tests catches most of them first. | `advise` prints the set without refusing; `off` removes it. |
| `preflightMaxMinutes` | `10` | A large affected set would make preflight slower than the landing check it saves. Above this estimate, preflight is advice only. | Any whole number of minutes; `0` makes every set advisory. |
| `overlapGate` | `block` | Agents finished over unanswered overlap notices and found the clash only at composition. Only exact-base intersecting/adjacent hunks, distinct additions or delete/rename versus edit need an answer. Symbol names alone and disjoint same-file edits produce no automatic notice; missing evidence reports incomplete coverage. A peer changing an exported symbol your changed lines use in another file adds one advisory cross-file note per Lane pair, which never blocks. Languages without a TS/JS import scanner (Go, Python, Rust, Java, C#, …) are matched by package. | `warn` adds the notice to the receipt without refusing; `off` removes it. |
| `urgentRoles` | `["owner"]` | Builders marked routine landings urgent, which pushed every other landing back. Urgent is for a red main or an incident the owner names. | `["owner","agents"]` lets agents on the owner's login use it again. |
| `autoClaim` | `true` | An agent's unsaved edits were invisible to others ("unsaved edits unavailable"), and a clash on one file cost about an hour (2026-11-05). The first-write hook records "touching PATH" on the agent board so other agents' first writes to that file show it. | `false` stops new automatic claims and hides live ones. |
| `checkpointNudgeMinutes` | `30` | A builder that stops unexpectedly loses everything unsaved. Saves take under a minute. | Any number of minutes; `0` turns the nudge off. |
| `dormantAfterDays` | `2` | Lanes nobody saved, started or landed for days stayed active (60 on the dogfood project, 52 idle) and kept raising overlap notices, presence entries and board signals for work long on main. | Any whole number of days; `0` never marks a Lane dormant. |
| `stallAlerts` | on, 15 and 30 min | A check outage (2026-10-30, every result upload refused from 18:35 to 21:05) stalled landings for hours before anyone looked. | `{"stallAlerts":{"enabled":false}}`, thresholds, recipients and webhook preset below. |

### preflight

- **Project file `forge.json`.** Project settings for any language live in one JSON object at
  the repository root: `{"preflight": {"tests": {…}, "static": […], "guards": […]}}`, each
  described below, `{"install": {"scripts": true}}` (see [shareDependencies](#sharedependencies))
  and `{"packages": {"edges": […]}}` (the package graph's edges between ecosystems, below). A JS project may instead keep the same `preflight` object under `forge` in
  `package.json`; a key set in both files is an error, never a silent pick, and a `forge.json` that
  is not a JSON object makes the plan unavailable. Forge reads it as data and never runs it; keys
  it does not know are ignored.
- **Clean environment.** Every command preflight runs (static checks, the build step, package
  commands and the test runner) runs in one [clean check environment](security.md#clean-check-environments)
  built for the run and removed when it ends: a private HOME, XDG and temp directories and npm
  configuration, only the allowlisted variables and the shared check caches, with no passthrough. A
  test that needs a credential or setting from your shell fails here as it would in the landing check.
- **Static checks first.** Cheap repository-wide checks the landing check also runs (formatting,
  the foundation check, document and schema guards) run before any build or test, whenever the
  change touches their inputs, and a failure ends the run with that check's own output and no tests
  started (`receipt.static`, plan `static.selected` and `static.untouched`). They are declared as
  `preflight.static` in a root `forge.json` (any language, for example
  `{"preflight":{"static":[{"name":"vet","command":["go","vet","./..."],"inputs":["**/*.go"]}]}}`)
  or as `forge.preflight.static` in `package.json`: each entry is a `package.json` script name or
  `{name?, script? | command?: [program, ...args], inputs?: [glob, ...]}`; without `inputs` any
  change triggers it, and a declared script the project no longer defines makes the plan
  unavailable instead of silently skipping. With no declaration only a conventionally named
  formatter script (`format:check`, `check:format`, `fmt:check`) runs; an unknown `check` script is
  never guessed, because it may be a full verification. A check over its 120 s timeout is reported
  `timed-out`, not passed: the landing check still runs it.
- **Test runner, per project.** Preflight, the `tests` read, Intent contract tests and semantic
  union tests use the project's own runner. Declare it as `preflight.tests`:
  `{glob: string | [glob, ...], command: [program, ...args]}`, where an argument `{files}` becomes
  the selected files (otherwise they are appended). Any project can declare it in a root
  `forge.json`, for example `{"preflight":{"tests":{"glob":"**/test_*.py","command":["python","-m","pytest","{files}"]}}}`;
  a JS project can instead put the same object under `forge` in `package.json`
  (`forge.preflight.tests`, for example `{"glob":"**/*.test.ts","command":["pnpm","exec","vitest","run","{files}"]}`).
  Declaring it in both is an error. Without a declaration Forge infers it, running no repository
  code: from the `test` script (`node --test [paths]`, `tsx --test [paths]`, `vitest`, `jest`,
  launched through the package manager its `packageManager` field or lockfile names), following
  named scripts up to four deep (`npm run NAME`, `npm test`, `pnpm NAME`, `yarn NAME`,
  `bun run NAME`, `run-s`/`run-p`/`npm-run-all` names and `name:*` patterns). A chained script
  (`npm run a && npm run b`) keeps every runner, each file running with the one whose paths own
  it; a cycle, deeper indirection, a `cd`, another package's scripts (`--prefix`, `--workspace`) or a
  runner Forge cannot run per file (mocha, playwright, `go test`, …) makes the script unreadable,
  with the reason, never a dropped runner. Otherwise a `vitest` or `jest`
  dependency, else, when the repository has a `package.json`, files matching Node's own test
  patterns (`.js` fixtures in a Go or Python repository are not Node tests), else the **package
  graph** below. When
  nothing applies, preflight runs the static checks alone and says `tests unavailable` with the
  reason (`unavailable` when no static check applies), and the `tests` read returns scope
  `unavailable`. Node's runner over top-level `tests/*.test.mjs` keeps the import-graph tiers below.
  Any other declared or inferred runner selects by path: changed test files, then the tests named
  for a changed module (`sum.test.ts` for `sum.ts`, closest folder first) and, in local preflight,
  every test that reaches a changed file through a static JS/TS import graph (relative imports,
  workspace package names and their `exports`, and tsconfig `paths`; `src/js-import-graph.ts`, no
  repository code runs; a computed import or an undeclared bare specifier selects its importer's
  tests for every code change), then its test files inside the packages the change affects; the
  landing check runs the rest; hosted `tests` reads stay path-named. A runner declared or
  inferred this way also runs the triggered guards first. Contract tests may live at any test path
  in any language (`*.test.*`, `*.spec.*`, `__tests__/`, `x_test.go`, `test_x.py`, `XTest.java`,
  `XTests.cs`, `x_spec.rb`, or a file under a `test/`, `tests/` or `spec/` folder such as Rust
  `tests/x.rs`), when the project's runner runs that file.
- **Package graph, any ecosystem.** From manifests alone (never running repository code) Forge maps
  each changed path to its owning package and selects it plus every package that depends on it:
  Go modules (`go.mod`; a module requiring another or replacing it with a local folder depends on
  it; modules a `go.work` uses depend on each other, since workspace modules import each other
  without a `require`; a change to `_test.go` files only runs that package folder, and a `testdata/`
  file, which other packages' tests may read by a relative path, runs its whole module and the
  modules that require it), Rust crates (Cargo workspace `members`/`exclude`, where a crate with its own `[workspace]`
  that the parent excludes is a separate workspace; `path` and `[workspace.dependencies]` edges), Python packages (`pyproject.toml` `[project]`/Poetry or
  `setup.cfg`, src layouts, requirement names, local paths (`[tool.uv.sources]`, Poetry `path`) and the crate a
  maturin build compiles, an edge to a package of any ecosystem there; a project that builds nothing,
  uv `package = false`, Poetry `package-mode = false` or no build system, owns only the files no
  nested package claims, and reads a nested package only through a path, workspace member or
  maturin crate it declares; `setup.py` is code and is never read), Gradle projects (`settings.gradle(.kts)` `include`, `project(":x")` and `projects.x`
  edges), Maven modules (`<modules>`, also those a `<profile>` adds; dependency and parent
  coordinates), .NET projects (`<ProjectReference>`, matched case-insensitively and by wildcard, in
  the project, every enclosing `Directory.Build.props`/`.targets` and the repository files they
  `<Import>`) and JS/TS packages (`workspaces` or `pnpm-workspace.yaml` members, and any
  other `package.json` with its own lockfile, such as `web/` and `server/` packages that are not a
  workspace). Every `settings.gradle(.kts)` outside `build/`, `src/` and `buildSrc/` roots its own
  Gradle build (an `android/` build included): its projects live below that folder, the folder's
  own build files select every project of the build, and a project also depends on builds its
  settings `includeBuild`. Likewise every `pom.xml` no other pom lists as a module roots a Maven
  build. With no other
  runner, each ecosystem's own command runs the selection when it is unambiguous: `go test ./...`
  (or `go test ./pkg`) in the module, `cargo test -p NAME`, pytest through the lockfile's tool (uv,
  Poetry, PDM) or `python -m pytest`, `gradle :mod:test` (`:mod:allTests` for Kotlin Multiplatform; in the build's folder; `test`
  for a single-project build), `mvn -pl mods -am test` (in the build's folder; a wrapper the tree commits,
  `./gradlew` or `./mvnw`, runs instead only when the project declares `"preflight": {"wrappers": true}`
  in `forge.json`, and the plan's advisory names an undeclared one), `dotnet test PROJECT` for
  test projects, `pnpm --filter ./DIR run test` / `npm run test --workspace=DIR` /
  `yarn workspace NAME run test` for workspace packages and `npm run test` (its own package
  manager) in a standalone package's folder, for packages with a `test` script.
  The selection is full, with the reason, when a changed path is outside every package (a root
  file, a lockfile, CI config), the root package is affected and the module graph below cannot
  narrow it (a root package reached only as a dependent is one more package where its command
  tests just that package, Cargo's `-p`), a manifest cannot be read, the layout
  is computed (Gradle `projectDir`, a `setup.py`-only package), more than 2,000 manifests exist, or
  no unambiguous command exists (Python without pytest declared and without unittest modules, Bun workspaces), a selected package
  has test files but no test command of its own (a JS package without a `test` script whose tests
  the root runs, a Gradle project without its own build file, a Gradle test source set such as
  `src/integrationTest` that `test` does not run), or a selected Maven module is one only a profile
  adds. When unsure the graph widens, never narrows: a package with a reference it
  cannot place (a `path`, `file:`, `workspace:`, local `replace`, `<ProjectReference>` or
  `<Import>` target that is no package it read, a Gradle `apply from:` script, or a plugin that is
  not a Gradle/Kotlin/Android one in a build with `buildSrc/` or an included build, where convention
  plugins add project dependencies) is selected by every change, with its dependents and the reason.
  Repository docs
  outside every package change nothing. Docs means prose (`src/prose-paths.ts`, one rule for every
  selector): Markdown, MDX, reStructuredText, AsciiDoc, and `.txt` only with a prose name (`README`,
  `LICENSE`, `NOTICE`, `CHANGELOG`, …) or under `docs/`; `requirements.txt`, `CMakeLists.txt` and
  any file under a fixture, `testdata` or snapshot folder are inputs, never docs. A package found only by its manifest inside another
  package's folder, or inside a package of another ecosystem, also selects the enclosing package,
  unless that package has no tests and nothing depends on it. When the manifests place no package,
  the reason names them and why (a Gradle build file with no settings file, a `package.json` with
  neither workspaces nor its own lockfile). Manifests do not show edges between ecosystems (a
  Python or JS package that builds a Rust crate, a Go server embedding a JS build), so in a
  repository with more than one ecosystem a change also selects every package with tests of the
  other ecosystems, unless its manifest names them (a maturin build's crate, a Python project that
  builds nothing) or `forge.json` declares them:
  `{"packages": {"edges": [{"from": "python:py", "to": "cargo:crates/core"}]}}` (`from` depends on
  `to`; packages as `ecosystem:folder`, `.` for the root). A declared list, even an empty one, is
  the complete set of cross-ecosystem edges; an edge naming no package makes the graph unknown
  (full). The graph is cached per head; the `tests` read reads
  manifests in the same batched source reads (none for Forge's own Node layout or a cached head).
  A scoped configured check command receives the same selection in `FORGE_CHECK_PACKAGES`, with a
  runner for it in `FORGE_CHECK_PACKAGES_RUN`, and an Intent without a contract can get a scoped
  first check when the graph selects a minority ([check command scope](workflows.md#check-command-scope)).
  It is a selector, never an independence proof.
- **Module graph narrows a changed package to the tests that reach the change.** For Python, Go,
  Rust, Java and Kotlin, Forge reads each source file's imports and top-level names lexically (no
  repository code runs) into a module graph per head (`src/module-graph.ts`; facts cached per
  blob, so a save re-reads only changed files; at most 5,000 source files, 1 MiB each, 16 MiB in
  all, the code graph's bounds, else package level as above). A changed package, the root package
  included, then runs only the test units whose imports reach the change: pytest files
  (`python -m pytest tests/test_a.py`, conftest.py and `__init__.py` chains included; without
  pytest, the `test*.py` files that import unittest and define a `TestCase`, as
  `python -m unittest tests.test_a`, needing `__init__.py` in every folder down to them), Go package
  folders (`go test ./a ./b`), Cargo test targets (`cargo test -p NAME --test=T`), Rust library unit
  tests by module path (`cargo test -p NAME --lib -- a::b::`, one invocation apart from the targets;
  the doctests, if the crate has any, rerun whole as `--doc`, since doc comments are not read), and
  JVM test classes under `src/test/` (`./gradlew :p:test --tests C`, `mvn test -Dtest=C`) and, in a
  Kotlin Multiplatform build, under a declared target's test source set (`src/jvmTest` is
  `./gradlew :p:jvmTest --tests C`). Packages that depend on it still run whole. It stays at package level when a changed path is not module code
  (data, C, a manifest, a deleted file), when the package depends on another changed package,
  when neither pytest is declared nor any test file is a unittest module (a test-looking file that
  is not one keeps Python whole), when pytest's `python_files`, `pythonpath` or `import-mode` is set,
  and when a reached file's users are invisible: Rust binary, example and build-script code
  (Cargo builds it into every test target), Rust library code with `#[no_mangle]`, `extern` blocks or
  linker-registry attributes and every file of a proc-macro library, JVM tests in a source set
  without a task Forge can name (`commonTest`, `androidTest`, a set of a target the build file does
  not declare), Kotlin top-level `operator fun` and `package-info.java`. Rust `impl` blocks and
  `macro_rules!` macros act without being named, so every file of the crate that names a type,
  trait or macro they mention depends on them, and a file calling a macro that defines tests has
  those tests; a library `lib.rs` that holds tests runs the whole library harness. Dynamic loading (`importlib`, `__import__`, `subprocess`, `sys.path`,
  `os/exec`, `plugin`, `Class.forName`, `ServiceLoader`, `include!`, `#[path]`) or a local import
  Forge cannot resolve makes that file depend on its whole package, never on nothing. Java and
  Kotlin edges come from package visibility plus word matches on top-level names, so common names
  over-select. `node scripts/measure-module-graph.mjs DIR PATH…` prints the reach and the selection
  with and without the module graph for any checkout.
- **Inferred commands advise; declared ones can be required.** A runner Forge inferred (these
  package commands, or `vitest`/`jest` guessed from a dependency with no `test` script) can need
  setup only the project's CI does: test data it fetches, services, a toolchain. Its plan carries
  `advisory`, and `land --save` reports it (`status: "advised"`, plus `lastRun` when the last run
  of this head failed) without `PREFLIGHT_REQUIRED`. A runner the project declared (`preflight.tests`
  in `forge.json` or `package.json`) or wrote as its `test` script keeps the `require` policy.
- **A missing toolchain is environment, not failure.** Before a package command runs, preflight
  looks for its program on `PATH` (and a JVM for the Gradle and Maven wrappers); a missing one, an
  exit of 127 or a spawn `ENOENT` (any runner) records `ENVIRONMENT / TOOLCHAIN_MISSING` with the
  `missing` programs and the `units` not run. The receipt never claims a pass, and landing treats
  it as advice; the hosted check runs those tests with its own setup.
- **Package-command estimates.** A unit this machine already ran is priced at its smoothed time; the
  rest at the median of the project's recent hosted check durations (land and wait record them from
  the landing timing they already hold: no extra call), else 60 s per command. `estimateBasis`
  says which (`measured`, `hosted`, `default`).
- `nforge agent ROOT preflight '{"laneId":"…"}'` always runs changed tests, explicit coverage,
  smoke and the project's declared *guards* (`preflight.guards` in `forge.json`, or
  `forge.preflight.guards` in `package.json`, filtered by
  path rules, protected like mandatory tests, cost in `local.guards`; see
  [workflows](workflows.md#local-preflight-guards)); then *learned* tests; then *direct* tests; then direct consumers
  of hub modules (`wide`); then *recent* failers; then tests that watch a distinctive name in a changed source (any import distance);
  then `near` consumers (two modules between). There is no file count. Mandatory, learned and direct
  tests are protected: the time budget never trims them (`local.protected`; `protectedOverBudget`
  says when they alone exceed it), and only the run's wall-time cap stops one.
  A *direct* test runs a changed module: it loads it itself or through test fixtures (a helper
  under `tests/` adds no distance), or loads a module that imports it or dispatches it in process
  (*fixture-reached*: a fixture that loads `convex/a.ts` runs what `a.ts` imports for every test
  using it; 2026-11-07, seven landing failures of `projectHostedLandingCancel.ts` sat behind
  `tests/hosted-landing-fixture.mjs`), or is named for it (`tests/NAME.test.mjs` for a changed
  `NAME.ts`, or the module's trailing words: `hosted-landing-cancel` for `projectHostedLandingCancel`).
  A computed path, a path string in product code and a by-name loader's closure (every Convex
  module named anywhere the test's code reaches) keep landing coverage but never make a test close.
  Within direct and wide, tests rank by product modules between, then the fan-in of the fixture
  that carries them (a test's own import before a shared harness), then fixture depth.
  A changed module whose own loaders (tests at zero modules between) would overrun the budget on
  this machine is a *hub*: its consumers are ranked as `wide` instead, and its own named test stays
  protected. Tests one module away never make a module a hub. A *learned* test failed in a
  landing check or a preflight while one of the changed paths was changed (2026-11-06: the
  disk-hygiene prune test and the delta behaviour tests were trimmed and the regression surfaced
  only by hand). The record is `preflight-learned.json` beside the timings: changed path to failing
  test file, from the `CHECK_FAILED` response `land --save` or `wait` already holds (the finish gate
  remembers the landing's changed paths) and from failed preflight files. Learned tests run even
  where the import graph does not reach them, for every project runner: a failing `x_test.go`,
  `test_x.py` or `XTest.java` is stored by its test-name shape (preflight: by the runner's globs)
  and planned again, as its own `learned` tier, on the next change to the same path, when the
  runner's globs still match it; entries expire after 30 days, the record is bounded
  and never uploaded, and no server call is added. A *recent* failer runs a changed module within two
  modules and failed in a landing check within 14 days under other paths (2026-11-06: two read-budget
  tests failed for the completion-tick change, and a sibling file of the same modules would have
  missed the learned record). A recent failer that is already direct or wide stays there and runs
  first among equally close tests; the rest rank after `wide` and are trimmed by time, never
  protected, so a flaky failer cannot grow the protected set or displace a direct importer
  (2026-11-07: 13 recent files reached through the backend's shared wrapper took the budget from the
  importers of four job modules). `local.tierTests` names the local tests of each tier. A *name watcher* shares a rare path-like name with the change, such as a mkdtemp
  prefix the module creates and a test that hooks `fs.open` on paths matching it; an import graph
  cannot see that link (2026-11-05: `hosted-checkout-barriers` was four edges away). A name counts
  only when at most 1% of the project's tests match it, and watchers rank by how rare their names
  are. Within a tier, tests that failed last time run first, then the cheapest by what earlier
  runs on this machine timed (`preflight-files.json` beside the timings: smoothed milliseconds and a
  failed flag, bounded, never uploaded). Budget the ranked tiers leave over runs the cheapest timed
  tests the budget cut from them, last (`local.filler`); coverage the ranking does not reach
  (computed paths, by-name closures, three or more modules away) never fills it.
  A *comment-only* edit (the parser sees the same program for JS and TS; for `#`-comment languages
  only the leading header changed) adds only the tests that read the file's text, never its
  importers (`local.commentOnly`). A comment that a tool reads as an instruction is code: a
  type-checker or linter directive (`@ts-expect-error`, `eslint-disable`, `type: ignore`, `noqa`),
  a test-environment or JSX pragma, an encoding or `frozen_string_literal` line, a Dockerfile parser
  directive, a YAML schema line or a build tag. The base bytes come from this machine's object stores; without
  them a path counts as changed.
  A *docs-only* change (Markdown under `docs/` or at the root) parses no import graph: it runs only
  the tests that read a changed document, beside the static checks it triggers. A test reads a
  document when it names its path (`docs/a.md`, `../docs/a.md`; a root document needs a `./` or
  `../` prefix, or its quoted name in a file that resolves names against the root), or loads a test
  helper or script that does. Product code naming a document links to it; it is no read. Those
  readers are also what the landing's docs scope runs beside the documents checks (the same selector,
  `scripts/docs-readers.mjs`); a document no test reads runs no test file. Beside code,
  the readers of a changed document are mandatory. The selector reads only saved paths, so a file
  the save ignores (a typecheck's generated declarations) never makes the inventory look incomplete
  and widen the plan to the whole suite; a saved file that really differs here still does, and the
  reason says so first. Before anything runs, preflight prints one `preflight plan:` line on stderr:
  scope, files here, deferred files, budget, estimate, static checks and why.
  A time budget (180 s by default; `"budgetSeconds":N` overrides) is filled in that
  order using each file's own measured time where known and the mean seconds per file otherwise
  (the last 8 completed runs on this machine; 4 s until one is measured). `estimateMinutes` is never
  more than the budget plus the longest planned file. The budget is also a wall-time cap on the test
  phase, protected tiers included: the run goes in groups of about 30 estimated seconds, each sized
  from known file times or the speed this run has observed and never past the time left, starts no
  file once the budget is spent (the first file always runs), and so ends within the budget plus
  about one file. Files it did not start are `stopped` in the receipt (`stoppedForTime` counts them)
  and join the deferred set; `stoppedRerun` is `preflight '{"laneId":"…","retry":true}'`, which
  plans exactly those files (passes are reused, no filler). A failure ends the run the same way (`stoppedForFailure`): the rest
  is not started, passes are kept, fix and run again. A cut trims the farthest
  tier first, never leaves a nearer consumer out while a farther one runs, and never touches
  protected tests. The plan's `local.summary` and the receipt
  (`rule`, `budgetSeconds`, `trimmedTiers`, `deferredTests`, `deferredTo: "pre-queue"`, `slowest`)
  say what was trimmed and why and which files were slowest. Every file skipped for time is named
  (`local.trimmedTests` in the plan; `skipped` in the receipt, trimmed plus not started), with one
  command that runs exactly those files (`rerun`): `preflight '{"laneId":"…","trim":false}'` runs
  every ranked local tier with no budget and no filler, and reused passes make it run only what
  was skipped, so its results are recorded and learned like any other run. Trimmed and farther consumers (three
  or more edges, dynamic) are
  `deferredTests`: they run in the pre-queue Lane check (`acceptance.admissionCheck`, on by
  default; with `false` they run first in the queue check). The receipt also reports build and
  test wall time (`buildMs`, `testMs`) and the largest test process's `peakRssMb` where
  `/usr/bin/time` can report it (macOS, Linux).
- Private gzip receipts retain per-file passes, even from failed runs. Delta selection checks
  both inventories; invalid evidence or changed runtime prevents reuse. Plans name `reusedTests`
  and `deltaPaths`. No server calls or uploads are added.
- Non-Markdown root/docs/`evals/` files select full landing coverage; Markdown-only docs
  retain their fast path, and Markdown under `evals/` selects only the code that names it.
  Near-full coverage runs on the landing runner.
- Identical source trees reuse passes. Otherwise `require` demands a pass only when complete
  coverage fits `preflightMaxMinutes`; larger sets or unavailable paths remain advisory.
- An unhealthy finite probe records `ENVIRONMENT / FILESYSTEM_EVENTS_UNHEALTHY`, the fseventsd
  remedy and next action. This source-bound advisory never claims a local pass; hosted checks
  remain required. `nforge doctor ROOT` runs the diagnostic.
- `"run":false` only plans. Save first: receipts name saved source; unsaved edits are refused.

### overlapGate

- `nforge agent ROOT ack '{"laneId":"…"}'` answers every pending overlap notice on the Lane in one
  command (`accept-order`: keep your change and land in order). `"choice":"split"` records that you
  moved your edit off the file. Answers have stable ids, so repeating the command replays them.
- With `block`, `land --save` refuses with `OVERLAP_UNANSWERED` while a blocking notice is unanswered, and prints
  the `ack` command. Disjoint same-file or documentation hunks are advisory and need no answer.
  Each notice records its class and reason. Missing range evidence remains advisory;
  exact landing composition still catches conflicts. The check uses the overlap read that the land receipt already makes.

### dormantAfterDays

- `dormantAfterDays` is stored-only: it is not in the effective defaults that `capabilities` carries
  (that shape parses strictly in both directions, so a new field there breaks every CLI/server pair that
  differs by one release). Only the server reads it; absent means 2.
- A Lane is dormant when its record was last written (save, start, sync, landing, lifecycle change) more
  than `dormantAfterDays` ago. Dormant Lanes are left out of overlap notices, presence, board signals and
  the Lanes listed at `start`. Their saved work is kept and any save or start revives them.
- No scan runs. Overlap reads use an index on the Lane's last activity, so dormant Lanes' rows are never
  read. Open Lanes saved before this field existed are judged by their presence time (a row with no time
  at all counts as live) until they next write, a landing completion stamps them from their Lane record
  (up to five per landing, one indexed range read, empty once healed) or `abandon-dormant` indexes them.
- `nforge agent ROOT lanes '{"view":"dormant"}'` lists dormant Lanes with `abandonable` (`landed`: an
  accepted receipt landed the saved head, stamped on the Lane or named in a landed receipt's inputs; `empty`:
  nothing was ever saved; `null`: other saved work). The dry run also compares the paths a `null` Lane
  changed with main's bytes (one State read; only when some Lane has a complete change list of at most 200
  paths): all equal, a deleted path absent, and the Lane reports `abandonable:"on-main"`.
  `view:"live"` hides them; the default lists all and marks `dormant`.
- `nforge x ROOT abandon-dormant '{}'` is the owner's dry run; `{"apply":true}` abandons up to 25
  `landed`/`on-main`/`empty` Lanes per call (never pinned Lanes or other saved work), indexes the remaining dormant
  Lanes, and says how many are left. The saved head is kept; `start --reopen` undoes it.
- A landing also completes an accepted Lane when only its record version changed after the pins were taken;
  a new save or a reopen after the pins still keeps it open.

- Below `dormantAfterDays` an idle Lane costs one line: advisory notices from Lanes idle more than 6 h
  collapse into one `idle-lanes` summary per start/peers read, and a Lane whose Intent was landed by a
  later Lane is superseded (no presence, no advisory notices; blocking notices stay). A dormant window
  shorter than one day was therefore not needed (Issue 55024d40); keep `dormantAfterDays` at its default.

### urgentRoles

- `owner` is the project owner acting in person: a signed-in session, or the owner's CLI with
  `"asOwner":true` on `prioritize`. `agents` are agents running on the owner's CLI login.
- Agents share the owner's login, so this is a default-behaviour guard, not an access rule.
  Contributors never jump the queue, whatever this setting says.
- `prioritize` with `urgent` from another role is refused with `URGENT_NOT_ALLOWED`. A landing
  submitted with `priority:"urgent"` by another role stays normal, and its `priorityReason` says why.

### checkpointNudgeMinutes

- Hosted Lane receipts carry `unsavedFor`: minutes since the oldest file edit newer than the Lane's
  last save. Past the threshold they also carry `nudge` with the save command.
- It is computed from local file times when an agent calls Forge. Nothing runs in between. A newer
  file whose bytes and mode still equal the saved baseline is not an edit (stat index first, at most
  256 files / 64 MiB read per call).
- No `nudge` while a landing of this checkout is live (the reply names its wait, or this session's
  turn ledger records it): the landing froze the saved source, and a save would supersede it.

### stallAlerts

- Alerts ride the existing landing stall alarm, which fires after 15 minutes without progress.
  An idle project schedules nothing.
- Tier 1, at `notifyAfterMinutes` (default 15): what is stuck, why, what was already retried and
  the repair command. Tier 2, at `repeatAfterMinutes` (default 30): the same with a diagnosis (the
  dead step, the last error, who is waiting). Each tier is sent once per stall; progress stops them.
- The stuck agent sees the latest alert as `stallAlert` on its landing and finish status reads. Alerts never rewrite the landing itself.
- Channels:
  - `email`: up to 10 recipient addresses, sent with Cloudflare Email Service from
    `support@nanthai.tech` (deployment variable `FORGE_ALERT_EMAIL_FROM` overrides it). Needs the
    deployment variables `FORGE_ALERT_EMAIL_TOKEN` and `FORGE_ALERT_EMAIL_ACCOUNT_ID`.
  - `webhook`: one POST to the URL in the deployment variable `FORGE_ALERT_WEBHOOK_URL`, shaped for
    the preset: `ntfy` (phone push; recommended), `slack`, `discord`, `telegram` or `generic` (JSON
    `{subject,text}`). `off` by default.
- The webhook URL and the email token are secrets. They live only in deployment environment
  variables, never in the policy, the repository, logs, receipts or alert text. Delivery logs carry
  the channel and HTTP status only.
- Example: `{"agentDefaults":{"stallAlerts":{"email":["you@example.com"],"webhook":"ntfy"}}}`.
- The same channels carry the landing speed alert: a sustained jump in time to main or check
  minutes over the project's 7-day median, at most once a metric a day
  ([regression ladder](agents/regression-ladder.md#rung-1-landing-speed-alert)).

### Reduced-evidence actors

Who may use the contract gate and keep a passed first check across a clean overtake is decided by
project policy, not by who the owner is. Persons and system actors never qualify.

- `acceptance.autoActors` non-empty: exactly the listed agents qualify (the owner's agent too only if listed).
- Empty, the default: the owner's agent qualifies. Another agent qualifies only when `trust.enabled`
  and its earned trust on the Candidate's paths is above `supervised`.
- Anyone else gets the full gate and the exact recheck after an overtake; nothing is reused for them.
- Trust is read only when it is enabled (one row per actor); no other call is added.

## Always on

These have no setting: they fix failures and have no sensible alternative.

- **Start returns the Lane first.** A hosted `start` prints `{"started":{"laneId":…,"path":…}}` on
  stderr as soon as the Lane exists, before its files download.
  - Before this, `start` from a checkout also downloaded a second full copy of the Lane under
    `ROOT.forge-client/lanes/`. Across 105 dogfood starts the median was 26 s, p90 110 s, and the
    worst 34 minutes. The lead root held 203 such copies (5.1 GB).
  - `path` in the start JSON chooses the directory to open the Lane in.
  - `"open":false` returns the Lane pins without a checkout.
  - Neither field is part of the request identity.
- **A landing never depends on the client staying alive.** `land --save` runs its submission in a
  detached process with file output.
  - That process saves, composes and submits. It replays its own request while the save job runs,
    so submission never waits for the agent to call again.
  - From submission on, the server drives the landing.
  - Interrupting the client, killing it or closing its output (for example `| head`) leaves the
    submission running. Run the same command again to resume or read the outcome.
- **Messages with any characters.** `--message-file FILE` sets `message` from a file, and
  `--message-file -` reads it from stdin. `--command-file -` reads the whole JSON request from stdin.
  Apostrophes, quotes and newlines need no shell quoting.
- **Closed output is safe.** A closed stdout or stderr reader never crashes `nforge` mid-action.
- **Version skew names the fix.**
  - An action this CLI does not know names the upgrade step. If the deployment has advertised it,
    the error is `CLI_UPGRADE_REQUIRED`.
  - An action the deployment does not offer says that the server may be older and needs a deploy.
  - A response this CLI cannot parse says that the versions likely differ.
  - Newer actions advertised by the server no longer break older CLIs.
- **No saves during an active land.** Saving a Lane while its land is queued or checking would
  throw away the checks; the save is refused unless it says `supersedeFinish:true`.
- **Retry the same Lane.** A failed land returns `retryCommand` for the same Lane. `cancel`
  receipts carry `cost`: cancelling discards the queue place, the checks and the retry link.
- **Stale queued landings say so.** When a landing changes a file that a queued, not-yet-checked
  landing also changes, that entry is marked `wouldConflict` with the files. Its next receipt says
  to sync and land the same Lane again; the new land replaces the queued entry. This is path
  advice, not a proven text conflict. Each land reads at most 50 queued entries.

## Size ceilings

These fixed ceilings are not settings. Each one falls back to a wider run or a recheck, never to a
narrower one or a wrong "unaffected": past it, Forge runs more, not less. Every one is a constant
in the file named in the table.

| Input | Ceiling | Past it | Where |
| --- | --- | --- | --- |
| Changed paths handed to a project command (`FORGE_CHECK_CHANGES`) | 128 KiB of JSON, about 3,000 paths | the list is left out and the command runs in full | `src/check-command-scope.ts` |
| Package manifests read for one head (package graph) | 2,000 manifests and 16 MiB | the layout is unknown: full selection, with the reason | `src/package-graph.ts` |
| Paths walked in a checkout for the package graph | 500,000 | the graph is unknown: full selection | `src/package-graph-checkout.ts` |
| JS/TS import graph | 20,000 files, 1 MiB per file, 128 MiB together | selection stays path-only | `src/js-import-graph.ts` |
| State manifest in first-check reuse | 8 MiB per manifest (roughly 60,000 to 70,000 files) | no first-check reuse: the check runs as usual | `convex/projectHostedReuse.ts` |
| Secret scan of a file | 1 MiB; binary files (a NUL in the first 8 KiB) are skipped | the file is counted as skipped, not scanned | `src/secret-scan.ts` |
| JUnit reports per job | 32 files, 8 MiB each, 16 MiB together, 5,000 test files | the rest is not read (extra report files are noted); the check's own result is unchanged | `src/junit-report.ts`, `src/junit-report-files.ts` |
| Overlap sketch per file | 1 MiB and 20,000 lines | no line-range evidence for that file: advisory only | `src/hosted-overlap-text.ts` |

## What agents are told

The agent skill, MCP tool descriptions, `capabilities` (`rules`) and `llms.txt` carry one line per
active rule, generated from the effective settings. A rule that is off adds nothing.

First-write hooks default on (`nforge settings firstWriteHooks false` disables
them). [Hook settings](agents/workflow.md#overlap-before-the-first-write) describe
reversible removal, per-project switches and advisory coverage.
