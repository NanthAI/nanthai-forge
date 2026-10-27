# Maintainer release and CLI installation

`nforge release` explicitly releases accepted native `main`: native Git export
(with optional reuse), build, development backend, matching web, CLI package,
local install, atomic CLI wrapper selection, and supervised owner runtime selection. It never lands a Lane, changes
acceptance policy, pushes source recovery, or publishes a GitHub mirror. A failed
release does not undo a successful landing or establish recovery coverage.

This command implements Forge's maintainer workflow, using the existing native
exporter, `scripts/deploy-forge-preview.mjs` and `scripts/package-local.mjs`.
The backend command is `convex dev --once`; production backend deployment is
outside this workflow. The web stage uses the configured Netlify site's production
URL (`--prod`), rather than making a draft. Backend, web and installed CLI receipts
all name the originally selected native State and acceptance.

Prepare the shared-schema release baseline in a Lane with
`npm run schema:snapshot`, commit it with the release source, and land it before
selecting the accepted State to release. The command checks declared migrations
before updating `scripts/schema-compat/released.json`; see
[shared schema compatibility](../development.md#shared-schema-compatibility).

## Configure once per release

Save a private request file containing paths, not credential values. Use a fresh
UUID for each release number, and keep that file for retries. Paths are resolved
against the invoking directory on first use; absolute paths are convenient.

```json
{
  "operationId": "11111111-1111-4111-8111-111111111111",
  "runtimeDirectory": "/private/forge-runtime",
  "configurationDirectory": "/private/forge-development-config",
  "cliPath": "/private/bin/nforge",
  "npmCli": "/private/node/lib/node_modules/npm/bin/npm-cli.js",
  "reuseExport": "/private/previous-release/export"
}
```

`configurationDirectory` supplies the existing development `.env.local` and
`.netlify/state.json`. The build stage privately copies those two files to its
own source directory; subsequent backend/web stages use that same configuration
and source. Dotenv entries override inherited entries with the same names.
Provider login/configuration and executable availability remain external inputs;
this is ordinary execution under the invoking OS account, not isolation or a
credential vault. Do not put secrets in request files, observations, or reports.
The selected Node executable and npm CLI path are retained for resume.

`reuseExport` is optional. The native exporter validates it and falls back to a
full export if it is unavailable or unusable. No existing export, build, package,
installation or release directory is deleted. Outputs live in new directories
under `runtimeDirectory/releases/UUID`. A pre-existing directory for a new
operation ID is preserved and reported explicitly.

## Run deploy number N

```sh
nforge release OWNER --command-file /private/releases/deploy-N.json
```

The first invocation pins the accepted main State and its acceptance ID. Retrying
the same file or running the returned resume command retains those pins even
when main advances. A different request under the same UUID is rejected with
`WORK_OPERATION_CHANGED`; a new release uses a new UUID.

```sh
nforge release OWNER --status UUID
nforge release OWNER --resume UUID
```

Status is a local read. It does not contact providers, deploy, or repeat commands.
The returned `complete`, `status`, `stage`, `head`, and stage attempts distinguish
success, known child failure, pending stages, and unknown outcomes. An incomplete
release exits nonzero. CLI installation is selected only after all previous stages
succeed. Per-stage IDs remain stable; each explicit retry of a failed stage gets
a new attempt ID and fresh output directory. Earlier successful stages are skipped.
Completed operations replay their retained receipt without selecting the CLI or restarting the owner again.
`installedHead` is the release's successful selection observation, not a current
probe of a wrapper somebody may have changed later. Remote provider versions are
observed only through the successful child exit; no independent live compatibility
probe or rollback of a previously deployed backend/web is claimed.

The local journal is under `OWNER/.forge/work/maintainer-releases/UUID`. Each child
writes its own terminal receipt before exiting; a caller lost after child
completion can recover that receipt. Child exit codes and signals are retained.
Output is private in each attempt's `child.log`; command results do not copy logs
or credential values to the terminal. These local driver files and runtime
installations are not portable canonical Work/recovery records.

## Interrupted and failed stages

A known failed local stage can be resumed directly. Its prior outputs remain in
place and the retry uses new paths. A surviving stage process is reported as
`RELEASE_RUNNING`; no second child is started. If both the child and its terminal
receipt are lost, the outcome remains unknown. A provider's nonzero child exit
also remains unknown: it may already have changed the provider before failing.
Neither status nor resume silently repeats an unknown deployment.

After inspecting the original provider operation and matching source/configuration,
record its observed result in a private JSON file:

```json
{
  "stage": "web",
  "attemptId": "22222222-2222-4222-8222-222222222222",
  "outcome": "succeeded",
  "evidence": "Provider observation identifies the original deployment and source"
}
```

```sh
nforge release OWNER --resume UUID --reconcile /private/release-observation.json
```

A succeeded backend/web observation skips that original stage; failed permits a
new attempt. This is an attributed operator observation, not independently
verified provider evidence. Local unknown attempts may be recorded as failed to
retry into fresh directories; local success needs the original child receipt
because later stages require its exact output paths. Keep the original UUID,
attempt ID, source and observation. No additional confirmation is part of the
successful release path.

## Select and verify the owner runtime

After CLI selection, the `owner` stage discovers the current user's launchd
`com.nanthai.forge-owner` service and checks that its `serve` owner matches this
release. A missing service (including platforms without this supervisor adapter)
is a successful skip with an explicit receipt note; it does not install a service.
The supervisor interface keeps discovery, restart and PID observation separate
from selection and retirement.

The service's configured CLI entry point must be inside `runtimeDirectory`.
Release atomically replaces that file or symlink with a symlink to the new
installation's exact `dist/cli.js`. Node resolves that entry point into the new
package, so imports and newly started workers use the new runtime. This also
works with an existing real `installed-owner` directory: no directory is moved,
removed or copied over. Previous entry-point bytes or link text, mode and digest
are retained as `previous-owner-cli` in the release directory; the rest of every
previous installation remains available.

The stage restarts through launchd and verifies its reported PID, kernel start
time, exact installed CLI path and authenticated local response. `serve` retains
private discovery in `OWNER/.forge/work/owner-runtime.json` (mode 0600), including
its existing local bearer token. If discovery cannot be retained, existing serve
APIs remain available and release reports an unverified owner. `/api/owner` uses the existing bearer/host/origin
checks and returns only owner, port and process identity. Tokens, environment
values, supervisor output and process arguments never enter release receipts.

The release-owned `owner-selection.json` retains the original service and process
identity before selection and restart. Resume first observes a requested restart;
a responding new process is adopted without another restart. A replacement
process that has not verified is preserved and reported as
`RELEASE_OWNER_UNVERIFIED`; resume can verify it later. An owner already answering
from the selected install needs no restart. Failed attempts share this plan, and
a dead stage child can resume it after a lost reply. Historical release receipts
created before this stage remain historical receipts.

After verification, release retires detached `local-watcher-worker.js`,
`auto-exchange.js`, `presence-worker.js` and `post-accept-main.js` processes, plus advisory,
GitHub push, integration preview and weekly metrics workers in previous runtime
installations. It matches the install path and kernel start
identity, rechecks both before each signal, and excludes the current install,
paths outside the runtime directory and all agent MCP `cli.js` processes. Each
worker gets SIGTERM, up to ten seconds to exit, then SIGKILL only if that same
process remains. The receipt records each PID, start time, script path, attempted signals
and observed exit. Resume can repeat an interrupted signal attempt after rechecking
identity; it never applies that attempt to a reused PID. Presence and main-audit workers use nonblocking Work-lock
admission so signal delivery cannot be trapped in a synchronous lock wait;
shutdown aborts their observers and has a one-second exit backstop.
Physical check controllers keep their pinned runtime until their checks finish;
release never signals them. Queued and checking landings survive owner replacement.
If a remote controller dies, startup adopts its original run and provider pins.

To undo owner selection, first check `selectionPath` still resolves to the
receipt's `executablePath`. Atomically restore `previousOwnerCli` as a file with
`previousOwnerMode`, or recreate its saved link text for
`previousOwnerKind: "symlink"`, then restart the same supervisor. This restores
the previous runtime without discarding either install. Retired advisory workers
are recreated by ordinary owner activity. Owner rollback does not roll back
backend/web deployments or the CLI wrapper.

## Restore the prior CLI selection

Before any stage runs, the journal saves the prior wrapper's exact bytes (or symlink target),
kind, mode and SHA-256 in `previous-cli`. Selection uses a temporary wrapper and atomic
rename, and detects an intervening wrapper change. A lost reply after rename is
reconciled by comparing the intended wrapper bytes. The installed package and
all previous package/installation directories remain available.

The result's `previousCli.path`, `previousCli.mode` and `previousCli.exists` give
the undo inputs. For `kind: "file"`, restore an existing previous wrapper by copying those saved bytes
to `cliPath` and restore its recorded mode. For `kind: "symlink"`, recreate the link using the target text
stored in `previous-cli`; the original target is never rewritten. If there was no previous wrapper,
remove only the wrapper this release selected. Check the current wrapper still
names this release's installation before undoing it, so later selections survive.
Restoring the wrapper does not roll back backend or web deployments.

## Validation boundary

Fixture tests fake exporters, builders, package installers and providers. They
exercise failed stages, actual child exits/signals, unknown replies, durable
receipt reconciliation, exact source resume, existing directories, package
integrity, previous CLI selection, fake supervised owner restarts, runtime verification,
crash/resume, identity-fenced worker retirement and both workers’ SIGTERM shutdown. Fixture success is not evidence that a live
development release, account login, provider reconciliation or cross-version
backend/client compatibility has been exercised.
