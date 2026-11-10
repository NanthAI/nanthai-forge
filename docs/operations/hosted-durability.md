# Hosted deployment durability

This procedure backs up a whole Convex deployment, including private table data,
source objects, Work, grants, encrypted Secret Objects and file storage. It is
separate from a Forge project archive and from the canonical local owner's backup.
A hosted copy can lag local accepted `main`; this procedure preserves the hosted
snapshot, not unpublished local work. Keep the local owner and its portable backup.

The tooling is fixture-tested. The owner-approved offsite policy is a weekly
file-inclusive export to R2, keeping the newest four completed copies. Installation
and the first real run are lead actions. The Actions workflow schedules runs only
after it is placed on the chosen repository's default branch and configured.
The backup command never deploys, imports or contacts any account until invoked.

A development-deployment data restore drill passed on 2026-10-20: export 146 s
(787 MB, 27,143 stored files), import about 2 h 17 min, and comparison 243 s with
equal tables, files and Work. Code, authentication and environment were not
redeployed; off-machine owner recovery remains unqualified. Convex scheduled
backups require Pro; the weekly R2 job below uses standard GitHub-hosted Linux
runners. The Mac is only a manual fallback; no deployment is configured by these scripts.

## Object-storage references

New backup/proposal archive transfers, imported artifacts, Zone exports, binary
derivatives and finish-plan JSON use the existing presigned R2 protocol. Exported
rows retain exact keys, sizes and SHA-256 pins: archives use their owning
backup/proposal plus `artifactBlobs`; imports and derivatives use `r2blob:`
references to `artifactBlobs`; finish plans use `projectObjects`. No second R2
component or private in-process object registry is required.

A Convex export preserves these rows, including reservations and tombstones. R2
bytes remain in the configured bucket; including Convex file storage in the ZIP
does not copy R2 objects into it. Retain the corresponding bucket objects when
restoring the table snapshot. The database-only verifier recognizes committed,
nonremoved artifact references regardless of table order, and still refuses
unresolved references or remaining legacy source/derived files. The maintenance
script retains its paged project-prefix inventory and legacy-copy purge; new
R2-only archives have no Convex copy eligible for that purge.

Legacy `_storage` IDs remain readable, including migrated IDs retained as lookup
aliases. New R2-only archive receipts may omit `storageId`; the retained key and
pins identify the original container. The browser and native archive readers use
`backupTransfer:sign`; existing range-action clients remain compatible. The optional receipt storage ID and optional `projectUploadCleanup.r2Key`
need no row migration. Deploy the compatible readers before resuming R2 archive uploads.
R6 backfills the remaining legacy bytes; R7 verifies and purges them afterwards.
The [lead runbook](r2-backfill.md#lead-runbook-r6-r7-and-database-only-backup) lists each live step, its preflight and the owner approval required for R7 deletion.
Neither backfill nor purge is run automatically by this change. The manual
`derivedArtifacts:sweep` handles one bounded legacy orphan page and returns its
cursor; it schedules no recurring or delayed sweep. New R2 derivatives and
archives do not start `_storage` scans.

## Snapshot and backup

Use the accepted Forge source and lockfile, Node 24.22.1+ (24.x), installed dependencies
(`npm ci --ignore-scripts`), and Python 3 for read-only ZIP streaming. The script
invokes the project's pinned Convex CLI directly. Use an existing Convex login or
supply the selected deployment's credential through the process environment;
never put a key in a flag, command transcript, report or committed file. A private
Node `--env-file` can load an operator-managed environment file.

```sh
# Local plan only; does not contact Convex.
node scripts/hosted-durability.mjs export --deployment SOURCE_NAME --path /private/backups/source.zip --dry-run

# Lead runs only after the owner authorizes the real drill.
node scripts/hosted-durability.mjs export --deployment SOURCE_NAME --path /private/backups/source.zip
```

`--deployment` selects the source explicitly. If omitted, export uses
`HOSTED_DURABILITY_DEPLOYMENT`, then `CONVEX_DEPLOYMENT`. The latter may contain
Convex's `dev:NAME`/`prod:NAME` form. The CLI authenticates the selected deployment;
credentials and selector must identify the same deployment. A concrete deployment
key is checked against the requested name before the CLI starts; a mismatch
returns `DEPLOYMENT_CREDENTIAL_MISMATCH`. Project keys retain native named selection.
Project dotenv files cannot inject a different credential or self-host target. There is no implicit
production fallback. Export always includes file storage and writes an unoccupied
`.zip` path. Private staging is removed after completion/failure; existing backups
are never overwritten. Provider stdout/stderr is withheld, including on errors.
A failed or lost reply does not prove a backup exists: check the requested local
file before choosing a new filename. The command does not deploy or import.

Keep the original ZIP unchanged in private storage outside the project. Save its
SHA-256, accepted source/lockfile identity, source deployment identity, snapshot
observation time and byte size separately. Preserve code, backend configuration,
authentication configuration and environment variables through existing private
operator backups. Preserve the exact Secret Object keyring separately; never add
it to the comparison report.

Convex's [export command](https://docs.convex.dev/cli/reference/export) and
[snapshot guide](https://docs.convex.dev/database/backup-restore) describe a
consistent table snapshot, optional file storage, and the omissions: deployed
code/configuration, environment variables and pending scheduled functions.
Storage is under `_storage/`, with a document manifest and individual files.
A ZIP alone does not restore a functioning application or restart pending jobs.

## Restore into a fresh deployment

These are lead-run instructions after scratch approval, not commands executed by
the tooling. Use a new empty Convex deployment with its own identity and credentials.
Import the original snapshot before deploying the matching schema/functions, as
in Forge's existing self-host restore procedure. This avoids clashes with table
IDs from a schema deployed before import. The ZIP import preserves document and
storage IDs and creation times, so references remain intact.

```sh
# Confirm the selected target is the approved fresh scratch deployment.
# Use target credentials in the environment; do not reuse a source deploy key.
npx convex import --deployment FRESH_TARGET_NAME /private/backups/source.zip

# After import, lead restores the saved matching code/configuration and private
# environment through the established deployment process. No backfill is needed
# or authorized by this durability procedure.
```

The flag above uses the existing CLI login or a project key, as documented in the
[import reference](https://docs.convex.dev/cli/reference/import). With a concrete
target deployment key, omit the selector (the native CLI derives the deployment
from that key); independently confirm its target identity first. Do not use `--append`, `--replace`, `--replace-all` or `--yes` for
this fresh-target drill. The default import fails when imported tables already
contain data. An interrupted import has no Forge operation receipt: inspect its
Convex status and the target before retrying, and retain the source ZIP. This
procedure never restores over the source deployment or routes users to scratch.

See [Convex data import](https://docs.convex.dev/database/import-export/import)
for atomic ZIP import, ID preservation and file-storage behavior. Reinstating
code, authentication and private environment is separate from data validation.
Restored access rows are historical; exercise existing current-access checks
before using the scratch instance. Pending jobs require explicit recovery review;
this procedure does not schedule or replay them.

## Verify the restored data

Prefer comparing the saved source ZIP against a new snapshot of scratch. A live
source can advance after its backup; a later source-vs-target mismatch is not by
itself evidence of a broken restore.

```sh
node scripts/hosted-durability.mjs verify --left-export /private/backups/source.zip --right-deployment FRESH_TARGET_NAME

# Fully offline, after exporting scratch separately:
node scripts/hosted-durability.mjs verify --left-export /private/backups/source.zip --right-export /private/backups/restored.zip

# Optional: independent snapshots of two deployments using the current login.
node scripts/hosted-durability.mjs verify --left-deployment SOURCE_NAME --right-deployment FRESH_TARGET_NAME
```

Deployment inputs generate Convex snapshot exports with file storage into private
temporary ZIPs, removed when verification ends. Convex retains its generated
server-side snapshot under its own backup behavior; removing a temporary download
does not delete that backup. Application records are unchanged. Each export is internally consistent; two
exports are not an atomic observation of both deployments. A single process
credential may not authorize both deployments; in that case export each separately
under its own credential, then compare the local ZIPs.

The JSON report contains:

- Accepted `main` head per active hosted Work project: the project's
  `projectHostedChannels` main row (server authority), else the Work index's
  `hostedChannels/main`, else its hosting-time `channels/main`; plus Intent/Lane/Candidate
  counts from the selected ready generation's actual record partition.
- Counts and SHA-256 digests of every exported table's canonical full records,
  including IDs, creation times, payload chunks, journals, other projects and
  historical/unselected generations. JSON key and row order do not matter; string
  values and array order remain exact. Available per-table generated schemas are
  compared too.
- A digest over every non-table ZIP entry's path, byte size and SHA-256, including
  all stored file bytes. Storage metadata and each referenced file are required;
  a table-only ZIP is not accepted as a complete backup.

No document values, private source, ciphertext, credentials or provider logs are
printed. Reports still contain private project IDs and accepted source hashes;
keep them private. Exit code **0** means equal/exported, **2** means different,
and **1** means a command or input error. An unavailable or building Work index is
reported as `WORK_INDEX_UNAVAILABLE`, never a successful zero count. Projects
without hosted Work have their tables/files compared but no Work projection.
A deployment without any verifiable hosted Work is not a qualified Forge drill.
No index rebuild or other mutation runs automatically.

Equal hashes establish snapshot data equality, not source-closure validity,
application health, an off-machine recovery or a power-loss guarantee. To qualify
the drill, the lead should open the restored project under its configured auth,
confirm accepted main and selected Lane/Candidate/Intent detail, download the preserved
checkpoint through the existing recovery path, restore into a new local directory
and check its source/Work integrity. Record only observed results and elapsed
restore/verify times. Keep the source and local owner unchanged throughout.

## Weekly R2 backup

The [Actions workflow](../../.github/workflows/hosted-backup.yml) runs Mondays at
03:00 UTC and supports `workflow_dispatch`. It backs up only the dev deployment
`benevolent-wildebeest-974`; the command uses an explicit deployment selector and
never a production flag. It runs the existing exporter and format-1 backup path,
including file storage by default, keeping four completed copies. No PR, fork,
push or external event triggers this workflow. Its token has only `contents: read`;
actions are SHA-pinned and checkout does not retain the token. Credentials reach
only the freshness and backup steps, after install/build. Dependencies install
with scripts disabled. No backup, retry state or private snapshot is uploaded to
Actions artifacts or caches. Provider text and signed URLs remain withheld;
`hosted-backup-mask.mjs` registers credential-derived fragments/endpoints with
`::add-mask::` before either command, escaping workflow-command characters.

The lead creates these as **secrets of the `hosted-backup` environment** (deployment branches: `main` only, so forks and pull requests never receive them). Use credentials made for the backup alone: an R2 token limited to the backup bucket, and a Convex key with export permission.

| Secret | Value |
| --- | --- |
| `CONVEX_DEPLOY_KEY` | Backup-only key for `benevolent-wildebeest-974` (export permission) |
| `R2_ACCOUNT_ID` | Existing backup R2 account ID |
| `R2_BUCKET` | Existing backup bucket name |
| `R2_ACCESS_KEY_ID` | Existing backup R2 access key ID |
| `R2_SECRET_ACCESS_KEY` | Existing backup R2 secret access key |

Set the **`hosted-backup` environment variable** `HOSTED_DURABILITY_R2_PREFIX` to the
existing weekly backup prefix, including its trailing slash, separate from source
blob objects. There is deliberately no guessed new prefix: freshness and retention
must see the same four-copy history as the Mac job. The bucket already exists.
Set the workflow's `HOSTED_DURABILITY_DATABASE_ONLY` env toggle to `'1'` only for
the deployment-wide migration described below; the default remains `'0'`.
`HOSTED_DURABILITY_STATE_DIR` points inside the runner's private temporary directory.

The first credential-bearing step reads R2 in pages of at most 1,000 keys,
selects the newest completed backup name, reads its manifest and checks the ZIP's
size/checksum metadata with HEAD. It reports only `ageDays` and `overdue`. No
Convex call or ZIP download is needed for freshness. A missing backup or age over
**eight days** exits 2; provider failures, invalid metadata and missing ZIPs exit 1.
Exactly eight days is current. The backup step still runs after freshness fails,
so an overdue installation can recover while that run stays **red**. The next
manual dispatch can confirm freshness. Installation with no completed backup
therefore has an expected red freshness step even if its first backup succeeds.
The existing local `backup-status` remains a separate seven-day offline check.

[GitHub schedule caveats](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule):
runs may be delayed or dropped under load, including at the start of the hour;
schedules run only from the default branch. Public-repository schedules are
automatically disabled after 60 days without repository activity. A disabled or
dropped run creates no failed job and cannot email about its own absence. This
freshness gate exposes a missed week on the **next** scheduled or manual run;
it is not an independent dead-man monitor. No additional poller is installed.

A failed step leaves the job red and immediately starts an independent `alert` job,
including when install/build failed. The job reuses `src/stall-alerts.ts`, with the
**ntfy** webhook preset and the existing Cloudflare email transport. It sends the
failed Actions run link, the next action and the bounded retry policy; no private
snapshot, provider response, credential or endpoint is logged. Only channel and
HTTP status are reported. Missing configuration or failed delivery makes the
alert job fail explicitly. Network delivery uses the existing ten-second deadline
per configured channel, with no recurring work.

For owner notification, the lead adds **`FORGE_ALERT_WEBHOOK_URL` as a secret in
the GitHub Actions `hosted-backup` environment**, containing the owner's subscribed
ntfy topic URL. This workflow does **not** need that secret in Convex. Configuring
landing stall alerts separately requires the same name in the Convex environment;
setting either environment does not configure the other. Never paste the URL into
logs or source. Installation and a real delivery qualification remain owner/lead
steps; synthetic HTTP tests establish the request/delivery path, not owner receipt.

The optional Cloudflare email channel uses the existing secrets
`FORGE_ALERT_EMAIL_TOKEN`, `FORGE_ALERT_EMAIL_ACCOUNT_ID` and optionally
`FORGE_ALERT_EMAIL_FROM` in the same Actions environment (the existing sender
default applies when FROM is absent). Set environment **secret**
`FORGE_ALERT_EMAIL_TO` to the comma-separated recipients, so public Actions logs mask the addresses. No email or webhook
secrets reach the backup job, and no backup credentials reach the alert job.
One successful channel counts as delivery; rejected channels remain visible.

Under GitHub's normal
[workflow notification behavior](https://docs.github.com/en/actions/concepts/workflows-and-actions/notifications-for-workflow-runs),
email depends on the recipient's Actions notification settings. Schedule messages
go to the schedule actor, which is not necessarily the repo owner. Those settings
and actual owner receipt are not observable from the workflow, so GitHub's own
failure email alone does not establish same-day owner delivery. The explicit
stall-alert channel supplements it. A dropped/disabled scheduled run still cannot
run its alert job; the schedule caveat above remains.

### Workflow repository choice and first run

Owner decision (2026-10-29): the workflow runs in the public `NanthAI/nanthai-forge`
repository, with its secrets in the `hosted-backup` environment restricted to `main`.
The Forge mirror pushes to `main` regularly, which keeps the schedule active.
A private ops repository remains an option for operators who want private run logs.
Run metadata and redacted logs are public, so privileged workflow changes need
careful review: `.github/**` is a protected path that needs owner approval. Manual
dispatch can only use the `hosted-backup` environment from `main`.

First-run steps for the lead after that choice:

1. Place the reviewed source and workflow on the chosen default branch, set the
   five secrets above, and set the existing prefix variable. Keep the file-inclusive
   default unless the whole deployment qualifies for database-only backups.
2. Disable the installed Mac calendar agent with the `bootout` procedure below
   before Actions dispatch; retain its private retry state. Resolve an existing
   pending local operation using that same state before switching runners.
3. Establish the owner's schedule notification actor/settings, then dispatch the
   workflow manually. Inspect freshness age and the backup's `complete:true`
   receipt. A missing/overdue prior copy keeps this run red after recovery;
   dispatch again to confirm green and an age near zero.
4. Confirm a later Monday run appears in Actions and notification delivery works.
   Stop automatic runs by disabling the workflow; existing R2 copies remain.
   Use the manual fallback only while Actions backup is stopped.

Expected cost (estimate, not a hosted measurement): roughly 5–10 Linux minutes
per run including install/build, export, upload and readback; 4–5 Mondays means
20–50 minutes/month, plus initial dispatches. Standard Linux is
[free in public repos; private GitHub Free includes 2,000 minutes/month](https://docs.github.com/en/billing/concepts/product-billing/github-actions).
The private allowance is shared: the lead checks remaining included minutes before
enabling. No paid runner, recurring poller, cache or artifact is added. Idle compute
and Convex calls are zero. A passing run still makes one native Convex export,
with its existing CLI-managed provider requests; no new application Convex
functions or document writes are introduced. Index-unavailable recovery is bounded
to three exports total, with 15-second then 45-second backoff, not polling. Each
attempt snapshots all deployment documents and included stored files once. At N
documents, normal snapshot reads remain N and the retry ceiling is 3N; native
provider-internal billed I/O and requests are not observable from this script.
The receipt reports `documentCount`, `storedFiles`, compressed ZIP `size` and
SHA-256 to make the run's scale visible. All R2 writes follow successful validation;
retries add no R2 upload/readback bytes. A passing run uploads and reads back one
ZIP of B bytes plus its small manifest (2B transferred), using 16 MiB multipart
parts. Four completed copies retain approximately 4B bytes, plus manifests.
The pre-change successful run held a 2,198,906,965-byte ZIP: about 4.40 GB combined
upload/readback and 8.80 GB for four equal-size copies; current size comes from
the new receipt, not that historical estimate. Referenced source/artifact R2 bytes
remain in their existing bucket, outside the Convex ZIP as described above.
The validator still retains one hash per exported record and compact Work/file
metadata; uploads buffer one 16 MiB part, and readback streams. No retry holds
multiple snapshots or accumulators. Alerting adds no Convex or backup-R2 I/O and
runs only after failure (one POST per configured destination). Real billing
coverage must be reported separately from these code-derived counts. Freshness adds three R2 requests for
a normal one-page prefix (LIST, manifest GET, ZIP HEAD); legacy retention/upload
requests remain unchanged.

For a manual local fallback, use an accepted source/lockfile, Node 24.22.1+,
Python 3 and `npm ci --ignore-scripts && npm run build:core`. The same R2 and
Convex names can come from an existing private operator environment file outside
source. Choose the existing prefix and a private state directory outside source;
`HOSTED_DURABILITY_R2_PREFIX` and `HOSTED_DURABILITY_STATE_DIR` supply those settings.

```sh
# First real run, performed by the lead after setting the existing environment.
# Keep this operation id when retrying an unknown outcome.
node --env-file="$EXISTING_ENV_FILE" scripts/hosted-durability.mjs backup \
  --deployment "$DEPLOYMENT" --prefix "$BACKUP_PREFIX" \
  --state-dir "$BACKUP_STATE_DIR" --operation-id "$BACKUP_OPERATION_ID"

# Offline check; no credentials or account calls. Exit 2 means no successful run
# or the last success is more than seven days old; exit 0 means current.
node scripts/hosted-durability.mjs backup-status --state-dir "$BACKUP_STATE_DIR"
```

The job exports with file storage, validates the ZIP with the existing table,
Work and storage verifier, hashes the ZIP, then sends 16 MiB multipart uploads with
per-part MD5 checksums. It downloads the completed remote ZIP as a stream and
checks its complete size/SHA-256 before publishing a create-only manifest. The
manifest records observation time, deployment, ZIP size/SHA-256, stored-file
summary, package version and lockfile/backup-source hashes. These hashes identify
the backup tooling; preserve matching deployed code/configuration separately as
in the snapshot procedure above. Verification reads R2 bytes back; it does not
re-export the live deployment.

Only after both remote objects verify does retention list the selected prefix.
It deletes ZIP/manifest pairs beyond four completed backup names, preserving the
just-written copy even if the machine clock moved backwards. Other prefixes,
unrecognized names and incomplete uploads are untouched. Deleting those older
copies is the approved retention behavior and is irreversible; there is no undo
for pruned copies. Disable the Actions workflow to stop future automatic runs/deletion.
This does not delete Convex-generated snapshots or configure provider retention.

`last-run.json` and the pending ZIP are private local retry state. Keep that
directory between local retries. Actions runners are ephemeral: each run starts
a new operation, and a rerun is a new backup, not a resumption of a lost runner's
local pending state. Unfinished remote uploads remain untouched. No cache or
artifact retains private retry state. A failed export/upload/checksum check never starts
retention. An interrupted multipart upload resumes its same key/upload ID and
replaces parts deterministically; a lost completion or manifest response is
reconciled by reading the existing bytes. Retry without a new operation id while
pending; an explicit id must match the pending operation. Completed explicit ids
return their saved receipt. A lost multipart-initiation response is reconciled by listing multipart uploads
for the exact operation key before creating another upload. The job never prunes
incomplete uploads. Forge's process queue prevents concurrent local writes; `BACKUP_BUSY` leaves
the pending operation intact for retry. Changing deployment/bucket/prefix requires its own state directory,
so a retry cannot switch destinations silently.

Success prints one JSON line including `pruned`, `missedWeek` and scale counts.
Every command failure prints a secret-safe `code`, named `step` and one
`nextStep`, then exits 1. Provider text and signed URLs remain withheld. Work-index
failures distinguish a missing/building/failed generation, wrong project/backup,
missing record partition and no verifiable Work projects. Project/generation
references are twelve-character SHA-256 prefixes, not raw private identifiers.
These describe the captured snapshot, not a claim about the later live index.
The historical bare error cannot identify which branch occurred without its ZIP.

`backup` and `verify` deployment inputs retry only a missing/building generation
or missing partition. They discard their own failed temporary ZIP, wait 15s then
45s, and export again (three attempts total), retaining the enclosing backup
operation ID. The manifest timestamp reflects the successful export attempt.
Each retry prints its sanitized reason, attempt and backoff; exhausted retries
retain the pending local operation and never start upload/retention. Failed
indexes and binding mismatches do not retry. Offline ZIP comparisons do not retry
unchanging bytes. No automatic index repair, schedule or retention change occurs.
The offline status reads local last-success/pending state; it does not establish
remote freshness on a fresh Actions runner. Its backup receipt can therefore say
`missedWeek:true` on each new runner; use the preceding R2 freshness result for
schedule health. The local manual fallback retains its original retry semantics.

To restore, download a retained ZIP and its manifest using the existing R2 operator
tooling, verify the ZIP size/SHA-256 against the manifest, then follow
[Restore into a fresh deployment](#restore-into-a-fresh-deployment) and
[Verify the restored data](#verify-the-restored-data). A checksum match is transport
integrity; the existing restore drill remains the recovery qualification procedure.

## Database-only backup and restore

After every project's durable bytes in the deployment have moved to R2, use
`--database-only` for `export`, `backup`, and comparisons of database-only
snapshots. Exports cover the whole deployment, so a migrated single project is
not sufficient if other projects or legacy import/zone/agent archives still
need Convex file storage. The ZIP validator refuses known source/archive rows
that still point only at Convex storage. Prepared uploads and disposable derived
caches are not durable source. Keep ordinary file-inclusive exports for mixed
storage until all durable source paths have migrated.

```sh
node scripts/hosted-durability.mjs export --deployment SOURCE_NAME --path /private/backups/database.zip --database-only
node scripts/hosted-durability.mjs backup --deployment SOURCE_NAME --prefix BACKUP_PREFIX/ --state-dir /private/backup-state --database-only
node scripts/hosted-durability.mjs verify --left-export /private/backups/database.zip --right-deployment FRESH_TARGET_NAME --database-only
```

For the already approved weekly job, the lead may set
`HOSTED_DURABILITY_DATABASE_ONLY` to `'1'` in the workflow env (or use
`HOSTED_DURABILITY_DATABASE_ONLY=1` in the manual operator environment). The
schedule and keep-four completed-backup retention do not change. No job is
installed or enabled by this option. The default continues including Convex
file storage. A backup's pending state, manifest and receipt pin its storage
mode; retry the original operation with that same mode.

Restore imports the original database ZIP into a fresh deployment using the
fresh-target procedure above, then restores matching code, authentication,
private environment and the existing R2 bucket configuration. The immutable R2
objects already hold the source bytes: this restore does not re-upload or copy
them through Convex. Retain their exact project prefixes and keys; database
rows contain the R2 pointers and original IDs. Restore backend R2 credentials
through the existing private operator process. Deleting a project's R2 prefix also removes its bytes from the recovery
available through retained database-only snapshots. A database ZIP without the corresponding
R2 objects is not a full recovery copy.

Database-only verification compares all exported database rows and selected
Work/main pins while accepting the deliberate absence of Convex files. It does
not establish R2 health; the lead separately verifies the referenced immutable
objects and exercises an authenticated source download from the restored project.
No real database-only restore or bucket drill has been run by this implementation.

## Retired Convex tables (B1.9)

The Bet 1 deletions left four tables with no writers: `projectPublicationAttempts`,
`projectPublications`, `projectPublicationPages` and `projectReturnSupersessions`.
(`ownerAcceptanceMachines` and `ownerAcceptanceRequests` were empty on dev, so their
definitions, reader and purge entries were removed from the schema; a Route A restore of
an older backup that still holds them must skip those two tables.) Their definitions stay in
the schema until the rows are exported and purged, because schema push and a Route A
restore of an older weekly backup still contain them. The optional fields
`exchangeCleanupCursor`, `exchangeCleanupDone`, `work.intentMigration`,
`projectBackups.metadataPublication` and `projectBackups.ownerDerived` are only
counted: live code still reads them.

```sh
node scripts/retired-tables.mjs inventory --deployment NAME
node scripts/retired-tables.mjs export --deployment NAME --dir NEW_PRIVATE_DIR
node scripts/retired-tables.mjs restore --deployment SCRATCH_NAME --dir NEW_PRIVATE_DIR
node scripts/retired-tables.mjs purge --deployment NAME --dir NEW_PRIVATE_DIR --deployed-at ISO
```

- `export` writes one checksummed JSON Lines file per table plus `manifest.json`
  (0600, never overwrites). A table that fills the read page is refused as truncated.
- `restore` imports only into an empty deployment other than the source and then proves
  every row came back. The weekly backup also holds these tables, so a restore of any
  retained backup is a second copy.
- `purge` is a dry run. It reports the four retired tables, their live rows and JSON
  bytes, export coverage, estimated calls/I/O and source readers that still require
  the table definitions. The optional live fields above remain report-only.
- `--execute --approval FILE --operation-id UUID` replaces only populated retired
  tables with empty JSON Lines data and reads them back. The private approval pins
  the deployment digest, exact export manifest and table set. The current owner gate
  is a closed backup fix, a received real failure alert and one verified post-deploy
  backup (`verifiedBackup: {id, completedAt, r2Bytes, sha256}`, `backupFixClosed: true`,
  `alertReceived: true`); the two-weekly-backups wait is removed.
- Every live row must exactly match its exported row before any deletion. A retained
  private operation receipt next to the approval reconciles an unknown import outcome;
  replay the same operation ID and original inputs. A changed export, deployment or
  live row stops the operation. There is no automatic retry or automatic undo.
- Execution uses one Convex CLI read per retired table plus a replacement and a
  readback per populated table, zero application function calls, and deletes each
  row with one entry per index plus its creation-time entry. Provider
  internal requests and billed I/O are not exposed; the estimated DB reads are
  62,932 JSON bytes. Idle costs zero calls. Peak retained row memory is O(export +
  one bounded table page); a full 20,000-row page remains explicitly incomplete.

Keep the operation receipt and qualifying R2 backup after deleting the approved
local export. Table definitions and restore readers remain for older backups;
removing them is a separate schema/recovery change.
