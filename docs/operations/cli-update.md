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

When main moves, no command waits for the install or its canary. A command runs on
the complete, vetted current build, prints one stderr line (`Forge CLI main HEAD is
installing; this read|write ran on OLD`), and starts one detached `nforge update
--background` unless an updater is already live. That updater installs main beside the
running build, runs the pre-switch canary and switches; the next command runs on main.
The background updater takes the update lock before its single release read, so extra
starts cost nothing, and one that gets the lock just after another refused the same head
does not repeat the canary. Its output goes to `DIR/update.log`. Each command makes one
release read; running on the current build adds none (Issue 2a0557b6).

- Reads (agent `status`, `planning`, `show`, `diff`, `peers`, `lanes`, `observe`,
  `landing`, `wait`, `preflight`, `decisions`, `queue`, `doctor`, and top-level
  `status`, `wait`, `docs`, `heavy`) always behave as above. After a failed background
  install, reads stop starting new ones for 10 minutes (`DIR/update-failed.json`);
  the next write retries and reports the failure.
- Writes (everything else) behave as above too, except in three cases where they install
  in the foreground first: the last background install failed (`DIR/update-failed.json`
  is under 10 minutes old), no build is selected yet (first install), or an explicit
  historical rollback is being restored. So a broken update never leaves writes
  silently on old code. The foreground write installs that exact State, or joins an
  install already running, and then re-runs the same command in the new build. The
  caller gets one result and never runs `nforge update` by hand. A write that waited
  does not read the release again; the re-run child does not read it either when its
  parent just verified that build.

The update is cheap and invisible:
stdout holds only the command's result; the one progress line, the selected/revert
line and any step failure output go to stderr; successful build and smoke output is
discarded and no help text is printed. The build is not a heavy-slot job, so it never
queues behind test batches (about 4 s warm; one updater per installation through
`update-lock`). The runtime lock is held only for milliseconds: selection, hook
migration and the final retirement fence. Process inspection and deletion of old
builds run outside it. Commands wait up to 30 s for that lock; only the foreground
cases above and an explicit `nforge update` wait (up to 10 min) for a live updater; a dead updater is reclaimed at once and its unselected stage is
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
the updater dependencies; the canary below) runs between the
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

## Signed releases

Landing on main decides what main is; a release signature decides what the updater installs.
Released States are signed with an Ed25519 key created outside Forge. A private key is never
stored in Convex, this repository or environment files; the automated signer (below) holds one as
a GitHub environment secret. The public keys live in `src/cli-release-keys.ts`
(`CLI_RELEASE_KEYS`), which the CLI and the Convex store share. The updater checks a new release with the keys
of the build that is already installed, never with keys from the build it is about to install.

The owner's manual steps (only public material is printed):

```sh
nforge cli release-key --out KEY_FILE                  # once per key; mode 0600, never overwritten
nforge cli release-sign --key KEY_FILE [--state STATE --release N] # default: current main
```

`release-sign` signs the statement `forge-cli-release/v2`, project id, State hash and release
number, and stores the 64-byte signature with its number (`projectReleaseSignatures`,
insert-only, at most 4 per State). The owner may store a signature while signed in; anyone else
only without a sign-in and only a v2 signature that the server verifies against
`CLI_RELEASE_KEYS` for exactly that project, State and release number. Anything else is refused
before any database read, so a wrong signature costs one refused call and writes nothing. The release number defaults to main's source
revision, which grows with every accepted State; `--state` needs an explicit `--release`. The
store refuses a number that is not above every other State's, or that differs from the number
the State already has. The store is untrusted: a row can make a signature present, never valid.

When main moves, the updater makes one small signature read for that State, after the release
read and before any download, dependency install or build. Nothing is read when main has not
moved, and idle costs nothing. The verdict is written to `DIR/release-signature.json`.

- A signature from a listed key that verifies: the update continues (canary, two-step switch).
- A listed key's signature that does not verify: the State is refused like a canary failure. The
  current build keeps serving every call, one alert goes out, and the canary back-off applies.
- A valid signature whose release number is below the highest one installed on this machine
  (`DIR/release-number.json`), or the same number on another State: refused the same way, as a
  downgrade (an earlier signed State put back on main). Only `--state` installs it.
- No signature from a listed key (none yet, unknown keys only, or the read failed): while
  `CLI_RELEASE_SIGNATURES_REQUIRED` is `false` (the transition) the update continues as before.
  Once it is `true`, the updater holds on the current build without an alert and looks again
  after `CLI_RELEASE_SIGNATURE_RETRY_MS` (1 minute) until the signature appears or main moves.
- An explicit `nforge update --state STATE` selection skips the check and leaves the recorded
  release number as it is; it is the owner's own rollback and recovery path.

Migration from v1 signatures (no release number, made before numbers): while signing is optional
they verify as before and set no release number, so nothing is compared. Once
`CLI_RELEASE_SIGNATURES_REQUIRED` is `true`, a v1 signature counts as missing (held), because it
cannot be checked for a downgrade. Builds from before release numbers cannot read numbered rows
and treat them as unsigned, which installs during the transition. A machine records its first
release number at the first numbered release its own (new) updater installs.

The first release key is listed (key id `f3b8ac47a969d73d`). Signing is still optional:
`CLI_RELEASE_SIGNATURES_REQUIRED` stays `false` until the first signed release is installed.

### Automated signer

`.github/workflows/release-sign.yml` signs main on every push of the GitHub mirror (and on
`workflow_dispatch`), so no one signs by hand. It runs one job on a GitHub-hosted runner in the
`release-sign` environment, which deploys from `main` only and holds the key as the secret
`FORGE_RELEASE_SIGNING_KEY`. The job has `contents: read`, pins every action by SHA, and runs
`scripts/release-sign-ci.mjs` with plain Node from a sparse checkout (no install, no build):

1. Skip when a newer main commit has passed this one (GitHub compare, no Convex call). The
   workflow's concurrency group keeps one run going and one queued, and a newer push replaces the
   queued run, so a mirror backlog drain signs only the newest head.
2. Read the commit's `Forge-State` trailer (none: nothing to sign).
3. One Convex read, `projectReleaseSignatures:signerMain`, without a sign-in: the job signs a
   short read proof (`forge-cli-release-read/v1`, project, State, time within 5 minutes) with
   the release key, and the server answers only if a listed key made it. It returns main's head,
   its release number (the source revision) and whether this State already has a v2 signature
   from this key. A State that is no longer main's newest, or is already signed, is skipped.
4. Sign `forge-cli-release/v2` with that number and store it with `projectReleaseSignatures:put`.

Cost: two Convex calls per signing (one when skipped at step 3, none at step 1), one job of about
30 s on a free public runner, nothing when main does not move. The key reaches only the signing
step, as an environment value the script removes before it starts any child process; it stays in
memory and is never printed or written to disk. The read proof and the store refuse wrong
signatures before any database read.

The trade-off: CI holds a release key, so anyone who can run code in the `release-sign`
environment can sign. That is limited to workflow runs on `main`, so keep `main` writable only by the Forge
mirror. The store is still untrusted: the updater verifies every signature
with its installed keys and refuses lower release numbers. If the key is exposed, rotate it as
below and replace the secret.

One-time setup (repository admin; replace `OWNER/REPO`, the URL and the project id):

```sh
gh api -X PUT repos/OWNER/REPO/environments/release-sign --input - <<'JSON'
{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}
JSON
gh api -X POST repos/OWNER/REPO/environments/release-sign/deployment-branch-policies -f name=main -f type=branch
gh secret set FORGE_RELEASE_SIGNING_KEY --env release-sign --repo OWNER/REPO < KEY_FILE
gh variable set FORGE_RELEASE_URL --repo OWNER/REPO --body https://DEPLOYMENT.convex.cloud
gh variable set FORGE_RELEASE_PROJECT --repo OWNER/REPO --body PROJECT_ID
```

The URL and project id are the ones the CLI release source uses (`source.json` in the CLI
installation). The job stays off (skipped, no runner) until
`FORGE_RELEASE_PROJECT` is set. `gh secret set` reads the key from the file without printing it.

Turning the switch on: after the first signed release, confirm `release-signature.json` says
`verified` with a `release` number on every machine, then land `CLI_RELEASE_SIGNATURES_REQUIRED = true` and sign that
landing too. A test refuses `true` with an empty key list.

Rotation: land the new public key in a release signed with an old key, sign with every listed key
until each machine runs that build, then remove the old key in a release signed with the new key.
If a key is lost or exposed, remove it in a release signed with a remaining key; with none left,
each machine recovers once with `nforge update --directory DIR --state STATE` of a release that
lists the new key.

## Canary and rollback

A broken build must never strand every agent at once, so each auto-update
smoke-tests the new build before the switch. The canary runs in `preSwitch`: the build
is installed but not active, and every caller keeps using `current`. Auto-updates run it only
in the detached updater, so no command waits on it. It runs the new build's own entry with
a 20 s cap per step and 60 s for all its steps together: `--version`, `status ROOT --json`
on a Forge clone, a `planning` read, and a `wait` on a landed operation.
Each step needs exit 0 and a JSON document (agent receipts must name the build under test).
The clone is the one `nforge update ROOT` or the first update-starting command named
(`DIR/canary-clone.json`); with none recorded, only the version step runs and the log says
so. The wait uses only landing operations, whose wait is a pure read: the last vetted one, then
the newest this machine saw land (`wait` records each landed operation in
`$XDG_STATE_HOME/forge/landed-operations.json`, five per project, one local write per landing).
A planning put's operation id is never used. The wait is one non-blocking status read
(`timeoutSeconds:0`): an operation still running
(`IN_PROGRESS`) is skipped, and so is a wait that says `NOT_FOUND`,
`WORK_OPERATION_CHANGED` or `OPERATION_EXPIRED`; each skip is a log line and drops the
operation. With none recorded the log says the wait was skipped. A wait that times out goes
through the differential rule below like any other failed step.

The canary is differential: only when a step fails on the new build, the same step runs on the
current build (pinned with `FORGE_CLI_CANARY` to its own commit, so it makes no freshness read
and starts no update; its own 20 s cap), timed. The switch is refused only when the current build
passes that step, and the log names both results (`...; the current build HEAD passes the same
step`). A step both builds fail, including one both time out on, is not a regression: the pass
line lists it as skipped with both results, so a server-side, data or load problem never
strands the fleet on an old build.

A busy host slows both builds alike (Issue 2a0557b6: two good builds were refused within 20
minutes because the hosted wait was slow while about 15 builders ran checks). So a step that
only **timed out** on the new build, while the current build then passes it, gets one retry on
the new build with its own 20 s cap: at most one retry of one step per canary run. The retry
is judged against the current build's time from the same run. It passes unless it fails,
times out again, or is clearly slower: more than 3 times and more than 5 s slower than the
current build (`cliCanaryClearlySlower`). The pass line marks a retried step (`wait 430ms (on
its one retry after a slow first run; current build 380ms)`); a refusal names both timings. A
step that fails outright (non-zero exit, bad JSON, error document) gets no retry.

The canary adds no hosted call to a normal call: its children skip the freshness read
(`FORGE_CLI_CANARY=HEAD`, honored only by that exact build), and its own reads (status,
a 50-item planning page of about 40 KB, one or two waits; a failed step once more on the
current build; at most one retried step) happen once per attempted build. It never writes
hooks and never writes hosted state: children run with a private `HOME` that is deleted
afterwards, so the real `~/.claude` and `~/.codex` are unreachable by construction; credentials
and caches come from the real XDG directories. One log line reports a pass with per-step
timings.

On a failure the current build does not share (non-zero exit, timeout, bad JSON) the switch is refused, the previous
build keeps serving every call, and the reason goes to `DIR/canary-refused.json`. The
refused build is not retried in a loop: the same head waits 10 min, then 20, 40, ... up to
6 h; a new main is tried at once; a waiter never repeats a canary that just failed. One exception
(Issue 3205f7e6): when the new build fails a step the current build passes with a version-skew
code (`HOSTED_PROTOCOL_INVALID`, `HOSTED_ACTION_UNSUPPORTED`, `CLI_UPGRADE_REQUIRED`), the
server deploy of that State is probably still running. The canary then **holds** without an
alert and retries every minute for 15 minutes from the first such failure; only skew that
outlasts the window becomes a refusal with the back-off and alert. A failed canary does not
set the background updater's 10-minute failure mark, so reads also retry on the minute. While a
refusal is active, reads and writes both run on the working build. The full notice (reason,
next retry, `DIR/canary-refused.json`, `nforge cli rollback`) prints once per refused head on
the installation: the first command claims it with an exclusive marker file
(`DIR/canary-noticed-HEAD`), so concurrent commands cannot print it twice. Every later command
prints one short line, `Forge CLI main HEAD was refused by its pre-switch canary; running on
OLD.` The full reason stays in `DIR/canary-refused.json` and the updater's `DIR/update.log`. The alert goes out
once per head: that notice plus one ntfy/Cloudflare message through the existing stall-alert
transport, using `FORGE_ALERT_WEBHOOK_URL` or a private `$XDG_CONFIG_HOME/forge/alert-webhook-url`
file. The message names the step and exit class only (no URLs, tokens, paths or child output).

### Server contract (CLI ahead of the deploy)

The CLI switches as soon as main moves; the server of the same State deploys later (minutes on
the dev mirror, possibly much later for a self-hoster with any CI). So a build never assumes
server behaviour its server has not advertised. The capability read every hosted command
already makes names the contract features of `src/hosted-contract-features.ts`
(`features:[...]`); the server answers with the subset its code implements. A server that
predates the list rejects the argument, the CLI drops just that field and retries once, and
it advertises nothing. For each feature not advertised the CLI keeps the old safe behaviour:
without `planning-put-keeps-omitted`, a put sends the stored kind, title, body, status, links
and group (one extra planning-item read for a hand-written put; none for start and
reconcile, which already hold the item). A feature listed in `hostedRequiredFeatures` has no
fallback: while the server lacks it, every hosted reply carries `serverContract.missing`, and
the canary **holds** the switch (`step: server-capabilities`, the same back-off, no alert,
log line `Forge CLI canary held HEAD: the server does not yet advertise ...; next retry after
HH:MM UTC`). The next attempt after the deploy switches. Add a feature name in the same change
that implements the behaviour on the server; never rename or reuse one.

### Server replies (CLI behind the deploy)

The other direction: a published or not-yet-updated CLI talks to a newer server (Issue
3205f7e6; on 2026-11-06 an added `agentDefaults.autoClaim` broke planning and wait on the
installed CLI for 9 minutes). One rule: **a server may add reply fields; it never removes,
retypes, makes optional or adds enum values to a field without a contract feature.**

- CLI side: every hosted reply is parsed with `parseHostedResponse` (src/hosted-response.ts).
  It drops object keys this CLI does not know, at any depth, and still rejects a missing
  required field, a wrong type or an unknown enum value (`HOSTED_PROTOCOL_INVALID`). Response
  schemas stay `.strict()` so tests catch typos; request schemas never use the helper.
- Server side: a change that alters meaning (not just adds) answers the old shape unless the
  client advertised the matching feature of `src/hosted-contract-features.ts`. Example: the
  capability reply's `agentDefaults` keeps the frozen keys of `WIRE_AGENT_DEFAULT_KEYS`; newer
  keys go only to a CLI that asks for `agent-defaults-extended` (State fe3b6292).
- New CLI, older server: a reply field the CLI adds must be optional or take a `.default()`
  (the server it talks to may not have deployed yet), or sit behind a feature.
- Guard: `tests/hosted-response-contract.test.mjs` (part of the landing check's full run)
  compares the Candidate's reply schemas with `scripts/response-compat/released.json`, the
  released CLI's contract, and parses the Candidate server's capability reply with that
  released contract. A failure names the field; declare a feature-gated change in
  `scripts/response-compat/declared.json` with the printed `path` and `change`. Refresh the
  baseline at release with `npm run build:core && npm run response:snapshot`.

CLIs built before this rule parse replies strictly, so any added field still breaks them;
they recover when the updater installs a current build.

Exactly one previous build is kept, the exception to pruning (the one-CLI rule otherwise
stands; older builds retire as before). `nforge cli rollback [--directory DIR]` switches
`current` (and `manager`) to it with one atomic rename, makes the build it left the new
previous, and holds the left head off until main moves; run it again to switch back. It
makes no network call and no release read, takes the update lock, refuses under a
measurement hold, and migrates hooks as an update does. An explicit `nforge update`
installs main even while it is held.
