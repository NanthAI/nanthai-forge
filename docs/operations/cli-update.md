# CLI updates

`nforge update FORGE_CHECKOUT` installs the accepted `main` State from a hosted
Forge source checkout. This must be the Forge source project, not a project you
are building with Forge. The command records its deployment and project in the
installation's private `source.json`. It never reads GitHub. The default install
is `~/.local/share/forge-cli`; `--directory DIR` selects an existing installation.
The installer writes the product launcher at `~/.local/bin/nforge`; `--bin FILE`
selects another PATH location. It enters `DIR/launcher.mjs`, which fences a runtime
lease before importing the version-aware controller. Repeated updates keep one
`current`, without external updater scripts.

The internal `manager` pointer normally shares current's build. Explicit historical
rollback preserves the main controller, so even a target predating freshness
checks cannot become an unguarded PATH entry. The next ordinary invocation restores
verified main before dispatch; the controller and current then share one build again.
There is no second user-selectable CLI.

Managed commands check configured Forge main before hooks or execution.
Help, heavy status and local agent/heavy/pull/clone argument errors make zero
network calls. Valid commands make one authorized metadata query, cached
for that process in addition to its action calls. There is no timer,
periodic check or idle network activity.

When main moves, reads and writes behave differently:

- Reads (agent `status`, `planning`, `show`, `diff`, `peers`, `lanes`, `observe`,
  `landing`, `wait`, `preflight`, `decisions`, `queue`, `doctor`, and top-level
  `status`, `wait`, `docs`, `heavy`) never wait for an install. They run on the
  complete current build, print one stderr line, and start one detached
  `nforge update --background` unless an updater is already live. The background
  updater takes the update lock before its single release read, so extra starts
  cost nothing. Its output goes to `DIR/update.log`. After a failed background
  install, reads stop starting new ones for 10 minutes (`DIR/update-failed.json`);
  the next write retries and reports the failure.
- Writes (everything else) never run on an older build. A write installs that exact
  State, or joins an install already running, and then re-runs the same command in
  the new build. The caller gets one result and never runs `nforge update` by hand.
  A write that waited does not read the release again; the re-run child does not
  read it either when its parent just verified that build. So each command makes
  one release read.

The update is cheap and invisible:
stdout holds only the command's result; the one progress line, the selected/revert
line and any step failure output go to stderr; successful build and smoke output is
discarded and no help text is printed. The build is not a heavy-slot job, so it never
queues behind test batches (about 4 s warm; one updater per installation through
`update-lock`). The runtime lock is held only for milliseconds: selection, hook
migration and the final retirement fence. Process inspection and deletion of old
builds run outside it. Commands wait up to 30 s for that lock and up to 10 min for a
live updater; a dead updater is reclaimed at once and its unselected stage is
removed by the next update. Only first-write hooks keep the zero-wait fail-open lock.
Failed discovery, unavailable authentication or a failed build refuses a write with
`CLI_UPDATE_REQUIRED` and the exact `nforge update --directory DIR` recovery
command. When sign-in is missing or expired, that command includes `--login`,
which runs the existing device sign-in flow inside the updater before its release
read. This keeps authentication recovery available without dispatching a normal
command from an unverified runtime. An unconfigured package reports
`CLI_UPDATE_SOURCE_REQUIRED`; bootstrap it with `nforge update FORGE_CHECKOUT --directory DIR`.

Update source uses Forge's existing hash-verified paged checkout and R2 downloads.
The updater serializes installations, reuses product-managed dependencies only
for the exact package, lockfile, platform and Node major identity, and installs
missing dependencies using `npm ci --ignore-scripts`. It builds and smoke-checks
the staged CLI with a synthetic home. Activation has two steps.
`installCliBuild` makes the complete stage an installed build at `builds/HEAD`;
that build is installed but not active, and nothing selects it yet. Then
`activateCliBuild`, the one switch, atomically replaces the `manager` and `current`
symlinks under the runtime lock. A pre-switch check (`preSwitch(build, head)` in
the updater dependencies, reserved for the canary, ac9c4ed4) runs between the
two steps. If it throws, the previous build stays selected. A failed transfer,
dependency install, build, smoke check or pre-switch check preserves the prior
current. On macOS, a lookup that races the symlink rename can fail with EINVAL
for an instant. Readers resolve `current`/`manager` with a short retry, and a
re-run child gets the concrete build path. Publication compares the current observed before discovery;
a concurrent change is preserved with `CLI_UPDATE_CHANGED`, rather than downgraded
from an earlier release read. A failed hook migration retains old build bytes.

Agent receipts include `cliCommit`: the accepted Forge State hash for managed
builds. Source development checkouts run their own code for tests and report
`development` when no accepted-source marker is available. Development checkouts
are not released installations.

First-write hooks use the stable `current/dist/agent-edit-hook.js` path. The
updater also migrates existing Claude and Codex Forge hook commands after the
swap, before pruning. It validates both settings files before replacing either
one; each file replacement is atomic, unrelated settings and hook opt-outs
survive, and both old and new runners remain available through migration.
The owner does not need to reinstall hooks after updates.

The stable bootstrap and managed CLI/hook processes record local runtime leases,
including kernel process identity. Replaced builds remain while their processes may lazy-load
modules. Retirement checks detached-worker and legacy process script paths privately.
If inspection is unavailable, it preserves uncertain runtimes. A replaced build is marked
`.retired` and stays for 10 minutes (product retention, `CLI_RETIRE_GRACE_MS`). This covers
a process that resolved the old path just before the switch and has not claimed a lease yet.
A later update removes it once it has no live users. If a build is still retired when a
process tries to claim it, that process re-runs on current and is not refused. There is no
background collector, and a no-op update performs no cleanup.

A measurement hold at `DIR/.freeze` prevents changes to current. Landing commands
explain the wait and watch local hold removal before reading the released version,
with no timers or server polling. Other stale processes
under that hold refuse with `CLI_UPDATE_FROZEN`, naming the hold and recovery
command. The updater never removes a measurement hold itself.

To explicitly rebuild a retained accepted State for rollback:

```sh
nforge update --directory DIR --state FULL_FORGE_STATE_HASH
```

This selects that State in the same `current`. The main controller stays available
while that historical selection exists, including for targets without any updater
of their own. The next ordinary invocation checks main again and updates if needed; a
rollback does not silently disable freshness checking. Runtime source States
remain available in Forge after local old builds are deleted.

The metadata check reads constant-size project/access/channel records and writes
none. Updates additionally use one publication-time authorization read plus
existing paged object discovery and R2 transfer. The source manifest occupies
O(file count) metadata memory; file bytes are staged on disk, never loaded as one
project-sized buffer. Build time and disk use depend on source and dependencies.
Synthetic tests assert single-read caching, zero timer work, atomic selection,
update-then-prune hook validity and protection of live runtimes. Live billed
usage, platform qualification and installation adoption require release evidence.
