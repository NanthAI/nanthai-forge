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

Every managed CLI process checks the configured Forge main before dispatching a
command, including help and version. It makes one authorized, finite metadata
query and caches the result or failure for that process. There is no timer,
background check or idle network activity. A CLI behind main installs that exact
State, then starts the completed current runtime. Failed discovery, unavailable
authentication, a busy updater, or a failed build refuses command execution with
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
the staged CLI with a synthetic home before atomically replacing the `current`
symlink. A failed transfer, dependency install, build or smoke check preserves
the prior current. Publication compares the current observed before discovery;
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
If inspection is unavailable, it preserves uncertain runtimes. It removes unused old builds on a
successful swap after their users have exited; no age-based retention
policy or background collector is added. A no-op update performs no cleanup.

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
