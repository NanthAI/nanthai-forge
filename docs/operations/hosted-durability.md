# Hosted deployment durability

This procedure backs up a whole Convex deployment, including private table data,
source objects, Work, grants, encrypted Secret Objects and file storage. It is
separate from a Forge project archive and from the canonical local owner's backup.
A hosted copy can lag local accepted `main`; this procedure preserves the hosted
snapshot, not unpublished local work. Keep the local owner and its portable backup.

The tooling is fixture-tested. A real backup/restore drill has not been performed.
The owner must approve a fresh scratch deployment before the lead runs the drill.
No deployment, backup schedule, retention or automatic deletion is configured by
these scripts.

## Snapshot and backup

Use the accepted Forge source and lockfile, Node 22.12+ or 24, installed dependencies
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

## Cadence and cost proposal (owner decision)

Proposed starting point: one daily file-inclusive backup, seven daily copies,
one separately downloaded weekly copy retained for four weeks, and a monthly
restore drill into fresh scratch. This targets up to 24 hours of hosted data loss;
restore time remains unmeasured. These are proposals, not configured defaults or
authorized deletion rules. The owner selects cadence, destinations and retention.

Convex's managed daily/weekly backups require Professional. Managed daily backups
are kept seven days and weekly backups fourteen days; local/offsite copies are a
separate owner choice. See [backup behavior](https://docs.convex.dev/database/backup-restore).

For an illustrative Professional US-region deployment with **1 GB table data,
4 GB stored files and a 5 GB ZIP**, thirty daily generations plus downloads mean
about 30 GB database I/O, 120 GB file reads, 150 GB ZIP generation and 150 GB ZIP
download bandwidth per month. At seven retained snapshots, backup storage is
about 35 GB. Using published marginal rates ($0.20/GB database I/O, $0.12/GB file
bandwidth, $0.03/GB-month file storage), that is approximately **$57.45/month**
before included allowances, plan/seat fees, weekly copies, restore traffic and
scratch storage. This is a planning estimate, not measured usage or a quote;
compression and actual billed usage change it. Local weekly retention adds no
Convex storage if copies are kept outside Convex; external storage has its own cost.
A restore additionally writes table data and transfers stored files. Published
non-US usage rates are 1.3× (illustrative subtotal **$74.69/month**).
Verify current [Convex usage pricing](https://docs.convex.dev/production/state/limits)
and the deployment's usage dashboard before the owner selects a plan or cadence.
