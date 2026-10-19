# Source exchange

`nforge exchange` sends a native or Git-backed checkpoint to a hosted Convex project. It uploads only the content the project does not already have, identified by SHA-256. Source ancestry, paths, modes and artifacts stay intact. It does not create an archive and does not sync in the background.

Run `nforge login DEPLOYMENT_URL` and approve the device in Forge. Saved credentials are used automatically; `FORGE_AUTH_TOKEN` remains an environment override for CI. Never put credentials in request files. Owners can push and migrate. Contributors can read accessible checkpoints and upload immutable proposal objects; checkpoint publication and hosted source return remain owner-only. A scoped source grant cannot upload.

Use `nforge host ROOT` to create and bind a hosted project first. Bound owners need no request file:

```sh
nforge exchange ROOT push
nforge exchange ROOT pull --target NEW_DIR
```

Push records its operation UUID, local revision and observed current hosted backup before upload;
re-running after an unknown outcome resumes those exact pins. Pull materializes selected hosted main into a source client directory; omitting
`--target` uses a sibling named `ROOT-hosted-main`. Full Work recovery is the separate
`restore` command described below. Known hosted checkpoint or Work CAS mismatches trigger up to three automatic rebases
after the initial attempt. Each rebase reconciles current hosted metadata and derives
a fresh candidate with deterministic child operation IDs under the parent push ID.
A checkpoint published before a stale source return stays retained. Git-backed exchange preserves its source
bundle and complete Work, uploading only missing objects/chunks, without a compressed Work archive.
For native bound owners, push first retains local Work and available mutable run outputs,
then reconciles supported hosted metadata into the captured candidate and current local Work, stores the checkpoint,
returns it as the hosted Work base and refreshes the derived index. Intent status, Lane state,
lifecycle history and other local record changes travel with the complete Work snapshot even when
source bytes do not change. Hosted edits are preserved or reported as conflicts. Each phase retains
its operation ID and pins across unknown replies. Git bound owners retain checkpoint-only push;
command-file pushes select hosted Work only when `returnSource` is supplied.

Explicit project IDs and original request files remain supported:

```sh
nforge exchange ROOT push --command-file forge-push.json
nforge exchange ROOT reconcile --command-file forge-reconcile.json
nforge exchange NEW_DIR pull --command-file forge-pull.json
nforge exchange ROOT migrate-archive --command-file forge-migrate.json
```

With the token set, `nforge mcp ROOT --agent` also offers `forge_exchange` and `forge_migrate_archive` over the same code.

## Push

```json
{ "url": "https://DEPLOYMENT.convex.cloud", "projectId": "PROJECT_ID",
  "operationId": "ORIGINAL_UUID", "previous": "CURRENT_BACKUP_ID", "revision": 123 }
```

`revision` is the local Work revision. The first push sends everything. Later pushes send only new content, and large files send only changed chunks. To return the checkpoint as the project's hosted source, add `"returnSource": {"expectedBackupId": "…", "revision": 120, "operationId": "RETURN_UUID"}`. The nested revision is the hosted one. Hosted edits made in the meantime are kept, and a concurrent return reports a conflict instead of overwriting.

## Work record exchange

Native clients prepare exchange schema 2: missing stable-key Work records and
chunked ordered catalogs, plus an add/change/remove delta pinned to the previous
checkpoint catalog, whole Work digest and hosted journal revision. The existing
Work JSON format stays intact. Changed records and touched references are
validated on the hosted path; canonical whole-JSON hashing streams retained
record segments without reconstructing both Work snapshots. Source-return
history keeps its original whole-JSON digest semantics through an exchange-only
journal adapter.

The first v2 checkpoint, old or mismatched baselines, unsupported metadata and
large preparation contexts retain full validation. No hosted row rewrite or
backfill is needed. Schema-1 checkpoints, recovery and the logical-manifest
compatibility endpoint remain available. Record preparation and full digest
hashing still read retained metadata; transferred bytes alone do not measure
their CPU or storage-read cost.

Complete validation compares the record catalog against the original validated
Work bytes, preserving their field order and absent optional/default fields.
Schema parsing must not change the snapshot used for that exact digest comparison.
When parsing changes top-level field order or adds defaults, source return uses
complete replay to preserve the existing parsed-Work journal digest semantics.

`node --import ./tests/check-runtime.mjs scripts/measure-work-record-delta.mjs`
compares synthetic v1/v2 pushes after 1 and 20 landings using the existing
1,000-State fixture. Both modes upload only missing content and supply the same
owner-derived sidecar. It reports uploaded bytes, Work records validated,
reference-context records read and time from source-return action entry to the
first staging mutation. It uses local in-memory hosted handlers and no account,
deployment, network push or canonical owner.

## Receive

`reconcile` merges hosted Work into an existing owner that already has the common source. It takes `backupId` and `revision`, and leaves Lane files and unrelated records alone. `restore` builds a new owner from `backupId` (also accepted by the legacy `pull` request). Optional `cacheRoot` reuses source bytes from another owner, and `journalPath` supplies the hosted Work journal. Restore checks every hash, never runs repository commands, and never overwrites an existing directory.

## Migrate an older archive

`migrate-archive` converts one native `.tar.gz` backup to shared objects. It needs `backupId`, `archivePath` and `originalDigest`. The converter verifies the archive, uploads missing content and switches the same backup ID to the object form. Only then is the old compressed copy removed. A failure before the switch leaves the archive selected.

## Retries

Source-return metadata trees release decoded chunks after copying or hashing them;
record reconstruction writes into one logical Work buffer. Work hashing streams
canonical pretty JSON rather than constructing another complete Work string.
Durable return steps store their immutable Work/manifest snapshot once and keep a
reference in subsequent position cursors. Existing embedded-snapshot cursors
resume with the same operation and timestamp, and switch on their next committed
step. These changes reduce duplicate allocations; compatibility validation still
loads complete Work metadata, and per-View provenance can grow with its changed
paths and retained saves. They do not establish a fixed memory bound for every
possible project history.
Selected View steps derive only the requested View's read model, retaining its
supersession and acceptance context; save-index lookup scans backward without
copying the Lane's save history. The memory fixture uses a producer process to
write synthetic backups and emitted test handlers to disk, then a separate action
process under `--max-old-space-size=384`. It reports producer and action lifetime
peak RSS separately, including Node and imports, plus sampled action heap. Its
compatibility action has 12,000 saves and 1,425 source files but no Views; it does
not measure historical provenance or establish an O(batch) bound for Work parsing.

Keep the whole request and its operation UUID. A retry of a finished push returns the original result without re-uploading and without moving a later selection. Otherwise it finds what is already stored and sends only what is missing. A changed request under the same UUID is rejected. `previous` must be the project's current checkpoint. If another push landed first, the push fails with `PROJECT_CHANGED`, publishes nothing and forks nothing. Pull the latest checkpoint, reconcile, and push again with a new `previous` and operation UUID. Interrupted preparation publishes nothing. Retry data lives in `.forge/work/exchange-OPERATION_ID`.

Transient publication, receipt lookup, journal and source-return failures retry internally with exponential backoff (three retries per phase). Each retry retains its operation ID and exact payload; an unknown publication reply reconciles the existing receipt rather than publishing again. Native bound pushes pin the current Work revision and immutable record pointer under
a short owner lock, then durably retain the local capture before the first hosted read. Rebase attempts
share that capture; each retains its own reconciled candidate before upload. Local
writes after capture travel on the next push. Reconciliation merges validated hosted
metadata into newer local Work under its final owner lock. Unknown outcomes retain
the original snapshot and request; retries never recapture them. Explicit revision-pinned
requests keep their revision checks. Inconsistent hosted snapshot reads report
`WORK_CHANGED_DURING_PUSH`; exhausted hosted transaction conflicts report `HOSTED_CONFLICT`. Opaque platform failures become `HOSTED_ACTION_FAILED` with a safe request ID when available, rather than a bare `INTERNAL_ERROR`. Authentication, changed-operation payloads and stable validation failures remain typed and do not retry. A known stale bound push allows the next invocation to select fresh pins; an unknown outcome preserves the pending request. No retry silently changes a source revision or overwrites hosted edits.

Zero bytes uploaded does not mean zero work. Validation and hashing still happen locally. To time one request, run `node scripts/measure-exchange-latency.mjs REQUEST_JSON RESULT_JSON`.

## Object proposals and browser imports

The Backups and Proposals pages accept local export files, unpack them locally, and upload logical objects rather than compressed archives. Identical content is reused. A browser backup that races a newer selection is retained without rewinding the current checkpoint. New archive registrations are retired; old stored archives and original pending uploads remain readable and resumable. No migration or deletion is needed to use object transport. Local recovery/release archive export remains available.

For an object proposal, download its receive request (`{url,projectId,proposalId,operationId}`), then run:

```sh
nforge exchange ROOT receive-proposal --command-file forge-proposal-receive.json
```

This downloads and validates the proposal, then imports it into a separate Lane in the existing owner using the original operation ID. Receive the hosted Intent first through the existing Work reconciliation flow. `pull-proposal` with `{url,projectId,proposalId,cacheRoot?}` is also available to retain an unpacked export in a fresh directory. Use that directory as `archivePath` in the existing `import-native-contribution` request and its manifest SHA-256 as `archiveSha256`. These compatibility field names also accept local archives with their original compressed digest. The importer validates complete source closure and creates a separate Lane; contributor Work and check claims never become owner evidence.

Warm native pushes keep a checksummed preparation hint per project/checkpoint. It reuses retained source and finished-run content and omits known uploaded pins from negotiation. Corrupt or missing hints fall back to full preparation. The server validates changed digest/size bindings against a fully validated prior immutable closure; old or incomplete checkpoints take the full path. Access and current project state are checked again at publication. Source returns retain the public Work generation, including when a larger record partition is staged. CLI cursors pin the source revision to prevent mixing pages across returns.

Native pushes prepare an optional owner-derived sidecar alongside their pinned
Work snapshot. It travels as a project-scoped immutable object and its digest and
size accompany source return. Selection uses the hosted source-return baseline,
not merely the previous upload checkpoint: new States' parents and own-parent
ancestry deltas, changed Lane/View comparisons, changed View provenance and new
selected trees. Parent references reuse ancestry already hosted; full closures
are never copied into each new State. Older baseline hints reuse their exact
locally prepared Work bytes after digest verification. If unavailable, hosted
computation supplies the missing derivation.

The sidecar and local `owner-derived-cache.json` each have a 4 MiB byte budget.
Only the latest delta is cached. Oversized old caches are skipped before reading;
new derived rows stop accumulating at the budget. If the sidecar cannot fit, the
client omits it and the push continues using hosted computation. The server checks
the declared size before fetching bytes, then checks actual size, digest and JSON.
Malformed, legacy and oversized sidecars are optimization misses. Original source
and publication pins remain stable across retries, including oversized legacy
prepared sidecars.

For a read-only offline measurement of a retained pending push, build core and run
`node scripts/measure-owner-derived.mjs OWNER`. Add `--current` to measure current
owner Work against the same hosted baseline. This reads local source and exact
prepared metadata only, writes a replacement cache to temporary scratch and
removes it, and never contacts hosted or modifies owner transport state. Output
reports old/new sidecar and cache bytes and delta row counts.

Hosted source return remains owner-only. It checks sidecar shape, Work pin,
comparison and View keys, counts and object-pin membership using metadata. Valid
complete sidecars skip source derivation item phases; absent, malformed or
incomplete ones automatically use the existing hosted computation. Publication
retains its original operation ID, current authority checks and source/Work CAS.
No Work format bump, hosted row migration or backfill is required. The sidecar is
a disposable index supplied under the owner's existing source trust. Contributor
proposals retain their existing hosted derivation path.

Native object returns reuse the previous generation's State-parent cache, immutable diffstat pairs and unchanged View provenance. Complete and streamed native projections produce identical parent-cache rows and counts, including chunked parents for large fan-in. Only new source heads receive compact, chunked ancestry closures; older pair indexes remain readable, and missing pair membership can be resolved lazily from cached parents. Acceptance and supersession refresh the affected View summaries without rereading unchanged file provenance. Bounded row deltas publish atomically into the selected partition. Larger deltas use the complete staged-partition path. Optional cache fields and record collections require no migration; an older generation reuses its complete ancestry boundaries and caches new States during its next return.

The CLI writes phase, items done/total, durable step, elapsed time and ETA to stderr, including the saved step when resuming. JSON stdout retains the original final receipt. The server advances many items between durable checkpoints and continues bounded batches within each action; restart always uses the original operation and stored cursor.

Metadata reconstruction and comparison remain proportional to retained metadata. Source-byte reuse and fewer RPCs alone do not establish an end-to-end latency guarantee.

## Work record delta exchange

Current clients send native exchange schema 2: missing stable-key record bytes and
chunked catalogs pinned to the exact baseline checkpoint and hosted journal
revision (see [Work record delta exchange](../architecture.md#work-record-delta-exchange)).
Hosted publication validates changed records and their references and streams the
complete Work digest; portable JSON, source-return events and owner-only writes are
unchanged. First exchanges, old checkpoints, schema-1 clients and oversized
preparation contexts use full-snapshot validation. No existing hosted rows are
rewritten.

Native bound pushes retain one local capture before the first hosted read and
release the owner lock before source traversal and networking; later local edits travel on the next push. Known hosted
CAS mismatches use at most three rebases after the initial attempt, with separate
immutable attempt identities. A lost reply reconciles the original attempt before
changing its baseline.

## Hosted main client checkout

`projectMain:current` is the client contract for current hosted `main`. Its schema-1
reply names `projectId`, the selected source `generationId` and `backupId`, the
native State `head`, and `receipt` (`id`, `kind`, `previousHead`,
`previousReceiptId`). A hosted receipt takes precedence over the uploaded native
Channel receipt. With no hosted move, the latest accepted native main receipt is
the seed. A project without an accepted main receipt is not yet checkout-ready.
The generation's record partition is an implementation detail, not a source pin.
The query checks current project access and observes selection and receipt in one
transaction. Optional `expected: {head, receiptId}` refuses stale observations
with `CHANNEL_CHANGED`, including a different receipt selecting the same head.
This read expectation does not change acceptance semantics or grant write authority.

Open an empty directory without an owner checkout:

```sh
nforge exchange CLIENT_DIR open --command-file main-pull.json
nforge exchange CLIENT_DIR pull --command-file main-pull.json
```

```json
{ "url": "https://DEPLOYMENT.convex.cloud", "projectId": "PROJECT_ID",
  "operationId": "ORIGINAL_UUID",
  "expected": { "head": "STATE_SHA256", "receiptId": "CHANNEL_RECEIPT_ID" } }
```

Omit `expected` to select the current observed main. The client durably pins that
selection under the original operation ID; interrupted retries continue that exact
head even if hosted main advances. A completed retry returns its original receipt
without rewinding a newer checkout. Use a new operation ID for a new pull.
Current read access is checked on every invocation, on each object read and again
before publishing files; a cache never grants access.

Only the selected State and its file blobs are downloaded, using the existing
project object bindings and storage transport. The sibling `CLIENT_DIR.forge-client`
cache retains verified SHA-256 objects and operation receipts for resumption.
Unchanged pulls transfer zero objects; a changed file fetches its new blob and new
State. Every downloaded object's size and hash are verified before installation.
Files and executable modes are staged, then the directory is replaced under a
local publication lock. An interrupted replacement recovers the previous directory
or recognizes the installed checkout on retry. Local modified, deleted or untracked
files are preserved with `WORK_CONFLICT`. The selected contract is recorded in
`CLIENT_DIR/.forge/hosted-main.json`; this directory is a source client, not a
native Work owner, and does not acquire independent acceptance authority.

Bound `nforge exchange OWNER pull --target CLIENT_DIR` uses this same checkout
(default sibling: `OWNER-hosted-main`). For explicit, repeatable operation identity,
use the command-file form above. Full retained history/Work recovery remains
separate: `nforge exchange NEW_OWNER restore --command-file restore.json` takes
`{url, projectId, backupId, cacheRoot?, journalPath?}`. The older `pull` request with
`backupId` remains a compatible spelling of independent-owner restore. Restore
continues to materialize the uploaded native head; it does not claim to track
hosted-selected main. Git interoperability remains a derived projection of native
source, not an additional main authority.
