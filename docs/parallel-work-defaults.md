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
| `shareDependencies` | `true` | Each Lane needs `node_modules` (261 MB for Forge itself), and every agent ran `npm ci`. When a Lane opens, its `node_modules` becomes a link to one install per exact lockfile. | `nforge settings shareDependencies false`. |
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

- The install key is a hash of `package-lock.json`, `package.json`, the platform and the Node major
  version. A Lane with a different lockfile never shares another Lane's install.
- The first Lane with a new lockfile runs `npm ci` once, in the shared cache, under a heavy slot.
  Concurrent opens of the same lockfile wait for that one install.
- A failed install leaves no partial cache, and the Lane opens without `node_modules`.
- An existing `node_modules` is never replaced.
- The cache is `$XDG_CACHE_HOME/forge/deps` (default `~/.cache/forge/deps`) and is safe to delete.
- If your Lane changes `package-lock.json`, replace the link before installing:
  `rm node_modules && npm ci`. Removing the link does not touch the shared install.

### landWait

- `land --save` (and the old `finish` spelling) on a hosted Lane first submits. It then waits for
  the outcome through the existing live subscription, with no polling.
- It prints one line: `LANDED receipt …`, `CHECK PASSED (not landed)`, or `FAILED CODE: message`.
  A failure is followed by each failing file and its first error, when the check reported one.
- Exit codes: 0 landed or passed, 2 failed, 3 still running after 90 minutes. Run the same command
  again to keep waiting.
- Ctrl-C stops waiting, never the landing.

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
| `overlapGate` | `block` | Agents finished over unanswered overlap notices and found the clash only at composition. Only exact-base intersecting/adjacent hunks, distinct additions or delete/rename versus edit need an answer. Symbol names alone and disjoint same-file edits produce no automatic notice; missing evidence reports incomplete coverage. A peer changing an exported symbol your changed lines use in another file adds one advisory cross-file note per Lane pair, which never blocks. | `warn` adds the notice to the receipt without refusing; `off` removes it. |
| `urgentRoles` | `["owner"]` | Builders marked routine landings urgent, which pushed every other landing back. Urgent is for a red main or an incident the owner names. | `["owner","agents"]` lets agents on the owner's login use it again. |
| `autoClaim` | `true` | An agent's unsaved edits were invisible to others ("unsaved edits unavailable"), and a clash on one file cost about an hour (2026-11-05). The first-write hook records "touching PATH" on the agent board so other agents' first writes to that file show it. | `false` stops new automatic claims and hides live ones. |
| `checkpointNudgeMinutes` | `30` | A builder that stops unexpectedly loses everything unsaved. Saves take under a minute. | Any number of minutes; `0` turns the nudge off. |
| `dormantAfterDays` | `2` | Lanes nobody saved, started or landed for days stayed active (60 on the dogfood project, 52 idle) and kept raising overlap notices, presence entries and board signals for work long on main. | Any whole number of days; `0` never marks a Lane dormant. |
| `stallAlerts` | on, 15 and 30 min | A check outage (2026-10-30, every result upload refused from 18:35 to 21:05) stalled landings for hours before anyone looked. | `{"stallAlerts":{"enabled":false}}`, thresholds, recipients and webhook preset below. |

### preflight

- **Static checks first.** Cheap repository-wide checks the landing check also runs (formatting,
  the foundation check, document and schema guards) run before any build or test, whenever the
  change touches their inputs, and a failure ends the run with that check's own output and no tests
  started (`receipt.static`, plan `static.selected` and `static.untouched`). They are declared in
  the project's `package.json` as `forge.preflight.static`: each entry is a script name or
  `{name?, script? | command?: [program, ...args], inputs?: [glob, ...]}`; without `inputs` any
  change triggers it, and a declared script the project no longer defines makes the plan
  unavailable instead of silently skipping. With no declaration only a conventionally named
  formatter script (`format:check`, `check:format`, `fmt:check`) runs; an unknown `check` script is
  never guessed, because it may be a full verification. A check over its 120 s timeout is reported
  `timed-out`, not passed: the landing check still runs it.
- `nforge agent ROOT preflight '{"laneId":"…"}'` always runs changed tests, explicit coverage,
  smoke and the project's declared *guards* (`forge.preflight.guards` in `package.json`, filtered by
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
  where the import graph does not reach them; entries expire after 30 days, the record is bounded
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
  importers (`local.commentOnly`). The base bytes come from this machine's object stores; without
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

## What agents are told

The agent skill, MCP tool descriptions, `capabilities` (`rules`) and `llms.txt` carry one line per
active rule, generated from the effective settings. A rule that is off adds nothing.

First-write hooks default on (`nforge settings firstWriteHooks false` disables
them). [Hook settings](agents/workflow.md#overlap-before-the-first-write) describe
reversible removal, per-project switches and advisory coverage.
