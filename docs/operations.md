# Operations

## Backup and recovery

An export holds the full retained source States, Work and every available recorded run file.

```sh
nforge work ROOT                                                    # shows the current revision
nforge work ROOT '{"action":"export-work","archive":true}' REVISION # folder plus .tar.gz
nforge restore-native BACKUP.tar.gz NEW_DIR                         # native owners
nforge restore-work BACKUP.tar.gz NEW_DIR                           # Git-backed owners
```

Copy the whole export outside the project. It holds private history and logs, so treat it as private. Restore always writes to a new, unused directory. It validates every file against the manifest and recreates Lanes and Candidates. Unfinished commands are marked interrupted and never restart. The original owner is untouched, so keep it until you have checked the copy.

Not included: uncheckpointed edits, ignored credentials, dependency caches and disposable workspaces. Checkpoint what you want first. To move between machines, restore on the target.

A release export (source only, empty Work) is much narrower and is not a backup of Work.

An older CLI refuses an owner it cannot preserve. Upgrade by installing the new package in a separate directory and pointing it at a backed-up owner. To roll back, restore the backup with the old tools. Never let an older writer rewrite an upgraded owner.

### Hosted backups and return

`nforge recover NEW_DIRECTORY --command-file recovery.json` discovers the
project's current source authority before selecting recovery. Being bound is not
itself a cutover. In `native-owner` mode, including a rollback at a higher epoch,
the command retains full owner recovery/reconnect and local acceptance. The
existing native archive/object, saved-Lane, journal and evidence behavior stays
available; requests accept `{operationId,url,projectId,archivePath?,cacheRoot?}`.
`recover OWNER reconnect` and `recover OLD_OWNER client` remain native-mode
commands. Shadow mode also retains native recovery and its existing authority
rules.

Only server authority, or a local pending switch to server, selects the new
runner/cache behavior. The gate is
`sourceAuthority(binding).mode === 'server' || state.authorityTransition?.mode === 'server'`.
Fresh-machine recovery obtains the binding authority from its authenticated
hosted selection. A native reconnect is not admitted while the local switch to
server is pending. Server recovery takes `{operationId,url,projectId}` without
credentials, reads selected main through hosted APIs, folds exact records and
receipts, and registers the existing configured Mac runner. It creates no native
owner marker, accepting Work store or owner binding. Its only hosted mutation is
normal idempotent runner registration; no commands restart.

The B1.5a1 fold pins hosted main's head, receipt, snapshot and revision alongside
the seed checkpoint. It reads record versions/bodies/heads, operations, source
registrations, finish/landing queues and observations, H14 acceptance snapshot
deltas and completion pages, lifecycle overlays, check outcomes and stale
source-return supersessions. Project-indexed pages use at most 64 rows and a
128 KiB provider read window (an existing oversized document remains readable).
A second pass compares exact row hashes. This is a verified paged export, not a
database-wide transactional snapshot. Every page rechecks current owner access
and pins; observed changes preserve staging and return `WORK_STALE`.

Canonical document strings and their referenced source/object closure remain in
immutable content-addressed pages. The runner cache roots them in its recovery
marker without constructing native Work. The independent archive/fold machinery
also retains this overlay at `Work.hostedRecovery`; existing `export-work` and
native restore preserve it for backup and an explicitly qualified rollback.
`hostedRecoveryRows` streams the retained table documents. H14 lineage and ordered
completion roots are validated without applying pending completions or replaying
acceptance. Large opaque source blobs stream to disk and final cache validation
hashes them from disk, with visited identities in disposable disk scratch.

### Route B: recover a runner and cache from hosted

This section applies to server authority. Bound projects that remain
`native-owner` use the native recovery path above, including after rollback.

On a clean machine, install the compatible Forge package and sign in with the
existing owner account. Restore the existing runner configuration and private
collector credential references through the normal worker setup. Recovery never
changes project runner settings. Write `{operationId,url,projectId}` to
`recovery.json`, using one UUID for all retries, then run:

```sh
nforge recover "$NEW_CACHE" --command-file recovery.json > recovery-result.json
# The result names configuration.machineId. Start execution separately:
nforge worker "$DEPLOYMENT_URL" "$PROJECT_ID" "$MACHINE_ID"
```

The recovered directory contains selected main source, `.forge/hosted-main.json`
and `.forge/recovery-runner.json`. Immutable hosted recovery pages retain the
original queue outcomes, pending completion cursors, source-return supersessions
and acceptance/snapshot receipt identities; they are cache data, never a local
acceptance ledger. Saved Lane source remains hosted and can be opened through
the ordinary hosted agent commands. No native `accept`, owner listener, exchange
push or reconnect step is part of Route B. Acceptance continues through hosted
CAS. An explicit higher-epoch rollback is the separate procedure below.

Retry the original request and destination after interruption, including a lost
registration reply. Current access is checked again before cached results are
returned. Completed retries preserve subsequent local edits; changed recovery
pins before capture completes retain staging and report `WORK_STALE`. Keep the
private staging path from the result until recovery is checked. Existing
unrelated destinations remain untouched.

The credential-free synthetic drill is `node tests/recovery-runner-drill.mjs`
after `npm run build:core`. It starts with a clean destination, recovers work
accepted only in fake hosted tables, runs the check selected by an actual hosted
landing request through the hosted Mac executor, and verifies the recovered cache has no native acceptance
path. Step times below are local fixture observations, not production RTO/RPO.
One local synthetic run measured the following steps (milliseconds). Fixture
creation was 8,526 ms; end-to-end recovery was 7,387 ms. The per-phase readings
omit small journal/orchestration gaps and are not additive RTO estimates.

| Step | Measured ms |
| --- | ---: |
| Select hosted pins and configured runner | 2 |
| Checkout selected hosted main | 621 |
| Fold hosted tables and source closure | 5,914 |
| Revalidate receipts and cached objects | 487 |
| Register runner | 2 |
| Publish cache | 20 |
| Prove native Work construction cannot accept | 13 |
| Enqueue deliberate hosted landing and its check | 8 |
| Execute check and deliver its hosted result | 322 |

The fixture retained two landing requests (one accepted, one pending), one exact
acceptance/completion receipt and hosted-only source. Dropped accepted receipts:
0; pending landing/completion rows missing after recovery: 0. For server authority,
the previous Route B restored a native owner; the new path produces no native
owner marker or accepting Work store. Native-owner recovery and local acceptance
remain available. No live before/after dropped-landing rate is claimed.

The pending landing and partial completion receipts are compared byte for byte;
metric 5.3's live dropped-landings count remains unmeasured by this fixture.

See the [recovery drill](operations/recovery-drill.md) for Route A's weekly
Convex ZIP restore, configuration inputs and reporting. A native portable archive
remains an independent backup and input to an explicitly qualified rollback;
it remains available for native-owner recovery and rollback, and does not grant
local acceptance for server authority.

For whole-deployment Convex snapshots, fresh-target restore and offline/live
comparison tooling, see [hosted deployment durability](operations/hosted-durability.md).
This complements project archives; the live restore drill remains unverified.

Hosted projects store the same archives. Use "Store private backup" in the browser, or `nforge exchange` for incremental pushes. To work on hosted Intents locally, download the pinned archive and the current journal together, then run `nforge restore-native ARCHIVE NEW_DIR --journal HOSTED_WORK.json`. Return a new checkpoint with "Return checkpoint to hosted Forge". If another edit landed first, nothing is overwritten. Both versions stay, so download the current Work and reconcile first. A lost reply is resolved with "Reconcile original source return".

### Hosted Intent migration

Owners can preview and run the existing operation-pinned hosted migration through
`hosted-work`. Use a CLI built with these commands and a backend providing
`projectIntentMigrationActions:preview` and `projectIntentMigration:progress`.
Authenticate with `nforge login DEPLOYMENT_URL` or the existing `FORGE_AUTH_TOKEN`
environment override. For a locally bound owner:

```sh
nforge hosted-work ROOT '{"action":"migrate-intents","operationId":"ORIGINAL_UUID","dryRun":true}'
nforge hosted-work ROOT '{"action":"migrate-intents","operationId":"ORIGINAL_UUID"}'
```

Replace `ORIGINAL_UUID` with one UUID and retain it for every retry. The same JSON
also works with `nforge hosted-work DEPLOYMENT_URL PROJECT_ID JSON` or
`--command-file FILE`. This migrates hosted Work only; local `migrate-intents`
is a separate operation.

Dry run replays the current checkpoint and journal, applies the same converter
and validates the result without staging batches, publishing a generation or
changing source. It reports the observed revision, `alreadyUnified`, and
before/after counts with `foldedPairs`. On an already unified snapshot, counts
show current Intents, Initiatives and aliases and zero new folds.

During migration, stderr identifies the operation UUID, revision, generation
and staged-batch count as they change; stdout holds the final JSON result.
After interruption, timeout or an unknown reply, rerun the original request with
the same UUID. The server resumes retained batches, reconstructs at a newer
revision when a concurrent journal append wins, and publishes only after its
existing source/revision checks. A completed migration returns its retained
generation even after later source selections; a new operation does not migrate
it again. A progress-read failure reports unavailable progress while the
original action result remains authoritative. No automatic retry chooses a new
operation or claims success. Previous generations, source backups and journal
bytes remain retained by the existing migration.

### Hosting progress and recovery

`nforge host ROOT --json --wait` emits progress and result JSON lines; ordinary progress uses stderr.
`nforge host ROOT --status` reads the local binding and last saved progress without making network
calls. During native backfill it reports `historyBackfilling: true`, the last phase/counts/rate/ETA,
an observation timestamp and any recorded interruption code. The hosted backup also carries
`historyBackfilling` until complete-manifest validation succeeds. Its full manifest is pinned from
the start; incomplete history is never described as a complete recovery copy.

A detached backfill inherits the current process environment and existing saved authentication.
It executes only Forge's transfer code, never repository scripts. If the machine stops, the
connection fails or login expires, retain the entire local Work directory (including
`hosted-binding.json` and `exchange-UUID`). Reauthenticate to the original account if necessary,
then rerun `nforge host ROOT --wait`. Existing missing-content negotiation and nonce reconciliation
reuse completed uploads after unknown replies. No retained source or history is deleted. A completed
backfill changes its completion marker only; a concurrent source push or hosted note stays intact.

Hosting uses pages of at most 100 pins, up to four byte-bounded source pages, 16 POSTs per active
upload window, and a 16 MiB window budget per uploader. Hosting prepares its negotiated missing
pins directly, avoiding redundant discovery calls; ordinary concurrent exchanges retain fresh-first
discovery. Server metadata/ancestry reads batch up to
100 pins/2 MiB, reuse the action-local verified-byte reader and recheck current authority. Large
objects retain the existing ranged/chunked path. Publication validates selected pins in batches. First-host completion instead scans the
new project's content index once in 100-row pages and checks the full required set, so it does not
repeat thousands of individual indexed lookups. These are internal scheduling bounds, not retained-data limits.

Offline qualification: `npm run build:core`, then `node scripts/measure-host.mjs`. It generates
3,000 file blobs (~220 MB), 500 linked native States and 2,100 Work records, exercises the actual
host/exchange/backend handlers with fixture storage, and reports phase times and RPC counts.
`HOST_BENCH_RTT_MS` selects simulated RPC/storage latency (default 20 ms). An optional
`HOST_BENCH_FIXTURE` directory caches a generated synthetic owner for repeated comparisons; each run
uses a fresh independent copy. Setup is excluded from
hosting elapsed time. This measures a synthetic local transport, not deployed Convex throughput.

At 80 ms simulated RTT, the same cached 3,501-object owner (220.4 MB of native objects;
2,100 Work records) took **211.9 s before / 28.6 s after (7.4×)**. Both runs uploaded exactly
3,748 physical objects / 221,729,371 bytes, including 1.31 MB of metadata trees. Current source
and Work were usable at 12.6 s. The final run spent 1.9 s preparing/segmenting metadata, 1.7 s
negotiating across both phases, 1.6 s seeding current files/Work/State ancestry, 1.2 s initializing
Work, 5.7 s in the index action (previously 89.1 s), 9.0 s backfilling, and 6.7 s validating current
and complete history. Times overlap at RPC level and are not independent per-call sums. Discovery
plus preparation/completion changed from 38 missing + 487 discovery + 487 prepare + 487 complete
calls to 46 missing + 44 prepare + 44 complete calls; the extra missing pages seed current data
first. Source objects in this fixture are below the large-file threshold, so large-file chunking
is not benchmarked. A 20 ms earlier intermediate build measured 96.2 s → 23.5 s; performance depends
on latency and shared-machine load. These results do not establish a deployed-provider speedup.


Release needs the rebuilt CLI and updated Convex schema/functions together (`historyBackfilling`,
current-first publication, larger upload batches, batched ancestry and `completeHistory`). An
old CLI's pending full-host operation retains its original behavior. The CLI does not deploy.
After the lead deploys, qualify a large native owner and a Git owner against the real provider,
including credential expiry and restart, before claiming a live-host speedup.

### Permanently delete a hosted project

An owner signed in with `nforge login DEPLOYMENT_URL` (CLI scope) can use the same
public `projectLifecycle:permanentlyDelete` mutation as the browser:

```sh
nforge host ROOT --delete-project PROJECT_ID --confirm PROJECT_SLUG
nforge host ROOT --delete-project PROJECT_ID --confirm PROJECT_SLUG --deployment https://DEPLOYMENT.convex.cloud
```

`--confirm` must exactly match the current project slug. ROOT can be an unbound
local Forge owner or a local owner bound to another project; the project ID and
current owner authentication select the hosted project. Deployment selection uses
`--deployment`, then ROOT's binding, `FORGE_DEPLOYMENT_URL`, then the saved login's
default deployment. To delete the project ROOT itself is bound to, explicitly add
`--allow-bound-project`. The check compares both deployment and project ID.

The command reads the owner's project metadata, retains the operation UUID and
expected revision privately under ROOT's Work directory before submitting, prints
progress, and waits for up to ten observations, backing off from two seconds to
ten seconds between reads. Completion
prints `purgeComplete: true` and the observed tombstone (`removal: "deleted"`,
`name: ""`, `currentBackup: null`). `--json` emits progress and result JSON lines.
A pending purge exits with `HOST_DELETE_PENDING`; an interrupted request or poll
can be retried with the exact same command and ROOT to reuse its saved pins.
The entire network observation window is bounded to ninety seconds, including slow
requests. Owner/authentication and server concurrency errors remain explicit. An
explicit retry refreshes pins after a definite `WORK_STALE` rejection, or when a
newer active project revision proves the earlier deletion could not have committed.
Unknown outcomes retain the original operation and revision.

Projects with R2 data remain `deleting` until every prefix DELETE succeeds. If
maintenance is disabled, the purge records `R2_MAINTENANCE_DISABLED` and schedules
nothing further. The CLI names the required backend setting,
`FORGE_R2_MAINTENANCE=1`; after it is enabled, retry the same command to resume.
Transient R2 errors retry the saved page up to eight attempts, with delays doubling
from one minute to a fifteen-minute cap. Exhaustion records
`R2_PURGE_RETRY_EXHAUSTED`; resolve the storage error and retry the command. Retries
reuse one tracked chain per project, and completed tombstones schedule no purge.

Permanent removal deletes the project's hosted source, Work, backups, grants and
project settings through the existing scheduled purge. Its minimal tombstone and
cleanup receipts remain. Deletion is permanent; local recovery copies remain
separate. The command retains the local owner, source and hosting binding.
After deliberately replacing the hosted project, `nforge host ROOT --new` creates
and binds a replacement.

### Hosted cockpit index format and team reset

Hosted Work index format **4** includes Candidate Lane/head inputs and dependency counts, run timing,
exit code, a 200-character check name and the retained failure summary (at most 4096 characters),
and Lane save count plus the last save time and a 200-character message. Full records, messages,
check definitions, dependencies and logs remain in their existing payloads. Reactive summaries do
not load full checkpoint arrays or check environments. The 32,000-character payload chunks and
100-entry/500,000-byte RPC batches are unchanged.

Formats 2/3 are no longer selected. The existing `ensure` path can rebuild the disposable index
from its source checkpoint and journal; no retained-data migration is needed. Source returns also
publish format 4. For the team's reset release, the owner has chosen to delete the old hosted
project and seed a replacement instead of migrating it. Only the lead performs these steps:

1. Use an up-to-date Lane of accepted `main` as the deployment directory. With Node 24.22.1+ (24.x) on PATH,
   install/build and deploy the backend and hosted browser. `DEPLOYMENT_ENV` is the private env
   file containing the **target deployment's** `CONVEX_DEPLOY_KEY`, `VITE_CONVEX_URL` and browser
   configuration; the deploy key and URL must refer to the same backend. `SITE_ID` is the existing
   team Netlify site. The preview script also updates that backend's worker URL.

   ```sh
   npm ci --ignore-scripts
   npm run build
   npx convex deploy --env-file "$DEPLOYMENT_ENV" --typecheck enable --yes
   node --env-file="$DEPLOYMENT_ENV" scripts/deploy-forge-preview.mjs "$SITE_ID"
   ```

2. In the deployed browser, open the old project → Settings → **Permanently delete project** →
   **Delete project permanently**. Wait for **Project removed**; use **Retry removal** if interrupted.
   The owner may instead use the [CLI deletion command](#permanently-delete-a-hosted-project).
   This is the existing owner-authorized deletion flow, scoped to that project. It removes hosted
   source, Work, backups, grants, prepared briefing sources, project guidance (including its operation
   history and maintainer assignments) and autonomy policy history. The project tombstone clears its
   name, hosting request, guidance and policy; only existing retry/cleanup identities and receipts
   remain. Personal guidance and other projects are unaffected. Keep the canonical local owner. No code migration, table-wide wipe or local-owner deletion is involved.

3. Rebuild/install the CLI from accepted `main`, sign in, then host the canonical owner directly:

   ```sh
   OWNER="$FORGE_OWNER"
   nforge login https://DEPLOYMENT.convex.cloud
   nforge host "$OWNER"
   nforge host "$OWNER" --status
   nforge hosted-work "$OWNER" '{"action":"workspace"}'
   ```

   `host` creates the replacement, transfers missing source/Work objects, initializes hosted Work
   and builds/selects the current index in one command. It prints the project URL and records the
   binding locally. No export, archive upload, bootstrap IDs or `forge-push.json` is needed. If the
   owner is already bound to a previous hosted project, use `nforge host "$OWNER" --new` explicitly.
   Re-running after interruption resumes the original creation/upload/index operation, including
   an interrupted `--new`. Native hosting becomes ready after current source, Work and the index;
   older content continues in a resumable local background process. `host --status` reports
   **history backfilling** until the full pinned closure is validated. Use `host --wait` to follow
   completion before testing full recovery. The initial seed eventually uploads the complete closure;
   subsequent `nforge exchange "$OWNER" push` reuses stored objects and pins the current hosted head.
   Recreate any desired contributor grants on the replacement explicitly.

   Inspect the new format's summaries, then open the printed URL and inspect Now, a Lane and Intents:

   ```sh
   nforge hosted-work "$OWNER" '{"action":"records","collection":"lanes"}'
   nforge hosted-work "$OWNER" '{"action":"records","collection":"views"}'
   nforge hosted-work "$OWNER" '{"action":"records","collection":"runs"}'
   ```

   Confirm save counters/timestamps, Candidate inputs and run names/timing. Exported history may contain
   runs predating durable failure summaries; those summaries stay absent and local logs remain
   authoritative. Only the lead deploys the Convex schema/functions, hosted browser and rebuilt CLI;
   hosting itself deploys no source or executable.

## Native runner selection

Native checks support local, [Modal](operations/modal-checks.md), and [GitHub Actions or Blacksmith](operations/github-actions-checks.md) runners. `checks.fallback` accepts `manual` or `local` and defaults to `manual`, including existing policies. Automatic local fallback requires explicit opt-in and owner-originated work. Confirmed runner outages and budget exhaustion return retryable infrastructure outcomes rather than failed-test evidence. See [runner fallback](operations/runner-fallback.md) for policy commands and recovery.

The existing owner-only project policy is the single runner setting. CLI-created
owners default to the own machine. Show it with `nforge policy OWNER` or
`nforge agent OWNER status`; edit with a fresh operation UUID (replay that UUID
and payload after an unknown reply):

```sh
nforge set-policy OWNER '{"operationId":"UUID","checks":{"runner":"local"}}'
nforge set-policy OWNER '{"operationId":"UUID","checks":{"runner":"github-actions","repo":"OWNER/REPO","runsOn":"blacksmith-4vcpu-ubuntu-2404","shards":4}}'
nforge set-policy OWNER '{"operationId":"UUID","checks":{"runner":"modal","credentialsRef":{"kind":"env","tokenId":"PROJECT_MODAL_ID","tokenSecret":"PROJECT_MODAL_SECRET"}}}'
```

For Modal, set the two named variables in the owner process environment using the
project's own account/key. Alternatively use
`"credentialsRef":{"kind":"file","path":"/absolute/external/project-modal.json"}`.
That local JSON file contains `tokenId` and `tokenSecret` values and must resolve
outside the owner, including its Lanes; symlinks into source are rejected. Only the
reference enters policy/Work. Values are read immediately before SDK invocation,
kept in process memory and passed only to the owner-side SDK process; they never
enter source, plans, Work, logs or hosted storage. The SDK gets an empty config and
no ambient Modal account/environment selectors. Missing, unreadable or invalid
credentials return `MODAL_CREDENTIALS_REQUIRED` naming `checks.credentialsRef`,
without using the owner's account or falling back locally. Existing Modal owners
must explicitly configure their reference. No hosted runner account funds checks.

Every new terminal check receipt has `backend.cost`: the runner/label, estimated
billed seconds/minutes, estimated USD, per-execution quantities and the basis.
Unavailable quantities are `null`, never an inferred zero. Local provider usage
and charge are zero; hardware and electricity are outside the estimate.
Actions estimates use each job's `started_at`/`completed_at`, rounded up separately
to minutes, including retained retry attempts. GitHub's timing API is retained in
`backend.billableMinutes` for compatibility but is not the USD basis: Blacksmith
jobs can report zero there. Built-in standard x64 rates are Linux $0.006,
Windows $0.010 and macOS $0.062 per minute ([GitHub pricing](https://docs.github.com/en/billing/reference/actions-runner-pricing)).
Blacksmith Ubuntu x64 labels use vCPU/2 × $0.004/job-minute; the 3,000 free
2-vCPU minutes/month are noted, not deducted because account-wide consumption is
unknown ([Blacksmith pricing](https://www.blacksmith.sh/pricing)). Set or override
any label's estimate with `checks.ratesUsdPerMinute`, for example
`{"blacksmith-4vcpu-ubuntu-2404":0.008}`. Unknown labels retain usage with unknown USD
until configured. The journal pins the selected rate for adoption.

Modal uses recorded Sandbox core-seconds × $0.00003942 plus GiB-seconds ×
$0.00000667, measured at worker runtime when available
([Modal pricing](https://modal.com/pricing), [resource basis](https://modal.com/docs/guide/sandbox-resources)).
`status.checkCosts.months` groups all retained months (UTC run start) by runner
and label, deduplicates remote execution identities and reports unknown/legacy
run counts. Totals sum available estimates before allowances, credits and billing
adjustments; provider invoices remain authoritative. Legacy Modal controller-time
and aggregate estimates remain explicitly labelled, may overstate spend and are
not reconciled against invoices. `modalCost` remains the current-month compatibility
summary with its historical basis; it excludes Actions. No backfill is performed.

## Local check reliability

### Check environment contract

Checks, Playbook steps and event automations use the same clean local runner.
The command receives a fresh materialized Candidate and private HOME/USERPROFILE,
XDG and temporary directories. Ambient Forge/cloud tokens, SSH agent settings,
credential-file overrides, `NODE_OPTIONS` and npm configuration are omitted.
Only the runtime allowlist and generated check metadata described in
[security](security.md#clean-check-environments) are supplied by default.
The dedicated shared npm content cache remains under the runner's home, so its
path is visible; this is environment hygiene, not home-path secrecy or an OS sandbox.

For an existing check, include `env: ["NAME"]` or `credentials: ["TOKEN_NAME"]`
in its local `define-check` command. Each list names exact parent-process variables;
there is no prefix expansion. Missing values remain absent. The lists are pinned
in the check definition and receipts; their transient values are not recorded there.
For example, `credentials: ["AWS_SHARED_CREDENTIALS_FILE"]` exposes only that
variable in addition to the clean defaults, whereas `env: ["HOME"]` restores
all home-relative configuration discovery. Other variables keep their defaults.
Runner-generated `FORGE_CHECK_*` input/output metadata keeps its pinned values.
Command output can still expose any supplied credential.

The default command cannot discover the user's SSH, AWS, Forge or dotenv files
through inherited HOME/XDG paths. Known absolute paths remain readable with the
user's OS permissions, and retained source is not secret-scanned. Synthetic
negative and opt-in coverage lives in `tests/check-environment.test.mjs`.

### Queue and recovery

All local owners and Forge processes under one OS account share a filesystem check queue at `~/.forge/check-queue`. The default limit is `max(1, floor(logical CPUs / 4))`; set `FORGE_MAX_CONCURRENT_CHECKS` to a positive integer in every runner environment to override it. A queued run reports `queued`, can be cancelled, and waits before workspace materialization or command execution; command timeouts start only when the command starts. `observe` shows its original run id. `finish` normally waits through the queue; optional `waitMs` returns a bounded receipt (including `queued`, `terminal:false`) and replaying the same operation resumes the original finish. `FORGE_CHECK_QUEUE_DIR` selects an alternative shared directory; use the same directory for every production runner. Forge must be able to write `~/.forge` (or the `FORGE_CHECK_QUEUE_DIR` directory); in a sandbox or container that blocks it, `finish` fails with `SYSTEM_EPERM`/`SYSTEM_EACCES`, the path and a hint. Allow the write or point `FORGE_CHECK_QUEUE_DIR` at a writable directory shared by every runner on the machine. There is deliberately no automatic owner-local fallback: separate queues would let each owner run its own full set of checks and exceed the machine-wide limit. System failures and unexpected errors write the full stack to `<owner>/.forge/logs/diagnostics.log` (else `~/.forge/logs`, else the temp directory; 3 files of up to 256 KB) and the error names that file.

Use `nforge queue list` to see operations, Lanes, phases, ages and holders.
`nforge queue prioritize OPERATION` advances a waiter; `nforge queue cancel OPERATION`
cancels its finish and check process group, including children. MCP exposes the
same actions through `forge_queue`. Prioritization preserves active non-audit
holders. Main audits yield to foreground checks and coalesce onto the newest
accepted main; GitHub push drains pending main audits first.

Queue holders and runs record PID plus process start identity. Status, observe, run, finish and clean apply reconcile a dead local runner as `interrupted`, retaining its output and original operation id without rerunning the command. A surviving detached process group keeps its queue capacity and workspace until it exits. Legacy records without a start identity remain conservatively PID-based; remote-host liveness is unknown.

Before Lane/check materialization and check execution, Forge probes free space on the owner's filesystem. At ≤5 GB free, receipts include a warning; below 2 GB, preparation refuses with `DISK_LOW` and points to `nforge agent ROOT clean` (dry run). A drop while queued produces a failed run with a structured `error` rather than executing. Configure decimal-GB thresholds with `FORGE_DISK_WARN_GB` and `FORGE_DISK_BLOCK_GB` (non-negative; `0` disables that threshold). Forge never deletes files because of low disk space.

### Landing lifecycle drill

Run the Q4 drill from a prepared checkout (Node 24.22.1+, dependencies installed
with `npm ci --ignore-scripts`, then `npm run build:core`):

```sh
node --import ./tests/check-runtime.mjs --test --test-concurrency=2 \
  tests/landing-lifecycle.test.mjs \
  tests/hosted-landing-lifecycle.test.mjs \
  tests/landing-check-recovery.test.mjs \
  tests/hosted-mac-runner.test.mjs
```

The restart cases create disposable native owners and real gated check processes.
They seed keyed passed checks, stop the owner controller with SIGTERM or SIGKILL
mid-check, and start a replacement controller. Both solo admission and combined
checks must land the original entries without resubmission. A dead local
controller or a service-stop signal retains the old run and reserves one
deterministic replacement operation for its unfinished check. Its diagnosis and
entry `infrastructureRetries` record the original run. Passed content-keyed evidence
is tried first. Explicit cancellation, failed source checks and preparation errors
retain their normal outcomes. A surviving orphan process group keeps its check
capacity until it exits. Cancel the original landing entry to stop its recovery.
Standalone `run` operations still retain their original interrupted outcome.

The hosted cases use in-memory backend transactions, a fake provider and fake R2
objects. They keep one remote check running across a 30-minute client clock jump
or a 10-minute transport outage, then deliver its retained signed completion.
Previously passed shard records, the run and the landing handle must retain their
identities; the original submission must reach `landed`. The Mac-runner tests also
exercise lease expiry, fencing, the existing one-requeue behavior, late callbacks,
and terminal delivery when no runner returns. These are deterministic simulations;
they do not sleep the test Mac, disable Wi-Fi or contact a live service.

Each lifecycle case prints JSON with simulated outage duration, elapsed wall time,
passed-check re-runs, stranded entries and recovery mutations. The initial restart
replay ended one in-flight entry as `cancelled` (SIGTERM) or `interrupted` (SIGKILL),
requiring resubmission to continue. The measured recovery cases all landed with
zero re-runs of passed checks, zero stranded entries and zero requester mutations
to settle:

| Case | Simulated outage | Measured wall time |
| --- | --- | --- |
| Solo check, SIGTERM restart | Service stop/start | 20.018 s |
| Solo check, SIGKILL restart | Service stop/start | 19.426 s |
| Combined check, SIGTERM restart | Service stop/start | 18.651 s |
| Combined check, SIGKILL restart | Service stop/start | 16.061 s |
| Hosted remote check, sleep | 30 minutes | 0.485 s |
| Hosted remote check, network loss | 10 minutes | 0.489 s |

These are synthetic drill times, not production latency or
runner-billing measurements; fault injection and starting the replacement service
are excluded from recovery-mutation counts. Repeat output gives current timings.

For Phase 5 metrics, this qualifies metric 5's recovery path without a manual retry
and metric 6's preservation of passed work; production interventions per landing,
check minutes and reuse rate remain unmeasured by this drill. Metric 3 is checked
by requiring every original submission to settle, with no pending queue work.

## Local cleanup

`nforge agent ROOT clean` (MCP `forge_task` action `clean`) reclaims regenerable local disk. It is a dry run unless you send `{"apply":true}`; the dry run lists candidates grouped by kind with bytes and the reason each is safe, plus totals and every skipped item with its reason. Apply recomputes the set under the owner lock and re-validates each item (pass `items` ids from a dry run to limit it; anything that changed is skipped). `kinds` filters:

- `check-retention`: remove eligible terminal remote source copies immediately; after strictly more than seven days, remove unpinned terminal runs’ remaining source/runtime and shard work copies and keep the final 64 KiB of each combined or shard log at its original path. Terminal receipts (including failure summaries), selection, changes, plans, provider state and selected artifacts stay. Running/queued/preparing runs, explicit release build-run/export pins, resumable or unknown remote executions and in-use directories stay. Acceptance and open-Lane references retain evidence without protecting old bulk; recent shard work and logs remain untouched. Both the run end and the individual remaining copy/log must be older than seven days.
- `check-workspaces`: finished check runs’ `workspace/`, `runtime/`, `modal-source/` and `github-actions-source/` copies, without an age gate. Remote source copies require a matching terminal receipt, no resumable backend, release/export pin, unresolved remote execution or process blocker. `result.json`, logs, selection, plans and artifacts stay. Missing receipts, archived-interrupted-only receipts, receipt mismatches and unresolved remote executions have specific skip reasons. An interrupted run with a matching archived receipt and a recorded supersession by a later retained Candidate in the same Intent/Lane family may release only its remote source copies; its evidence stays untouched. Ambiguous interruption or supersession retains all copies.
- `lane-deps`: `node_modules`, `dist` and similar gitignored build directories inside completed or abandoned Lanes.
- `lanes`: the whole directory of a completed or abandoned Lane, only when a capture of it equals the Lane head State; otherwise it is skipped as uncaptured edits. Gitignored files (such as `.env`) are not in State and are deleted with it. `reopen`, `checkpoint`, `sync` and `finish` re-materialize a removed Lane from its head State.
- `exchange-staging`: unreferenced exchange staging older than seven days. Pending operations, old baseline hints that still depend on staging, and retained export references keep their directories. Pending or explicitly retained export manifests pin only the exact check-file bytes they reference; completed preparation baselines retain staging metadata without pinning owner log prefixes. Unreferenced staging, including staging younger than seven days, does not pin old check files. A log pin does not protect its run’s source or shard work copies.
- `auto-snapshots`: remove automatic snapshot pointers and caches of completed or abandoned Lanes after strictly more than seven days from both the snapshot and latest Lane closure. Open Lanes are protected regardless of snapshot age; reopening within the window keeps their source protected. Dry-run `disk.kinds` reports the current footprint of all snapshots, including protected open Lanes, with shared State/blob objects counted once. Candidate `bytes` counts pointer/cache bytes; `snapshotBytes` separately reports the referenced State/blob footprint, including shared objects (per-snapshot sums can overlap). Removing a pointer does not delete source objects: `objects` can reclaim only those unreachable from every other retained root. Saved checkpoints are unaffected.
- `objects` (only when named): wraps `inspect-native-objects` and `collect-native-objects`.

Active and paused Lanes, Work records, referenced objects and anything outside ROOT are never touched. Repeating is safe.

With `lifecycle.cleanRegenerableCopies:true`, terminal checks immediately remove eligible remote source copies and Lane lifecycle events also sweep these copies and the seven-day retention kinds. Retention is automatic only under that existing opt-in; there is no background daemon. It removes old log prefixes and expired closed-Lane auto-snapshot pointers/caches permanently and records that fact; rerunning a check reconstructs its source copy, not its original output. A resumed run gets a separate cleanup action for its new terminal end time; repeating the same completion returns its recorded cleanup result. Dry runs do not reconcile or rewrite run records.

With `lifecycle.cleanRegenerableCopies:true`, Lane completion and abandonment automatically apply the shared cleanup validator under the owner lock; accepted-work completion also sweeps eligible older copies. Preset defaults are unchanged: Autonomous opts in, while other presets and migrated owners retain their existing setting. Automatic whole-Lane cleanup preserves excluded local settings and arbitrary ignored files outside recognized build directories. Dirty, active, pending, in-use or unverifiable copies stay, with reasons recorded alongside removed paths and `reopen`/rebuild instructions in automatic-action receipts. Terminal native checks retain immediate workspace/runtime cleanup across presets after validating and flushing terminal receipts, logs and selected artifacts; run details report removals or skipped copies. Retained source and evidence stay readable. Retrying a completed finish does not re-materialize its removed closed Lane.

## Object collection

```sh
nforge work OWNER '{"action":"inspect-native-objects"}' 0
nforge work OWNER '{"action":"collect-native-objects"}' 0
```

Inspection counts objects and lists verified unreferenced candidates, and changes nothing. Collection repeats the inspection under the lock and deletes only those objects. It never touches referenced history, Lanes, run files, backups or temporary files. If the retained history cannot be verified, it deletes nothing. Retry after an interruption. Deletions are final, so keep a backup. Collection upgrades an older owner to at least Work format 3, and older CLIs then refuse it.

## One authority cutover

This is the Bet 1 cutover procedure for [Phase 5](phase5-plan.md#bet-1-one-authority-then-delete),
not a claim that the project has switched. The authority transition mutation,
epoch fences and journaled native client are implemented and qualified locally
below. The pinned cutover command and lead checklist are described below. Follow the
[migration invariants](operations/hosted-landing-contract.md#migration-invariants-deferred-implementation)
throughout. No deployment, account operation or real-owner cutover was performed
for this document.

### B1.2b: drain the owner queue

**Choose “drain the owner queue before the switch”, rather than implementing the
G3 submission-ID bridge plus G6 journal bridge.** This is a one-time operator
cutover rule, not a new quota or everyday user confirmation. It needs one pinned
drain predicate and routing boundary. Bridges would additionally need durable
per-Lane native ↔ per-request hosted ID mappings, parent/entry/attempt lineage,
versioned journal conversion and reconciliation of different request hashes at
every crash point. The drain retains those historic identities without translating
a live native request into a hosted request.

Stop admitting **new native landing requests for this bound project** during the
handover, while allowing already admitted requests to finish. Keep Lane editing
and saves available. B1.2b must retain a new finish/land's operation and exact saved
inputs until hosted admission is available; report a pending handover and resume
that original request after discovery, without silently choosing newer saves or
losing the request. An old CLI follows the upgrade path below. This temporary
routing boundary must not cancel admitted work or turn observer timeout into a
terminal result.

“Drained” means more than an empty batch: reconcile every owner `landingEntries`
entry, `landingBatches` member, owner-acceptance request and native finish/land
journal, including journal-only commands and unknown acceptance replies. Each
admitted submission has either an actual main receipt or a retained
`terminal-failed` outcome delivered to its requester (or durably available for
that requester's reconnect). Finish reconciliation under the old IDs and request
hashes; retain completed journals with the snapshot. A waiting review, dependency,
ambiguous provider execution or missing receipt is **not drained**. Do not cancel
it merely to enable cutover. If one cannot settle, remain owner-authoritative;
there is no timeout that discards it. The tradeoff is a handover wait that may be
longer than a bridge-enabled switch. This is less code and preserves metric 3's
zero-dropped-landings invariant; the live zero is still to be measured by M1/B1.5b.

The bound authority client records the handover marker before testing the drain
predicate. CLI and MCP share native admission under the same owner lock. Already
admitted requests reconcile their original native journals; new requests retain
their operation and immutable input States in `hosted-submissions` and return
`pending-handover` until hosted capability discovery reports server authority.
Editing and saving remain available. Replay the original transition after its
reported blockers settle. The transition retains its drained owner revision;
the hosted transaction compares it with the seeded checkpoint and checks current
owner-acceptance requests and nonterminal indexed entries/batches before changing
the epoch. These indexed predicates participate in the same OCC transaction as
the switch. Completed transition replays retain their original receipt.

After the binding selects server authority, bound `finish` and `land` use the
existing hosted-agent transport and H16 save path, then compose and enqueue on
`projectHostedLanding:enqueue`. `finish` captures its primary Lane; `land` and
siblings use their saved States. Private staging checkouts preserve those bytes
across retries and leave working drafts untouched. The hosted request pins the
authority epoch and exact composition/check selection. Source preparation can
return pending before queue admission; replay the same operation to continue.
Once enqueued, hosted workers own progress without a Mac or native listener.
`wait:false` returns the queue receipt, and synchronous calls observe hosted
submission versions; observation timeout remains pending. Check-only finish
does not request acceptance, and `keepOpen` remains part of the accepting request.
Provider OCC exhaustion retries the original payload without selecting newer
source. Native-owner and server-shadow bindings keep their native landing path.

### B1.4b: command-driven Mac source cache

A server-authoritative bound native project starts Lanes from hosted records and
R2 source objects. Hosted main reads discover current authority and select
`projectHostedChannels:current` for schema 2; failure never substitutes the
historical `projectMain:current` seed. Native-owner and shadow bindings retain
their existing source selection. The local source adapter exposes `get(id)` and
`put(bytes)` over existing content identities and R2 keys. Concurrent cold reads
use the existing batched download cache, with byte and size verification before
installation. Lane materialisation reuses the verified B1.4a tree cache and APFS
clone/copy fallback.

Bound `checkpoint` (also `save`) captures immutable retry bytes, uploads changed
objects directly through R2 presigning, then uses the existing hosted save
worker and head/version CAS. Local Work acknowledges a head only after the
hosted save completes. Interrupted upload leaves the prior head selected; a lost
commit reply replays the original save, including after the agent edits again.
Pending hosted work returns pending without advancing the local saved head.
Explicit workspace, named-channel and stacked starts retain their selected
State and upload it before hosted start publishes a pointer; default starts use
hosted main. No source exchange push, pull or open runs in this lifecycle path.
Compatibility exchange commands remain available until B1.6.

Cache observations record hosted source revision and the revision actually
materialised on existing commands. Refresh starts no timer, poller or idle
worker. This supplies metric 7 observations; fleet p50/p95 lag and contradiction
minutes still require observed post-cutover operation. This path creates no
check run and changes no check reuse key or runner configuration (metrics 6/8).

### Ordered cutover and forced upgrade

1. **B1.2a — transition and all-writer fencing.** The authenticated mutation in
   `convex/projectSourceAuthority.ts` uses `nextSourceAuthority` and retains an
   operation-idempotent mode/epoch receipt. Before real cutover, qualify that
   transition together with the expected main **head and receipt**, native Work revision, hosted
   source/journal revision and validated seed/snapshot pins. Both forward and
   rollback directions are required. `server-shadow` still leaves the owner in
   charge. Fence `ownerAcceptance.complete`, `projectExchange.publish`,
   `projectWorkActions.acceptChannel`, native `accept-channel` and
   `projectHostedChannels.seed`; audit source-return, bootstrap/import, recovery
   and background publication paths against the same mode/epoch. A stale upload
   or delayed owner completion cannot advance main. Replaying a completed
   transition returns its original receipt; a changed request under the same UUID
   fails explicitly. Same-head/new-receipt races must lose CAS too.
2. **B1.2b–d — route, seed, browser.** Build bound CLI/MCP finish/land over
   `projectHostedLanding:enqueue`, with the drain rule above; build the pinned,
   paged, resumable seed of native main plus records (B1.2c); move browser accept,
   request-changes and revert onto hosted landing/acceptance (B1.2d). Seed retries
   resume their original pages and preserve source/record/receipt identities.
   Shadow preparation is not a second acceptance ledger. Validate main digest,
   receipt, saved Lanes, record pages and ancestry before selecting the seed.
3. **B1.2e — stop bound Mac acceptance.** Install the authority-aware local
   routing/fence before enabling server mode: when the project switches, bound
   direct accept and the Mac landing worker cannot publish native main; the error
   names the hosted path. Native-owner projects, bound or unbound, retain ordinary
   acceptance, including after rollback to native-owner.
   Re-read authority before publication; a saved local binding is not permission.
4. **B1.5a — complete recoverability first.** SP1 → B1.4b must have supplied
   schema-2 main/cache reads from `projectHostedChannels:current`; qualify the
   runner/evidence prerequisites B1.3a–b too. Fold hosted queue, records, attempts,
   acceptance snapshot deltas and pending completion overlays into an exact
   recovery snapshot (B1.5a1). Rewrite Route B as recovery of a runner/cache,
   without granting local acceptance authority (B1.5a2). Prove that work accepted
   only on hosted survives. The old checkpoint plus legacy journal is insufficient.
5. **B1.5b — snapshot, drain, final seed, switch and drill.** Publish/install the
   compatible CLI and server code together before the switch. Drain as above;
   capture the rollback package below, finish the seed at the final pinned owner
   head/receipt/revision, then CAS to `server` at a higher epoch. If any pinned
   input changed, renew preparation; never overwrite the newer source. Resume
   held new requests through hosted admission. On a clean machine run Route B,
   then re-measure Route A with every retained-backup object still available.
   Any push-era object purge follows the existing approved retention scope;
   this plan does not authorize a purge. Observe seven days in which every accept
   uses hosted CAS, including with Macs offline. Record metrics 3, 5 and 7; metric
   7 changes from owner/hosted lag to cache lag and surface contradictions.
6. **B1.6a–c, then B1.7/B1.8 — delete only replaced callers.** Require B1.5b and
   the SP1 decision before deleting push/auto-exchange, source return and owner
   relay. Keep transport/cache/upload and historic replay dependencies listed
   below. B1.7's hosted converter needs B1.6b plus journal compaction; B1.8 needs
   the replacement browser path. Retired Convex table definitions remain until
   B1.9's separately approved export/purge after two weekly backups.

For old CLIs, server mode's source-contract schema 2 is the upgrade boundary:
`requireSourceContract` returns `CLI_UPGRADE_REQUIRED` for schema-1 readers;
`projectMain:current` cannot substitute the old seed for server main. B1.5b must
also cover every legacy bound writer with the epoch fence, not just modern CLI
capability discovery. Return a structured upgrade message naming a compatible
package and the hosted path; do not fall back to native acceptance, source return
or old exchange push. Preserve offline edits, saved heads and pending original
operation IDs. Back up the local owner, install the compatible package separately,
rediscover project authority, and reconcile the original requests before any
new submission. Completed native requests reconcile from their retained native
receipts/journals; never enqueue them again under hosted identity. No new
login/consent step is implied beyond current authentication.
`WORK_UPGRADE_REQUIRED` remains the separate Work-format error. Never use an older
writer to downgrade an upgraded owner; restore its matching backup into a new
folder with compatible tools.

### B1.5b: pinned cutover command and lead checklist

The cutover release is **nforge 0.3.1** (source contract 2). Install the matching
package on every CLI/MCP host and deploy its server code before switching. The
builder's synthetic drill does not change the dogfood owner or deployment. Only
the lead performs the following real-owner procedure.

1. Stop starting owner-mutating commands for the handover. Verify no agent is
   mid-command; checkpoint its drafts without choosing newer saves for an
   existing submission. Reconcile the native queue, batches, acceptance requests
   and finish/land journals to actual receipts or delivered terminal outcomes.
   The native and hosted queues must be empty, including review/check/dependency
   waits and unknown replies. Keep the saved operation IDs. Do not cancel work
   to make the predicate pass. The apply command records the existing handover
   marker before checking the local drain, so new native finishes retain their
   exact inputs for hosted admission.
2. Capture the rollback package described below, the matching package/lockfile,
   a deployment export and all referenced object closures off-owner. Qualify the
   source worker, runner evidence and server-mode local acceptance fence. Complete
   the B1.2c validated final seed at the drained owner's exact main **head and
   receipt**, source/Work revision and object closure. An old push-era checkpoint
   alone is insufficient. Remain native-owner if these prerequisites are absent.
3. Read fresh server pins with `nforge host "$FORGE_OWNER" --cutover-pins`.
   Save a private, credential-free request containing
   `{operationId:"<new UUID>",mode:"server",pins:<that exact result>}`.
   `pins` contains authority/epoch, complete schema-2 main selection, backup ID
   and digest, project revision, journal revision and seeded owner revision.
   Keep this file unchanged for retries.

   ```sh
   nforge host "$FORGE_OWNER" --cutover-file cutover.json --dry-run
   nforge host "$FORGE_OWNER" --cutover-file cutover.json --apply > cutover-receipt.json
   ```

   Dry-run performs authenticated reads only. It reports all server and local
   changes and does not reserve an epoch, create a receipt or close admission.
   Apply rechecks local main/receipt/revision and drain after recording the
   handover marker. Its single server transaction rechecks the exact pins and
   both queues, advances authority by one epoch, updates main's authority pin
   **without changing its head or receipt**, and retains an immutable receipt.
   A same-head/new-receipt race fails too. The receipt's `at` is the UTC metric-7
   boundary; `metric7` changes from `owner-ahead-of-hosted` to
   `cache-behind-hosted`. Historical replay returns that same timestamp and
   receipt after later transitions. A changed request under the same UUID fails.
   A lost reply leaves the local marker and request intact; replay reconciles
   before selecting new work. A known stale-pin failure clears only its own
   marker so the lead can prepare fresh pins under a new operation. No cache pin is rewound by a historical receipt.
4. Check server capabilities and schema-2 main at the returned epoch. Resume held
   submissions with their original IDs. Shut down the Macs for one deliberate
   hosted landing and retain its H14 CAS receipt. An old CLI's capability request
   (missing version or below 0.3.1) gets one `CLI_UPGRADE_REQUIRED` with the
   compatible nforge version, package-install command and hosted resume path.
   Legacy native publication attempts get the same upgrade response on the
   cut-over project. Modern clients advertise their supported version. Merely
   binding a native-owner or shadow project does not activate this gate.
5. On a clean machine, follow [Route B](operations/recovery-drill.md#route-b-surviving-hosted-copy).
   Compare the hosted-only landing's exact head, receipt and source bytes, saved
   work and pending completion/queue outcomes. Verify the result is a runner and
   cache, with no local accepting owner. Re-register existing runner references
   through the ordinary worker path. Recovery must not repeat an acceptance.
6. **R2 push-era object purge:** inventory the exact candidate object keys and
   subtract the complete transitive closures of **every kept backup**, the
   rollback package and all still-selected source/Work/evidence. Include shared
   recipe/chunk objects, historical State parents and referenced hosted receipt
   pages; do not infer reachability from a filename prefix, current main alone,
   or a missing graph edge. Retain the inventory, keep-set and dry-run difference
   with the private cutover receipt. Apply only that explicit unreferenced
   push-era set under the existing approved purge scope. The R2 backfill tool's
   Convex-copy purge is a separate operation and is not this object deletion.
   Restore the newest kept weekly backup with **Route A after the purge**, check
   its object closure and publish the measured time here. No builder runs the
   purge and this command creates no new retention/deletion behavior.
7. Watch **seven UTC days** from the receipt: join every main move to its H14
   hosted CAS receipt and epoch; account separately for compensation/reverts.
   Record metric 3's queued/landed/terminal/pending counts (dropped target zero),
   metric 5's operator interventions per landing, and metric 7's cache-lag p50/
   p95 plus contradiction minutes across CLI/MCP/web. Compare with the retained
   before-cutover baseline. Keep missing samples partial, never zero. Inspect
   these on existing lifecycle reads/writes; no timer or background poller is
   introduced. The real cutover is qualified only after this observation period.

Rollback uses a **new** request with `mode:"native-owner"` and freshly read pins,
after draining hosted requests and folding/restoring/verifying all later hosted
work as described below. Apply preserves current main/receipt and advances to
another higher epoch; a stale owner copy cannot regain acceptance by editing its
binding. Once cut over, the older mode-only transition command refuses fresh
transitions and names the pinned command. Existing completed transition receipts
remain replayable.

Run the credential-free qualification from the source Lane:

```sh
export PATH=/usr/local/bin:$PATH
npm ci --ignore-scripts
npm run build:core
node scripts/phase5-cutover-drill.mjs
```

It uses only synthetic owners and indexed hosted fixtures. The actual H14 receipt
from the Macs-offline landing is the receipt supplied to the clean-machine
recovery, rather than an independently invented recovery receipt. It times each
step, verifies exact recovery, and exercises reverse CAS and original-operation
replay. A pending empty input completion page is valid at entry zero; nonempty
page cursors retain their original bounds checks.

The synthetic cutover phases below were observed with Node 24.22.1. The
runner/cache qualification is **blocked until B1.5a2 is on main**: the older
recovery entry point returned a native recovery copy rather than `runner-cache`.
The test fails on that contract; it does not skip the recovery assertion.

| Synthetic step | Seconds | Result |
| --- | ---: | --- |
| Cutover dry-run | 0.009 | Read-only plan |
| Cutover apply | 0.006 | Atomic project/main epoch and receipt |
| Hosted CAS landing, all Macs offline | 0.073 | One actual H14 receipt |
| Old CLI refusal | 0.003 | Structured upgrade error |
| Clean-machine recovery invocation | 2.972 | Legacy copy; runner/cache qualification failed |
| Post-recovery rollback in the linked drill | — | Unrun after the dependency failure |

The separate bound-client/transaction tests exercise reverse CAS at epoch 2,
receipt/head preservation and historical replay. The linked post-recovery
rollback and a clean runner/cache result still require the prerequisite. The
measured synthetic landing had one queued submission and one delivered landing
receipt (metric 3: zero dropped); no queue nudge, restart or landing retry was
needed. Production interventions per landing (metric 5) remain unmeasured. The
receipt records the metric-7 boundary and after-cutover form; fleet cache-lag
p50/p95 and contradiction minutes remain unknown. Real Route A after the R2
purge, real Route B and the seven-day watch remain **unrun** by this builder.
These are not production RPO/RTO measurements.

### Rollback point and return to owner authority

The rollback point is the **fully drained, validated final owner snapshot immediately
before the forward authority CAS**, with the matching hosted seed and authority
pins. Retain the matching package/lockfile and these private inputs off-owner:

- Exact accepted main State/blob closure and head/receipt chain; native bootstrap
  head; every saved Lane base/head/checkpoint; Candidates, ordered dependencies,
  runs/evidence hashes, unavailable-evidence declarations and lifecycle records.
- Portable full Work snapshot/revision and records, plus the **whole owner Work
  directory separately** for immutable physical record pages, local finish/land
  journals, original commands/hashes/child IDs, pending transport operations and
  binding. Portable `export-work` does not include every driver/retry file or
  unsaved edit. Preserve dirty/ignored files separately if needed; never put
  credentials in the cutover request or documentation.
- Hosted snapshot/seed object closure, source and journal revisions, main
  head/receipt, authority mode/epoch, queue/attempt/operation settlements and
  completion overlays. Save a matching deployment export and references to
  separately retained R2 bytes/configuration; a local tar archive alone is not a
  backup of hosted tables. Runner/auth/keyring configuration stays separately
  backed up through the existing private process.

**Return to owner authority by another transition, at a higher epoch:**

1. Reconcile unknown hosted acceptances using their original operation IDs. Drain
   hosted in-flight landings to delivered terminal outcomes, as for the forward
   switch. Keep editing and saves available while landing waits.
2. Fold the **latest** hosted main, receipts, saved Lanes, records and completion
   overlays through B1.5a into a new native recovery package. The pre-switch
   `export-work` archive is the rollback baseline; it omits later hosted work.
   Never replay already accepted work as a new acceptance. Keep the original
   request hashes and receipt identities.
3. Restore the archive into a fresh folder with a compatible package:
   `node dist/cli.js restore-native "$ARCHIVE" "$NEW_OWNER"`. Compare accepted
   main through its Channel receipt, all saved Lane heads and source bytes, and
   logical Work records. The returned top-level `head` is the native bootstrap
   State, not necessarily accepted main. Restore validates hashes and source
   closure, reconstructs physical record pages, and marks unfinished runs
   interrupted without launching commands. Keep dirty/ignored edits separately.
4. Perform the B1.2a reverse CAS from the currently observed server mode/epoch to
   `native-owner` at **current epoch + 1**, with the qualified cutover's matching
   source/Work/main-receipt/snapshot pins. Forward at E+1 means reverse at E+2 or
   later. Retain the transition UUID for an unknown reply; replay reconciles the
   existing receipt. An older local epoch never grants permission to accept.
5. Rebind the recovered owner at the returned epoch, resume observations from
   authoritative records, and resume native admission with original pending
   identities. Terminal failures are not automatically resubmitted; an unknown
   paid execution is not duplicated. Caches and runner workspaces can be rebuilt.

**If hosted is down, landing pauses and editing continues.** Keep the snapshots,
local edits and original operation IDs, then reconcile when hosted returns. If
hosted cannot execute the CAS or its latest records cannot be folded, rollback
cannot complete. There is no emergency override, epoch rewind or local file-copy
failover. Qualify the full source/Work-pinned reverse path before the real switch; the
local mode/epoch drill below does not establish production recoverability.

Deleting the old owner stack in B1.6 narrows software rollback. Retain the
compatible pre-deletion package and a lossless folded snapshot. Historical
journal bytes and digests stay unchanged. Keeping an archive alone does not prove
that the post-deletion path works.

### Local rollback qualification

Run from the selected source Lane, with Node 24.22.1+ and no hosted connection:

```sh
export PATH=/usr/local/bin:$PATH
npm ci --ignore-scripts
npm run build:core
node scripts/phase5-rollback-drill.mjs
```

For dogfood scale, add `--clone-owner "$FORGE_OWNER"`. The source owner is
only read: the script pins its atomic Work pointer, runs `cp -c -R` into a fresh
throwaway directory, and removes copied bindings, credentials, dotenv files and
local worker endpoints before constructing an owner service. It uses no shell,
real hosted project, account or deployment. Only the copy's automation/provider
policy is neutralized. Both modes delete the copies, archive and restored owner
in `finally`; the JSON result confirms `copyDeleted`.

The drill calls the actual `projectSourceAuthority:transition` mutation through
the same in-memory local fake as the transition tests. It switches native epoch 0
→ server epoch 1, saves one local Lane change, exports its full Work archive,
restores it, compares source States and logical Work/Lane/acceptance records,
then reverses to native epoch 2. It reconciles a repeated reverse UUID and
checkpoints, composes and accepts another edit locally at the returned epoch.
The saved change is local; this does not simulate hosted-only recovery folding.

The default synthetic drill first creates accepted `main` distinct from the native
bootstrap State. Its regression test verifies that the drill pins that acceptance
as its Intent base, round-trips both Lanes and lands after epoch 2. This catches a
bootstrap-based Candidate that would correctly fail with `CHANNEL_DIVERGED`.

**Dogfood qualification: exit 0; copies deleted.** The copy contained 527 Lanes. All source-State and logical Work comparisons
passed; the one unfinished run became interrupted without restarting a command.
The reverse CAS reached epoch 2, reconciled its original UUID, and the restored
owner checkpointed, composed and accepted locally. The archive contained 19,888
files: **1,296,268,470 compressed bytes**, **4,231,746,621 logical bytes**.
Observed on one Mac with other builders running:

| Step | Seconds |
| --- | ---: |
| APFS clone and credential/binding scrub | 229.457 |
| Isolate the copy's automation/provider policy | 35.625 |
| Create a Lane pinned to accepted main | 40.418 |
| Forward transition: native 0 → server 1 | 0.057 |
| Edit and checkpoint | 3.799 |
| Archive export | 387.089 |
| Full archive restore, including run interruption | 603.070 |
| Compare source States, Lanes and Work records | 11.833 |
| Reverse transition: server 1 → native 2 | 0.031 |
| Checkpoint, compose and accept locally | 100.518 |
| Delete the throwaway owner, restored owner and archive | 192.323 |

The earlier argv-only fix exported 19,859 files in 403.384 s, but its original
restore was still incomplete after 630 s: 233 of 527 Lanes had materialized.
Native sampling showed repeated per-file `fsync` calls. Restore now stages each
Lane inside the unpublished private owner and publishes the owner as a whole,
preserving independent writable files, failure cleanup and the existing space
check. The completed restore remains just over ten minutes; these observations
are not a production recovery-time guarantee. Physical record-page filenames may
differ; logical records differ only by the documented interruption.
The restore profile attributed 195.075 s to 528 materializations (root plus Lanes)
and 7.112 s to Work loading. The remaining time includes archive processing,
validation and publication of indexed records for the interrupted run. The shared
record writer and checkpoint code were not changed by this archive qualification.

Archive filenames use a NUL-delimited stdin list, and native metadata output is
spooled privately. USTAR/gzip and the existing archive schemas remain unchanged;
old archives still restore. The live-copy helper tolerates only vanished temporary
owner locks/files that it discards anyway. Missing durable records or source,
permission failures and other copy errors still fail; source and Work validation
remain mandatory parts of the drill.

**Unrun:** real hosted cutover and drain/admission concurrency, hosted-only
recovery folding (B1.5a), clean-machine Route A/Route B and seven days of single
hosted authority (B1.5b). Local fake transitions and archive recovery are not
production RPO/RTO measurements.

### Deletion inventory and last callers

Counts below are full-file **`wc -l` on the B1.1 Lane tree**, based on source
`f066fcc92c451af97f7c28a9a2e73cdf001debdcea2b1d10372493e80e4370d0`.
They re-measure the Phase 5 input inventory; they are not estimates of lines
actually removed. Caller evidence includes imports/re-exports, worker `new URL`
paths, `moduleUrl`, string Convex function references and `api`/`internal` uses.
Generated `convex/_generated/api.d.ts` declarations are not live callers. This
static inspection is partial; a missing reference is not proof of independence.

Every row's last callers are the first **surviving production modules** reached
backwards through the retiring A–I modules. Directory prefixes and extensions
are kept in paths. Repeated caller sets are named immediately below each table.
A surviving module may still lose the particular calling function; the split
inventory below records that boundary. Tests/scripts are inventoried separately.
G is conditional on server-projection coverage; I is gross replace/re-parent
scope, not a promise to delete useful review components.

#### B1.6a — exchange push/publication

| Module                                   |       LOC | Last surviving callers |
| ---------------------------------------- | --------: | ---------------------- |
| `src/bound-exchange.ts`                  |       478 | A1                     |
| `src/bound-exchange-supersede.ts`        |        91 | A1                     |
| `src/bound-push-progress.ts`             |        50 | A1                     |
| `src/bound-push-id.ts`                   |        12 | A1                     |
| `src/exchange-cli.ts`                    |       267 | A2                     |
| `src/mcp-exchange.ts`                    |        82 | A3                     |
| `src/exchange-progress.ts`               |         8 | A1                     |
| `src/native-exchange-prepared.ts`        |        73 | A4                     |
| `src/native-exchange-migrate.ts`         |       105 | A2                     |
| `src/git-exchange-prepared.ts`           |        62 | A4                     |
| `src/pending-exchange.ts`                |       163 | A5                     |
| `src/push-progress-state.ts`             |        36 | A6                     |
| `src/native-publication.ts`              |        75 | A4                     |
| `src/publication-metadata.ts`            |        46 | A7                     |
| `src/publication-pin-window.ts`          |        67 | A8                     |
| `src/work-exchange-context.ts`           |        87 | A9                     |
| `src/exchange-proposal.ts`               |        78 | A2                     |
| `convex/projectExchange.ts`              |       271 | A10                    |
| `convex/projectExchangeMigration.ts`     |       124 | A11                    |
| `convex/projectWorkRecordExchange.ts`    |       255 | A9                     |
| `convex/projectPublicationValidation.ts` |       287 | A8                     |
| `convex/projectPublicationProgress.ts`   |       115 | A8                     |
| `convex/projectPublicationStore.ts`      |       313 | A8                     |
| `convex/projectPublicationAttempt.ts`    |        78 | A12                    |
| `convex/projectPublicationRun.ts`        |        43 | A12                    |
| `web/src/ExchangeHandoff.tsx`            |       110 | A13                    |
| **Whole-file scope**                     | **3,376** |                        |

- **A1:** `src/cli.ts`, `src/host-binding.ts`, `src/mcp-agent-workflow.ts`, `src/work-store.ts`.
- **A2:** `src/cli.ts`, `src/mcp-agent-workflow.ts`.
- **A3:** `src/mcp-agent-workflow.ts`.
- **A4:** `src/native-exchange.ts`.
- **A5:** `src/cli.ts`, `src/host-binding.ts`, `src/host-command.ts`, `src/mcp-agent-workflow.ts`, `src/native-exchange.ts`, `src/pending-status-read.ts`, `src/pending-status.ts`, `src/work-records.ts`, `src/work-store.ts`, `src/work.ts`.
- **A6:** `src/host-binding.ts`, `src/host-command.ts`, `src/pending-status-read.ts`, `src/pending-status.ts`, `src/work-store.ts`.
- **A7:** `convex/projectExchangeActions.ts`, `convex/projectSourceProjection.ts`, `convex/projectWorkLoad.ts`, `src/exchange-client.ts`, `src/exchange-convex-fetch.ts`, `src/native-exchange.ts`, `web/src/HostedWork.tsx`.
- **A8:** `convex/projectExchangeActions.ts`, `convex/projectSourceProjection.ts`, `convex/projectWorkLoad.ts`, `src/exchange-client.ts`, `src/exchange-convex-fetch.ts`, `web/src/HostedWork.tsx`.
- **A9:** `convex/projectExchangeActions.ts`, `src/exchange-client.ts`, `src/exchange-convex-fetch.ts`, `web/src/HostedWork.tsx`.
- **A10:** `convex/projectExchangeActions.ts`, `src/exchange-client.ts`, `src/exchange-convex-fetch.ts`.
- **A11:** `src/exchange-client.ts`, `src/exchange-convex-fetch.ts`.
- **A12:** `convex/projectExchangeActions.ts`.
- **A13:** `web/src/HostedWork.tsx`, `web/src/ProjectBackups.tsx`.

#### B1.6b — source return

| Module                                  |       LOC | Last surviving callers |
| --------------------------------------- | --------: | ---------------------- |
| `convex/projectSourceReturn.ts`         |       453 | B1                     |
| `convex/projectSourceReturnProgress.ts` |       457 | B1                     |
| `convex/projectSourceReturnPrepare.ts`  |       317 | B1                     |
| `convex/projectSourceReturnRecords.ts`  |       211 | B1                     |
| `convex/projectSourceReturnDelta.ts`    |       144 | B2                     |
| `convex/projectSourceReturnStep.ts`     |       120 | B2                     |
| `convex/projectSourceReturnCursor.ts`   |        94 | B1                     |
| `convex/projectSourceReturnMetadata.ts` |        93 | B2                     |
| `convex/projectSourceReturnRows.ts`     |        82 | B1                     |
| `convex/projectSourceReturnJournal.ts`  |        49 | B1                     |
| `convex/projectSourceReturnBudget.ts`   |        17 | B1                     |
| `convex/projectWorkRecordReturn.ts`     |       323 | B1                     |
| `convex/projectReturnIndexStage.ts`     |       245 | B3                     |
| `convex/projectReturnMetadataStore.ts`  |       157 | B4                     |
| `convex/projectReturnCommit.ts`         |       122 | B1                     |
| `convex/projectReturnSupersede.ts`      |        88 | B5                     |
| `convex/projectGitReturnIndex.ts`       |       112 | B1                     |
| `convex/coordinationReturnChanges.ts`   |        50 | B1                     |
| `src/work-source-return.ts`             |       136 | B6                     |
| `src/source-return-progress.ts`         |        30 | B7                     |
| `web/src/HostedSourceReturn.tsx`        |       107 | B8                     |
| **Whole-file scope**                    | **3,407** |                        |

- **B1:** `src/exchange-client.ts`, `src/exchange-convex-fetch.ts`, `web/src/HostedWork.tsx`.
- **B2:** `convex/projectExchangeActions.ts`, `convex/projectSourceProjection.ts`, `convex/projectWorkLoad.ts`, `src/exchange-client.ts`, `src/exchange-convex-fetch.ts`, `web/src/HostedWork.tsx`.
- **B3:** `convex/projectWork.ts`, `src/exchange-client.ts`, `src/exchange-convex-fetch.ts`, `web/src/HostedWork.tsx`.
- **B4:** `convex/projectExchangeActions.ts`, `convex/projectSourceProjection.ts`, `convex/projectWork.ts`, `convex/projectWorkLoad.ts`, `src/exchange-client.ts`, `src/exchange-convex-fetch.ts`, `web/src/HostedWork.tsx`.
- **B5:** `convex/projectWork.ts`, `src/cli.ts`, `src/exchange-client.ts`, `src/exchange-convex-fetch.ts`, `src/host-binding.ts`, `src/mcp-agent-workflow.ts`, `src/work-store.ts`, `web/src/HostedWork.tsx`.
- **B6:** `src/exchange-client.ts`, `src/exchange-convex-fetch.ts`, `src/work-source-return-chunks.ts`, `web/src/HostedWork.tsx`.
- **B7:** `src/cli.ts`, `src/exchange-client.ts`, `src/host-binding.ts`, `src/mcp-agent-workflow.ts`, `src/work-store.ts`.
- **B8:** `web/src/HostedWork.tsx`.

#### B1.6c — owner relay/activity

| Module                                 |       LOC | Last surviving callers |
| -------------------------------------- | --------: | ---------------------- |
| `src/owner-acceptance-consumer.ts`     |       279 | C1                     |
| `src/owner-acceptance.ts`              |        60 | C2                     |
| `src/owner-lifecycle.ts`               |       110 | C1                     |
| `src/owner-lifecycle-schema.ts`        |        15 | C3                     |
| `src/owner-recheck.ts`                 |        83 | C1                     |
| `src/owner-request-publication.ts`     |        37 | C1                     |
| `src/owner-sync-types.ts`              |        28 | C4                     |
| `src/agent-hosted-sync.ts`             |       348 | C5                     |
| `src/agent-activity-snapshot.ts`       |        42 | C5                     |
| `convex/ownerAcceptance.ts`            |       271 | C6                     |
| `convex/ownerLifecycle.ts`             |        75 | C7                     |
| `convex/projectOwnerSync.ts`           |       132 | C4                     |
| `web/src/lane/OwnerDecision.tsx`       |       151 | C8                     |
| `web/src/lane/owner-decision-model.ts` |        77 | C8                     |
| `web/src/lane/OwnerLifecycle.tsx`      |       163 | C7                     |
| **Whole-file scope**                   | **1,871** |                        |

- **C1:** `src/host-command.ts`, `src/http.ts`.
- **C2:** `src/native-work.ts`.
- **C3:** `src/host-command.ts`, `src/http.ts`, `web/src/PlanningIntents.tsx`, `web/src/intents/HostedIntents.tsx`, `web/src/lane/HostedLane.tsx`.
- **C4:** `src/agent-workflow.ts`, `src/github-sync-status.ts`, `src/host-command.ts`, `src/http.ts`, `src/mcp.ts`, `src/presence-worker.ts`.
- **C5:** `src/agent-workflow.ts`, `src/host-command.ts`, `src/mcp.ts`, `src/presence-worker.ts`.
- **C6:** `convex/projectWorkActions.ts`, `src/host-command.ts`, `src/http.ts`, `web/src/HostedWork.tsx`, `web/src/PlanningIntents.tsx`, `web/src/intents/HostedIntents.tsx`, `web/src/lane/HostedLane.tsx`.
- **C7:** `web/src/PlanningIntents.tsx`, `web/src/intents/HostedIntents.tsx`, `web/src/lane/HostedLane.tsx`.
- **C8:** `web/src/HostedWork.tsx`.

#### B1.8 — reconciliation/baselines

| Module                             |     LOC | Last surviving callers |
| ---------------------------------- | ------: | ---------------------- |
| `src/native-companion.ts`          |     470 | D1                     |
| `src/exchange-reconcile.ts`        |     195 | D2                     |
| `src/native-exchange-reconcile.ts` |      57 | D1                     |
| `src/native-exchange-baseline.ts`  |      84 | D3                     |
| `src/exchange-journal-delta.ts`    |     100 | D2                     |
| `src/native-closure-validation.ts` |      60 | D1                     |
| `src/work-journal-page.ts`         |      24 | D2                     |
| **Whole-file scope**               | **990** |                        |

- **D1:** `src/cli.ts`, `src/host-binding.ts`, `src/mcp-agent-workflow.ts`, `src/work-store.ts`, `src/work.ts`.
- **D2:** `src/cli.ts`, `src/host-binding.ts`, `src/mcp-agent-workflow.ts`, `src/work-store.ts`.
- **D3:** `src/cli.ts`, `src/host-binding.ts`, `src/mcp-agent-workflow.ts`, `src/native-exchange.ts`, `src/work-store.ts`.

#### B1.6a — auto exchange/spend pause

| Module                               |     LOC | Last surviving callers |
| ------------------------------------ | ------: | ---------------------- |
| `src/auto-exchange.ts`               |     341 | E1                     |
| `src/auto-exchange-status.ts`        |      97 | E2                     |
| `src/auto-exchange-spend.ts`         |      83 | E3                     |
| `src/auto-exchange-usage-command.ts` |      81 | E1                     |
| `src/auto-exchange-wake.ts`          |      69 | E1                     |
| `src/auto-exchange-notify.ts`        |      53 | E4                     |
| `src/auto-exchange-state.ts`         |      45 | E3                     |
| **Whole-file scope**                 | **769** |                        |

- **E1:** `src/host-binding.ts`, `src/work-store.ts`.
- **E2:** `src/host-command.ts`, `src/pending-status-read.ts`, `src/pending-status.ts`.
- **E3:** `src/host-binding.ts`, `src/host-command.ts`, `src/pending-status-read.ts`, `src/pending-status.ts`, `src/work-store.ts`.
- **E4:** `src/host-binding.ts`, `src/landing-worker-wake.ts`, `src/landing-worker.ts`, `src/work-store.ts`.

#### B1.8 — freshness/unsynced UI

| Module                                  |     LOC | Last surviving callers |
| --------------------------------------- | ------: | ---------------------- |
| `convex/projectFreshness.ts`            |      74 | F1                     |
| `src/hosted-freshness.ts`               |      23 | F2                     |
| `web/src/shell/HostedFreshnessLine.tsx` |      45 | F3                     |
| `web/src/ui/generation-freshness.ts`    |       9 | F4                     |
| **Whole-file scope**                    | **151** |                        |

- **F1:** `convex/projectWorkIndex.ts`.
- **F2:** `convex/projectWorkIndex.ts`, `web/src/HostedLanes.tsx`, `web/src/cockpit/HostedNow.tsx`, `web/src/cockpit/LaneRow.tsx`, `web/src/hosted-work-index.ts`, `web/src/intents/IntentBoard.tsx`, `web/src/intents/IntentDetail.tsx`, `web/src/intents/IntentParts.tsx`, `web/src/lane/HostedLane.tsx`, `web/src/lane/LaneParts.tsx`, `web/src/shell/Attention.tsx`, `web/src/shell/HostedStrip.tsx`, `web/src/ui/Rail.tsx`, `web/src/ui/primitives.tsx`, `web/src/views/LaneViews.tsx`, `web/src/views/ViewPage.tsx`, `web/src/views/WorkMap.tsx`, `web/src/views/intent-views.ts`.
- **F3:** `web/src/shell/HostedStrip.tsx`.
- **F4:** `web/src/HostedLanes.tsx`, `web/src/cockpit/HostedNow.tsx`, `web/src/cockpit/LaneRow.tsx`, `web/src/intents/IntentBoard.tsx`, `web/src/intents/IntentDetail.tsx`, `web/src/intents/IntentParts.tsx`, `web/src/lane/HostedLane.tsx`, `web/src/lane/LaneParts.tsx`, `web/src/shell/Attention.tsx`, `web/src/shell/HostedStrip.tsx`, `web/src/ui/Rail.tsx`, `web/src/ui/primitives.tsx`, `web/src/views/LaneViews.tsx`, `web/src/views/ViewPage.tsx`, `web/src/views/WorkMap.tsx`.

#### B1.6c — conditional owner-derived display

| Module                             |     LOC | Last surviving callers |
| ---------------------------------- | ------: | ---------------------- |
| `src/owner-derived.ts`             |     272 | G1                     |
| `src/owner-derived-pages.ts`       |     106 | G1                     |
| `src/owner-derived-local.ts`       |      68 | G2                     |
| `convex/projectOwnerDerived.ts`    |     329 | G3                     |
| `convex/projectOwnerIndexRows.ts`  |     100 | G4                     |
| `convex/projectOwnerProjection.ts` |      82 | G5                     |
| **Whole-file scope**               | **957** |                        |

- **G1:** `convex/projectExchangeActions.ts`, `convex/projectSourceProjection.ts`, `convex/projectWorkLoad.ts`, `src/exchange-client.ts`, `src/exchange-convex-fetch.ts`, `src/native-exchange.ts`, `web/src/HostedWork.tsx`.
- **G2:** `src/native-exchange.ts`.
- **G3:** `convex/projectExchangeActions.ts`, `convex/projectSourceProjection.ts`, `convex/projectWorkLoad.ts`, `src/exchange-client.ts`, `src/exchange-convex-fetch.ts`, `web/src/HostedWork.tsx`.
- **G4:** `src/exchange-client.ts`, `src/exchange-convex-fetch.ts`, `web/src/HostedWork.tsx`.
- **G5:** `convex/projectSourceProjection.ts`.

#### B1.7 — format conversion

| Module                                    |     LOC | Last surviving callers |
| ----------------------------------------- | ------: | ---------------------- |
| `src/work-intent-converter.ts`            |     232 | H1                     |
| `src/work-intent-migration.ts`            |     107 | H2                     |
| `src/hosted-intent-migration-client.ts`   |      74 | H3                     |
| `convex/projectIntentMigration.ts`        |     156 | H3                     |
| `convex/projectIntentMigrationActions.ts` |     117 | H3                     |
| **Whole-file scope**                      | **686** |                        |

- **H1:** `src/work-hosted-intents.ts`, `src/work-intent-local.ts`, `src/work.ts`.
- **H2:** `src/work.ts`.
- **H3:** `src/hosted-work-client.ts`.

#### B1.8 — legacy hosted accept/review

| Module                               |       LOC | Last surviving callers |
| ------------------------------------ | --------: | ---------------------- |
| `web/src/IntentDelivery.tsx`         |        92 | I1                     |
| `web/src/HostedChannels.tsx`         |       200 | I1                     |
| `web/src/NativeSourceReview.tsx`     |       459 | I1                     |
| `web/src/lane/HostedReview.tsx`      |       511 | I1                     |
| `web/src/lane/ReviewStory.tsx`       |       151 | I1                     |
| `web/src/lane/RevertAcceptance.tsx`  |       105 | I1                     |
| `web/src/lane/RequestChanges.tsx`    |        68 | I1                     |
| `web/src/lane/review-model.ts`       |        68 | I1                     |
| `web/src/lane/ReviewDisposition.tsx` |        52 | I1                     |
| `web/src/lane/ReviewCheck.tsx`       |        45 | I1                     |
| **Whole-file scope**                 | **1,751** |                        |

- **I1:** `web/src/HostedWork.tsx`.

#### Surviving modules with split edits

These are whole-module measurements, **not additional removable LOC**. The
calling function/entry point below is the last consumer of the retiring portion;
retained functions still have normal callers. Re-run impact selection at deletion.

| Module                                |   LOC | Retiring portion and last caller/boundary                                                                                                                                                                                                                        |
| ------------------------------------- | ----: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/native-exchange.ts`              |   821 | Push prepare/push halves; keep pullNativeExchange and shared ContentPin/manifest/transport types for recovery-source and checkouts. Last push callers: host-cli, exchange-cli, bound-exchange.                                                                   |
| `src/exchange-client.ts`              |   698 | Publication/migration/journal/returnSource halves; keep current/objects/missing/upload/manifest/download for saves and cache. Last push/return callers: host-cli, native-exchange and exchange-convex-fetch; recovery-transport still needs journal until B1.5a. |
| `convex/projectExchangeActions.ts`    |   524 | Publication/published/publish/completeHistory entry points; keep checkpoint/manifest/downloadBatch/downloadPart/objectBytes/exchangeMetadata. Last callers: exchange-client and host-cli (via client).                                                           |
| `src/host-binding.ts`                 |   212 | Push, autoExchange and acceptanceOwner configuration; last consumers: host-command, bound-exchange, auto-exchange-wake, owner-acceptance-consumer.                                                                                                               |
| `src/host-command.ts`                 |   190 | Listen/sync-agent/auto-sync/spend flags, flush consumer and status wiring; last caller: host-cli.                                                                                                                                                                |
| `src/host-cli.ts`                     |   277 | Creation prepare/push/completeHistory replaced by B1.2c seed; entry: CLI host.                                                                                                                                                                                   |
| `src/cli.ts`                          |   442 | Exchange/migrate-archive dispatch; top-level executable.                                                                                                                                                                                                         |
| `src/mcp.ts`                          |   302 | Owner activity/reconcile command exposure; entry: MCP.                                                                                                                                                                                                           |
| `src/mcp-agent-workflow.ts`           |   269 | forge_exchange and forge_migrate_archive exposure; entry: MCP agent mode.                                                                                                                                                                                        |
| `src/native-work.ts`                  |   609 | Owner-request compose/accept branch and creation/promotion ladder; callers: WorkService and init-native CLI; unbound acceptance stays.                                                                                                                           |
| `src/work.ts`                         |   963 | reconcile-hosted-work and migrate-intents dispatch; callers: CLI/MCP/HTTP Work service.                                                                                                                                                                          |
| `src/work-records.ts`                 |   389 | recordPendingExchange on writes; WorkStore and record transactions still need record storage.                                                                                                                                                                    |
| `src/work-store.ts`                   |   283 | Auto-exchange wakes and creation/format promotion; WorkService/record transactions retain storage.                                                                                                                                                               |
| `src/landing-worker.ts`               |   238 | notifyAutoExchange after landing; native unbound landing controller survives.                                                                                                                                                                                    |
| `src/landing-worker-wake.ts`          |    28 | notifyAutoExchange wake; native Work writers retain landing wakes.                                                                                                                                                                                               |
| `src/presence-worker.ts`              |   294 | queueAgentSync; Lane presence callers remain.                                                                                                                                                                                                                    |
| `src/agent-workflow.ts`               |   884 | B5 relay scheduling; agent CLI/MCP lifecycle remains.                                                                                                                                                                                                            |
| `src/http.ts`                         |   128 | startOwnerAcceptanceListener; CLI serve remains Git/Work transport.                                                                                                                                                                                              |
| `src/github-sync-status.ts`           |    81 | projectOwnerSync display publication; GitHub mirror/status callers remain.                                                                                                                                                                                       |
| `src/pending-status.ts`               |   374 | Auto-exchange projection; agent status callers remain.                                                                                                                                                                                                           |
| `src/pending-status-read.ts`          |   102 | Auto-exchange projection; pending-status callers remain.                                                                                                                                                                                                         |
| `src/exchange-convex-fetch.ts`        |   124 | Source-return/supersede RPC routing; exchange-client retains object transport.                                                                                                                                                                                   |
| `convex/projectWork.ts`               |   602 | detachReturnMetadata/requireActiveReturn and retirePartition scheduling; projectWorkActions retains legacy replay until folded.                                                                                                                                  |
| `convex/projectWorkLoad.ts`           |   195 | publicationSnapshot and migration replay; projectWork query/action callers need a replacement before deletion.                                                                                                                                                   |
| `convex/projectWorkIndex.ts`          |   227 | projectFreshness projection; hosted Work reads remain.                                                                                                                                                                                                           |
| `convex/projectWorkActions.ts`        |   249 | acceptChannel native owner relay and legacy selection branch; hosted-work-client/legacy browser accept must route to hosted landing.                                                                                                                             |
| `convex/projectSourceProjection.ts`   |   165 | Owner projection dependency; callers: projectWorkIndexActions and projectIntentMigrationActions. Verify projectHostedProjection parity before deleting G.                                                                                                                                         |
| `convex/projectWorkCommand.ts`        |   177 | hostedChannelMoves hydration; projectWorkActions uses legacy Work command replay until folded.                                                                                                                                                                   |
| `convex/projectWorkIndexedCommand.ts` |   182 | hostedChannelMoves hydration; projectWorkActions indexed command path.                                                                                                                                                                                           |
| `convex/projectWorkProjection.ts`     |   250 | hostedChannelMoves read/write; projectWork command/index paths.                                                                                                                                                                                                  |
| `convex/projectMain.ts`               |   112 | Legacy selected-main read; hosted-main-checkout must use projectHostedChannels current in server mode.                                                                                                                                                           |
| `web/src/HostedWork.tsx`              |   823 | Exchange/source-return and legacy IntentDelivery wiring; hosted project shell remains.                                                                                                                                                                           |
| `web/src/ProjectBackups.tsx`          |   556 | Publish UI; project backup settings remain.                                                                                                                                                                                                                      |
| `web/src/hosted-handoff.ts`           |   144 | Printed reconcile-hosted-work command; copy-prompt/handoff callers.                                                                                                                                                                                              |
| `src/work-types.ts`                   | 1,329 | Legacy workSchema union and refine gates; shared WorkData imports remain across src/convex/web.                                                                                                                                                                  |
| `src/work-unified-types.ts`           |   104 | Dual isUnifiedWork/safeParseWork paths; WorkStore and hosted readers retain current-format parsing.                                                                                                                                                              |
| `src/work-hosted-intents.ts`          |    70 | Hosted journal converter; projectWorkLoad, projectIntentMigrationActions, work-backup, work-metadata and source-return journal need original replay until compaction. Keep restore-only conversion.                                      |
| `src/work-intent-local.ts`            |    58 | noteId imported from work-intent-converter; ordinary unified Intent/note writes survive: extract noteId before making converter restore-only.                                                                                                                    |
| `src/work-format.ts`                  |    13 | B1.7 creation/current-format gate or lazy-promotion site; retain its ordinary native/Work callers, remove the legacy branch after migration. Historic replay keeps its original representation.                                                                  |
| `src/native-git.ts`                   |   422 | B1.7 creation/current-format gate or lazy-promotion site; retain its ordinary native/Work callers, remove the legacy branch after migration. Historic replay keeps its original representation.                                                                  |
| `src/hosted-bootstrap.ts`             |    78 | B1.7 creation/current-format gate or lazy-promotion site; retain its ordinary native/Work callers, remove the legacy branch after migration. Historic replay keeps its original representation.                                                                  |
| `src/hosted-github-bootstrap.ts`      |   117 | B1.7 creation/current-format gate or lazy-promotion site; retain its ordinary native/Work callers, remove the legacy branch after migration. Historic replay keeps its original representation.                                                                  |
| `src/work-autonomy.ts`                |   135 | B1.7 creation/current-format gate or lazy-promotion site; retain its ordinary native/Work callers, remove the legacy branch after migration. Historic replay keeps its original representation.                                                                  |
| `src/landing-batch-store.ts`          |   466 | B1.7 creation/current-format gate or lazy-promotion site; retain its ordinary native/Work callers, remove the legacy branch after migration. Historic replay keeps its original representation.                                                                  |
| `src/work-channel.ts`                 |   512 | B1.7 creation/current-format gate or lazy-promotion site; retain its ordinary native/Work callers, remove the legacy branch after migration. Historic replay keeps its original representation.                                                                  |
| `src/post-accept-selection.ts`        |    83 | B1.7 creation/current-format gate or lazy-promotion site; retain its ordinary native/Work callers, remove the legacy branch after migration. Historic replay keeps its original representation.                                                                  |
| `src/native-contribution-register.ts` |   138 | B1.7 creation/current-format gate or lazy-promotion site; retain its ordinary native/Work callers, remove the legacy branch after migration. Historic replay keeps its original representation.                                                                  |
| `src/work-record-transaction.ts`      |   434 | B1.7 creation/current-format gate or lazy-promotion site; retain its ordinary native/Work callers, remove the legacy branch after migration. Historic replay keeps its original representation.                                                                  |
| `src/work-lifecycle.ts`               |    29 | B1.7 creation/current-format gate or lazy-promotion site; retain its ordinary native/Work callers, remove the legacy branch after migration. Historic replay keeps its original representation.                                                                  |
| `src/work-metadata.ts`                |   268 | B1.7 creation/current-format gate or lazy-promotion site; retain its ordinary native/Work callers, remove the legacy branch after migration. Historic replay keeps its original representation.                                                                  |
| `src/native-pr.ts`                    |   259 | B1.7 creation/current-format gate or lazy-promotion site; retain its ordinary native/Work callers, remove the legacy branch after migration. Historic replay keeps its original representation.                                                                  |
| `src/work-evidence.ts`                |   208 | B1.7 creation/current-format gate or lazy-promotion site; retain its ordinary native/Work callers, remove the legacy branch after migration. Historic replay keeps its original representation.                                                                  |
| `src/native-objects.ts`               |   102 | B1.7 creation/current-format gate or lazy-promotion site; retain its ordinary native/Work callers, remove the legacy branch after migration. Historic replay keeps its original representation.                                                                  |
| `src/native-work-history.ts`          |   229 | B1.7 creation/current-format gate or lazy-promotion site; retain its ordinary native/Work callers, remove the legacy branch after migration. Historic replay keeps its original representation.                                                                  |
| `src/landing-replay-planner.ts`       |   217 | B1.7 creation/current-format gate or lazy-promotion site; retain its ordinary native/Work callers, remove the legacy branch after migration. Historic replay keeps its original representation.                                                                  |
| `web/src/hosted-work-index.ts`        |   304 | B1.8 freshness/unsynced status or projection consumer; retain the page/component and its route/parent, remove only owner-lag display logic.                                                                                                                      |
| `web/src/HostedLanes.tsx`             |   298 | B1.8 freshness/unsynced status or projection consumer; retain the page/component and its route/parent, remove only owner-lag display logic.                                                                                                                      |
| `web/src/cockpit/HostedNow.tsx`       |   407 | B1.8 freshness/unsynced status or projection consumer; retain the page/component and its route/parent, remove only owner-lag display logic.                                                                                                                      |
| `web/src/cockpit/LaneRow.tsx`         |   161 | B1.8 freshness/unsynced status or projection consumer; retain the page/component and its route/parent, remove only owner-lag display logic.                                                                                                                      |
| `web/src/intents/IntentBoard.tsx`     |   285 | B1.8 freshness/unsynced status or projection consumer; retain the page/component and its route/parent, remove only owner-lag display logic.                                                                                                                      |
| `web/src/intents/IntentDetail.tsx`    |   479 | B1.8 freshness/unsynced status or projection consumer; retain the page/component and its route/parent, remove only owner-lag display logic.                                                                                                                      |
| `web/src/intents/IntentParts.tsx`     |   452 | B1.8 freshness/unsynced status or projection consumer; retain the page/component and its route/parent, remove only owner-lag display logic.                                                                                                                      |
| `web/src/lane/HostedLane.tsx`         |   591 | B1.8 freshness/unsynced status or projection consumer; retain the page/component and its route/parent, remove only owner-lag display logic.                                                                                                                      |
| `web/src/lane/LaneParts.tsx`          |   176 | B1.8 freshness/unsynced status or projection consumer; retain the page/component and its route/parent, remove only owner-lag display logic.                                                                                                                      |
| `web/src/shell/Attention.tsx`         |   223 | B1.8 freshness/unsynced status or projection consumer; retain the page/component and its route/parent, remove only owner-lag display logic.                                                                                                                      |
| `web/src/shell/HostedStrip.tsx`       |    64 | B1.8 freshness/unsynced status or projection consumer; retain the page/component and its route/parent, remove only owner-lag display logic.                                                                                                                      |
| `web/src/ui/Rail.tsx`                 |    70 | B1.8 freshness/unsynced status or projection consumer; retain the page/component and its route/parent, remove only owner-lag display logic.                                                                                                                      |
| `web/src/ui/primitives.tsx`           |   334 | B1.8 freshness/unsynced status or projection consumer; retain the page/component and its route/parent, remove only owner-lag display logic.                                                                                                                      |
| `web/src/views/LaneViews.tsx`         |   114 | B1.8 freshness/unsynced status or projection consumer; retain the page/component and its route/parent, remove only owner-lag display logic.                                                                                                                      |
| `web/src/views/ViewPage.tsx`          |   332 | B1.8 freshness/unsynced status or projection consumer; retain the page/component and its route/parent, remove only owner-lag display logic.                                                                                                                      |
| `web/src/views/WorkMap.tsx`           |   325 | B1.8 freshness/unsynced status or projection consumer; retain the page/component and its route/parent, remove only owner-lag display logic.                                                                                                                      |
| `web/src/views/intent-views.ts`       |    86 | B1.8 freshness/unsynced status or projection consumer; retain the page/component and its route/parent, remove only owner-lag display logic.                                                                                                                      |
| `web/src/intents/HostedIntents.tsx`   |   487 | B1.6c OwnerLifecycle/owner-request call site; retain the page and re-parent lifecycle onto hosted records.                                                                                                                                                       |
| `web/src/PlanningIntents.tsx`         |   361 | B1.6c OwnerLifecycle/owner-request call site; retain the page and re-parent lifecycle onto hosted records.                                                                                                                                                       |

The B group has a live retained dependency that the input inventory understated:
`src/work-source-return-chunks.ts` (69 LOC) imports **and calls**
`validateSourceReturn` from `src/work-source-return.ts`; `src/work-metadata.ts`
uses the chunk validator for historical journal replay. B1.6b must extract/retain
that validator with its original digest semantics, not delete it merely because
the new return RPC disappears. Similarly, `work-intent-converter.ts` exports
`noteId`, used by live `work-intent-local.ts`; B1.7 keeps that helper outside the
restore-only converter. `projectWorkLoad.ts` still calls `publicationSnapshot`
from `projectSourceReturnMetadata.ts`; replace/fold that read before removing B.

Keep `src/native-companion-types.ts` (41 LOC): `work-types.ts` retains
`nativeCompanionReceipts`. Keep `convex/ownerAcceptanceFields.ts` (42 LOC) and
all retired table schemas until B1.9. Keep object upload/download/retry/cache and
chunk modules, `work-exchange-records`/`work-exchange-delta`,
`native-exchange-tree`/`stream`/`files`, `recovery-capture`, `recovery-inventory`,
`native-backup`, `work-backup`/`work-backup-archive`, and the Convex exchange
reader/cache/validation modules. Saved-state recovery, cache, checkpoint upload
or historic replay still calls them. `src/native-checkpoint-publication.ts` is
native checkpoint lock preparation, **not** hosted push publication; keep it.
Unbound native Work and its landing worker also stay.

#### Tests, fixtures and benchmark scripts

These are current whole-file sizes for the input inventory's deletion-specific
coverage, **not a recommendation to delete a test that still proves a retained
path**. Test entry points are `node --test`/the selected test runner; fixtures and
workers are reached from the named test family. Re-parent useful review/restore
assertions first. Mixed tests (for example `host-cli`, `hosted-work`,
`landing-worker`, `exchange-request`, `project-exchange-reader`,
`work-exchange-delta` and upload scheduling) retain their surviving coverage.

| Slice/group | Test/fixture/worker LOC (`wc -l`)                       | Current last caller                      |
| ----------- | ------------------------------------------------------- | ---------------------------------------- |
| A           | `tests/native-exchange.test.mjs` (832)                  | Selected test runner                     |
| A           | `tests/project-exchange.test.mjs` (797)                 | Selected test runner                     |
| A           | `tests/work-exchange-records-hosted.test.mjs` (654)     | Selected test runner                     |
| A           | `tests/agent-prepared-publication.test.mjs` (395)       | Selected test runner                     |
| A           | `tests/publication-read-churn.test.mjs` (359)           | Selected test runner                     |
| A           | `tests/r3a-publication.test.mjs` (354)                  | Selected test runner                     |
| A           | `tests/project-exchange-publication.test.mjs` (320)     | Selected test runner                     |
| A           | `tests/pending-exchange.test.mjs` (276)                 | Selected test runner                     |
| A           | `tests/exchange-contention.test.mjs` (234)              | Selected test runner                     |
| A           | `tests/native-exchange-cutover.test.mjs` (224)          | Selected test runner                     |
| A           | `tests/exchange-pinned-snapshot.test.mjs` (186)         | Selected test runner                     |
| A           | `tests/native-exchange-records.test.mjs` (172)          | Selected test runner                     |
| A           | `tests/exchange-latency-contract.test.mjs` (166)        | Selected test runner                     |
| A           | `tests/exchange-latency.test.mjs` (116)                 | Selected test runner                     |
| A           | `tests/project-exchange-fixture.mjs` (142)              | project-exchange test family             |
| B           | `tests/hosted-return-progress.test.mjs` (768)           | Selected test runner                     |
| B           | `tests/r3b-source-return.test.mjs` (250)                | Selected test runner                     |
| B           | `tests/work-source-return.test.mjs` (258)               | Selected test runner                     |
| B           | `tests/source-return-commit.test.mjs` (292)             | Selected test runner                     |
| B           | `tests/source-return-egress.test.mjs` (257)             | Selected test runner                     |
| B           | `tests/source-return-incremental.test.mjs` (217)        | Selected test runner                     |
| B           | `tests/source-return-index.test.mjs` (318)              | Selected test runner                     |
| B           | `tests/source-return-memory-fixture.mjs` (220)          | source-return memory/prepare test family |
| B           | `tests/source-return-memory.test.mjs` (192)             | Selected test runner                     |
| B           | `tests/source-return-post-prepare-memory.test.mjs` (35) | Selected test runner                     |
| B           | `tests/source-return-post-prepare-worker.mjs` (299)     | source-return memory/prepare test family |
| B           | `tests/source-return-prepare-logs.test.mjs` (140)       | Selected test runner                     |
| B           | `tests/source-return-prepare-memory-worker.mjs` (293)   | source-return memory/prepare test family |
| B           | `tests/source-return-prepare-memory.test.mjs` (89)      | Selected test runner                     |
| B           | `tests/source-return-prepare.test.mjs` (244)            | Selected test runner                     |
| B           | `tests/source-return-progress.test.mjs` (142)           | Selected test runner                     |
| B           | `tests/source-return-records.test.mjs` (169)            | Selected test runner                     |
| B           | `tests/source-return-supersede.test.mjs` (165)          | Selected test runner                     |
| C           | `tests/owner-acceptance.test.mjs` (968)                 | Selected test runner                     |
| C           | `tests/agent-hosted-sync.test.mjs` (483)                | Selected test runner                     |
| C           | `tests/r3c-owner-only.test.mjs` (374)                   | Selected test runner                     |
| C           | `tests/ui-owner-acceptance.test.mjs` (49)               | Selected test runner                     |
| D           | `tests/native-companion.test.mjs` (554)                 | Selected test runner                     |
| D           | `tests/exchange-journal-delta.test.mjs` (482)           | Selected test runner                     |
| D           | `tests/native-closure-validation.test.mjs` (231)        | Selected test runner                     |
| E           | `tests/auto-exchange.test.mjs` (755)                    | Selected test runner                     |
| E           | `tests/auto-exchange-usage-command.test.mjs` (100)      | Selected test runner                     |
| E           | `tests/auto-exchange-spend.test.mjs` (76)               | Selected test runner                     |
| F           | `tests/hosted-freshness.test.mjs` (191)                 | Selected test runner                     |
| G           | `tests/owner-derived.test.mjs` (448)                    | Selected test runner                     |
| H           | `tests/intent-merge-local.test.mjs` (553)               | Selected test runner                     |
| H           | `tests/hosted-intent-migration.test.mjs` (425)          | Selected test runner                     |
| H           | `tests/intent-merge.test.mjs` (291)                     | Selected test runner                     |
| H           | `tests/hosted-intent-migration-cli.test.mjs` (269)      | Selected test runner                     |
| H           | `tests/work-format-compatibility.test.mjs` (214)        | Selected test runner                     |
| I           | `tests/ui-review.test.mjs` (91)                         | Selected test runner                     |

Benchmarks are explicit operator entry points; their CLI runner is the last caller:

| Script                                  | LOC |
| --------------------------------------- | --: |
| `scripts/measure-exchange-delta.mjs`    | 109 |
| `scripts/measure-exchange-latency.mjs`  | 256 |
| `scripts/measure-owner-derived.mjs`     |  50 |
| `scripts/measure-work-exchange.mjs`     | 125 |
| `scripts/measure-work-record-delta.mjs` | 128 |
| `scripts/measure-source-upload.mjs`     |  80 |

The A–I whole-file production scope totals **13,958 LOC** before
split edits, test/benchmark changes, retained helpers and review re-parenting.
This is the LOC baseline for B1.1; runtime metrics do not move in this docs slice.
Metrics 3 (dropped landings), 5 (operator interventions) and 7 (authority/cache lag)
remain unmeasured here, not assumed zero. The drain/rollback procedure is designed
to preserve them; B1.5b must supply the live before/after evidence.

## Account data

Account, then "Your Forge data", then "Refresh inventory" lists everything you own across seven families. "Download metadata" saves the inventory with hashes. It holds no source, raw Work, secret values or credentials. Use project archives, import snapshot controls and Secret Object export for those.

You can select owned items for removal. Projects and imports use their normal final-deletion paths, agent grants are revoked, teams are cleaned up and personal saved items are removed. "Leave incoming access" removes only your own rows in things shared with you. Other people's grants and records are untouched. An interrupted request resumes from "Retained original requests". Receipts, downloaded copies and Clerk and GitHub identities remain.

## Client error reports

Signed-in hosted browsers record failures in the Convex `clientErrors` table (see [architecture](architecture.md#client-error-capture)). Each row holds the reporting account's auth subject, kind (`error`, `unhandledrejection`, `render`, `mutation`, `action`), scrubbed message and stack, route path, build hash, and when known the Convex function name, error code and project. Rows never hold source contents, URL query strings or recognized tokens.

To read a project's reports, call `clientErrors:recent` with `{projectId, paginationOpts}` as the project owner; anyone else receives `PROJECT_UNAVAILABLE`. There is no browser view yet. Operators can also inspect the table in the Convex dashboard. Match `build` against the hashed `assets/index-<hash>.js` of a deployment to find the build that failed.

Reports are kept until removed by hand: there is no automatic retention, and they are not yet part of "Your Forge data" inventory or project and account deletion.

## Secret Object recovery

Keep the exact `FORGE_SECRET_KEYS` keyring, a JSON object with an `active` key ID and a `keys` map of base64 32-byte keys. Back it up apart from the database. To rotate the encryption key, add a new key and mark it active. Never remove an old one while any export or snapshot may need it. Rotating the credential and rotating the key are different things.

Open Secret Objects, choose an object, then "Export or delete object". "Download encrypted object" saves every version, grant and audit event, plus its SHA-256. If the object changes mid-download, retry. The file has no key material. In a private Node process, decrypt it with `recoverSecretArchive(text, keyring)` from `@nanthai/forge`. The result is plaintext in memory, and grants are historical only. Create a replacement through `secretActions.create` with a new operation UUID and re-grant access explicitly.

To restore live IDs, grants and audit together, restore a whole-instance snapshot with the original keys (see below).

"Permanently delete object" removes encrypted values, grants and audit rows and leaves a minimal receipt. Reconcile an interrupted deletion from "Deletion receipts". Existing downloads and the GitHub credential itself are unaffected, so revoke the credential at GitHub as well.

## R2 object storage (write path)

New project objects can be uploaded straight to Cloudflare R2 instead of Convex file storage. This is the R1 write path and R2 dual read of the [R2 storage plan](r2-storage-plan.md). Reads dispatch per object, so an opted-in project pushes, publishes and pulls end to end. Keep it to throwaway projects until a real-bucket smoke has passed.

### Convex environment

Read only inside Convex functions and never sent to clients.

| Name | Meaning |
| --- | --- |
| `FORGE_BLOBS` | `r2` turns the write path on for opted-in projects. Anything else, or unset, keeps Convex storage. |
| `R2_ACCOUNT_ID` | Cloudflare account id; the endpoint is `https://<account>.r2.cloudflarestorage.com/<bucket>/<key>`. |
| `R2_BUCKET` | Private bucket name, for example `forge-blobs-dev`. |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | S3 credentials for an R2 API token with Object Read & Write on that one bucket. |

With the flag on and an opted-in project, a missing variable fails the upload with `R2_NOT_CONFIGURED` rather than falling back.

### Per-project opt-in

The owner runs `projectObjectCommit:setR2Writes` with `{ projectId, enabled }`. The default is off. The deployment admin can set it with the internal `projectObjectCommit:setR2WritesAdmin` (`npx convex run`), which is how smoke tests flip it. Both the flag and the opt-in must be on for R2 writes. Rollback: set `enabled` to false or unset `FORGE_BLOBS`; new writes return to Convex storage and nothing is deleted.

### Behaviour to know

- Upload URLs expire after 15 minutes. Objects are never overwritten; a repeated upload of the same content is accepted as already stored.
- Download URLs expire after 5 minutes; readers sign again once on expiry. Objects already committed to R2 stay readable when `FORGE_BLOBS` is unset, as long as the `R2_*` settings are present; without them reads of those objects fail with `R2_NOT_CONFIGURED`.
- A corrupt or tampered object is rejected with `BLOB_DIGEST_MISMATCH` and never written.
- Prepared but uncommitted objects are not swept yet (slice R7).

## Self-host

The same Convex schema runs on the pinned official local Convex backend (SQLite and local files). The launcher supports macOS arm64 and Linux x64. It is a loopback development setup with no TLS, public ingress or production guarantee.

```sh
npm ci --ignore-scripts
node scripts/selfhost.mjs init DIR BACKEND.zip PORT   # verifies the pinned SHA-256 first
node scripts/selfhost.mjs start DIR                   # foreground; Ctrl-C stops it
```

Download the backend zip for your platform from the pinned `get-convex/convex-backend` release. The pins and hashes live in `scripts/selfhost.mjs`. A pin cannot be swapped in place. `init` refuses an existing directory.

Always pass `--env-file DIR/deployment.env` to every `npx convex` command so you never touch the cloud dev project. Keep `deployment.env` private since it holds the admin key. For a new anonymous instance:

```sh
npx convex env set CLERK_JWT_ISSUER_DOMAIN '' --env-file DIR/deployment.env
npx convex env set FORGE_CLI_ISSUER '' --env-file DIR/deployment.env
npx convex deploy --env-file DIR/deployment.env --typecheck enable --yes
```

Convex rejects reads of unset auth-config variables even inside an optional guard. Set both issuer variables explicitly; an empty string keeps that provider disabled.

Build the browser with `VITE_CLERK_PUBLISHABLE_KEY=''` and `node --env-file=DIR/deployment.env ... vite build web --mode hosted`. For private access, set the Clerk and GitHub App variables from [development](development.md) on the instance. They are not part of snapshots, so set them again on a restored instance.

**Backup:** `npx convex export --include-file-storage --path DIR/backup.zip --env-file DIR/deployment.env`. A snapshot holds documents and files. It does not hold deployed code, backend environment, instance config or local Work stores. Save the Forge commit and lockfile with it.

**Restore:** start a fresh instance, import first, then deploy: `npx convex import backup.zip --env-file ...` and then `npx convex deploy`. Deploying a newer schema first can clash table IDs. A restored snapshot can bring back older grants, so recheck current access.

**Backend upgrade:** create a fresh instance with the new pin and restore a snapshot into it. Keep the old instance until you accept the result. Rollback restores a snapshot into a fresh instance on the old pin.

**Storage:** the launcher accepts an optional private dotenv file as a third `start` argument. It sets native S3 storage with five buckets (`S3_STORAGE_EXPORTS_BUCKET`, `_SNAPSHOT_IMPORTS_`, `_MODULES_`, `_FILES_`, `_SEARCH_`) and `AWS_*` credentials. Changing the argument on an existing database does not move its files. Restore a snapshot into a fresh instance instead.

`node scripts/selfhost-smoke.mjs` runs the repeatable check against the pinned public repo `sindresorhus/is-plain-obj`. It needs a read-only `GITHUB_TOKEN`. On failure it reports the stage, a command label with private arguments withheld, exit status and a bounded, secret-redacted diagnostic tail. Raw diagnostics remain in the invocation’s private temporary directory; deployment environment contents are never printed.

**Licenses:** Forge's server is AGPL-3.0-only and the launcher and client are Apache-2.0 (see [LICENSE.md](../LICENSE.md)). The downloaded Convex backend has its own FSL-1.1-Apache-2.0 terms. Inventories: [npm](dependency-licenses.md) and [native backend](native-dependency-licenses.md). The native one is partial and not an SBOM.

## Preview environments

In local Work, "Preview environments" selects a retained Netlify draft under a name. "Roll back to this preview" selects an earlier draft and appends a new move. This changes a local pointer only. It uploads nothing, promotes nothing and checks no health. Use the `select-preview-environment` action with `expectedPrevious` set to the current selection UUID. Back up the Work store, because Convex snapshots do not include it.

### Backfill coordination activity timestamps

After deploying the additive coordination activity index, run
`npx convex run coordinationBackfill:activity '{"cursor":null}'` against the
intended deployment (`--prod` for production). Repeat with the returned cursor
until `isDone` is true. The internal mutation requests 100-row pages with a
500,000-byte read budget and derives optional timestamps from retained Lane/run
summaries. Any page may be replayed, or the process restarted at null. New index
writes populate the same field. Imported-history activity counts are incomplete
until the backfill finishes; source and retained Work history remain intact.

Lossless hosted source acquisition uses the [GitHub project import](operations/github-project-import.md) API, separate from the derived analysis tour.

## Work record collection

```sh
nforge work OWNER '{"action":"collect-records"}' 0
nforge work OWNER '{"action":"collect-records","apply":true,"backup":true}' 0
```

The default is a read-only plan: page counts, physical bytes, reclaimable pages,
projected remaining bytes, and the reasons for every retained page. It takes no
lock, creates no backup and rewrites no records. Source objects and check files
are outside this command's collection scope.

Application holds the owner lock. It requires a verified full-directory copy of
the exact current Work pointer/revision; `backup:true` creates one first as a
sibling `OWNER.records-backup-UUID` directory, including uncheckpointed workspace
files, pending operations and all old pages. The private
`record-collection-backups.json` receipt records that copy's file digests. A new
Work revision requires a new backup. Keep the backup directory for recovery;
restore its complete contents into a separate directory. This full-directory
copy is separate from the portable `export-work` / `restore-native` format.

A page is eligible only when unreachable from the current Work closure, kept
backup Work pointers, protected Lane snapshot pins and local pending
journal/operation metadata. Closed Lane snapshots expire strictly after seven
days from both snapshot and closure; the latest open Lane snapshot stays
protected. Current automatic snapshots contain source pins only. Portable
`export-work` directories and archives contain self-contained Work, so they do
not depend on local record pages. Unknown or damaged metadata stops collection;
unverifiable orphan pages are preserved for diagnosis. Interrupted application
leaves current Work readable; retry recomputes reachability and finishes the
remaining unlinks. Writers announce pending record staging under a short collection fence before
writing any pages. While a live writer is staging, collection conservatively
keeps all pages because its future references are not yet published. Committing
or aborting prepared publication releases that pin. Dead process pins do not
retain pages; any durable pending operation references remain protected.
The staging fence prevents those unpublished pages from being removed.

New pages use zstd when it is smaller than plain JSON. Their identities still
hash the original JSON bytes. Storage manifest `forge-work-records-v3` advertises
this physical capability; v1/v2 pointers and plain JSON pages remain readable
without migration, and the portable Work schema is unchanged. Upgrade every
writer before using v3 owners: old CLIs reject the new storage manifest. Reads
never repack existing pages; existing raw pages shrink only as later writes
produce compressed versions and unreferenced versions are explicitly collected.

Run backend evidence still contains inline verdict arrays. A separate test-name
catalog is deferred: stable names repeat alongside their per-run verdicts. Splitting a run's stable test identities from its verdict/status
vector requires a further record capability and reader/export compatibility work.
