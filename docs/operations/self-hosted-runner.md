# Self-hosted check runner

A project can run checks on its own Linux host, VM, container or macOS machine
without GitHub. The provider is `self-hosted`, with a stable UUID `machineId`,
pinned `runtime` and `environmentFingerprint`, `platform: {os, arch}` using Node
names (for example `linux/x64` or `darwin/arm64`), and optional `labels: string[]`.
Labels describe the selected machine for project routing; this release selects
one exact machine per project, rather than choosing from a pool by label.
You pay nothing to Forge for runner compute; hardware, electricity, hosting and
backend/object-storage usage remain yours.

A self-hosted machine runner keeps logs in Forge, visible only to the project's
readers. Self-hosted GitHub Actions runners (`runsOn` labels on a `github-actions`
runner) still run in the runner repository, whose Actions logs are as visible as the
repository: a private project refuses a runner repository that is not private unless
its owner accepted public logs with `publicLogs:true` (`RUNNER_REPOSITORY_PUBLIC`, at connect, dispatch and each runner call; see
[security](../security.md#hosted-check-authorization)).

## Start on Linux or macOS

Use Node **24.22.1+ (24.x)** and a built Forge source package. Install dependencies
with `npm ci --ignore-scripts`, then `npm run build:core`. No fixed Node path,
GitHub account, launchd, systemd, Keychain, Xcode or macOS sandbox is needed.
The check's declared command and tools must be available on the runner's PATH, and `git` too when the project has submodules ([submodules in checks](github-actions-checks.md#submodules-in-checks)); the container image includes it.

Use the existing owner sign-in (`nforge login "$DEPLOYMENT_URL"`) or inject
`FORGE_AUTH_TOKEN` through your service's secret facility. No collector key file
is needed: registration authenticates the project owner, verifies the exact
configured machine/runtime/environment and returns this machine's own signing key,
derived on the backend from the deployment key (`FORGE_HOSTED_CHECK_KEY_<ID>`) for
this one project and machine. Nothing new is stored; the worker keeps the derived
key in memory only, and it is refused for any other project or machine. Output,
heartbeat and result calls must also come from the signed-in project owner who
registered the machine. The deployment key itself never leaves the backend. An
older deployment that does not issue machine keys still reads the legacy
`FORGE_HOSTED_CHECK_KEY_FILE` (owner-only mode 600) or `FORGE_HOSTED_CHECK_KEY_<ID>`.
Project children receive neither collector key nor account token.

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
command. Import by name (default `verify`) or `checkId` reads the retained command
fields from hosted Work, including compact indexed records, and preserves the
original definition digest. `configure-runner provider:"self-hosted"` derives runtime, platform and
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
  --env FORGE_AUTH_TOKEN \
  --mount type=volume,src=forge-runner-state,dst=/var/lib/forge-runner \
  forge-runner "$DEPLOYMENT_URL" "$PROJECT_ID" "$MACHINE_ID" '["linux","build"]'
```

The base image
contains Node/npm and core utilities. Add the tools your check requires in a
child image, then configure from that same image. The image runs Linux on Docker
Desktop for macOS too. Writable private temp/cache storage is required. Full
local logs default to the existing `forge-mac-check-logs` directory under the OS
temp directory; `FORGE_LOCAL_CHECK_LOG_DIR` can select a persistent private mount.
The historical directory name and seven-day local log behavior are unchanged.
A container is an execution environment, not an additional Forge sandbox.

## Toolchains and caches in checks

Checks run with a private HOME, so tools that keep state under HOME would start
cold or fail. The runner sets these per run, for every repository:

- Dedicated, credential-free content caches next to the npm cache
  (`~/.cache/nanthai-forge/check-*/<project>`, created on demand, outside the private
  HOME): `GOMODCACHE`, `GOCACHE`, `PIP_CACHE_DIR`, `UV_CACHE_DIR`, `NUGET_PACKAGES`, and
  `MAVEN_ARGS=-Dmaven.repo.local=…` (omitted if that path has whitespace). Each project
  has its own directory, so no check sees another project's cached content. They are
  separate from your own caches, so your Cargo, Gradle or pip credentials and settings
  are not read.
- `CARGO_HOME` and `GRADLE_USER_HOME` also read executable configuration (Cargo's
  `config.toml`, Gradle's `init.d` and `gradle.properties`), so they point at a fresh
  directory inside the run. Only the downloaded content (`registry` and `git` for Cargo,
  `caches` and `wrapper` for Gradle) is linked in from the project's directory under
  `check-cargo-home` / `check-gradle-home`; configuration a check writes dies with the run.
- Installed toolchain homes, passed only when they exist at the default location:
  `RUSTUP_HOME` (`~/.rustup`), `PYENV_ROOT` (`~/.pyenv`), `MISE_DATA_DIR`
  (`~/.local/share/mise`), `ASDF_DATA_DIR` (`~/.asdf`). Nothing is created for a
  missing one. A toolchain at another location is passed by declaring its variable
  in the check's `env`, which also overrides the default.

These are transient run settings, so the recorded environment and its fingerprint are
unchanged. To reclaim disk, delete `~/.cache/nanthai-forge/check-*-*`; the next check
repopulates them. The first check of a project after this layout starts with empty caches.

The runner places a Candidate's files directories first, then files, then links, and
refuses a State whose paths would share one name on its volume (names that differ only
by case or Unicode form on APFS), so nothing is written through a link.

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


## Optional Actions cache preparation

When this machine is used through the GitHub Actions workflow (runner labels in
`configure-runner`), the hosted check definition can declare `actions.setup`.
The fixed Actions supervisor runs that command in `FORGE_SOURCE_CACHE_DIR`, before
the tests, to warm an existing sticky disk or cache. Keep that directory outside
Candidate source and use a command already installed on the runner. Setup receives
no Actions/OIDC credentials; its stdout cannot supply test reports and a cache
failure continues cold. Candidate paths, bytes, modes and the execution plan are
verified afterwards; a setup command that changes source fails the exact check.
The native `self-hosted`/legacy `mac` provider does not execute Actions-specific
setup. See [the Actions setup contract](github-actions-checks.md#warm-hosted-actions-jobs-and-optional-setup)
for the definition example, shard budget and cold/warm measurement procedure.
Declared `actionsToolchains` and `actionsCache` add pinned workflow steps on any
Actions runner, including this one ([toolchains and dependency cache](github-actions-checks.md#toolchains-and-dependency-cache)).
