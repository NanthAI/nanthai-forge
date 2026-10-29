# Hosted deployment durability

This procedure backs up a whole Convex deployment, including private table data,
source objects, Work, grants, encrypted Secret Objects and file storage. It is
separate from a Forge project archive and from the canonical local owner's backup.
A hosted copy can lag local accepted `main`; this procedure preserves the hosted
snapshot, not unpublished local work. Keep the local owner and its portable backup.

The tooling is fixture-tested. The owner-approved offsite policy is a weekly
file-inclusive export to R2, keeping the newest four completed copies. Installation
and the first real run are operator actions; no schedule is installed by this repo.
The backup command never deploys, imports or contacts any account until invoked.

A development-deployment data restore drill passed on 2026-10-20: export 146 s
(787 MB, 27,143 stored files), import about 2 h 17 min, and comparison 243 s with
equal tables, files and Work. Code, authentication and environment were not
redeployed; off-machine owner recovery remains unqualified. Convex scheduled
backups require Pro; the weekly R2 job below runs independently on the operator's
Mac. No deployment or schedule is configured by these scripts.

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

- Selected accepted `main` head per active hosted Work project, preferring
  `hostedChannels/main` over local `channels/main`, and Intent/Lane/Candidate counts
  from the selected ready generation's actual record partition.
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

The weekly job runs on the operator's Mac using this exporter, without Convex's
Professional scheduled-backup feature. Use an existing private operator-managed
environment file or process environment with `R2_ACCOUNT_ID`, `R2_BUCKET`,
`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` and the existing Convex credential/login.
These are the same R2 names used by [blob storage](../r2-storage-plan.md); credentials
stay out of flags, the plist, manifests and logs. Do not place the environment file
inside source. The selected bucket must already exist. No new secret store is used.

Build core once (`npm ci --ignore-scripts && npm run build:core`). Choose a dedicated
bucket prefix such as `hosted-backups/production/`, separate from blob objects, and
a private local state directory outside source. `HOSTED_DURABILITY_R2_PREFIX` and
`HOSTED_DURABILITY_STATE_DIR` can supply these two nonsecret settings. Deployment
selection has the same environment fallback as export.

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
for pruned copies. Uninstall the job below to stop future automatic runs/deletion.
This does not delete Convex-generated snapshots or configure provider retention.

`last-run.json` and the pending ZIP are private local retry state. Keep that
directory between runs. A failed export/upload/checksum check never starts
retention. An interrupted multipart upload resumes its same key/upload ID and
replaces parts deterministically; a lost completion or manifest response is
reconciled by reading the existing bytes. Retry without a new operation id while
pending; an explicit id must match the pending operation. Completed explicit ids
return their saved receipt. A lost multipart-initiation response is reconciled by listing multipart uploads
for the exact operation key before creating another upload. The job never prunes
incomplete uploads. Forge's process queue prevents concurrent local writes; `BACKUP_BUSY` leaves
the pending operation intact for retry. Changing deployment/bucket/prefix requires its own state directory,
so a retry cannot switch destinations silently.

Success prints one JSON line including `pruned` and `missedWeek`. Failure prints
one redacted error line and exits 1; provider text and signed URLs are withheld.
The offline status reads the last success and pending state. Check it from the
operator's existing machine monitoring: a switched-off Mac cannot report its own
missed week. The next successful run also reports whether the prior success was
overdue. A fresh installation reports `missedWeek:true` until its first success.

### Install or uninstall on macOS (lead only)

The [launchd template](../../scripts/launchd/com.nanthai.forge-hosted-backup.plist)
runs Mondays at 03:00 local time. launchd coalesces calendar events missed during
sleep when the Mac wakes; a logged-out user agent waits for that user's login.
Render its nonsecret paths/settings using the environment below. Use an accepted,
stable source directory with dependencies/core built, an absolute Node path,
Python 3 on the template PATH, and the existing private environment-file path.
The file's contents are never copied into the plist. This is a template, not an
installed schedule.

```sh
# Set SOURCE, NODE, EXISTING_ENV_FILE, DEPLOYMENT, BACKUP_PREFIX and BACKUP_STATE_DIR
# to your existing paths/settings; export them for this renderer.
mkdir -p "$BACKUP_STATE_DIR" "$HOME/Library/LaunchAgents"
python3 - <<'PYTHON'
import os, pathlib, plistlib
source = pathlib.Path(os.environ["SOURCE"])
text = (source / "scripts/launchd/com.nanthai.forge-hosted-backup.plist").read_text()
settings = dict(SOURCE=str(source), NODE=os.environ["NODE"],
    NODE_BIN=str(pathlib.Path(os.environ["NODE"]).parent),
    EXISTING_ENV_FILE=os.environ["EXISTING_ENV_FILE"],
    DEPLOYMENT=os.environ["DEPLOYMENT"], PREFIX=os.environ["BACKUP_PREFIX"],
    STATE_DIR=os.environ["BACKUP_STATE_DIR"])
from xml.sax.saxutils import escape
for key, value in settings.items():
    text = text.replace("__" + key + "__", escape(value))
plistlib.loads(text.encode())
target = pathlib.Path.home() / "Library/LaunchAgents/com.nanthai.forge-hosted-backup.plist"
target.write_text(text)
target.chmod(0o600)
PYTHON
chmod 700 "$BACKUP_STATE_DIR"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.nanthai.forge-hosted-backup.plist"
launchctl print "gui/$(id -u)/com.nanthai.forge-hosted-backup"

# Uninstall: stops the schedule, retains backups and local retry/status records.
launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.nanthai.forge-hosted-backup.plist"
rm "$HOME/Library/LaunchAgents/com.nanthai.forge-hosted-backup.plist"
```

Logs are `launchd.log` and `launchd-error.log` in the chosen private state directory.
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
`HOSTED_DURABILITY_DATABASE_ONLY=1` in its existing operator environment. The
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
