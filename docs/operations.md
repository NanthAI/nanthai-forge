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

`nforge recover NEW_OWNER --command-file recovery.json` guides full native-owner
recovery and reconnects an existing project using current owner authority. The
request contains `{operationId,url,projectId,archivePath?,cacheRoot?}` without
credentials. Keep the operation ID and destination for retry. Saved main/Lanes,
journal revision, exact evidence hashes and unavailable evidence are reported.
See the [recovery drill](operations/recovery-drill.md) for both the weekly
deployment ZIP and surviving-hosted routes, independent native archives, runner
configuration, and returning the old machine as a source client.

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

## Local cleanup

`nforge agent ROOT clean` (MCP `forge_task` action `clean`) reclaims regenerable local disk. It is a dry run unless you send `{"apply":true}`; the dry run lists candidates grouped by kind with bytes and the reason each is safe, plus totals and every skipped item with its reason. Apply recomputes the set under the owner lock and re-validates each item (pass `items` ids from a dry run to limit it; anything that changed is skipped). `kinds` filters:

- `check-retention`: after strictly more than seven days, remove unpinned terminal runs’ source/runtime and shard work copies and keep the final 64 KiB of each combined or shard log at its original path. Terminal receipts (including failure summaries), selection, changes, plans, provider state and selected artifacts stay. Running/queued/preparing runs, explicit release build-run/export pins, resumable or unknown remote executions and in-use directories stay. Acceptance and open-Lane references retain evidence without protecting old bulk; recent checks remain untouched. Both the run end and the individual copy/log must be older than seven days.
- `check-workspaces`: the `workspace/` copy of a finished check run whose process group is gone. `result.json`, logs and artifacts stay.
- `lane-deps`: `node_modules`, `dist` and similar gitignored build directories inside completed or abandoned Lanes.
- `lanes`: the whole directory of a completed or abandoned Lane, only when a capture of it equals the Lane head State; otherwise it is skipped as uncaptured edits. Gitignored files (such as `.env`) are not in State and are deleted with it. `reopen`, `checkpoint`, `sync` and `finish` re-materialize a removed Lane from its head State.
- `exchange-staging`: unreferenced exchange staging older than seven days. Pending operations, old baseline hints that still depend on staging, and retained export references keep their directories. Pending or explicitly retained export manifests pin only the exact check-file bytes they reference; completed preparation baselines retain staging metadata without pinning owner log prefixes. Unreferenced staging, including staging younger than seven days, does not pin old check files. A log pin does not protect its run’s source or shard work copies.
- `objects` (only when named): wraps `inspect-native-objects` and `collect-native-objects`.

Active and paused Lanes, Work records, referenced objects and anything outside ROOT are never touched. Repeating is safe.

With `lifecycle.cleanRegenerableCopies:true`, terminal checks and Lane lifecycle events also sweep the seven-day retention kinds. Retention is automatic only under that existing opt-in; there is no background daemon. It removes old log prefixes permanently and records that fact; rerunning a check reconstructs its source copy, not its original output. Dry runs do not reconcile or rewrite run records.

With `lifecycle.cleanRegenerableCopies:true`, Lane completion and abandonment automatically apply the shared cleanup validator under the owner lock; accepted-work completion also sweeps eligible older copies. Preset defaults are unchanged: Autonomous opts in, while other presets and migrated owners retain their existing setting. Automatic whole-Lane cleanup preserves excluded local settings and arbitrary ignored files outside recognized build directories. Dirty, active, pending, in-use or unverifiable copies stay, with reasons recorded alongside removed paths and `reopen`/rebuild instructions in automatic-action receipts. Terminal native checks retain immediate workspace/runtime cleanup across presets after validating and flushing terminal receipts, logs and selected artifacts; run details report removals or skipped copies. Retained source and evidence stay readable. Retrying a completed finish does not re-materialize its removed closed Lane.

## Object collection

```sh
nforge work OWNER '{"action":"inspect-native-objects"}' 0
nforge work OWNER '{"action":"collect-native-objects"}' 0
```

Inspection counts objects and lists verified unreferenced candidates, and changes nothing. Collection repeats the inspection under the lock and deletes only those objects. It never touches referenced history, Lanes, run files, backups or temporary files. If the retained history cannot be verified, it deletes nothing. Retry after an interruption. Deletions are final, so keep a backup. Collection upgrades an older owner to at least Work format 3, and older CLIs then refuse it.

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
npx convex deploy --env-file DIR/deployment.env --typecheck enable --yes
```

Build the browser with `VITE_CLERK_PUBLISHABLE_KEY=''` and `node --env-file=DIR/deployment.env ... vite build web --mode hosted`. For private access, set the Clerk and GitHub App variables from [development](development.md) on the instance. They are not part of snapshots, so set them again on a restored instance.

**Backup:** `npx convex export --include-file-storage --path DIR/backup.zip --env-file DIR/deployment.env`. A snapshot holds documents and files. It does not hold deployed code, backend environment, instance config or local Work stores. Save the Forge commit and lockfile with it.

**Restore:** start a fresh instance, import first, then deploy: `npx convex import backup.zip --env-file ...` and then `npx convex deploy`. Deploying a newer schema first can clash table IDs. A restored snapshot can bring back older grants, so recheck current access.

**Backend upgrade:** create a fresh instance with the new pin and restore a snapshot into it. Keep the old instance until you accept the result. Rollback restores a snapshot into a fresh instance on the old pin.

**Storage:** the launcher accepts an optional private dotenv file as a third `start` argument. It sets native S3 storage with five buckets (`S3_STORAGE_EXPORTS_BUCKET`, `_SNAPSHOT_IMPORTS_`, `_MODULES_`, `_FILES_`, `_SEARCH_`) and `AWS_*` credentials. Changing the argument on an existing database does not move its files. Restore a snapshot into a fresh instance instead.

`node scripts/selfhost-smoke.mjs` runs the repeatable check against the pinned public repo `sindresorhus/is-plain-obj`. It needs a read-only `GITHUB_TOKEN`.

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
