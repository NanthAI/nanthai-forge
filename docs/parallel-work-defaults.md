# Parallel-work defaults

Forge ships three always-on landing rules alongside configurable defaults for parallel work.

## Always-on landing rules

- **Freeze after submission.** Pause edits, saves and syncs while waiting for a submitted landing.
  Resume when the landing settles or Forge directs you to recover it.
- **Retry in the same Lane.** If a landing fails, fix the failure in that Lane and land it again.
- **Follow queued conflict recovery.** If a queued landing reports `wouldConflict`, follow the reply's
  recommended command. When main has changed, `land --save` syncs and lands the same Lane again.
  If Forge recommends early resolution, sync to the exact pending predecessor, resolve the conflict
  and land the same Lane. If Forge recommends waiting, keep waiting for the outcome.

These rules apply with any [project settings](#project-settings), including when
[affected-test preflight](#preflight) is off. See the [agent workflow](agents/workflow.md) for landing
and recovery commands.

## Client settings (this machine)

Machine-wide settings are in `$XDG_CONFIG_HOME/forge/client.json` (default
`~/.config/forge/client.json`); `FORGE_CLIENT_SETTINGS=FILE` overrides it.
Read: `nforge settings`; set: `nforge settings KEY VALUE`; reset:
`nforge settings KEY --reset`.

| Setting | Default | Why | Change |
| --- | --- | --- | --- |
| `autoPruneHours` | `3` | An online Lane start or landing completion can reclaim registered local checkouts after this many hours without a Forge action or file change. | `nforge settings autoPruneHours 0` turns it off. `nforge prune` still works on demand. |
| `activeLanePruneHours` | `168` | A builder waiting on a long landing or review must keep its Lane folder; a 3-hour limit removed idle open Lanes. An open (`active`) Lane's root is removed only after this long with no Forge action and no unsaved edits. | `nforge settings activeLanePruneHours 0` never removes an open Lane's root. |
| `idleLaneHours` | `1` | Agents forgot open Lanes, which kept counting as active work and kept their disk. Start housekeeping lists the open Lanes this agent run started on this machine that have had no Forge action for this long. | `nforge settings idleLaneHours 0` stops the list. |
| `localHeavySlots` | `auto` | About 20 agents shared a 16 GB laptop. Unlimited parallel builds and test runs swapped the machine; 3 at a time kept it responsive. `auto` allows one heavy command per 5 GB of RAM, capped at half the cores and never below 1 (16 GB with 8 cores gives 3). | A number sets the slots; `0` turns the limit off. |
| `localHeavyMaxMinutes` | `60` | A finished reviewer's hung test held one of the machine's slots for 71 min (Item 593fc2d7). Heavy holds on the dogfood Mac take seconds to about 10 min, so a command still running after an hour is stopped (`SIGTERM`, then `SIGKILL` 10 s later; exit 124) and its slot freed. | A number of minutes, at most `1440` (a day), sets the bound; `0` removes it. |
| `shareDependencies` | `true` | Each Lane needs `node_modules` (261 MB for Forge itself), and every agent ran the install. When a Lane opens, its `node_modules` becomes a link to one install per exact lockfile and package manager (npm, pnpm, yarn or bun). | `nforge settings shareDependencies false`. |
| `installScripts` | `false` | A repository's own files could switch on dependency install scripts at `start`, so opening a Lane ran code its authors chose. A repository's declaration is a request: `start` shows it, and only you decide. | `nforge settings installScripts true` accepts repository requests on this machine; `start {"installScripts":true}` runs all scripts for one Lane. |
| `clientCacheMaxGB` | `2` | `ROOT.forge-client/lanes` caches disposable checkout copies. Past this size, the least recently used eligible copies are removed. Registered checkouts use hosted Lane pruning. | `nforge settings clientCacheMaxGB 0` removes the size cap. |
| `clientCacheMaxAgeHours` | `24` | The same cache: a copy nobody used for this long is removed. | `nforge settings clientCacheMaxAgeHours 0` removes the age limit. |
| `landWait` | `true` | Agents wrapped `land --save` in a polling loop to learn the outcome. `land --save` now waits by default and prints a compact summary. | `--no-wait` on one command, or `nforge settings landWait false`. |

### autoPruneHours and idleLaneHours

- The client keeps a small local index of the Lane checkouts it opened, at
  `$XDG_STATE_HOME/forge/lanes` (default `~/.local/state/forge/lanes`). It writes one small file
  when it opens a Lane and when an agent action touches one. Nothing runs in the background.
  Beside it, `forge/lane-resolutions.json` maps an old Lane id to the resolution Lane that took over
  its folder in place (at most 64 entries), so an old id is followed without listing the index.
- An online `start` or a client observing a successful landing with identified inputs can
  sweep due registered roots.
  Both share one machine-local window of 60 minutes. The next such command after the window
  checks up to 48 due identities from its deployment in one read, batching across projects
  and continuing larger inventories on later triggers. Nothing runs at idle or on offline startup.
  When nothing is due, housekeeping makes no read. With automatic pruning disabled, `start`
  can still use this window for idle advice on the current project.
- A root is removed only when all of these hold:
  - the server says the Lane is `abandoned`, or `completed` with a current landing receipt
    for the checkout head;
  - there has been no Forge action and no file change for `autoPruneHours`;
  - the root is not where the command runs;
  - the root holds no other Lane roots;
  - the checkout marker still names that Lane.
  Prune verifies that the checkout matches its saved baseline and that no checkout command,
  local process or snapshot worker is using it. A finished Lane's snapshot worker and cache
  inventory bookkeeping still count toward its size. The timestamp from replacing an
  unchanged inventory record does not count as use. Recent source and recovery changes
  still count as activity. A Lane containing another checkout with a Forge marker is retained,
  including custom paths under scratch. Prune rechecks for nested checkout markers before
  deletion and retains recovery archives in the adjacent cache.
- An `active` Lane with no Forge action for `activeLanePruneHours` (7 days) is also removed, but only when no
  Forge command of this machine runs in it and its
  checkout has no unsaved edits. The read-only check compares files against the saved State.
  At most eight checks per pass cover active or deleted-project copies. Finished Lane checks
  during `start` share its bounded housekeeping time and resume on a later start if the
  pass uses its time budget. An edited active root stays and is
  listed as idle. `open` restores a removed root from the saved head.
- Every removal appends one JSON line (time, Lane, root, server state, reason, idle hours, bytes) to
  `$XDG_STATE_HOME/forge/lane-prune.jsonl` (default `~/.local/state/forge/lane-prune.jsonl`) before the
  root is deleted; the file rotates to `lane-prune.jsonl.1` past 1 MB.
- Automatic pruning removes the registered checkout, including its scratch. The receipt lists the
  removed Lane IDs and how to restore saved source with `open`. Explicit pruning also removes
  generated adjacent cache and metrics while saving retained recovery. A `node_modules` link
  is removed as a link, preserving the shared install.
- Unavailable project access, missing Lane records and incompatible/unreachable deployments
  retain the root and report the reason and recovery. Local checkout/registry state may be stale
  after a reopen and never substitutes for current hosted lifecycle state. Live processes and
  unknown process coverage also retain copies. A deployment without the batched read prunes nothing.
- The idle list on `start` is per agent run (Issue d730121f). Each index entry records the agent
  session slug of the run that started or resolved the Lane (`null` for a person). Only Lanes of the
  calling run are listed with the `abandon` command. Idle Lanes that other runs of the same account
  started, and older entries with no run recorded ("unknown run"), get one line naming them, with
  no abandon offer. `nforge prune` (the operator asking) still lists every idle Lane.
- `nforge prune` is a dry run (it lists `wouldPrune` and changes no registry, pin, link or checkout);
  `--apply` removes and lists `pruned`. From a project checkout, prune inventories its local
  `ROOT.forge-client/lanes` directory. `--scan DIRECTORY` selects a different directory, including a
  project checkout (scanning its sibling `ROOT.forge-client/lanes`) or a `.forge-client` folder.
  The `folders` report includes unregistered checkouts, markerless directories, cache companions,
  and allocated checkout and scratch sizes where they can be measured. `largeScratch` flags
  scratch above the configured client cache size budget. Copies kept for unsaved edits list up to 20
  unsaved paths (`added`, `modified`, `deleted`) or the exact block (`pending-apply`,
  `unreadable-marker`, `unreadable-checkout`) and flag `staleMarkerHead` (when a saved/landed
  head is returned) or `staleMarkerVersion` (when the checkout marker version lags the server's
  Lane version). A standard apply also registers
  discovered checkouts that remain and removes dangling links to missing nested copies.
  Use `--finished-only` to reclaim abandoned Lanes and completed Lanes whose checkout head
  has a current landing receipt. It previews dependency eviction after releasing their links.
  Use `--unreachable` (mutually exclusive with `--finished-only`, never automatic) to preview or
  (`--apply`) reclaim clean, idle nested cache copies whose project is unreachable or unavailable
  past the grace period (`max(autoPruneHours, clientCacheMaxAgeHours)`), never `AUTH_REQUIRED`
  copies or copies with unsaved edits, pins, holds or active work.
  If a directory changes during removal and the filesystem returns `ENOTEMPTY`, prune
  reports that root and continues with other eligible roots. Receipt reads use pages of up to 48 Lane identities. An explicit prune with
  `autoPruneHours` set to 0 uses 3 hours.
- One root per Lane: `open` at a new path moves the copy `start` made under
  `ROOT.forge-client/lanes/` there instead of downloading a second tree. It reports
  `movedFrom`. A copy whose client lock is held, or one on another volume, is left alone.

### clientCacheMaxGB and clientCacheMaxAgeHours

- Nested Lane copies live under `ROOT.forge-client/lanes/`. Each use refreshes usage/size bookkeeping at `FOLDER.forge-client/cache-use.json`, beside
  the copy. Touch, inventory and eviction share this location; checkout replacement leaves it intact.
  A `.forge/cache-use.json` inside a copy is unknown metadata like any other: it is preserved and
  prevents eviction or replacement. Unknown metadata is preserved and prevents eviction or replacement.
- At most once an hour, from the CLI start, one local pass removes copies over the age limit and
  then least recently used copies until the directory is under the size cap. It reads no server
  and runs no timer. A pass that runs out of its 15-second budget continues on the next start.
- A copy is kept when it is the caller's own Lane, holds the work or snapshot lock or was used in
  the last ten minutes, is the target of a symlink beside ROOT (conflict checkouts), is an open Lane
  checkout this machine started, opened or resolved there, has unsaved edits, or a live local
  process works in or holds open files under it or its cache companion. Right before removal, cache
  GC re-reads the Lane registry, marker, locks, open-file processes and unsaved-edit state, preserves
  any `kept-apply` recovery directory, and retains the copy on `ENOTEMPTY`.
  Registered Lane roots use the hosted state read above. Unknown process coverage also keeps a
  copy. Cache eviction and idle Lane
  pruning share explicit cleanup's batched process-directory observation (one scan pass and one per
  removal batch), only when a copy
  might be removed. Cache eviction records its path, reason and bytes in the existing local Lane
  prune log before removal; it adds no server calls or idle activity.

### Local disk

- In a hosted Lane, `nforge status .` shows allocated checkout and scratch bytes.
  `nforge agent ROOT status '{"laneId":"LANE_ID"}'` reports the same local figures when the
  checkout is present. The read checks scratch first and samples up to 4,096 entries or 25 ms.
  Incomplete counts are reported as lower bounds. Scratch over 10% of free space on the
  Lane's volume is flagged. This measurement makes no server calls.
- Forge temp output goes to `$TMPDIR/forge-tmp/PURPOSE-PID-RANDOM`. Any CLI start removes entries
  there not written for 2 hours, at most once an hour, unless their process is still alive.
- Forge writes an empty `.metadata_never_index` (Spotlight exclusion) into each `ROOT.forge-client`,
  `$TMPDIR/forge-tmp`, the peers cache root and runtime release directories. Lane roots get none:
  the file would be an untracked source file. Keep Lane roots in a directory you exclude from
  Spotlight, for example with `touch DIRECTORY/.metadata_never_index`.

### localHeavySlots

- `nforge heavy CMD [ARGS...]` runs one heavy local command (build, typecheck, lint, tests). It
  waits for a free slot, including for commands the project declares as static. Every Lane and
  agent on the machine shares the slots. A leading `--`
  (`nforge heavy -- CMD`) ends heavy's own options.
- Slots are granted first come, first served. A caller that finds anyone waiting joins the back of
  the queue (one small ticket file per waiter); only the caller at the front tries the slots, so a
  newer short command never overtakes an older waiter. Waiters are woken by every release and
  re-check every 3 seconds.
- A waiting caller prints its queue position and, after three finished heavy commands on this
  machine, an estimate: the median of the last 32 hold times, applied to the earliest slot to free
  for each waiter ahead. It is a rough guide, not a promise.
- `localHeavySlots` is the base, not a hard count (ff33e9a6). On one day, all 3 slots were full for
  597 min. For 371 of those minutes at least one holder used 2 cores or less, often a one-core
  model check holding a slot for 97 min while load sat at 4-14 on 10 cores. Past the base, extra
  slots (up to twice the base, never more than the cores) open one at a time. The caller at the
  front of the queue gets one when all of these hold:
  - the larger of the 1-minute load and the holders' CPU, plus the newcomer's cores, is at most
    the cores. A holder counts the CPU its process tree uses now (one `ps` of pids and CPU),
    at least 1 core. A holder younger than 30 s, or unmeasured, counts its full share or its
    declared cores.
  - at least 25% of memory is free: macOS's kernel free percentage (what `memory_pressure`
    reports; swap there grows on demand, so its used share is no signal), or Linux's
    MemAvailable with swap under half used.
  - when two burst claims race past the limit, the one in the higher slot backs off.
- Freeze guard and outside-slot memory: while anyone holds a slot, no command starts, base slot or
  not, with under 10% memory free or while macOS reports warning/critical kernel memory pressure
  (`kern.memorystatus_vm_pressure_level >= 2`). Admission also reads resident memory (`rss`) from
  the same `ps` call (pids, CPU and RSS only, never arguments or environment) to separate heavy's
  own slot trees from everything else on the host (untracked `tsc`, `node` test shards, Playwright
  browsers, concurrent agents), taking the larger of `ps` outside RSS and kernel-used memory minus
  heavy's holders so compressed/swapped pages still count. Each young holder and newcomer reserves
  2 GiB (capped at 25% of RAM); settled holders count their measured RSS. Base slots hold when
  projected RAM exceeds 90% (10% headroom) and extra slots hold past 75% (25% headroom), so heavy
  scales down from `localHeavySlots` toward 1 when outside work consumes RAM. Heavy cannot gate
  processes started outside its slots: on a 16 GiB laptop, 10 builders plus reviewer children and
  UI browser tests hit macOS's out-of-application-memory limit with 4.8 of 6 GB swap (friction
  2475b276); cap concurrent builders on 16 GiB to about 4–6 without browser tests (fewer when
  Playwright browsers run). Load gates only the extra slots: a shared CI runner sits past 2 x cores
  through a whole suite, and holding its base slots there only stalled its own tests. A machine
  with no holder admits at once and reads nothing. Each decision reads load, memory once and `ps`
  at most once, and reuses that reading for 2 s. A waiting caller at the front prints why it is held.
- `nforge heavy --cores N [--max-minutes M] -- CMD` declares and caps a command's cores (test
  concurrency, `GOMAXPROCS`, `RAYON_NUM_THREADS`). It counts N instead of a slot's share.
  `--max-minutes` sets its own bound. A bound past `localHeavyMaxMinutes` needs N below the
  slot share, so long one-core work (a TLA model check) runs without changing the machine-wide
  bound and leaves room for test runs. Example: `nforge heavy --cores 1 --max-minutes 120 -- CMD`.
- The outermost heavy runs its command in its own process group. When the command exits, is
  stopped or runs past its bound, whatever it started and left running is stopped too (TERM,
  then KILL 2 s later). Nested heavy commands stay in their parent's group.
- A slot or ticket whose process died is reclaimed at the next check. Liveness compares the
  process start time as well as the pid, so a reused pid cannot hold a slot or a place in line.
- A slot limits jobs, not CPU, so heavy also bounds every runner its command starts, at any depth
  (an npm script, `sh -c`, `npx`, a script that spawns `process.execPath`, a nested `nforge heavy`),
  to the slot's core share N = max(1, floor(cores / slots)): 3 on 10 cores with 3 slots, 5 with 2.
  Without it, each slot's `node --test` ran up to 9 files at once (load 165 on 10 cores), and an
  npm script's or shell's `node --test` and a native typecheck stayed unbounded (load 65 on 10
  cores, 7008ff18).
  - `node --test`: a preload that heavy adds to `NODE_OPTIONS` (`--require`, from a folder in the
    OS temp folder that only this user can write, created 0700 and checked) restarts an uncapped
    test runner in place with
    `--test-concurrency=N`. A runner's own `--test-concurrency` on its command line wins; one set
    only in a Node config file does not. Node refuses `--test-concurrency` in `NODE_OPTIONS`
    itself, and a command that replaces `NODE_OPTIONS` instead of adding to it drops the cap.
    Node before 20.10 is left uncapped (it has no `--test-concurrency`). Where Node cannot restart a
    process in place (Windows, Node before 22.15) the capped runner runs as a child of the first,
    so a signal sent to that one process (not its group) does not reach the runner. A full or
    read-only temp folder costs the test cap, never the slot.
  - Go tools (the native TypeScript checker, esbuild) get `GOMAXPROCS=N` and Rust tools using
    rayon (oxlint) get `RAYON_NUM_THREADS=N`, unless the command already sets them.
  - Preflight's own slot gives its static checks, build and tests the same variables (so its tests
    see a `NODE_OPTIONS` preload the landing check's tests do not). Preflight's built-in Node runner
    uses `--test-concurrency=1`; a test command declared as static uses the slot's cap.
  - The full `npm test` is the landing check's.
- A `node --test` with no test file path is refused instead of falling back to Node's default full
  suite (frictions e4ce373a, 8e386100): direct `node --test`, `sh`/`bash`/`zsh -c` segments, and
  non-`test` npm/pnpm/yarn/bun scripts are refused before taking a slot or building; wrapped
  commands whose shell globs, variables or scripts expand to zero paths at runtime are refused by
  heavy's preload before any test runs. Explicit `nforge heavy npm test` (and `pnpm`/`yarn`/`bun
  test`) stays allowed for a deliberate full run.
  Flags after a Node script path go to the script. For example, `nforge heavy node replay.mjs
  --test TITLE` runs `replay.mjs` with its own `--test` argument.
- A `node --test` that leaves out a preload the project's own `test` script passes (`--import`,
  `--require`, `-r`) is refused before heavy takes a slot, builds or runs anything. This covers a
  direct `node --test` and a node segment inside one `sh -c`/`bash -c`/`zsh -c` string (a `&&`,
  `||`, `;` or `|` separated command list). The message names the missing flags and the corrected
  command; heavy never rewrites the command. Only the project's package.json `test` script is read.
- Heavy gives its command one compiled-test-module cache (`FORGE_TEST_MODULE_DIRECTORY`, under the
  OS temp folder) unless one is already set, and removes it when the command ends: every test file
  the command runs reuses modules earlier files compiled. Preflight does the same for all its
  groups ([module cache](development.md)).
- Preflight takes one slot for its full static batch, build and tests, including runs that only
  execute static checks. Nested `nforge heavy` and preflight commands reuse a live parent slot.
  A preflight that a test runs on a fixture takes no slot (the test already runs in one).
  `nforge heavy nforge agent ROOT preflight|land|finish ...` holds no slot itself: those commands
  check their arguments and preconditions first, then take their own slot, so a refusal never
  waits in the queue (friction 7c0ed580).
- A slot is never held by a command nobody waits for. A signal to heavy (an agent run ending, Ctrl-C)
  reaches the command; one that has not exited 10 s later is killed and the slot freed. A command
  still running after `localHeavyMaxMinutes` is stopped by its own heavy (exit 124). A holder that
  never stopped itself (a CLI from before the bound, or a wedged holder) is detected by its start time
  in the slot record: 5 min past its bound, the next waiter frees the slot without signalling the
  process. Waiters never kill another holder, and a holder whose slot was freed that way leaves the
  new holder's slot alone.
- `nforge heavy --status` lists holders and waiters by Lane id, executable name and time
  (`overBound` marks one past its bound); it never prints folders, arguments or environment. Its
  `today` field sums the last 24 hours: holds and minutes per kind, the three busiest Lanes, and the
  hold with the highest CPU and with the highest load (when, which Lane, what kind), so a load spike
  can be explained afterwards. Its `wait` field gives the queue wait p50 and p90 in seconds over the holds that
  recorded one (each hold records its wait since ff33e9a6).
- Every hold appends one line to the hold history: when the slot was taken, wall time, Lane, kind
  (test, typecheck, build or other, from the command words, which are not stored), peak CPU of the
  command's process tree in cores and peak 1-minute load. CPU comes from one `ps` per 10 seconds
  that reads process ids and CPU only, never arguments or environment; preflight records only the
  load when it ends; Windows records neither. The file is rolling: past 512 KiB it keeps its newest
  2,048 holds. Wait estimates use the last 32.
- The exit code is the command's exit code. The slots, tickets and hold history (`holds.jsonl`)
  live in `/tmp/forge-heavy-slots`; `FORGE_HEAVY_DIR` selects another directory.
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
- Other ecosystems follow the same rule wherever Forge forms their install (`src/ecosystem-install.ts`,
  the Actions seed). Composer installs with `--no-scripts --no-plugins`; an accepted Composer
  `config.allow-plugins` request drops only `--no-plugins` (Composer enforces its own list), and only
  "everything" runs composer scripts. A Gemfile and a mix.exs are themselves code, and `bundle install`
  builds gem native extensions, so Forge forms `bundle install` or `mix deps.get` only when everything
  is allowed, and otherwise says why. `start` installs JavaScript dependencies only.
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
  fails the previous link stays (a plain single-link `node_modules` keeps pointing at the old install while the new one
  is installed, then swaps in one step, so a check running in the Lane never sees it missing; the old install
  counts as just used, so a cache sweep evicts it last). These commands also restore a Forge link when its shared
  install was pruned. If the directory holds packages Forge did not link, it is kept
  and reported (`dependencies.status` `stale`, or a stderr line); delete it to relink. A Lane with no
  `node_modules` is not given one by these commands.
- The cache is `$XDG_CACHE_HOME/forge/deps` (default `~/.cache/forge/deps`). It has a
  **4 GiB** soft budget. Set `FORGE_DEPS_CACHE_MAX_GB` to a positive number of GiB to override it.
  Existing start/open/install/refresh work sweeps unused entries least-recently-used first; no daemon,
  polling, network or idle work is added. `nforge prune` previews eviction against the whole cache's
  disk footprint and `nforge prune --apply` applies it after Lane-root cleanup.
- Main checkout links, recent Lane links, pinned Lanes, running Lane commands and live install/link
  locks retain their entries even above budget. Lane links use the existing `clientCacheMaxAgeHours`
  setting (24 hours by default, 0 disables age expiry). Workspace overlays follow the same rule.
  CLI builds keep their installs while selected by `current`, `previous` or `manager`. Runtime leases,
  the CLI's retirement grace and the update lock protect live CLI work. Cache aliases are compared by their canonical
  filesystem paths, so a link through a different symlink spelling stays protected. An installer and eviction hold the same per-entry
  lock through link publication or removal; a failed relink keeps its old entry available through a process-identity rollback lease.
  Relinks never hold two exclusive install locks, so two Lanes can swap hashes without deadlocking.
  Abandoned partial installs can be reclaimed once their installer is gone. Unrecognised cache folders
  are left alone.
- Automatic eviction uses apparent installed-tree bytes. Completed sealed-package sizes are memoised
  locally and writable tool output is counted on every sweep. Automatic runs read entry metadata and
  registered/root references, measuring new or legacy sealed installs once. They remove read-only
  trees by restoring directory permissions without following symlinks.
- Explicit prune reports the current cache footprint in `dependencies.bytes` (after removal with
  `--apply`). It sums allocated 512-byte blocks, skips symlink targets and counts each hard-linked
  inode once per filesystem, like `du -sk` on a quiet cache. `downloadBytes` is included in that
  total and gets credit for links shared between downloads and installs. These are filesystem
  allocations, with no attempt to identify shared copy-on-write extents. `installedBytes` is the
  estimated installed-tree size after the previewed or applied eviction. Explicit prune can evict
  a pnpm or Yarn Berry download store if it is over budget, older than `clientCacheMaxAgeHours`, and
  has neither a live installer lease nor a retained install link. Dry run reports the currently
  allocated bytes and lists candidates separately.
  If another sweep holds the lock, prune reports `status: "busy"` and null sizes. An absent cache
  reports `status: "measured"` and zero bytes. If a directory moves during inspection or the
  disk walk fails, prune reports `status: "unavailable"` with null disk totals and retains its
  eviction receipt.
  Each retained installed set in `dependencies.kept` reports its measured allocated `bytes` from the
  same disk walk as the total, or null when unavailable. A shared set appears once. Its `idleLaneIds`
  name registered Lanes with matching checkout markers whose links retain that set, using
  `idleLaneHours` and local activity evidence. Other links, including
  active Lanes, CLI builds and unregistered checkouts, may also retain it. Use the IDs to find Lanes
  to finish or abandon. Automatic removals print the reclaimed size. Opening a Lane again reinstalls
  an evicted dependency tree when needed.
- A finished install's packages are read-only; its root, each `node_modules` root and tool-cache folders
  stay writable. A hosted Lane's install is keyed by its project too, so a fork never shares one.
  Cross-lockfile installed-file deduplication is not performed: hardlinks would share mutable inode
  permissions, and clonefile reuse needs verified file matching beyond the frozen install path.
- If your Lane changes its lockfile, run its normal `preflight` (or reopen it). Forge materialises the
  matching install and relinks automatically, including `npm-skipped` and `npm-rebuild` installs.
  For a separate private install instead, remove the Lane links and run your manager's frozen install;
  removing links never changes the shared tree.

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
2026-11-06 parse that object strictly. `overlapGate` was retired (Issue 853fcde3): the server always
sends `"off"` so those CLIs still parse, and no current CLI reads it. `autoClaim`, `dormantAfterDays`, `stacking` and `boardAudience` are stored-only: the server
reads them itself, the policy read shows them only when set, and capabilities never carry them. A
later key that agents must read goes to capabilities only for CLIs that ask for contract feature
`agent-defaults-extended`; current CLIs drop keys they do not know. Adding `autoClaim` to the
frozen set on 2026-11-06 broke capabilities across CLI/server versions with `HOSTED_PROTOCOL_INVALID`.

| Setting | Default | Why | Change |
| --- | --- | --- | --- |
| `preflight` | `require` | About 30% of first landing checks failed (2026-10-30), and every failure costs a full landing round on the project runner. A local run of the affected tests catches most of them first. | `advise` leaves tests advisory; static failures still refuse. `off` removes preflight. |
| `preflightMaxMinutes` | `10` | A large affected set would make preflight slower than the landing check it saves. Above this estimate, tests are advice only; static checks still run, and `land --save` still runs the top of the run order for a fixed 90 s (below). | Any whole number of minutes; `0` makes every set advisory. |
| `urgentRoles` | `["owner"]` | Builders marked routine landings urgent, which pushed every other landing back. Urgent is for a red main or an incident the owner names. | `["owner","agents"]` lets agents on the owner's login use it again. An urgent request it turns down queues at normal and says so: `land` prints "Urgent not applied; landing at normal priority" with the reason and how the owner grants it, and the land and wait replies and `queue` entries carry it as `urgentNotApplied`. |
| `autoClaim` | `true` | An agent's unsaved edits were invisible to others ("unsaved edits unavailable"), and a clash on one file cost about an hour (2026-11-05). The first-write hook records "touching PATH" on the agent board so other agents' first writes to that file show it. | `false` stops new automatic claims and hides live ones. |
| `checkpointNudgeMinutes` | `30` | A builder that stops unexpectedly loses everything unsaved. Saves take under a minute. | Any number of minutes; `0` turns the nudge off. |
| `dormantAfterDays` | `2` | Lanes nobody saved, started or landed for days stayed active (60 on the dogfood project, 52 idle) and kept raising presence entries and board signals for work long on main. | Any whole number of days; `0` never marks a Lane dormant. |
| `stacking` | `offer` | Two Lanes on one file both built on main, and the second repaired a conflict after the first landed (rework at 3, 5 and 10 parallel Lanes). When a peer touching your files is admitted, building on its pending head avoids that repair. `offer` prints the exact `sync {stackOn}` command; agents choose. | `auto`: the next plain `sync` stacks on the offered peer by itself. |
| `boardAudience` | `team` | The board and coordination are the team's working space; the owner asked that a public project keep them private to its team (Item b6588425). There is no `everyone`. | `team-and-contributors`: the project's readers may also post notes to the team and read their own threads ([audience](access.md#audience)). An agent's switch to it is held for the owner. |
| `stallAlerts` | on, 15 and 30 min | A check outage (2026-10-30, every result upload refused from 18:35 to 21:05) stalled landings for hours before anyone looked. | `{"stallAlerts":{"enabled":false}}`, thresholds, recipients and webhook preset below. |

### preflight

- **Project file `forge.json`.** Project settings for any language live in one JSON object at
  the repository root: `{"preflight": {"tests": {…}, "static": […], "guards": […]}}`, each
  described below, `{"install": {"scripts": true}}` (see [shareDependencies](#sharedependencies)),
  `{"packages": {"edges": […]}}` (the package graph's edges between ecosystems, below) and
  `{"packages": {"commands": {"cargo": ["cargo", "test", "--all-features", "{packages}"]}}}`, a
  per-ecosystem test command template (cargo, go, python, dotnet, gradle, maven) for the package
  graph below: `{packages}` expands to what Forge selected after the tool (`-p a -p b`, the Go
  packages, the pytest paths, the Gradle tasks, the Maven selection and phase), and
  `{"merge": {"union": […], "fragments": […]}}`, globs of shared list files whose conflicting
  hunks keep both sides, main first, read from main only
  ([shared lists](agents/workflow.md#markdown-conflict-resolution-on-finish)). A JS project may instead keep the same `preflight` object under `forge` in
  `package.json`; a key set in both files is an error, never a silent pick, and a `forge.json` that
  is not a JSON object makes the plan unavailable. Forge reads it as data and never runs it; keys
  it does not know are ignored.
- **Edits while queued.** If a standalone preflight waits for a heavy slot and the Lane changes
  before it gets one, it replans and tests the working files when the slot opens. The result
  describes that workspace run. Landing uses saved-head evidence and runs its own gate after saving.
- **Clean environment.** Every command preflight runs (static checks, the build step, package
  commands and the test runner) runs in one [clean check environment](security.md#clean-check-environments)
  built for the run and removed when it ends: a private HOME, XDG and temp directories and npm
  configuration, only the allowlisted variables and the shared check caches, with no passthrough. A
  test that needs a credential or setting from your shell fails here as it would in the landing check.
- **Static checks first.** Cheap repository-wide checks the landing check also runs (formatting,
  the foundation check, document and schema guards) run before any build or test, whenever the
  change touches their inputs. Hosted `land --save` also runs them when tests are advised or
  deferred or their selection is unavailable (including estimates above `preflightMaxMinutes`); a failure refuses before compose
  or submission, naming the check, its diagnostics and its declared `fix` command (otherwise its
  recheck command). Only the change's own static failures refuse: a failure that names a file the
  Lane adds, edits or renames into, or one its run on a temporary local copy of the Lane's base does
  not show (a whole-repo command that names no file is compared that way). A resolution Lane uses
  the main State it merged in as its comparison base. A diagnostic reproduced on that base is
  `pre-existing` and one advisory
  line; a failure only on files Forge writes into the Lane (the root `.forge/` folder and root `node_modules` link) is
  `forge-metadata` and reports one advisory without the tool's raw diagnostics. When a failure cannot be
  judged (unknown changed paths, no cached base bytes, program not installed) it is `unjudged` and
  advisory. The land reply's `staticAdvisory` holds those lines; the landing check still runs every
  check. A clean run costs nothing extra; only a failure naming no changed file pays one local base
  run, and no server call is added. After a static failure, fix the source, save, then use the same landing options
  with a fresh operation id; the refused operation retains its original source pins. The receipt and land reply carry `static` results separately from test status;
  `staticOnly: true` records that no tests ran and never satisfies the test gate. A failure ends
  the run with that check's own output and no tests
  started (`receipt.static`, plan `static.selected` and `static.untouched`). They are declared as
  `preflight.static` in a root `forge.json` (any language, for example
  `{"preflight":{"static":[{"name":"vet","command":["go","vet","./..."],"inputs":["**/*.go"]}]}}`)
  or as `forge.preflight.static` in `package.json`: each entry is a `package.json` script name or
  `{name?, script? | command?: [program, ...args], inputs?: [glob, ...], fix?: [program, ...args]}`; without `inputs` any
  change triggers it, and a declared script the project no longer defines makes the plan
  unavailable instead of silently skipping. With no declaration only a conventionally named
  formatter script (`format:check`, `check:format`, `fmt:check`) runs; an unknown `check` script is
  never guessed, because it may be a full verification. That inferred check is advice only: a failure
  is reported `unjudged` and never refuses, while a declared check keeps its gate. A check over its
  120 s timeout is reported `timed-out`, not passed: the landing check still runs it. A check's output
  prints while it runs. **Doing less on a small change:** when the saved paths are known, each check
  may read `FORGE_PREFLIGHT_CHANGED_FILE` (a file of the saved paths base to head, each followed by a
  NUL byte; adds, edits, deletes and both sides of a rename) and `FORGE_PREFLIGHT_CACHE_DIR` (a folder
  of its own that outlives the run). Neither is set when the paths are unknown, in the landing check or
  in a direct run, so a command that ignores them still checks everything. Forge's own repository uses
  them so that a source-only change skips the Convex runtime guard unless a changed path can touch its
  graph and the graph's files still match the last full pass, scans only the changed files for the
  per-file foundation rules and the format and lint tools, and runs the cross-file rules in full.
  A declaration can use `packageFiles: true` to include the manifest's `files` paths alongside its
  `inputs`. Forge uses it for installed bytes on changes to packaged files, using exact matching
  local smoke evidence when available and checking a guaranteed lower bound otherwise. The
  package runtime guard runs MCP/CLI module and chunk probes on preflight's existing core build
  when runtime inputs change. Both reuse package smoke's counters. The landing check exercises
  the complete archive and installation and measures CPU.
- **Quick head run on large sets.** Under `require`, when the estimate is over `preflightMaxMinutes`
  so the gate would run no test, `land --save` runs the top of the same run order (fast repo-wide
  guards, declared and learned guards, the change's own tests, then the tests that load a changed
  module) for 90 s of test time after the static checks pass, once per saved head (a replay reuses
  a run that did not fail; a failed one runs again on every land, so a test that passes on rerun
  does not block; a head whose full preflight already ran keeps that result instead). The budget is a hard cap: unlike a full run, declared guards that do not fit are left too, and the run is kept out of the preflight-time median. The reply's `defaults.preflight.quick` states the budget, the files it ran and the files it
  left. A failure refuses the land with the file and its error; otherwise, including a group stopped
  at the cap, the gate stays `advised` and the land submits,
  and the run never counts as a pass. On 11-18 to 11-20, 60 of 264 lands ran no test this way and
  10 then failed the landing check on a named file.
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
  `unavailable`. Node's runner over top-level `tests/*.test.mjs` keeps the import-graph tiers below, but only
  for a project that declares it or has Forge's own check entry; any other `node --test` project is
  a generic runner whatever its folder names.
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
  A Python package with no test file below it is not tested on its own (its dependents still run), and a pytest
  run that collects nothing (exit 5) passes.
  A scoped run keeps the project's own test flags (`--all-features`, `-race -tags integration`,
  `-m "not slow"`, `-c Release`, Gradle `check`, Maven `verify`): from a declared template first, else
  read as text from the declared check's command and the repository script it runs (never executed).
  A tool the CI runs in more than one way, or with a shell expansion or an unclear flag value, makes the
  selection full with the reason; selection flags (`--workspace`, `-p`, `-pl`, `./...`) are replaced by
  Forge's own. Preflight and the Intent contract have no check text, so they use the template only.
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
- **A declared package that is not installed is environment, not failure.** Forge installs a Lane's
  dependencies only from a lockfile. When a run fails and every failed test file imports (directly or
  through its relative imports) a package that a `package.json` declares but no `node_modules` holds,
  the receipt records `ENVIRONMENT / DEPENDENCIES_MISSING` with the `missing` packages and the test
  `units` it could not judge; landing treats it as advice, so a comment-only change to a test file
  lands. An import no manifest declares, an installed package, or any failed file the missing package
  does not explain stays a real failure (`PREFLIGHT_REQUIRED`). A refusal after a real failure names
  the exit code, the failed files, the start of the error output and the ways forward.
- **Package-command estimates.** A unit this machine already ran is priced at its smoothed time; the
  rest at the median of the project's recent hosted check durations (land and wait record them from
  the landing timing they already hold: no extra call), else 60 s per command. `estimateBasis`
  says which (`measured`, `hosted`, `default`).
- `nforge agent ROOT preflight '{"laneId":"…"}'` always runs changed tests, explicit coverage,
  smoke and the project's declared *guards* (`preflight.guards` in `forge.json`, or
  `forge.preflight.guards` in `package.json`, filtered by
  path rules, protected like mandatory tests, cost in `local.guards`; see
  [workflows](workflows.md#local-preflight-guards)) and the *learned guard set* (repo-wide tests
  that failed landing checks preflight skipped, by the saving formula in the same section; first,
  inside the budget, `local.guardSet`); then *learned* tests; then *direct* tests; then direct consumers
  of hub modules (`wide`); then *recent* failers; then tests that watch a distinctive name in a changed source (any import distance);
  then `near` consumers (two modules between). Two kinds of evidence from the change itself make a test
  *direct* at any distance: it hard-codes a literal the change removed from a changed file (a stale id
  or path; only a literal few tests carry), or it imports an export the change altered by name. Tests
  named for a budget, cost, registration, inventory or contract guard that the change reaches only
  through a hub or at a distance become *contract pins* (`local.guards`, up to 20 s, protected, counted
  inside the budget); a backend change (`convex/`) takes registration and inventory pins first, then
  cost pins, and a pin timed at 6 s or less starts with the fast files, ahead of the declared guards.
  There is no file count. Mandatory, learned and direct
  tests are protected: the time budget never trims them (`local.protected`; `protectedOverBudget`
  says when they alone exceed it), and only the run's wall-time cap stops one, which makes the
  run NOT COMPLETE (below). The cap never stops a guard: guards run first, and any left when it is
  spent still start.
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
  A *weakened test* is flagged in the preflight and land replies (`weakenedTests`), never refused.
  For each changed existing JS/TS test file (under a `test`, `tests`, `__tests__`, `spec` or `e2e`
  folder, or named `*.test.*`/`*.spec.*`; fixtures excluded) the saved version is parsed against the
  Lane base's and compared test by test: fewer assertion calls (`assertions-removed`, with counts), a
  check that pins less (`assertion-loosened`: strict to loose equality, an exact value to a bound,
  a pattern or a truthiness, a negation, `throws` without its matcher), a removed test
  (`test-removed`), a new skip (`skip-added`: `.skip`, `.todo`, `skipIf`, a `skip` option, a skip
  call, a guarded early `return` or a bare `return` before assertions), a name filter written into a test (`name-pattern-narrowed`:
  `--test-name-pattern` and the like), `.only` (`only-added`), and, as a hint, a test whose input
  changed under the same assertions (`input-changed`), including a changed `test.each` table. Each
  call to a file or suite helper contributes its assertions to the calling test. Skips, early returns
  and `.only` count once per helper for each calling test. Aliased test functions (`const it = baseIt.skip`,
  `test.extend`) and tests that pass their body by reference (`test('t', runCase)`) are read too.
  Formatting (layout, comments, quote style, semicolons, trailing commas, a lone arrow parameter's
  parentheses), order, renamed locals, a renamed test with the same body, a renamed or moved
  `describe` block, a test moved into another changed file, subtests added or reordered under a
  parent, assertions moved into a file helper the test calls, and new tests are not flagged. Flags
  name the file, the test and the kind, never values. Put one line `Weakened-tests: <why>` in the
  `land --save` message to clear them (`cleared` in the reply). Local and static: the base bytes
  come from this machine's object stores (no server call, no test run); without them nothing is
  flagged. A Lane over the check's bound (200 changed test files, 8 MiB read or 1.5 s; one file
  over 1 MiB is skipped unread) reports the rest as `notChecked: "not checked: N files"` and claims
  no removed test, so the check stays under about 2 s on a codemod Lane.
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
  about one file. A test file still running past its per-file limit (3 times its measured
  time, at least 120 s; 300 s when never timed; `"fileTimeoutSeconds":N` overrides) is killed and
  named in the receipt's `timedOut` and the failure, so a test that never resolves cannot hold a
  heavy slot. Every command preflight runs (the build, typechecks, static checks and tests) gets its own process group: when the command ends,
  anything it left running is killed, and a watchdog kills the group and removes its capture folder
  when the preflight process itself exits for any reason (budget, error, signal or SIGKILL). A command whose wrapper is killed from outside is no longer waited on. Because the clock can stop protected files, they run in this order: files this
  machine timed at about 2 s or less, repo-wide guard tests for the change first, then files whose
  learned saving beats their seconds (ahead of the declared guards, which are never stopped, so they
  always start): the first 10 s of them always (so nothing after them starts more than 10 s later),
  up to 30 s while the guards, the change's own test files, the changed modules' tests below and the
  files that failed before still fit
  the budget; declared and learned guards; the change's own
  test files; budget and contract guards (files named for a budget, weight, growth, ceiling, cost,
  contract, ratchet, baseline, limit or DB I/O guard), so a guard the landing check would fail on
  fails here first; the tests that load a changed module, a whole module at a time, the module the fewest
  tests load first, then the tests that run one through one other module, while they fit what the
  guards, own tests and the first 10 s of fast files leave of the budget, with up to half of that kept
  for files that failed before (loaders that failed before go first, across all modules; a module
  that does not fit is skipped and a later one still runs);
  files that failed before (the learned tier, and any other protected file that failed a
  landing check for these paths or this machine's last run), most saving per second first; fast files
  the room left out; tests named for
  a changed module (failed here last time first, then cheapest); repo-wide guards this machine never
  timed (the run measures them); the other protected files, those whose learned saving `p x C / r`
  beats their seconds first, most saving per second first (the guard set's formula: p from the guard set's server counts
  or this clone's learned failures over the window's landing outcomes, C and r from the server), the
  rest closest first; smoke and explicit coverage (document readers, slower scans, path rules) last.
  The order never adds or drops a file. Files it did not start are `stopped` in the receipt (`stoppedForTime` counts them)
  and join the deferred set; `stoppedRerun` is `preflight '{"laneId":"…","retry":true}'`, which
  plans exactly those files (passes are reused, no filler). After a failed run that stopped nothing,
  the same `retry` plans exactly the test files it failed when the receipt is this saved head's, names
  every failed file and started every planned one; otherwise
  it refuses and names the plain `preflight` command. When a stopped file is must-run
  (changed, learned or direct), the run is **NOT COMPLETE**: not passed (`passed: false`) and not
  failed (`exitCode: 0`). An environment result (a program missing here, a wedged tool) reads
  `ENVIRONMENT (not a failed run)` in the summary and `status: "environment"` in the land
  advisory, never FAILED. `incomplete` counts those files (`mustRun`, listed first in `stopped`)
  and, priced in `estimateMinutes` at this run's speed, the one command that finishes them,
  `finish`: `preflight '{"laneId":"…","retry":true}'`, the stopped files only (a retry has no
  wall-time cap). `finish` is offered only when it fits one agent wait (540 s); a longer one would
  outlive the agent's own command timeout, so the reply names landing alone. `land --save` reports it as
  `status: "incomplete"` with the same count and command; it advises and never refuses, since the
  landing check runs those files. A protected tier that fits the budget changes nothing. A failure ends the run the same way (`stoppedForFailure`): the rest
  is not started, passes are kept, fix and run again.
  Every run's reply and receipt carry one `outcome` (`passed`, `incomplete`, `environment` or
  `failed`) and `failed`, the test files plus static checks that failed (0 unless `failed`). When
  nothing failed, `next` is `land --save`; only a failure names preflight again. The process exit
  status follows the outcome: 0 passed, 2 failed (as a failed landing), 3 NOT COMPLETE, 4
  environment.
  Why a small change can leave 100+ must-run files: tests one module away (they load a module that
  imports the changed one) are protected, and the modules that carry them (landing and transport hubs)
  have about 85 to 220 consumers each. In replays of five NOT COMPLETE runs (2026-11-18), budgeting those consumers cut
  the protected sets of 110 to 428 files to 24 to 93 (a 61-file set kept 60), but dropped tests that
  failed landing checks after a passed preflight (incidents 8809fba5, e5e6fca8): those tests reach
  the change only through the same hubs, so no size cut separates them. The set stays whole; the
  cost is a NOT COMPLETE run whose next step is to land.
  A cut trims the farthest
  tier first, never leaves a nearer consumer out while a farther one runs, and never touches
  protected tests. The plan's `local.summary` and the receipt
  (`rule`, `budgetSeconds`, `trimmedTiers`, `deferredTests`, `deferredTo: "pre-queue"`, `slowest`)
  say what was trimmed and why and which files were slowest. Every file skipped for time is named
  (`local.trimmedTests` in the plan; `skipped` in the receipt, trimmed plus not started), with one
  command that runs exactly those files (`rerun`): `cd LANE && nforge heavy node --test FILES` for up
  to eight files; for more, `rerun` says the landing check is the full run and runs them (`trim:false`
  is no longer suggested: it runs the whole deferred plan locally). Trimmed and farther consumers (three
  or more edges, dynamic) are
  `deferredTests`: they run first in the queue check by default. Explicit
  `acceptance.admissionCheck: "full"` runs them in the pre-queue Lane check instead. The receipt also reports build and
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
- Tests always run; if they fail and a finite probe finds file events unhealthy, the receipt records
  `ENVIRONMENT / FILESYSTEM_EVENTS_UNHEALTHY`, the fseventsd remedy and next action. This source-bound advisory never claims a local pass; hosted checks
  remain required. `nforge doctor ROOT` runs the diagnostic.
- `"run":false` only plans. Save first: receipts name saved source; unsaved edits are refused.

### Overlap notices (retired)

`overlapGate`, `ack` and path overlap notices were removed (Issue 853fcde3). Every save trial-merges
its saved files with main and with peers' saved files and reports a real conflict as `conflictNotice`,
with nothing to answer ([exact conflicts at save](agents/workflow.md#exact-conflicts-at-save)). A stored
`overlapGate` value is ignored. An older CLI that calls `ack`, `peer-ack`, `overlap-acks` or
`overlap-answers` gets `CLI_UPGRADE_REQUIRED` with the upgrade step.

### Server enforcement of preflight

The CLI checks `preflight: require` before it composes. From the Lane checkout, `land --save` runs an unsatisfied required preflight inline with its local budget and operation ID. `PREFLIGHT_REQUIRED` names a failure and its recovery. `PREFLIGHT_BUDGET_EXCEEDED` names the continuation and includes the exact original landing replay. A test group still running at the quick-run cap is stopped and, like the files the cap never started, left to the hosted check: the same land goes on and submits. The server checks preflight again when it accepts
a new agent landing (`projectHostedLanding:enqueue` or `projectHostedLandingDesired:submit`). A
landing from an older or hand-written client that skips the CLI check is refused with the same
code (`PREFLIGHT_REQUIRED`) and next step.

Preflight and inline preflight also run the hosted secret scanner on changed
saved files they can verify locally against observed main. Findings give the
path, line, kind and fingerprint. Allow entries come from main. The hosted
check scans the composed Candidate and decides the outcome.

For the standard Forge check, the same local preview verifies queue proof from
saved paths, digests and available proof and replay registry files. With preflight
enabled, `land --save` refuses a confirmed missing or stale proof for a single
Lane before its heavy-slot wait and preflight, when the selected check runs the standard Forge recipe
(one fresh main read, only when the preview found a gap).
`QUEUE_PROOF_REQUIRED` names every missing or stale path (never "and N more"), where to attach the
proof in the Lane and the command to retry after attaching it. `recovery.queueProof` gives each
path its own next step: the registered replays that reach it and the refresh command, the
refresh command of each stale proof, and, under `uncoverable`, any changed core file no registered
replay reaches. A replay records only code it calls, so a pure schema or validator module (all of
its code runs at load) is proven with an on-path bench cell instead. When main also changed a covered file, composition gives
that file new bytes, so a proof with no recorded replay scope, or whose Lane bytes are not the proven
ones, refuses there too. A change of mode alone keeps the proven bytes. The refusal
names the files, the `save --sync` command and the offline refresh, which re-runs only the
named proofs' registered replays. The hosted planner verifies proof on the composed Candidate
before any test job starts. A refusal there fails every planned job at once, without running
tests. A refreshed proof records the top-level units its replay ran. It still holds after main
changes only functions the replay neither ran nor referenced; import order, load-time code, referenced
signatures and removed units stay bound. When main changed a unit the replay ran, the proof still
holds if the Candidate's file is the proven bytes plus main's own changes: every unit is the proof's
or main's, no proven unit is gone, and imports and load statements are the proof's or main's. That
route adds the proof's registered replay test file to the check's selection, so the replay re-runs
on the Candidate. A Lane edit after its proof matches neither side and still needs a refresh. The
planner pins either result for the static job. That path reads main's bytes of those files once.
Otherwise it reads nothing extra.
When static verification is the reported
cause, the compact landing receipt retains the first safe coded diagnostic line.

`land --save` checks the cheap refusals in one pass, after its save and before any heavy-slot wait,
preflight or compose: an edited Lane folder (`LANE_DIRTY`), Lane pins the server Lane moved past
(`WORK_STALE`, from the Lane read land already makes) and the queue proof above. The landing message limit is checked before
any call. Several refusals come back as one error: the first one's
code and recovery, and `recovery.refusals` naming each, so one fix round clears them all. A land
that stopped before submitting on a transient `HOSTED_ACTION_FAILED` (not a server limit) or on
`PREFLIGHT_BUDGET_EXCEEDED` is resumed by the next land of the same source and command, under the
same or a fresh `operationId`: its saved preflight, compose and operation are reused, nothing runs
twice. The journal keeps the stop's code (`finish-stopped`), so a later read can count it.

- The landing carries `gates`: the CLI's preflight result for each Lane head it composed. The
  server finds those Lanes and heads in one indexed read of the composition. A landing that names
  no composition of the caller's own is refused: an agent lands through `land --save`.
- Preflight runs on the agent's machine and its result is never uploaded. The server requires the
  CLI's result for the landed head (`passed`, `advised`, `none`, `no-checkout`, …), but it cannot
  prove the tests ran. A landing of a Lane from outside its checkout reports `no-checkout`, as before.
- Person landings, replays of an operation and server re-landings are not judged. Projects with
  `advise` or `off` read nothing extra.

### Project development alert destination

The Forge development project uses the `ntfy` webhook preset in
`agentDefaults.stallAlerts`; its destination is held in the Convex dev secret
`FORGE_ALERT_WEBHOOK_URL`. No topic or recipient address belongs in source.
The owner confirmed a forced-stall notification end to end. Email recipients
are configured through `agentDefaults.stallAlerts.email`; email delivery from
development is not available yet. The CLI treats an older capabilities reply
that omits `stallAlerts.email` as an empty recipient list.
