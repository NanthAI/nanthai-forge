# Self-hosted check runner

A project can run checks on its own Linux host, VM, container or macOS machine
without GitHub. The provider is `self-hosted`, with a stable UUID `machineId`,
pinned `runtime` and `environmentFingerprint`, `platform: {os, arch}` using Node
names (for example `linux/x64` or `darwin/arm64`), and optional `labels: string[]`.
Labels describe the selected machine for project routing; this release selects
one exact machine per project, rather than choosing from a pool by label.
You pay nothing to Forge for runner compute; hardware, electricity, hosting and
backend/object-storage usage remain yours.

## Start on Linux or macOS

Use Node **24.22.1+ (24.x)** and a built Forge source package. Install dependencies
with `npm ci --ignore-scripts`, then `npm run build:core`. No fixed Node path,
GitHub account, launchd, systemd, Keychain, Xcode or macOS sandbox is needed.
The check's declared command and tools must be available on the runner's PATH.

Use the existing owner sign-in (`nforge login "$DEPLOYMENT_URL"`) or inject
`FORGE_AUTH_TOKEN` through your service's secret facility. Provision the existing
collector signing credential: the deployment has `FORGE_HOSTED_CHECK_KEY_ID` and
`FORGE_HOSTED_CHECK_KEY_<ID>`, and the worker receives the same key in an owner-only
mode-600 file named by `FORGE_HOSTED_CHECK_KEY_FILE`. The environment alternative
`FORGE_HOSTED_CHECK_KEY_<ID>` remains supported. Never put key contents in arguments,
source, an image or service definition. Registration authenticates the project
owner and verifies the exact configured machine/runtime/environment; it does not
mint or display a credential. Project children receive neither collector key nor
account token.

Choose a stable machine UUID (for example `node -p 'crypto.randomUUID()'`) and
supply it on restarts. From the built package, this single command configures the
runner using the existing configure-runner flow, registers it and waits for work:

```sh
node scripts/self-hosted-runner/start.mjs "$DEPLOYMENT_URL" "$PROJECT_ID" "$MACHINE_ID" '["build"]'
```

Configuration and execution run in the same environment. Set
`FORGE_RUNNER_STATE_DIR` to a private writable directory to keep the setup journal
elsewhere. To register an already configured runner without changing settings
(including an existing `mac` runner), use:

```sh
nforge worker "$DEPLOYMENT_URL" "$PROJECT_ID" "$MACHINE_ID"
```

Configure the check definition separately through the existing `configure-check`
command. `configure-runner provider:"self-hosted"` derives runtime, platform and
clean-environment pins locally; optional `labels` and `machineId` select this
machine. The legacy `provider:"mac"` spelling also writes `self-hosted`.
`check-settings` reports, for example:
`runner: self-hosted (linux/x64, your machine; you pay nothing to Forge)`.

## Container

Build from the repository root. The recipe pins Node 24.22.1, copies only named
source/build inputs, uses a non-root `node` user and contains no credentials:

```sh
docker build -f scripts/self-hosted-runner/Dockerfile -t forge-runner .
docker run --rm --init --name forge-runner \
  --env FORGE_AUTH_TOKEN --env FORGE_HOSTED_CHECK_KEY_FILE=/run/secrets/collector \
  --mount type=bind,src="$COLLECTOR_KEY_FILE",dst=/run/secrets/collector,readonly \
  --mount type=volume,src=forge-runner-state,dst=/var/lib/forge-runner \
  forge-runner "$DEPLOYMENT_URL" "$PROJECT_ID" "$MACHINE_ID" '["linux","build"]'
```

The mounted key must be readable by container UID 1000 and retain mode 600;
provision that file without embedding its bytes in the image. The base image
contains Node/npm and core utilities. Add the tools your check requires in a
child image, then configure from that same image. The image runs Linux on Docker
Desktop for macOS too. Writable private temp/cache storage is required. Full
local logs default to the existing `forge-mac-check-logs` directory under the OS
temp directory; `FORGE_LOCAL_CHECK_LOG_DIR` can select a persistent private mount.
The historical directory name and seven-day local log behavior are unchanged.
A container is an execution environment, not an additional Forge sandbox.

## Health, idle and stop

Startup reports `Self-hosted runner registered: ...`; registration failure exits
nonzero. Check local stderr and use the existing read-only `check-settings` command
for the configured machine and blockers. Submit a synthetic check to test active
health and inspect its exact run status. There is no periodic health write or
poller: after registration and the initial empty work subscription, an unchanged
idle worker performs **0 additional Convex function calls**, reads or writes.
Subscription reconnects or queue/configuration changes can cause fresh reads.

Use Ctrl+C, send SIGTERM to this worker, or `docker stop forge-runner`. Shutdown
unsubscribes and kills its active command process group on Linux/macOS. Active
leases renew every 20 seconds and expire after 60 seconds; existing watchdogs
fence/requeue lost ownership once. Stopping idle creates no work. Restore previous
runner settings with `configure-runner configuration:{...}` if undoing setup.

## Compatibility and deploy order

1. Deploy the additive server/schema readers first: accept both provider names
   everywhere, retain the existing machine credential, lease and evidence protocol.
   No database backfill is needed; settings/run payloads are already JSON strings.
2. Install the new worker/CLI package. A new worker reads the current configuration
   and registers its exact bytes, so existing `mac` configurations continue to work
   without digest changes. Do not change configuration while an old worker is
   executing a pinned run; let it settle with the old configuration.
3. On the replacement worker, run the setup command above (or configure-runner),
   then start execution. New writes include platform and use `self-hosted`.

Old workers continue to handle old `mac` configurations on the new server. A
`self-hosted` configuration requires the new worker; configure it after that
worker is installed. A new CLI cannot write `self-hosted` to an old server: the
old server explicitly rejects the unsupported provider. There is no silent
fallback, re-pin or provider rewrite. Platform/labels are optional in the reader
for additive rollout; new writers always record platform. Legacy `mac` means
Darwin with unrecorded architecture. Historic digests, the runtime pin, signature
domains, `macEvidence` receipt field/tag and structured error codes remain intact.
The same owner/revocation and exact-Candidate acceptance checks apply on Linux.
Windows is unqualified: execution has an existing Windows child-kill branch,
but private Unix modes, symlink privileges and descendant cleanup need a real
Windows qualification before claiming parity. No new platform block is applied.
