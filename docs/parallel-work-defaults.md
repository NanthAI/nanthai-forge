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
| `idleLaneHours` | `1` | Agents forgot open Lanes, which kept counting as active work and kept their disk. `start` lists your open Lanes on this machine that have had no Forge action for this long. | `nforge settings idleLaneHours 0` stops the list. |
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
- `nforge prune` is a dry run; `--apply` removes. `--scan DIRECTORY` first registers existing
  checkouts in DIRECTORY and in its `*.forge-client/lanes/`. With `--apply` it also removes links
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
- A slot whose holder died is reclaimed. While waiting, the command wakes when a slot is released
  and rechecks dead holders every 30 seconds.
- The exit code is the command's exit code. The slots live in `/tmp/forge-heavy-slots`;
  `FORGE_HEAVY_DIR` selects another directory.
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

| Setting | Default | Why | Change |
| --- | --- | --- | --- |
| `preflight` | `require` | About 30% of first landing checks failed (2026-10-30), and every failure costs a full landing round on the project runner. A local run of the affected tests catches most of them first. | `advise` prints the set without refusing; `off` removes it. |
| `preflightMaxMinutes` | `10` | A large affected set would make preflight slower than the landing check it saves. Above this estimate, preflight is advice only. | Any whole number of minutes; `0` makes every set advisory. |
| `overlapGate` | `block` | Agents finished over unanswered overlap notices and found the clash only at composition. Only exact-base intersecting/adjacent hunks, distinct additions or delete/rename versus edit need an answer. Symbol names alone and disjoint same-file edits produce no automatic notice; missing evidence reports incomplete coverage. | `warn` adds the notice to the receipt without refusing; `off` removes it. |
| `urgentRoles` | `["owner"]` | Builders marked routine landings urgent, which pushed every other landing back. Urgent is for a red main or an incident the owner names. | `["owner","agents"]` lets agents on the owner's login use it again. |
| `autoClaim` | `true` | An agent's unsaved edits were invisible to others ("unsaved edits unavailable"), and a clash on one file cost about an hour (2026-11-05). The first-write hook records "touching PATH" on the agent board so other agents' first writes to that file show it. | `false` stops new automatic claims and hides live ones. |
| `checkpointNudgeMinutes` | `30` | A builder that stops unexpectedly loses everything unsaved. Saves take under a minute. | Any number of minutes; `0` turns the nudge off. |
| `stallAlerts` | on, 15 and 30 min | A check outage (2026-10-30, every result upload refused from 18:35 to 21:05) stalled landings for hours before anyone looked. | `{"stallAlerts":{"enabled":false}}`, thresholds, recipients and webhook preset below. |

### preflight

- `nforge agent ROOT preflight '{"laneId":"…"}'` always runs changed tests, explicit coverage
  and smoke, then all direct consumers, then distance-2 consumers, nearest first. There is no
  file count. A time budget (180 s by default; `"budgetSeconds":N` overrides) is filled in that
  order using the measured seconds per file (the mean of the last 8 completed runs on this
  machine; 4 s until one is measured). A wrong estimate cannot overrun: after the mandatory
  group the run goes on in groups of 10, checks the budget between groups, and stops with
  `stoppedForTime` tests unstarted, which join the deferred set. A cut trims the farthest
  tier first, never leaves a nearer consumer out while a farther one runs, and never touches
  changed tests, explicit coverage or smoke. The plan's `local.summary` and the receipt
  (`rule`, `budgetSeconds`, `trimmedTiers`, `deferredTests`, `deferredTo: "pre-queue"`) say what
  was trimmed and why. Trimmed and farther consumers (three or more edges, dynamic) are
  `deferredTests`: they run in the pre-queue Lane check (`acceptance.admissionCheck`, on by
  default; with `false` they run first in the queue check). The receipt also reports build and
  test wall time (`buildMs`, `testMs`) and the largest test process's `peakRssMb` where
  `/usr/bin/time` can report it (macOS, Linux).
- Private gzip receipts retain per-file passes, even from failed runs. Delta selection checks
  both inventories; invalid evidence or changed runtime prevents reuse. Plans name `reusedTests`
  and `deltaPaths`. No server calls or uploads are added.
- Non-Markdown root/docs files and all `evals/` select full landing coverage; Markdown-only docs
  retain their fast path. Near-full coverage runs on the landing runner.
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
