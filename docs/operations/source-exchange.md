# Source exchange

`nforge exchange` sends a native or Git-backed checkpoint to a hosted Convex project. It uploads only the content the project does not already have, identified by SHA-256. Source ancestry, paths, modes and artifacts stay intact. It does not create an archive and does not sync in the background.

Run `nforge login DEPLOYMENT_URL` and approve the device in Forge. Saved credentials are used automatically; `FORGE_AUTH_TOKEN` remains an environment override for CI. Never put credentials in request files. Owners can push and migrate. Contributors can read accessible checkpoints and upload immutable proposal objects; checkpoint publication and hosted source return remain owner-only. A scoped source grant cannot upload.

`nforge host ROOT` creates a project through a one-time hosted seed, independently of
exchange push/publication. It pins native main and its actual acceptance receipt
(or explicitly records the bootstrap State when no acceptance exists), portable
Work bytes/revision, and journal-only commands, attempts, waits and unknown
outcomes in recovery format 1. Immutable objects and Work records reuse the
missing-object upload layer and R2 presigning. Source/record validation pages
contain at most 100 references and 128 KiB of metadata; source/record bodies use
a 2 MiB action window, with an oversized individual body handled alone. Each
committed page saves its cursor. Retrying resumes that cursor and the original
local capture, even when local Work has since advanced. A completed seed returns
its original checkpoint without uploading again.

Partial seeds select neither a checkpoint nor hosted main. The final action
reads and hashes hosted native main, compares it with the pinned native digest,
then atomically selects the checkpoint and main and records seed completion.
It checks the authority mode/epoch and selected source/journal pins captured at
seed start. Seeding preserves native authority; switching authority is a separate
cutover. No seed polling or scheduled continuation runs. The command drives the
finite pages itself; rerun the same hosting command after an interruption.
`--wait` remains accepted, with no first-host background history backfill.

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
Rebases carry forward the prior attempt's reconciled candidate, including hosted events
already received, while retaining the original local source and mutable-output capture.
Bound pushes on one owner serialize transport work across processes; local Work writes
continue under their short owner locks. A concurrent continuation that loses the cursor
CAS returns current progress or the original completed receipt. Status probes never
advance the cursor. A checkpoint published before a stale source return stays retained. Git-backed exchange preserves its source
bundle and complete Work, uploading only missing objects/chunks, without a compressed Work archive.
For native bound owners, push first retains local Work and available mutable run outputs,
then reconciles supported hosted metadata into the captured candidate and current local Work, stores the checkpoint,
returns it as the hosted Work base and refreshes the derived index. Intent status, Lane state,
lifecycle history and other local record changes travel with the complete Work snapshot even when
source bytes do not change. Hosted edits are preserved or reported as conflicts. Each phase retains
its operation ID and pins across unknown replies. Git bound owners retain checkpoint-only push;
command-file pushes select hosted Work only when `returnSource` is supplied.

Bound exchange reports its local capture, hosted journal reconciliation, upload,
source return and index refresh phases on stderr, with periodic elapsed-time
updates while awaiting a reply. JSON stdout remains the final result. `WORK_CONFLICT`
identifies up to 20 conflicting collection/record/field items, the total count and
retained reconcile operation ID. Complete values remain in the pinned local receive
files rather than being copied into the error.

Explicit project IDs and original request files remain supported:

```sh
nforge exchange ROOT push --command-file forge-push.json
nforge exchange ROOT reconcile --command-file forge-reconcile.json
nforge exchange NEW_DIR pull --command-file forge-pull.json
nforge exchange ROOT migrate-archive --command-file forge-migrate.json
```

With the token set, `nforge mcp ROOT --agent` also offers `forge_exchange` and `forge_migrate_archive` over the same code.

## Large pushes and long actions

A large backlog keeps the original push and nested source-return operation IDs,
checkpoint pins and hosted revision through every continuation. Native returns
with at least 100 journal revisions since their base use durable preparation even
when the base Work is small. Preparation saves replayed Work at complete event
boundaries and resumes from that validated revision. Validation, projection and
private index commits keep their existing shorter scheduling windows. A shared
four-minute outer window is checked after complete work units; it never cancels
or splits a transaction. Index rebuilds yield after committed batches, and
publication waiters yield without taking another worker's claim or reading metadata
pages. Metadata-only publication retains its complete semantic-validation summary
and verifies committed pins one bounded immutable metadata page per transaction.
The initial semantic scan queries at most 16 pages (2 MiB of bodies) per call.
The saved page cursor and incomplete-pin tail advance atomically with those checks.
Continuations and lost replies skip verified pin pages; a retry after validation
uses the saved preview without rereading all metadata. Initial complete JSON/digest
validation remains indivisible; interruption before its summary commits can repeat
that initial scan. The first action reuses its scanned bytes for pin checks. Resumed actions read
only the next unverified pin page. Total metadata reads are at most two passes,
independent of continuation count; a single invocation reads each page once.

Pending is successful scheduling progress, not a transport retry. The client
continues immediately with `continuation:true`, the same operation ID and inputs,
and a small event-loop yield. Source-return output includes the phase, completed
and total items, and saved step; private partition copying also tracks its cursor.
Advancing pending responses do not consume a retry budget. Six consecutive pending
responses at the same saved position stop with `EXCHANGE_ACTION_STALLED` and an
instruction to retry the original operation. Elapsed time, ETA, invocation counts
and repeated storage reads do not establish progress. Existing optional source-return
step/byte settings now select a per-invocation yield window, rather than requiring
an operator to raise a per-push ceiling.

All long exchange HTTP calls have a seven-minute header and total deadline,
including the native HTTP dispatch deadline. Unknown replies reconcile the same
operation; they do not start another publication or source return. A work unit
must complete before yielding: single-object reads, full compatibility validation,
archive conversion and initial projection construction remain indivisible. The
four-minute window is therefore a scheduling target, not a guarantee that any
individual unit or endpoint finishes within four minutes. Compatibility manifest,
history validation, recipe validation, initialization, migration and full journal
export have no durable validation cursor. Modern clients resolve manifests and
page journals locally where supported.

## CLI upgrade

New pushes require owner display protocol 3. Older CLIs and publications without
complete owner display data receive the typed `CLI_UPGRADE_REQUIRED` error.
Install the current Forge CLI package (for the offline distribution, run
`npm install -g /path/to/current/nanthai-forge.tgz`) and prepare a new push.
Existing hosted reads and successful original-operation receipt replay keep
working. A retained operation that predates the new display protocol must be
reprepared from its local source with a new operation UUID; its existing
checkpoint and hosted history are preserved. There is no server derivation
fallback and no hosted backfill command.

Current CLIs compute missing display items locally before upload. Large owner
display payloads are split into hash-checked 128 KiB pages, so a backlog does
not omit comparisons, ancestry, Views or Code trees to fit a 4 MiB sidecar.
The server validates owner facts and stores them; owner-supplied display data
never changes who may land or bypasses revision, main-history or final CAS
checks. Coordination changed-path lists also come from the CLI, avoiding State
reads solely for advisory display. Index deltas above 1,000 rows copy existing database
rows into a private partition and apply removals/replacements in transactions of
at most 1,000 rows. The final source/Work CAS switches partitions only after every
batch is durable. Lost batch or final replies resume the original operation;
ready delta cursors from earlier deployments use the same staged commit.
When a hosted index is missing, the CLI automatically supplies complete local
facts and source return publishes a new private index under the original CAS.
Large immutable output is retained once; durable cursors carry its offset.
Legacy hosted reads retain their existing read-index compatibility behavior.

## Push

```json
{ "url": "https://DEPLOYMENT.convex.cloud", "projectId": "PROJECT_ID",
  "operationId": "ORIGINAL_UUID", "previous": "CURRENT_BACKUP_ID", "revision": 123 }
```

`revision` is the local Work revision. The first push sends everything. Later pushes send only new content, and large files send only changed chunks. To return the checkpoint as the project's hosted source, add `"returnSource": {"expectedBackupId": "…", "revision": 120, "operationId": "RETURN_UUID"}`. The nested revision is the hosted one. Hosted edits made in the meantime are kept, and a concurrent return reports a conflict instead of overwriting.

A completed source return remains one original journal event. Reconstructing
hosted Work validates it against its retained checkpoint, never against later
local landings. Newly introduced optional collections stay absent when reading
older checkpoints, preserving their original Work digests; writers initialize
those collections when used. Neither old receipts nor checkpoint bytes need a
repair or rewrite.

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
compatibility endpoint remain available. When either byte-reading native object checkpoint's
Work exceeds 16 MiB and a current index is available, compatibility preparation
saves a cursor between reading current Work, reading candidate Work, and checking
retained-history chunks. It does not load both complete Work copies in one
action. Complete object metadata is decoded as a stream, and Work schema validation
checks a scalar skeleton and bounded array segments. Snapshot compression and cold
snapshot decoding also stream; they retain one parsed candidate without complete
uncompressed byte and text copies. Large compatibility preparation bypasses the
raw byte memos while consuming history, keeping their duplicate byte windows out
of the candidate action. Record reads keep four bounded batches ahead
to overlap storage latency while preserving canonical order and digest checks. Each validation invocation checks up to eight chunks (a 256 KiB target,
with indivisible records preserved) against the pinned candidate, then saves its
position. Large compatibility returns build a complete private index partition
from validated owner rows through durable commits. Full-index rows are generated
and saved in bounded immutable batches rather than retained as a second complete
Work. Post-prepare continuations drain those batches; their snapshot keeps only
scalar Work metadata after row planning. Metadata page encoding and decoding
stream without joining or stringifying the complete snapshot. Small returns keep their incremental index comparison. Display rows always come from the owner; full metadata validation does not derive them. These thresholds schedule work; they do not limit accepted Work or
limit retained Work. Current pushes require the CLI upgrade above. Current-protocol retained operations use the same checkpoint, hosted
revision, operation UUID and timestamp when preparation resumes.

Publication validation is coordinated by project and original operation UUID in
a transactional attempt record. An overlapping retry waits for the same receipt
instead of starting another seed. Changed request pins still fail; failures
release their attempt, and a crashed worker's attempt expires at the ten-minute
action budget. Waiting callers return resumable pending progress after four minutes,
retaining the original request; the client immediately continues that request. Final publication still checks
current authority and the previous-checkpoint compare-and-set.

Formats 16/18/20 use schema-owned unified collections, including alias keys and
unpinned planned Intents, in record catalogs and deltas. Catalog size is independent
of the delta/context optimization budget; complete seed validation can establish
validated records for catalogs above 4 MiB. Unknown extension arrays, duplicate
keys and unsupported layouts still use complete compatibility validation.
Changes to schema-owned scalar metadata, including Git mirror and auto-push
receipts, use record delta after normal versioned schema validation. Unknown
changed scalar extensions and reordered collection histories keep the fallback.
Capacity-only Work promotions 17→19 and 18→20 retain the validated record base;
unchanged records keep their reference meaning, while changed records use their
new format's validation. Other format transitions keep complete validation.
Publication receipt replay restores its optional local preparation hint. When
reconciliation finds an exact retained base without that hint, it recovers the
original Work bytes and property order before preparing a new record delta.
It never uses mutable owner Work or journal-reduced Work as the publication base.
Missing/corrupt unprovable bases still use complete publication.
A change only to a local Channel receipt's `postAcceptRunId` is authenticated
against both original record bodies before treating its source and acceptance
fields as unchanged. Such check-link enrichment updates the receipt row without
pulling the original receipt's entire historical check-log graph into the touched
context. Other receipt changes keep the complete publication path. Source-return
history, protected acceptance pins and final hosted Channel authority still use
the existing validation; no context budget is increased.

Current CLI checkpoints add optional `recordPacks` to exchange schema 2. These
immutable, content-addressed spans contain consecutive canonical record bytes;
they target 128 KiB, anchor on stable record identities and retain local byte
locations for upload. Seed decoding and complete digest verification read packs
instead of opening each small record object. Every individual record hash and the
whole Work digest are still checked. A routine upload reuses unchanged packs;
publication still reads the complete logical Work for hashing. Checkpoints with
packs require the current reader; existing checkpoints without packs keep their
original read path.

Publication logs identify every delta skip gate, unavailable seed catalogs and
metadata-only publications; successful validation identifies seed or delta mode.
Prepare logs include each record-delta skip reason and separate current-load,
candidate-load and retained-validation completion messages. Record checkpoint
reconstruction batches up to 100 records with a 2 MiB target on hosted readers
(a larger indivisible record is read alone), preserving exact portable bytes and
fresh authority checks. Record preparation and full digest
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

Native object reconciliation first reads `projectWorkJournal:page` metadata and
proves an exact local base using the hosted manifest digest, its `work.json` hash,
source head and initial revision. Retained outgoing exchanges and earlier receive
or download caches supply those bytes. It replays the already received local event
prefix, checks the preceding event's SHA-256 against the server, then downloads only
new events in revision order. Every page rechecks current project access and the
same checkpoint, revision and Intent migration pins. The query reads no source
objects or complete Work; pages read at most 50 rows with a 256 KiB read/response
budget (one existing larger event remains readable).

An unprovable base or event boundary logs `journal delta fallback` with its reason.
Full checkpoint recovery reuses hash-verified retained downloads, including receive
directories written by older CLIs. Resolved metadata is retained before journal
export, so an interrupted export does not redownload the same large Work. Current
servers still return journal pages after base recovery. Older deployments use the
existing full `exportJournal` action; older CLIs keep that action unchanged. Access
failures and stale snapshot pins remain errors. Local companion validation, merge
conflicts, operation retries and final revision/CAS checks are unchanged. This
reduces network and hosted storage reads; local replay and merging still scale
with retained Work. Live latency and billing require separate measurement.

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
loads complete Work metadata, and per-Candidate provenance can grow with its changed
paths and retained saves. They do not establish a fixed memory bound for every
possible project history.
Selected Candidate steps derive only the requested Candidate's read model, retaining its
supersession and acceptance context; save-index lookup scans backward without
copying the Lane's save history. The memory fixture uses a producer process to
write synthetic backups and emitted test handlers to disk, then a separate action
process under `--max-old-space-size=384`. It reports producer and action lifetime
peak RSS separately, including Node and imports, plus sampled action heap. Its
compatibility action has 12,000 saves and 1,425 source files but no Candidates; it does
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

Exchange HTTP requests bound response headers, body inactivity and total request time.
Object transfers and Convex queries/mutations allow 30 seconds without headers or
body bytes, with a two-minute total per attempt. Long Convex actions (publication,
source return, journal export, logical-manifest reconstruction, index preparation,
history completion, initialization, object-recipe completion and archive migration) allow the full ten minutes both before
headers and in total, with 30 seconds of body inactivity after headers. Quick
checkpoint and download actions keep the short transfer deadlines. Long actions
also override Node's underlying HTTP header deadline to ten minutes; extending
only the application timer would still stop them at the transport's five-minute
default. Reads and replay-safe actions retry
three times after 100, 200 and 400 ms; each retry keeps the exact payload and operation
ID. Exhausted network failures report `EXCHANGE_REQUEST_TIMEOUT` or
`EXCHANGE_REQUEST_FAILED` with the call name, never a signed URL. Structured Convex
function errors keep their original code. Upload POSTs to Convex storage are bounded
but not blindly replayed: retrying the exchange reconciles their existing nonce-bound
objects. Redirected Convex storage downloads and recipe leaf reads also buffer the complete
response inside these deadlines; a partial body never outlives its timer. Legacy archive metadata and ancestry keep their streaming/early-cancellation behavior inside the
same deadlines. Server-side R2 and archive range reads use the same 30-second/two-minute
bounds with one retry; range-less archive responses still discard their prefix and
cancel the unused suffix.

The five-second reconcile heartbeat names manifest loading, work.json download
(with logical bytes reconstructed out of total), journal export or local merge,
and the active Convex function or R2 GET when waiting for its reply. R2 signed GETs are checked
for every uncached object, even with new R2 writes disabled. Signing returns no URL
for Convex-stored objects, which retain their existing download fallback. Previously
committed R2 rows remain readable with `FORGE_BLOBS` unset; the write flag and project
opt-in do not change their storage location.

Journal export pages hosted events and streams checkpoint byte reconstruction. Schema-1
Work reconstruction reads four byte chunks at a time; record checkpoints keep their
bounded record windows. Export hashes parsed Work with a streaming JSON digest rather
than building a second complete Work string. Export still materializes complete parsed
Work and the returned journal; it is not a proportional metadata read API.

Zero bytes uploaded does not mean zero work. Validation and hashing still happen locally. To time one request, run `node scripts/measure-exchange-latency.mjs REQUEST_JSON RESULT_JSON`.

## Object proposals and browser imports

The Backups and Proposals pages accept local export files, unpack them locally, and upload logical objects rather than compressed archives. Identical content is reused. A browser backup that races a newer selection is retained without rewinding the current checkpoint. New archive registrations are retired; old stored archives and original pending uploads remain readable and resumable. No migration or deletion is needed to use object transport. Local recovery/release archive export remains available.

For an object proposal, download its receive request (`{url,projectId,proposalId,operationId}`), then run:

```sh
nforge exchange ROOT receive-proposal --command-file forge-proposal-receive.json
```

This downloads and validates the proposal, then imports it into a separate Lane in the existing owner using the original operation ID. Receive the hosted Intent first through the existing Work reconciliation flow. `pull-proposal` with `{url,projectId,proposalId,cacheRoot?}` is also available to retain an unpacked export in a fresh directory. Use that directory as `archivePath` in the existing `import-native-contribution` request and its manifest SHA-256 as `archiveSha256`. These compatibility field names also accept local archives with their original compressed digest. The importer validates complete source closure and creates a separate Lane; contributor Work and check claims never become owner evidence.

Warm native pushes keep a checksummed preparation hint per project/checkpoint. It reuses retained source and finished-run content and omits known uploaded pins from negotiation. Corrupt or missing hints fall back to full preparation. The server validates changed digest/size bindings against a fully validated prior immutable closure; old or incomplete checkpoints take the full path. Access and current project state are checked again at publication. Source returns retain the public Work generation, including when a larger record partition is staged. CLI cursors pin the source revision to prevent mixing pages across returns.

Native pushes prepare a required protocol-3 owner display document alongside
pinned Work. Selection uses the hosted source-return baseline, independently of
the previous upload checkpoint. New States carry own-parent ancestry boundaries;
changed comparisons, Views, selected trees and coordination paths are computed
locally. Missing baseline metadata supplies full local facts for server selection.
The disposable local cache remains bounded to 4 MiB; an uncached item is computed
locally. The upload document has no total 4 MiB item budget: larger documents use
hash-checked pages. Invalid or incomplete current documents fail explicitly;
older documents report `CLI_UPGRADE_REQUIRED`. Source/Work pins and original
successful receipts remain stable across retries.

For a read-only offline measurement of a retained pending push, build core and run
`node scripts/measure-owner-derived.mjs OWNER`. Add `--current` to measure current
owner Work against the same hosted baseline. This reads local source and exact
prepared metadata only, writes a replacement cache to temporary scratch and
removes it, and never contacts hosted or modifies owner transport state. Output
reports old/new sidecar and cache bytes and delta row counts.

Hosted source return remains owner-only. It checks sidecar shape, Work pin,
comparison and Candidate keys, counts and object-pin membership using metadata. Valid
complete sidecars supply the staged index rows; absent, malformed or incomplete
current data fails explicitly. The server never fills display gaps during push. Publication
retains its original operation ID, current authority checks and source/Work CAS.
No Work format bump, hosted row migration or backfill is required. The sidecar is
a disposable index supplied under the owner's existing source trust. Contributor
proposals retain their existing hosted derivation path.

Native object returns copy retained database index rows for State parents, immutable diffstat pairs and unchanged Candidate provenance. Complete and streamed native projections produce identical parent-cache rows and counts, including chunked parents for large fan-in. Only new source heads receive compact, chunked ancestry closures; older pair indexes remain readable, and missing pair membership can be resolved lazily from cached parents. Acceptance and supersession refresh the affected Candidate summaries without rereading unchanged file provenance. Row deltas of at most 1,000 rows publish atomically into the selected partition. Larger deltas use a private staged partition and a short final CAS; existing readers see the complete old or new partition. Optional cache fields and record collections require no migration; an older generation reuses its complete ancestry boundaries and caches new States during its next return.

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

### Superseding an uncommitted retained push

`nforge exchange ROOT push --supersede-retained` explicitly retires a stuck
native bound push and starts a fresh capture. Use it when an immutable retained root
cannot take the record-delta path. Ordinary `push` continues the original
operation unless an explicit supersession is already pending.

The CLI saves the original request and a replacement UUID before contacting the
server. In one transaction the server checks current owner authority, verifies
that the selected hosted Work backup and revision still match the original
return base, and verifies that the original return has no committed receipt.
It records a tombstone for that return UUID. The final source-return transaction
checks this tombstone, so an in-flight old action cannot commit after supersession.
A committed return reports `SOURCE_RETURN_COMMITTED`; moved hosted Work reports
`WORK_STALE`. Either rejection leaves the original push available for receipt
reconciliation. No checkpoint, source object, Work or staging data is deleted;
the uploaded checkpoint stays available under normal retention.

A crash before the server transaction, a lost server reply, or a crash before the
local replacement is installed resumes the same saved supersession on the next
ordinary `push`. Repeating the flag while the replacement is pending resumes that
replacement. Local transport state retains the retired request and replacement
UUID in `supersededPushes`; do not delete or rewrite pending transport files.
The replacement captures current local Work, reconciles selected hosted Work,
and builds its delta against that selected Work checkpoint, independently of the
latest uploaded checkpoint used as the publication predecessor. Optional missing
baseline hints are recovered by normal reconciliation. Publication authenticates
the delta against that selected, fully validated Work catalog when the latest
upload is a superseded candidate; its predecessor CAS still pins the latest
upload. Delta eligibility and all
existing authority, retained-history, closure and final CAS validation still apply.

Large compatibility returns split retained Intent payloads into immutable private
record pages while decoding an older prepared snapshot. Exact Work hashing reads
those pages in original property and record order. Retained-history validation
hydrates only the matching original records; schema validation and index payload
projection consume bounded page groups in separate resumable steps. The final
staging cursor retains compact relationship context and output references rather
than complete Intent notes and lifecycle history. Owner-supplied display facts
remain required; the server does not derive source or provenance.

## Pending saved work

Each owner durably records saved mutations in `pending-exchange.json` beside its
Work store, independently of hosting enablement. Lane checkpoints (including
unlanded saves), Work edits, check completion and acceptance all pass through the
same commit boundary. A burst coalesces while retaining its first and last pending
times and revision range. The pending write is fsynced before publishing the Work
pointer; an interrupted commit can conservatively leave extra pending work.

An exchange capture seals that burst under the owner lock. Later writes form a
new batch and retain their own first-pending time. The retained exchange directory's
`pending-work.json` pins the owner queue identity, covered sequence, capture time,
Work revision and Work digest. These are local transport records, excluded from
portable Work. Older captures without these pins cannot clear the queue. A
successful complete-history push with no unavailable evidence acknowledges only
its captured batches. Bound pushes acknowledge after source return and index
refresh; failed or unknown outcomes stay pending for original-operation retry.
Current-first hosting leaves history and evidence pending until its full transfer
completes. Capturing, updating transport receipts and importing already-hosted
metadata do not enqueue new work themselves.

The project policy has a separate `autoExchange` preference: `enabled:false`,
`debounceMs:30000`, `maxPendingAgeMs:300000` by default. Partial `set-policy` edits
preserve unspecified fields; changing an acceptance preset preserves this project
preference. Enabling it wakes a detached per-owner driver on startup and saved
Work publications. It uses a trailing quiet debounce and the oldest pending save's
maximum age, with no check-green gate. Startup recovers a dead worker using kernel
process identity; the existing bound-push queue serializes automatic and manual
pushes. Unknown replies reconcile the retained original operation before another
snapshot. Saves during transfer get a follow-up capture. Bookkeeping does not
publish Work. Binding `autoSync` and GitHub `autoPush` remain separate.

The worker listens on a private local wake socket and watches publication events only while pending. Lifecycle clients notify the retained live worker directly, including after disable/rebind; filesystem events are advisory. When idle it
exits: no polling, usage read or network request. Pending retries use backoff;
pauses use one expiry timer that local changes can wake. Authentication failures
and journal conflicts retain pending work and a safe error code; owner activity
retries after the operator fixes the cause. An incomplete capture remains visible
and does not upload identical saves repeatedly; new saves or a manual push retry
it. No first-host history backfill is started by this worker.

`nforge host ROOT --status` and `nforge pending ROOT` include `autoExchange` with
pending age, status, retained operation, next attempt, spend observation, transport
observation, resume guidance and Undo. Both automatic and manual bound pushes report
`phase`, `lastProgressAt` (Unix milliseconds), and `stalledAfterMs`. Actual phase
changes, received headers and received bytes update progress; repeated attempts
of the same call and console heartbeats do not. After eleven minutes without progress, status reads `stalled` with the
instruction to retry on owner save/startup or run `nforge exchange ROOT push`.
The bound push remains retained with its original operation and capture pins.

On the next wake, a stalled automatic driver receives a cooperative cancellation
through its existing private wake socket. Its active exchange requests abort and
unwind before releasing the bound-push and automatic-driver queue slots. A
successor waits up to five seconds for those slots, then resumes the same retained
operation. Queue tickets still use kernel process-start identities: no live
holder is evicted on elapsed time alone, and no OS process signal is sent. An
older, unresponsive driver that cannot cooperate keeps its slot; status remains
stalled until it exits, and later startup/save retries recovery. Manual pushes
share the same serialization and cannot overlap it.

Disable future automatic pushes with
`set-policy {"autoExchange":{"enabled":false}}`; published history is retained.
Manual pushes remain available, including during a spend pause.

### Optional daily spend observation

For the dogfood project, enable `autoExchange.pauseOnDailySpend:true` alongside
`enabled:true`, `debounceMs:30000` and `maxPendingAgeMs:300000`. It is absent/off for
other projects. This defers new automatic attempts when measured team spend rises
**strictly more than USD 1** against the earliest retained observation within the
rolling 24-hour window. It never kills an in-flight push or blocks a manual one.
A pause resumes automatically when that baseline leaves the window, with a fresh
observation before admission. Until a full day has been observed, the baseline is
the first available sample. Team totals include unrelated usage and billing can
lag: this is an observed-delta pause, not an exact per-push cost ceiling.

Configure an **owner-local executable**, not a portable policy or hosted command:

```sh
nforge host ROOT --spend-command /absolute/owner-owned/forge-daily-spend
```

The path is saved only in the local hosted binding. The executable receives
`projectId` and `deployment` as its two arguments and writes exactly one JSON
observation to stdout:

```json
{
  "kind": "measured",
  "scope": "team",
  "subject": "stable-team-and-billing-counter-identity",
  "projectId": "your-project-id",
  "deployment": "https://your-deployment.convex.cloud",
  "observedAt": 1792656000000,
  "totalUsd": 12.34
}
```

`totalUsd` is the cumulative team spend counter in USD. `observedAt` is the
provider's observation time in epoch milliseconds, not the time an old cached
response was read. Counter resets or team changes start a new baseline.
`kind:"estimated"` is accepted as an estimate, but cannot admit a protected
automatic attempt.

Forge runs the executable without a shell, with a five-second timeout and a
16 KiB combined stdout/stderr bound. HOME, XDG and temp directories are private
and removed afterwards; the working directory is private too. PATH contains the
running Node directory and system executable directories. No environment or
Forge secrets are inherited. This is not an OS sandbox: the owner-controlled
executable can access files with the owner's OS rights. It alone reads the
provider token the owner already has; Forge never discovers, reads, stores or
passes a Convex team token. Keep credentials out of command arguments, returned
observations and logs. Provider error text is discarded.

For example, this executable shape uses an **owner-provided billing reader** that
knows the owner's existing provider API and credential file. That reader is not
part of Forge; substitute its path and the existing credential path. Use an
absolute Node shebang (from `command -v node`) and `chmod 700` the executable:

```js
#!/absolute/path/to/node
const { readFileSync } = require('node:fs');
const { readTeamSpend } = require('/absolute/owner-owned/convex-billing-reader.cjs');
const [projectId, deployment] = process.argv.slice(2);
(async () => {
  // Only this owner-controlled process reads the already-existing token.
  const { token } = JSON.parse(readFileSync('/absolute/private/provider-credentials.json', 'utf8'));
  const usage = await readTeamSpend({ token });
  console.log(JSON.stringify({
    kind: 'measured',
    scope: 'team',
    subject: usage.counterIdentity,
    projectId,
    deployment,
    observedAt: usage.observedAt,
    totalUsd: usage.cumulativeTotalUsd,
  }));
})().catch(() => { process.exitCode = 1; });
```

Spend is read only before admitting a pending automatic attempt, never on idle,
status or a manual push. Successful measured observations are reused for up to
one minute, including across worker restarts; expiry causes a read on the next
attempt, with no polling timer. Changing the command invalidates that cache.
The rolling spend calculation still uses the retained 24-hour history.

With `pauseOnDailySpend:true`, missing configuration, command failures/timeouts,
invalid JSON, cross-project, future, out-of-order or at-least-24-hour-old samples
**defer automatic pushes**. `autoExchange.status` is `paused`, with code
`AUTO_EXCHANGE_SPEND_UNAVAILABLE`; `spend.reason` distinguishes `unconfigured`,
`unavailable` and `stale`. `spend.paused` describes only a measured threshold
pause; unavailable dollars remain null. Status and pending output include the
reason and recovery guidance. Fix the executable, then set `--spend-command`
again or resume owner activity (save/startup) to retry. There is no background
usage polling while deferred. Manual `nforge exchange ROOT push` stays available.
Remove the local executable setting with `nforge host ROOT --no-spend-command`;
protected automatic attempts then remain deferred until it is configured again.
The previous `FORGE_CONVEX_USAGE_ADAPTER` in-process module hook is replaced by
this local executable setting.

Successful bound and explicit push receipts include `observation`: measured HTTP
attempts/RPC requests, request/response body bytes and process elapsed milliseconds.
Retries count as requests. Counts exclude headers/TLS and server-internal work;
source-return accounting remains separately available. Scope is the current local
attempt (including receipt replay), not cumulative billing for the original
operation. `estimatedUsd` and `billedUsd` are null: bytes and RPCs are not prices.
The latest successful bound observation is retained for local status.

## Recovery inventory

`nforge host ROOT --status` includes the read-only `recovery` inventory. The exported
`readRecoveryInventory(root, now?)` function returns the same typed data for other
status consumers. It performs no network calls, export, check recovery or Work
mutation. It reports completed seed/exchange/export capture times, root source and
accepted main heads, exact Work revision/hash, manifest pin, complete-history state
and each check evidence path's included/unavailable status. Source/Work capture
time is separate from evidence sampling and successful completion time.

A successful local export is listed separately and **does not prove an off-machine
copy**. Completed seeds and exchanges with complete retained history establish the
inventory's off-machine baseline. First hosting records a complete seed capture
only after seed finish succeeds and the pinned main digest is validated. Failed
or unknown finish outcomes add no capture until a retry confirms completion;
completed replays reuse the same receipt. Missing
logs/artifacts remain unavailable even when source and Work publication succeeds.
Nothing here blocks export, manual push, checking or acceptance.

Pending saves compare canonical record fingerprints against that baseline,
including unlanded Lane checkpoints, check completions and changed Work records.
These are saved records, not a count of every intermediate editing operation.
Evidence fingerprints detect later running-log bytes even without a Work revision
change. Oldest pending age uses recorded save times; un-timestamped replacements,
unknown capture times or pending evidence with no save timestamp produce `null`,
not zero. `oldestKnownPendingAgeMs` preserves the oldest known save age separately.
Unsaved filesystem edits and running processes remain outside this inventory.

The durable inventory and capture timing are local sidecars under `.forge/work`,
not canonical Work or additions to the archive/exchange wire format. They survive
process restarts without triggering another save. Existing captures without timing
report unknown time; restored owners without those sidecars have unknown prior
coverage. Preserve an export's returned recovery receipt alongside an off-machine
archive when recording its identity. Receipts describe observed successful capture,
not current remote storage health or a promised backup cadence. A reporting write
failure returns `RECOVERY_INVENTORY_UNAVAILABLE` without changing publication
success; missing/corrupt inventory never establishes coverage.
## Guided existing-project recovery

`nforge recover NEW_OWNER --command-file REQUEST.json` obtains a matching full
checkpoint and hosted journal with current owner authority, reports restored
main/Lane/evidence coverage, and explicitly reconnects the existing project.
Requests carry `{operationId,url,projectId,archivePath?,cacheRoot?}` and no token.
Native archives and hosted object checkpoints retain their original hashes;
whole-deployment weekly ZIP recovery first restores its application/backend.
See [the recovery drill](recovery-drill.md) for commands and qualification.

An explicit `recover OWNER reconnect` binds an independent restore as owner;
`recover OLD_OWNER client` returns the original Mac to an independent-copy role
while preserving its work. Neither changes hosted identity/authority or introduces
a lease. Existing source/Work/Channel CAS and reconciliation govern concurrent
owners. `exchange pull` keeps its selected-main source-client semantics.

## Hosted Lane editing checkout

`nforge exchange NEW_DIRECTORY open-lane --command-file REQUEST.json` opens an
exact hosted Lane selection without restoring a Work owner. The request is
`{url,projectId,laneId,operationId,expected?,paths?}`. Optional `expected` pins
`{head,sourceVersion,version}`; stale pins return `WORK_STALE`. Use the existing
login or `FORGE_AUTH_TOKEN`, never a token in the request file.

Omit `paths` for all files, or select relative file/directory paths for a sparse
checkout. An empty array initially opens only the baseline marker. Later calls
expand the selected paths; omitting `paths` expands to a full checkout. Existing
materialized paths and directory scopes remain selected. Paths describe editing
scope and confer no access or landing authority.

`.forge/hosted-lane.json` retains the full baseline State, exact schema-2 Lane
selection, deployment URL, operation UUID, scope and actual `materialized` paths.
Each baseline entry includes its digest and mode. Missing paths outside that set
are unchanged, never deletions; a missing materialized path is a local deletion.
Save clients must use that distinction when constructing an explicit delta.
Hosted save publication is a separate API; checkout itself changes no server head.

Verified objects and original-operation receipts live beside the directory in
`NEW_DIRECTORY.forge-client`. Membership and R2 signing use windows of at most
100 missing objects; full source/Work archives and Channel histories are not read.
An unchanged checkout downloads zero new source objects. Source files are writable
independent copies; executable modes, binary bytes and symlink target bytes are
preserved, including dangling links. The same symlink handling applies to hosted
main checkout.

The install stages a complete selected directory before replacement. Dirty files,
mode/link changes, local deletions and untracked content return `WORK_CONFLICT`
with content preserved. Interrupted downloads leave the existing checkout intact;
retry the original request UUID to resume its pinned selection. Install recovery
restores the previous directory when replacement stopped between renames, or
reconciles the installed operation marker after a lost completion receipt. An
older unfinished checkout cannot overwrite a newer marker. Completed retries
recheck access and return their original receipt without rewinding newer edits.

### Hosted Lane save API

`saveHostedLane(root, {operationId, message}, exchange)` saves a thin hosted Lane
checkout through the hosted save APIs. The hosted agent CLI uses this same
source-client helper; browser editor wiring is separate. The operation retains its command, captured
bytes, full baseline and delta pages in the sibling `.forge-client/saves` cache.
Retry the original operation after a lost upload, commit or response. Later local
edits remain on disk; retry uploads the captured bytes. Successful reconciliation
advances only the matching checkout baseline marker, without installing files.

A delta names each changed path's exact prior blob/mode and its replacement or
explicit deletion. Unmaterialized absent paths remain unchanged. Local additions,
rename-as-delete/add, executable modes, symlinks and binary bytes use the same
contract. The client first discovers missing logical objects in 100-object
windows, reuses existing chunk/recipe upload and verification, and stages ordered
metadata pages of at most 100 changes and 128 KiB. These windows do not limit the
total source size. An unchanged save records success without moving the head or
launching a worker.

`projectHostedSaves:prepare`, `stage` and `progress` retain the original operation,
baseline, counts and exact linked page root. `projectHostedSaveJobs:submit` creates
one child source job pinned to Modal, `FORGE_SOURCE_WORKER`,
`FORGE_SOURCE_RUNTIME` and `FORGE_SOURCE_KEY_ID`. The trusted worker verifies the
baseline State and each prior delta entry, downloads changed blobs with bounded
buffers/private disk, preserves other paths and constructs the native State with
server-selected parent/time. It never materializes or executes repository code.
State metadata still scales with the file manifest in worker memory.

The authenticated source-control ingress maps the worker's `grant` and `commit`
requests to internal `projectHostedSaveTransfers` functions, passing the exact
serialized dispatch, execution ID and content pin. Each call rechecks current
project/contributor access, authority epoch, worker lease and fence. Read grants
sign committed project objects, including verified recipe leaves; output grants
use the existing configured R2 path and create-only checksum-bound PUTs. Commit
performs HEAD verification and then rechecks authorization and the exact storage
key before binding the bytes. Source bytes do not pass through a Convex action.
These functions are internal: deployment, authenticated ingress routing, key and
provider provisioning remain required operator integration, not an enabled public
HTTP endpoint or a live end-to-end qualification.

A signed terminal source-job callback schedules `projectHostedSaveJobs:complete`.
That action reads only the small result manifest; the final mutation binds it to
the original input and signed job output, checks committed State membership and
atomically registers the State, CAS-updates the Lane, appends one save and retains
the original receipt. Two changed saves racing on one baseline have one winner;
the loser receives retained `WORK_STALE` evidence and keeps its delta. A new save
or sync can use that preserved source. Completed retries return their original
receipt and never rewind later Lane work. No main, Candidate or landing authority
is granted by a source upload or save.

### Hosted compose API

These APIs compose saved hosted source without a local Work owner. The hosted
agent CLI stages the same exact selection pages; browser controls are separate.

- `projectHostedCompose:prepare({projectId, request})`: `request` is JSON matching
  `composeRequestSchema`: original `operationId`, `intentId`, `authorityEpoch`,
  `expectedMain:{head,receiptId}`, `message`, and `inputs`/`dependencies` manifests.
  Each manifest is `{root:{sha256,size},pages,count}`. Even an empty selection uses
  one canonical empty terminal page. Select a Lane or dependency overall.
- Input page entries bind `{laneId,head,version,sourceVersion,lifecycleVersion,state}`.
  Dependency entries bind `{candidateId,head,state}` to a clean immutable Candidate.
  `state` is `{object:{sha256,size},recipe:{sha256,size}|null}`. All selections and
  objects belong to this project. `buildComposePages` automatically splits the
  ordered entries into canonical `forge-hosted-compose-page` objects; upload these
  through the existing missing-object path before staging.
- `stage({projectId,operationId,kind,index,page})` accepts the next exact JSON page
  for `kind:"inputs"|"dependencies"`, with a zero-based index. Each page contains
  `schema:1`, `kind:"forge-hosted-compose-page"`, `entries`, and `next` pin or null.
  `progress({projectId,operationId})` returns the retained staging state, terminal
  receipt, and server-pinned input once both manifests have been staged.
- Upload the exact canonical input returned by `progress`, then call
  `projectHostedComposeJobs:submit({projectId,operationId})`. Retry the original
  operation and payload after unknown replies. Completed retries return the
  original Candidate rather than computing or publishing another one.
- `projectHostedCompose:candidate({projectId,candidateId})` reads the canonical
  Candidate under current source access. The Candidate pins its Intent, original
  main head/receipt, ordered input/dependency roots and algorithm plus runtime.
  Its result is `{status:"clean",head}` or `{status:"conflict",conflicts:{sha256,size}}`.
  `composeConflictPageSchema` describes the linked conflict pages. Exact side
  States remain available for resolution; no resolution or sync is performed here.

The trusted authenticated source-control ingress must also route `describe` to
`projectHostedSaveTransfers:describe`, deriving `projectId` from its authenticated
pinned dispatch. Its internal result is canonical JSON text; the HTTP response carries the decoded
descriptor object. It returns only committed project object/recipe descriptors,
rechecking current execution, fence, lease, epoch and contributor authority.
The existing grant/commit transfer functions accept H08-owned compose jobs as
well as saves; bytes continue to travel directly to/from object storage. A compose
upload grant can return `{stored:true}` for an already committed logical object,
including legacy or recipe storage. The fixed transport consumes and verifies its
exact bytes without a redundant PUT/HEAD. Save-job grant replies retain their
previous contract for already pinned worker images.
The small signed result schedules `projectHostedComposeJobs:complete`; no client
needs to remain connected and no recurring idle worker is created. Only the small
result manifest crosses the finalizer action. Rebuild and pin the fixed image
with the compose reducer and descriptor transport before enabling this route.
Ingress provisioning, remote deployment, resolution/sync, live check dispatch and
landing remain separate work; these APIs alone do not enable a live end-to-end hosted loop.

## Hosted check API

The check APIs operate on canonical hosted Candidates without a local owner.
They accept/return canonical JSON text for versioned request/result contracts.
The provider contracts have local fake coverage; these endpoints alone do not
start live compute. Existing native check requests are unchanged.

- `projectHostedCheckDefinitions:configure({projectId,request})` takes an original
  `operationId`, `authorityEpoch`, `expected` digest (null to create), and `change`.
  For `kind:"definition"`, provide `checkId` and `command` using the local check
  fields: name, executable, args, environmentLabel and optional environment-name,
  credential-name, artifact-path, static/resource and declared-input settings.
  For `kind:"import"`, provide the existing `check` with its UUID, definition and
  timestamp. For `kind:"runner"`, provide `configuration` with `provider:"modal"`,
  `app`, `function`, `runtime`, `environmentFingerprint` and credential-use
  reference `{secretId,version,operation}`. Alternatively, use
  `provider:"github-actions"`, `repository:"owner/repo"`, `installationId`,
  `runsOn`, `runtime`, `environmentFingerprint` and the same credential-use
  reference for an existing GitHub App installation token. `runsOn` is the exact
  GitHub-hosted or Blacksmith runner label. `hostedActionsRuntime` exports the
  fixed Actions harness runtime fingerprint. No credential values are accepted.
  Settings use existing project-owner authority. Each mutation retains its exact
  original receipt; replay cannot rewind a later setting.
- `projectHostedCheckDefinitions:current({projectId,checkId})` returns the selected
  check, runner configuration and configuration digest. `list({projectId,cursor})`
  pages definitions. Current readers can inspect them; contributors can enqueue
  against the selected pins.
- `projectHostedChecks:enqueue({projectId,request})` takes `operationId`,
  `authorityEpoch`, `candidateId`, `expectedHead`, `checkId`, `expectedDefinition`,
  `expectedConfiguration` and `expectedEnvironment`. The Candidate must be clean,
  canonical and registered, and its exact State must match. Fresh requests require
  current definition/configuration/environment pins. The result retains a run
  UUID, stable dispatch key, frozen Candidate/definition/configuration and unknown
  initial cost. Original retries return that run after later source/configuration
  changes; they do not create another paid execution or switch its provider.
- `projectHostedCheckRead:status({projectId,runId})` reads one compact record with
  counts and exact pins, independently of shard/history size. `list` accepts a
  Candidate UUID and cursor. `shards({projectId,runId,cursor})` pages current shard
  metadata in automatic 100-row/128-KiB transport windows. Continue `continueCursor`
  until `isDone`; these windows are not a total run/shard/output limit.
- `projectHostedChecks:cancel({projectId,request})` takes its own original
  `operationId`, `authorityEpoch` and `runId`. The requester or project owner can
  cancel. Before dispatch this is terminal; after dispatch reservation it sets
  `cancelRequested` and retains an honest running/unknown status until a provider
  acknowledgement. Cancellation does not assert remote compute was terminated.

The internal `projectHostedCheckApi:control` mutation takes project/run identity
and a strict JSON `command`: `claim`, `prepare`, `reserve`, `empty` or `observe`.
The adapter prepares and uploads a complete immutable plan/selection outside
Convex, then supplies `head`, `definition`, `runtime`, `environmentFingerprint`,
`lockfile`, selection/manifest `{sha256,size}` references and positive `shardCount`.
The plan includes every selected job, including static checks. Indices cover
`[0,shardCount)`. Plan preparation checks committed object bindings and frozen
runtime/source pins. The provider must verify the actual source/lockfile/selection
bytes and execute that exact manifest; client claims cannot call this internal boundary.

`dispatchHostedCheck` runs a short controller tick through that mutation. A lease
owner/token fences responses. Dispatch intent is durable before external I/O.
Adapters must bind lookups to the complete original request and deduplicate
submissions by `dispatchKey`, including lost responses. Unknown lookups stay
unknown. One recovery requires two distinct fresh authoritative empty lookup
receipts under the current lease and reuses the original execution key/plan.
Eventually consistent absence is not authoritative. A rejected recovery retains
unknown status, since the original submission could still be running. The
controller does not choose a replacement provider or start an idle polling loop.

Trusted collection ingress calls only the internal
`projectHostedCheckApi:callback` with exact callback JSON and its signature. The
backend pins `FORGE_HOSTED_CHECK_KEY_ID` at enqueue and resolves
`FORGE_HOSTED_CHECK_KEY_<keyId>` itself. Signing uses the
`forge-hosted-check-provider-v1` domain. Keep this signing authority in fixed
collector/control code, isolated from project commands, source workers and account
credentials; never pass a signing key in a dispatch payload or project environment.
Provider integration owns ingress provisioning and pending-work wakes. Nothing
here deploys or provisions those integrations.

`hostedCheckCallbackSchema` binds project/run/operation, epoch/fence, provider and
execution, source/definition/configuration/environment, runtime, plan digest,
lockfile and selection. `kind:"shard"` carries index, ordered attempt, provider
execution, status/exit code and optional output reference. Running-to-terminal
transitions retain the same shard execution; replacement attempts retain older
callback receipts. `kind:"complete"` carries terminal/unknown status, exit code,
optional output reference and unknown or receipt-backed cost. Overall success
with missing, running or unsuccessful selected shards stays unknown. Late events
cannot rewrite a terminal outcome, and even duplicates recheck current authority.
No stdout or artifact byte field is accepted; R2 chunk/manifest transfer is H12.

H13/H14 can call `requireHostedCheckEvidence` inside their final transaction. It
requires the exact passed run, complete successful shard counts and current
definition/configuration/environment/epoch pins under current authority. Landing
still checks its own policy and main head plus receipt. A check result does not
move main or add a check requirement to person-selected acceptance.

### Hosted explicit sync and conflict resolution APIs

These APIs operate on hosted source records, without restoring a native owner.
There is no automatic recurring sync or added UI in this source API layer.
Every request has `operationId`, `authorityEpoch`, `message`, and one variant:

- `kind:"sync"`, `laneId`, exact `expected` Lane pins
  (`head`, `version`, `sourceVersion`, `lifecycleVersion`), and `target`:
  `{kind:"main",head,receiptId}` or `{kind:"candidate",candidateId,head}` for a
  clean immutable Candidate. Main's receipt distinguishes same-byte ABA moves.
- `kind:"resolution"`, `candidateId`, and exact `conflicts:{sha256,size}` from
  that conflict Candidate. This selects the original conflict, even after its
  input Lanes save again.
- `kind:"resolve"`, `laneId`, and exact `expected` pins for the saved resolution
  Lane. This completes its pending merge against the retained original inputs.

Call `projectHostedSync:prepare` with `{projectId,request:JSON.stringify(request)}`.
`projectHostedSync:progress` takes `{projectId,operationId}` and returns the
original `input` plan, staging state and optional terminal receipt. Commit the
canonical plan bytes as the exact project object, then call
`projectHostedSyncJobs:submit` with that identity. Source transfers and signed
callbacks reuse the existing job-authorized descriptor/grant/commit seam.
Rebuild and pin the fixed worker image with sync support before provisioning it;
this code does not deploy or configure a provider. Server finalization is short
and independent of a browser, coding host or native-owner process.

A completed terminal result contains `status` (`up-to-date`, `merged`, `conflict`
or `resolved`), exact schema-2 `lane` selection, the original `from` Lane pins
(or null), resolution provenance (or null), and original time/operation ID.
Conflict returns a **new resolution Lane**; its original Lane stays unchanged.
Its `resolution` retains `candidateId` (null for a direct sync conflict), exact
`conflicts`, `left`, `right`, `draftHead` and `status:"pending"`. Read/open that
Lane with the existing Lane checkout API. Text uses the local native sync
markers; binary and path conflicts retain the Lane side.

Save chosen resolution files through `saveHostedLane` or the existing paged save
APIs, then drive `resolve` against that saved head. The worker verifies draft
ancestry and the same unresolved-marker rule as local sync. Resolution can
explicitly choose unchanged binary bytes or delete a conflicted path. Success
retains the saved resolution head and original right input as parents and returns
`resolved`; it never resolves against silently newer source. A pending resolution
cannot be used as a completed compose input. Callers may drive this API phase
within their existing save/resolve action; it requires no new person approval.

For the next composition, first compose only the resolved Lane with empty
dependencies, producing a clean resolution Candidate. Prepend that Candidate to
the original ordered dependencies, then retain the original ordered Lane inputs
(including the suffix after the first conflict), using explicitly observed heads.
Dependencies execute before Lane inputs, so this prefix also resolves conflicts
that occurred during dependency composition. When there are no dependency-stage
conflicts, selecting the resolved Lane first among the original inputs can avoid
the intermediate Candidate. Later disjoint changes merge through ancestry; later
overlap creates another explicit conflict. These are source API phases that
callers drive, not extra person approvals. The Candidate and any required
check/landing remain separate operations under their current contracts. H15
finish and H17 compensation can reuse these pinned phases; none of these receipts
authorizes main movement or reuses a check on new bytes.

A same-Lane save while sync/resolve runs fails the final CAS with a retained
`WORK_STALE` receipt; its newer source and the original attempt remain available.
A fresh attempt uses a new operation UUID and explicit observations. Retry an
unknown result with the **original** request, including all expected pins. Current
access is checked even for completed retries, which return their original receipt
without moving source or starting another job.

For optional local application of a clean sync/resolved result, call
`applyHostedSync(root,{operationId,url,status,from,lane},transport)` using
`LaneTransport`. `from` is `{laneId,head,version,sourceVersion}` from the result.
This helper pins both the
previous client marker and exact server selection. It preserves sparse scope,
downloads only missing selected objects, and stages installation before checking
local bytes and marker again. Local edits, deletions, link/mode changes and
untracked contents are preserved on `WORK_CONFLICT`; a newer client baseline is
`WORK_STALE`. The original server result remains successful when local install
cannot proceed. Completed apply retries check current access but do not overwrite
later edits. There is no filesystem watcher, background pull or recurring timer.


## Hosted check output API

The provider-neutral output contracts are in `src/hosted-check-output.ts`.
`collectHostedOutput` redacts before the durable `OutputSink.retain` call;
`hostedOutputPublisher` connects the sink to internal signed R2 transfer APIs.
The adapter provides a durable redacted spool, credential/root redaction inputs
and its fixed trusted transport. Project-code processes receive none of the
collector key or upload-signing authority. No live provider ingress is enabled.

Internal `projectHostedOutputApi` functions take `{projectId,message,signature}`.
`message` is canonical JSON with schema 1, run/operation IDs, epoch, fence,
execution ID, source head, plan digest and a strict `body`:

- `kind:"chunk"` carries `{stream,sequence,offset,object:{sha256,size}}`. The
  stream pins shard index, attempt, execution ID, kind and redacted display name.
  The collector also sets a stable opaque `identity` digest before name redaction,
  preserving separate artifacts when their redacted display names coincide. Use
  the returned descriptor when verifying or replaying chunks.
  `prepare` returns an exact signed R2 target; PUT the redacted bytes directly.
  A create-only 412 reconciles through `commit`, which checks HEAD and current
  run authority before appending metadata. Retry the same chunk after a lost ack.
- `kind:"seal"` carries `{stream,chunks,bytes,sha256}` for the complete redacted
  stream, including an empty stdout/stderr/artifact. `commit` requires all chunk
  sequences and offsets. A missing chunk remains a recoverable gap.
- `kind:"final"` carries `root` from the current manifest response. After the
  check has a terminal result and every declared stream is sealed, upload the
  canonical root JSON using `prepare`, then `commit`. The root binds run/execution,
  revision, index hash-chain and stream/chunk/byte totals. It is immutable;
  original retries succeed without replacing later work. Final collection must
  declare every output stream, including prior attempts. No verdict implies that
  an incomplete collector has retained the entire log.

Public metadata APIs use current project reader authority, including anonymous
public reads. They return canonical JSON text:

- `projectHostedOutputRead:manifest({projectId,runId})` returns check status,
  execution ID, `complete`, sealed-stream count and the current root. It reads
  constant-size records, without scanning chunks or signing URLs.
- `streams({projectId,runId,cursor})` pages retained stream metadata/seals.
  Continue `continueCursor` until `isDone`.
- `chunks({projectId,runId,after})` starts at `after:0` and returns a page plus
  the next `after` revision and `more`. Resume this revision when a status
  subscription observes new chunks. The cursor orders commits; each chunk retains
  its own stream sequence and offset. Transport pages use 50 rows/128 KiB with
  continuation, without a total log/stream/history ceiling.
- `download({projectId,runId,streamId,sequence})` signs one exact committed chunk
  after a fresh access check. A null `streamId` selects the completed root object.
  Missing sequences return `NOT_FOUND` for recovery from the original collector.
  Signed URLs use the existing five-minute expiry. Revocation prevents new URLs;
  already issued capabilities remain usable until expiry. Verify direct bytes
  with `HostedOutputReader`, which also checks the final sealed-stream digest.

`completeOutputManifest` is an internal transaction helper for consumers such as
landing; it reports complete retention separately from exact passing-run evidence
and grants no acceptance authority. It adds no new acceptance requirement.
Readers and collectors do not poll or schedule timers. The UI must gate metadata
subscriptions and automatic byte downloads through its existing idle gate. The
legacy retained-log API remains available for historical native runs.

### Hosted Actions export and dispatch

`HostedActionsProvider` implements the H10 provider contract over
`projectHostedActions:control`. Supply a run-bound store, `hostedActionsRemote`
and an exporter calling `exportHostedActions` on the fixed source worker. The
exporter receives the current mapping/lease as its third argument. It reads
project objects through `sourceWorkerHttp` with input
`{kind:"forge-hosted-actions",runId,dispatchKey,owner,token}` and
`executionId:owner`. The trusted ingress derives project/lease identity from its
authenticated worker request and routes describe/grant/commit to the internal
`projectHostedActionsTransfers` functions. They recheck current project/actor,
epoch, dispatch key and live lease on every descriptor/grant and post-HEAD commit.
Repository and bundle bytes transfer directly to object storage; Convex sees
only exact `{sha256,size}` pins. Worker heartbeats renew the lease during export.

The immutable plan manifest is a `hostedActionsRecipeSchema` JSON object:
`{pin,head,definition,selection,groups,standard,interaction,command}`. `pin` is
`checkPin` of those fields excluding `pin`. Its selection must match the separately
committed selection object; command, lockfile, runtime, shard membership and State
are verified by the worker. `shardCount` is `groups.length + 1`, including static.
The worker reuses the existing workflow generator and runner script. Generated
workflow/recipe bytes belong only to the harness commit, not the Candidate State.

Each invocation performs one export, one ref publication, or a bounded
lookup/dispatch step and returns pending without waiting for a runner. The
mapping's `nextAt` carries lookup/rejection backoff. Adopting a run arms an
indexed, generation-fenced `projectHostedActionsWake` observation for that run. The adapter reports eventually consistent absence as unknown to H10, so
H10 cannot add another recovery. Its own twelve lookups plus a fresh empty branch
lookup permit the local path's one recovery after an ambiguous response, including
HTTP 400. Accepted acknowledgements never permit redelivery. GitHub does not
provide atomic dispatch deduplication against arbitrarily late run visibility;
duplicate exact matches remain explicit evidence errors.

`ActionsCredentialUse` privately resolves the pinned credential reference for the
selected installation/repository. Missing registration or repository permissions
produce `GITHUB_APP_UNAVAILABLE` / `GITHUB_APP_ACCESS` with actionable messages;
no App registration, personal token, `gh` or local checkout fallback occurs.
Current authorized readers can call `projectHostedActions:status` for the retained
mapping and structured setup error. A definitive rejection before any Actions
dispatch becomes H10 `runner-unavailable`; an earlier ambiguous dispatch stays
unknown even if later credential/access checks fail.
`cleanupHostedActions` first checks a committed terminal H10 result and exact
execution mapping, then deletes only the unchanged run-owned branch. Lost delete
replies are safe to reconcile; the State/export/run mapping stays retained.
`reconcileHostedActions` reads the exact retained recipe bytes, observes the
mapped run and pages its latest jobs on the fixed worker. Run ID, run-owned title,
export commit, original attempt and selected shard membership must match. Its
stable signed H10 callback identities reconcile lost shard/terminal replies.
`projectHostedActionsReconcile:evidence` checks current actor/epoch, worker lease,
State, export commit and run mapping before invoking the existing H10 callback
reducer. A native State is never replaced by the generated harness commit.
Finished/undispatched checks make no provider calls. Incomplete job lists settle
through bounded backoff observations; after the local controller's thirty
observations, stuck status can pass only with complete `actionsJobLogEvidence`
and a successful run with no contradictory job conclusion. Missing or failed
logs cannot pass. Installation credentials are never forwarded to a signed log
storage redirect. Export/dispatch success alone supplies no passing evidence.

H10 cancellation remains a request until the mapped provider run settles. A
successful cancel POST records acknowledgement; a lost reply can retry that
idempotent cancellation for the same run. It never starts another execution or
claims compute stopped. Transient observation failures retain the original run
and backoff. The durable wake re-arms before calling the fixed worker, respects
its lease/`nextAt`, ignores duplicate generations, and becomes a read-only no-op
after terminal evidence. There is no project sweep or recurring finished-job
observation. The fixed controller ingress is provisioned through
`FORGE_HOSTED_ACTIONS_CONTROLLER_URL` and its backend-only
`FORGE_HOSTED_ACTIONS_CONTROLLER_KEY`; it receives only project/run/dispatch
identity and must use the existing installation credential-use resolver.

`runHostedActionsJob` is the fixed runner supervisor integration, outside exported
project code. Trusted runner bootstrap supplies the original run/mapping and
provider-attested job/commit/State/shard pins, an explicit command environment,
and H12 `hostedOutputPublisher` sinks. No output signing or installation key is
passed to the project command. Stdout and stderr stream through the H12 redactor
and collector, flushing available bytes while the command is alive. The private
`HostedActionsOutputSpool` atomically fsyncs redacted immutable chunk/seal records
before direct R2 publication. Storage failure leaves pending output on disk;
a replacement collector replays those exact records without executing the
command again. Interrupted collection without seals stays incomplete. Trusted
bootstrap must preserve spool storage and supply redaction settings; the module
is not a sandbox against arbitrary code under the same OS account.

Completion-only provider logs never enter that live-output path. The existing
H12 Check panel reads the same paged chunk protocol; no new screen or viewer
poller is added. After all runner streams are sealed and the H10 result is
terminal, trusted final collection publishes the existing H12 root, separately
from check evidence. These modules do not deploy the controller ingress, install
the runner supervisor on a live runner, or provision its authenticated H12
transport. The lead must wire those fixed services to the generated workflow's
check command and perform a real owner-runner smoke after landing/deployment.

## Hosted landing queue API

Browser acceptance can set `finish.reviewedSource` instead of
`finish.composeOperationId`. This person selection pins the canonical Candidate's
Intent, main receipt and immutable input/dependency roots; it cannot select
another actor's mutable composition or follow later Lane saves. Agents retain the
original composition requirement. Final acceptance uses the same authority,
policy, check evidence and Channel CAS. `projectHostedLanding:candidate` is an
indexed, read-only subscription over the selected Candidate, its current attempt,
check, receipt and any compensating submission. New queue rows carry optional
Candidate and revert-receipt keys; older rows remain valid without a backfill.
A `revertOf` link is validated against the canonical reverse Lane's receipt
provenance and its completed composition. It is not acceptance authority.

`projectHostedLanding:enqueue({projectId, request})` accepts JSON metadata:

```json
{
  "operationId": "<original UUID>",
  "authorityEpoch": 1,
  "channel": "main",
  "expectedMain": { "head": "<State SHA-256>", "receiptId": "<main receipt>" },
  "candidateId": "<canonical Candidate UUID>",
  "expectedHead": "<clean State SHA-256, or null for a conflict Candidate>",
  "agent": true,
  "check": { "kind": "run", "runId": "<exact H10 run UUID>" }
}
```

`check` may instead be null, or `{kind:"request", checkId, expectedDefinition,
expectedConfiguration, expectedEnvironment}` using the current H10 pins. The latter
atomically enqueues one H10 check under a retained child operation. It does not run
project code inside Convex or replace the H11 provider adapter. Account/device
identity determines actor kind; `agent:true` explicitly downscopes an account.
Person-selected clean unchecked Candidates remain representable. Existing agent
check/policy requirements still belong to final acceptance, not queue admission.

A fresh request selects the current hosted main head and receipt and the Candidate's
exact base. Reusing an operation with different pins returns `WORK_OPERATION_CHANGED`.
Authorized original retries return the retained submission/current progress after
later main, definition or epoch changes, without replacing source/check pins.
Current project write authority precedes replay; current read authority precedes
`status`, `list` and `attempts`. Stale/foreign Candidate/run selections fail explicitly.
Source/file/log bytes are not accepted by this API.

`status({projectId, submissionId})` returns the current request and exact attempt.
`list({projectId,channel:"main",phase?,cursor})` and
`attempts({projectId,submissionId,cursor})` return complete continuation contracts in
100-row/128-KiB transport pages. Keep following `continueCursor` until `isDone`;
partial pages do not establish absence. Immutable attempt IDs, Candidate roots,
main receipts, policy context and run pins remain available for later review.

`projectHostedLanding:cancel({projectId,request})` takes JSON
`{operationId,authorityEpoch,submissionId}`. Current contributor/owner authority
is checked before new cancellation or receipt replay. The operation retains its
original outcome: a pending request becomes `terminal-failed` with
`LANDING_CANCELLED` and the shared `rejected` cause. Its original request,
attempts and source pins remain readable. An already terminal failure stays
unchanged. Cancellation releases only this request's queue claim and fences its
pending finish metadata IO; it neither abandons a Lane nor cancels a shared check
or source execution. Late callbacks cannot revive the request. Final acceptance
and cancellation race transactionally: acceptance first returns the actual landed
receipt; cancellation first prevents publication. Accepted source is never undone.
Retry the same operation and parameters after an unknown reply to get its
retained result, including after later main or authority changes.

The scheduled driver returns after metadata preparation, with phase `checking`,
`ready` or `terminal-failed`; queued/checking/ready observations remain pending.
A fake-provider test seam exercises H10 completion and lease recovery. `ready` is
not acceptance evidence and is not a claim that current policy permits publication.
No hosted Channel is moved by H13. H14 supplies final CAS/receipt/lifecycle handling;
H11 supplies actual check dispatch. Nothing here enables a native-owner cutover,
UI, deployment or real provider configuration.

For integration, `claimReadyLanding`/`requireLandingLease` fence H14's final
transaction. `pinLandingAttempt`, `insertLandingAttempt` and `writeLanding` support
named agent child attempts under that fence, preserving the original request and
check identities. Final settlement must accompany H14's actual canonical receipt.
`releaseLandingQueue` wakes later runnable work in the same transaction. A named
internal `projectHostedLandingDriver:recover` repairs pending/leased queue work;
it is an event/startup hook, never a scheduled scan of idle projects. Failed wake
receipts also reconcile on original enqueue replay. Check waiters wake from H10
result events in bounded byte-aware windows; they do not poll provider status.

### Hosted final acceptance API

H14's `projectHostedAcceptance:prepare({projectId,submissionId,attemptId})` retains a
plan under the attempt's original accept UUID. `stage` adds `{kind:"inputs" |
"dependencies",index,page}` where `page` is the JSON H08 compose metadata page.
Stage inputs first, then dependencies, following each committed hash/size/next pin
until null. Pages automatically split under H08's 100-entry/128-KiB transport window;
there is no total Lane/history ceiling. Replays require the exact original page.
Staging reads immutable included Lane versions, so later saves remain possible.

`accept` takes the same selection and uses the shared Channel fence/final CAS.
`publish` is its internal fenced primitive for H15, taking the retained claim
`{projectId,channel:"main",owner,token,submissionId,attemptId}`. These return
`{status:"landed",receipt}` only after actual atomic publication, or pending queue/
review observations. Stale main head/receipt, epoch, policy and exact-run evidence
return structured errors without consuming the request or replacing its source.
An agent request needs current exact-run evidence; an account can submit an exact
person request without a check. Devices always retain agent authority.

`receipt({projectId,receiptId})` returns immutable evidence and completion progress
under current project read access. The acceptance ID also selects its source-snapshot
delta and staged input ledger. Original retries authorize current access first and
return the original receipt, without moving later main or repeating effects. Run
references use H10 IDs; no dependency on H12 output-manifest internals is introduced.

When the existing lifecycle policy enables completion, publication activates the
staged exact-head ledger and schedules finite `complete({projectId,receiptId})`
materialization. It writes at most twenty Lane status versions per invocation and
resumes its retained page/entry cursor after a lost reply or stopped task. A named
internal call can repair a failed task; there is no idle scan. Completion never
closes a newer saved/reopened version or an entire Intent. Accepted-source receipt
and completion-ledger visibility do not wait for these canonical status projections.


## Hosted saved-work lifecycle API

`projectHostedLifecycle:transition({projectId,request})` accepts JSON validated by
`hostedLifecycleRequestSchema`: original `operationId`, `authorityEpoch`,
`action: abandon | reopen`, and a target. Abandon requires a retained reason;
reopen's reason is optional.

- Lane: `{kind: lane, laneId, expected: {head,version,sourceVersion,lifecycleVersion},
  dirty?, saveOperationId?}`. A known dirty client uses an explicit save-first
  child. `saveOperationId` pins H07's original save on the same actor, project,
  Lane, epoch and **original baseline**. The parent can return pending while that
  save runs. Its terminal callback wakes the retained parent without a client;
  successful publication compares the child's exact resulting pins before
  abandonment. A failed child is retained as a failed parent with no lifecycle
  write. A later save/reopen makes the original parent stale.
- Intent: `{kind: intent, intentId, version, cascade?}`. Abandon with cascade stages
  every active child in twenty-row/128-KiB transaction windows. Source saves,
  starts, completion and lifecycle changes invalidate its Intent revision. One
  final marker activates the complete staged selection, with no all-child final
  read. Reopen changes only the Intent. Completed/abandoned siblings stay as they
  were; no source or history is deleted.

Results use `hostedLifecycleResultSchema`: original receipt/time, pending/applied/
stale/failed status, selected target, child count, optional exact applied Lane
pins, retained save child and `cancellation: not-requested`. Current write
access is checked even on replay; successful replay returns its original receipt
without rewinding newer source or reapplying lifecycle. Pending work also checks
the current authority epoch at each step. Ordinary source saves remain available
on retained work; no new lifecycle access policy is added.

`progress({projectId,operationId})` is a finite status read with projection progress.
`advance` explicitly resumes the same operation after a stopped scheduler. Normal
cascade work runs in bounded internal ticks and stops at terminal/projection
completion. `history({projectId,kind,key,cursor})` pages retained applied events
under current reader access. Staged/stale events are not exposed as applied;
continue opaque cursors even for an empty filtered page. Canonical Lane reads and
parent pages resolve all applied children before background head-index promotion
finishes. Status-filtered internal Lane pages evaluate effective state over
bounded indexed pages; an empty page is not end of history.

`transitionHostedLane(root,{operationId,action,reason?,saveFirst?},exchange)` is an
API helper for an ordinary H04 checkout, with no native owner/listener. It refuses
known dirty abandonment with `LANE_DIRTY` unless `saveFirst:true`, retains the
original command and child capture/UUID, drives H07 once, then submits the
compound parent. Pending returns preserve both identities. Lost uploads/replies,
failed saves, stale pins and disconnects retain local files and captured bytes.
Reconciliation advances only matching checkout metadata, never working bytes;
reopen retains newer drafts. Intent cascade closes saved server work and cannot
claim to save a disconnected client's unknown edits.

Cancellation uses the separate `projectHostedChecks:cancel` API. An abandon
receipt never means a running check or arbitrary process stopped. Main,
acceptance receipts, source objects and saves are untouched by lifecycle changes.
The hosted agent CLI and MCP use these same primitives. Site controls
remain separate work.

### Hosted finish API

Add `finish:{composeOperationId,after:null}` to the ordinary hosted landing request
to drive its exact selected composition through check and acceptance. The compose
operation must be the caller's original completed H08 operation for that Candidate;
its ordered manifests, versions and settings remain pinned. `after` may name an
existing parent submission in the same project. Its receipt resumes the dependent;
its failure remains an explicit dependent failure. No recurring observer is needed.
Omit `finish` to retain the existing prepare-only landing behavior.

Explicit `projectHostedFinish:resume` rechecks current project/contributor write
authority and the pending request's original source-authority epoch before
scheduling. A revoked contributor, removed project or stale pending epoch is
refused without scheduling. Completed requests still require current project
write access but can reconcile their historical epoch without new work.

Original-operation replay returns the same submission and repairs outstanding
scheduler receipts. A changed payload under that operation ID is rejected. A main
head or receipt race creates an explicitly named child attempt, yields with backoff,
then recomposes and rechecks the original selection. Check evidence is never reused
for a different Candidate. Later Lane saves remain open and outside the selection.
Conflicted child Candidates retain their original conflict object for the existing
[resolution Lane API](#hosted-explicit-sync-and-conflict-resolution-apis).

`projectHostedFinish:status {projectId,submissionId,version?}` returns the submission,
version cursor, exact selection roots and named pending source attempt. It is a
reactive metadata read; it does not schedule work. `projectHostedFinish:inputs
{projectId,submissionId,attemptId,index}` reads one staged immutable input page and
compares each selected head with its current Lane. `superseded` retains the actual
outcome, as in the native submission contract. `staged:false` means that page has
not been prepared yet; continue after progress rather than treating it as empty
selection. Historical attempts remain available through the landing attempts API.

`projectHostedFinish:resume {projectId,submissionId}` repairs only the original
actor's named pending request on reconnect/startup. It creates no replacement
attempt or check. Source/check callbacks and parent terminal events normally wake
progress. The finite driver downloads one bounded metadata page or stores one
small hash-verified compose plan per action, then yields. Source computation and
check dispatch remain the existing H08/H10 jobs and configured provider routes.
Only H14's current-authority/exact-run/main CAS and real receipt report landing.

### Hosted compensating revert API

Revert uses the existing durable sync phases and the ordinary compose/finish APIs:

1. Call `projectHostedSync:prepare {projectId,request}` with serialized
   `revertRequestSchema` from `src/hosted-sync.ts`:
   `{kind:"revert",operationId,authorityEpoch,target,message}`. `target` is either
   `{kind:"receipt",receiptId}` or `{kind:"submission",submissionId}`. Submission
   addressing resolves the immutable accepted receipt after an unknown final reply;
   `NOT_FOUND` means no retained acceptance was found, never permission to guess a
   head or use the requested Lane's changes. Preparation creates a dedicated Intent
   and pins the two actual receipt heads, without changing main.
2. `projectHostedSync:progress {projectId,operationId}` exposes the exact worker
   input. Upload those canonical metadata bytes through the existing missing-only
   object path and call `projectHostedSyncJobs:submit`. Retry using the same UUID
   and request. Existing source-job recovery/callback publication applies; no new
   job kind, provider or periodic observer is needed.
3. The terminal sync result contains the compensating saved Lane selection. Its
   `status:"merged"` describes the produced source, not acceptance. The canonical
   Lane's `revert` provenance retains `receiptId`, `previous` and `accepted` heads.
   Compose that Lane through H08 against observed main, under its returned Intent,
   and enqueue the ordinary H15 landing request with
   `finish:{composeOperationId,after:null}`. Retain the compose/landing UUIDs before
   their first calls. H15 owns checking, recomposition on races and acceptance.

An overlap produces the usual conflicted Candidate; use the explicit H09 resolution
Lane API and compose/finish its resolved selection. The original compensating Lane
and receipt remain retained. Later disjoint source survives. A batch acceptance is
reversed as its complete actual main transition, and a revert-of-revert uses the
same receipt selection. Preparing or replaying checks current contributor access;
source dispatch/publication checks the pinned epoch. Final acceptance retains all
ordinary actor/policy/check rules, without adding an owner-only revert rule.
Receipt lookup and source publication are constant-size metadata transactions;
source diff/merge stays on the worker. These API-only phases do not create a local
native owner, transport command or site control.

## Hosted agent CLI and MCP

`nforge agent ROOT ACTION JSON` uses the hosted transport when JSON includes
`url` and `projectId`, when ROOT is a hosted Lane checkout, or when a previous
successful hosted command retained that address in ROOT's client cache. An
incomplete explicit address fails before constructing a native owner. Existing
native project commands retain their native workflow.

```sh
nforge agent ./edit start '{"url":"https://deployment.convex.cloud","projectId":"PROJECT_ID","outcome":"Add search"}'
nforge agent ./edit open '{"laneId":"LANE_UUID"}'
nforge agent ./edit save '{"message":"Search implementation"}'
nforge agent ./edit compose '{"laneId":"LANE_UUID"}'
nforge agent ./edit sync '{"laneId":"LANE_UUID"}'
nforge agent ./edit check '{"candidateId":"CANDIDATE_UUID","checkId":"CHECK_UUID"}'
nforge agent ./edit finish '{"laneId":"LANE_UUID","message":"Add search"}'
nforge agent ./edit cancel '{"submissionId":"SUBMISSION_UUID"}'
nforge agent ./edit revert '{"target":{"kind":"receipt","receiptId":"RECEIPT_UUID"},"message":"Reverse actual acceptance"}'
nforge agent ./edit abandon '{"laneId":"LANE_UUID","reason":"Superseded","saveFirst":true}'
nforge agent ./edit capabilities '{}'
nforge agent ./edit status '{"laneId":"LANE_UUID"}'
```

Start returns authoritative Lane pins; open materializes a verified full or sparse
checkout (`paths` selects relative files/directories). Save uses the existing
retained delta capture and missing-only upload path; `checkpoint` is its alias.
Compose accepts `inputs:[{laneId,expected?}]`, an optional `intentId`, and ordered
`dependencies:[{candidateId,head?}]`. Expected Lane pins include head, record,
source and lifecycle versions. Sync selects observed main by default, or an exact
`target:{kind:"main",head,receiptId}` / `{kind:"candidate",candidateId,head}`.
Its successful source receipt applies through the guarded checkout installer;
`apply:false` submits source work without installing it. Dirty or newer local
files remain preserved. Revert returns an isolated compensating Lane for ordinary
composition/finish; targets can also be `{kind:"submission",submissionId}`.

Hosted `cancel {submissionId}` cancels a landing request through the separate
landing API above. Its optional `operationId` identifies the cancellation,
not the original finish/check. Accepted requests return their landed receipt;
Lane lifecycle and check execution remain independent.

Check (`run` alias) pins a clean Candidate, definition, runner configuration and
environment before enqueue. Finish saves the opened Lane when applicable,
composes saved inputs, and submits the original composition to the durable finish
driver. Explicit `inputs` selects saved heads and leaves local drafts unsaved and
untouched. Its optional `check:{checkId,expectedDefinition?,expectedConfiguration?,
expectedEnvironment?}` selects a check; otherwise it selects `verify`, or the sole
configured check. An existing `candidateId` requires its `composeOperationId`.
`after` selects an exact parent submission. This transport always requests agent
acceptance, including with an account credential; current backend policy and
exact check evidence decide acceptance. A submitted/queued phase is not a landed
receipt. Worker/provider configuration remains deployment work; this CLI never
falls back to a local owner or runner.

Abandon/reopen use the canonical lifecycle API. An opened Lane uses the existing
dirty-draft guard and optional save-first compound request. A saved remote Lane
can be selected by `laneId` without a checkout; this makes no claim about drafts
on other clients. Intent targets are `{kind:"intent",intentId,version,cascade?}`;
reopen preserves each child's independent lifecycle.

Each mutation returns its operation UUID and `resolved.operationId`. The private
`ROOT.forge-client/agent` journal retains normalized original parameters, actor,
source/check/main pins and compound child UUIDs before mutation IO. Authentication
material is never written there. Identical parameters with an omitted UUID reuse
the journaled operation, including after losing stdout; a new explicit
`operationId` identifies a new request, even with identical text. Retry the same
request after an unknown response. Current access is rechecked on each dispatch;
changing a retained request or actor fails explicitly. Keep the client cache to
reconcile unknown operations across process restarts.

`capabilities` is a current authorized protocol/authority/configuration read;
configuration flags report presence, not live provider health. `status` and
`observe` are finite reads: select one `laneId`, `runId`, `submissionId` (optional
`version`), or `{kind,operationId}` where kind is save, compose, sync, revert or
lifecycle. They do not start compute or install an idle observer. Source/check
submission returns promptly; replay the original action to advance its retained
client phases and explicitly read status for progress.

`nforge mcp ROOT --agent` uses this same hosted address detection and existing
agent workflow registration. For a new client directory, select an explicit address:

```sh
nforge mcp ./edit --agent --url https://deployment.convex.cloud --project-id PROJECT_ID
```

The existing server registers `forge_task` for start/open/save/checkpoint/compose/
sync/finish/cancel/revert/abandon/reopen, `forge_check` for check/run/observe, and
`forge_work_overview` for status/capabilities. Actions use the CLI's exact portable
schemas inside `{command:{action,...}}`, the same response envelope and the same
`ROOT.forge-client/agent` journal and successful-address retention. Retrying through
either interface preserves original UUIDs, actor and source/check pins. Unsupported
hosted actions do not route to native tools. No person-acceptance input is exposed;
account credentials still submit `agent:true` through the existing finish transport.

`forge_current {laneId}` returns one saved Lane's source context. `forge_source
{laneId,file,start?,end?,expected?}` reads up to 200 lines. `forge_review
{command:{action:"show",laneId,path,expected?,force?}}` returns exact retained bytes
with utf8/base64 encoding and the same force behavior as native show. `laneId` may
be omitted in an opened Lane. Optional `expected:{head,version,sourceVersion}`
fails explicitly on movement. Results retain complete Lane source context plus
State/blob/mode pins. Reads use H04's verified object cache, select only the State
and requested file, and recheck current authorization and the original pins before
returning bytes. Sparse omissions stay readable without materializing them; unsaved
local edits never replace saved source. These tools hydrate no Work/history/graph.
Native graph tools remain registered for native source; no hosted graph is inferred.

`forge_check {command:{action:"observe",runId}}` remains a finite read. An explicit
`forge_wait {runId,timeoutSeconds?}` observes that run live until terminal, timeout
(default 600 seconds), request cancellation or disconnect. It returns the observed
run with `status:"terminal"|"timeout"|"cancelled"`; a terminal failed run remains
failed. MCP progress notifications carry observations when requested with a
progress token. Only a nonterminal active wait creates a subscription, and every
exit unsubscribes and closes its client. Terminal and zero-duration reads allocate
no live client. There is no idle polling, URL refresh, heartbeat, metadata hydration
or compute wake. Observation neither cancels a run nor grants acceptance evidence.
Hosted landing waits use `forge_wait {operationIds:[FINISH_OPERATION_ID,...],
cursor?,until?,timeoutSeconds?}` or `nforge agent ROOT wait` with the same selection.
One call follows all selected submissions, including named pending recomposes,
until all are terminal; `until:"any-change"` returns after the first change beyond
the initial snapshot. Each progress event and result carries a reconnect cursor.
Keep the cursor with the same deployment, project, actor and operation selection;
reconnecting rechecks current access and replays committed submission versions
without repeating delivered versions. Each server page reads at most twenty
version rows by exact indexes, independent of project/history size. A deployment
with older, unjournaled state explicitly resnapshots the current record; missing
historical evidence is not invented. Authority changes trigger a fresh authorized
snapshot while retaining immutable version identities for deduplication.

Only the active call subscribes. Registration is followed by an authoritative
reread to close missed wakeups; timeout, cancellation, errors and disconnect close
every subscription without waking or cancelling landing work. Staged input pages
also observe later saved Lane heads using the shared source-relative submission
projection. Unstaged input pages remain explicitly unstaged. A pending child
recompose never settles from its predecessor's stale input result.

Attempt history returns each attempt's own `observation` and `progress` (phase,
error, acceptance and settlement), separately from its `superseded` attempt flag.
A newer child or accepted submission never rewrites its predecessor's outcome.
Input pages use the selected attempt's retained evidence before projecting later
Lane saves as superseded. Old attempts predating retained progress return null
historical evidence rather than borrowing the current attempt's result.

These paths are qualified with local fakes, not live accounts or providers.

### Source authority transition and writer fencing

`projectSourceAuthority:transition` is an explicit owner mutation with
`{projectId, operationId, expected: {mode, epoch}, mode}`. It compares both expected
fields and commits `{mode, epoch: epoch + 1}` with an indexed operation receipt in
one transaction. Replaying the original UUID and inputs returns the original
result even after later transitions. Rollback is another transition to
`native-owner` at a higher epoch; it never resets the epoch.

On the bound native owner, run:

```sh
nforge host ROOT --source-authority '{"operationId":"UUID","expected":{"mode":"native-owner","epoch":0},"mode":"server"}'
```

The command records its exact request before network IO. Only a successful hosted
CAS installs its result in the local binding. If the process stops between the
hosted commit and the local pin update, repeat the same command; its receipt
finishes the local update without another transition. A known stale CAS updates
the observed pin and releases the pending command; an unknown outcome retains it.
Coordinate this command with the cutover's seeded source/Work pins and queue drain.
It does not seed main, drain work or enable hosted routing on its own.

`requireSourceAuthority(project, expected?)` in `src/hosted-source-authority.ts` is
the shared writer guard. `project` needs only an optional `sourceAuthority`;
`expected` is `{mode, epoch}`, defaulting to `native-owner` epoch 0. The helper
returns the matching authority or throws `SOURCE_AUTHORITY_STALE` with
`authority: {mode, epoch}`. Hosted errors retain that object in their structured
data. Existing epoch-zero callers need no new argument. Publication and legacy
acceptance calls can supply `authorityEpoch` after rollback; owner requests retain
the epoch at creation so an old completion cannot cross a rollback.

The existing hosted main seed, owner completion, exchange publication and legacy
acceptance commit check their authority in their write transaction. Their guards
reuse project rows already read for authorization. Native `accept-channel` checks
the binding pin under the owner lock, including before replay. It adds no hosted
read and remains usable offline before a switch. Hosted transactions are the real
fence; the local pin provides fast refusal. Stale-authority feedback received by
the owner transition, bound exchange, owner request consumer and hosted transports
advances the matching binding pin; delayed errors cannot rewind a newer epoch.
There is no polling or scheduled authority job.
