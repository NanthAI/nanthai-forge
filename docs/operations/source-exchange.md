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
reads solely for advisory display. Large index deltas copy existing database
rows into a private partition and switch only after all replacements are ready.
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
action budget. Waiting callers yield a retryable `WORK_BUSY` before exhausting
their action, retaining the original request. Final publication still checks
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
objects. Server-side R2 and archive range reads use the same 30-second/two-minute
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

Native object returns copy retained database index rows for State parents, immutable diffstat pairs and unchanged Candidate provenance. Complete and streamed native projections produce identical parent-cache rows and counts, including chunked parents for large fan-in. Only new source heads receive compact, chunked ancestry closures; older pair indexes remain readable, and missing pair membership can be resolved lazily from cached parents. Acceptance and supersession refresh the affected Candidate summaries without rereading unchanged file provenance. Bounded row deltas publish atomically into the selected partition. Larger deltas use the complete staged-partition path. Optional cache fields and record collections require no migration; an older generation reuses its complete ancestry boundaries and caches new States during its next return.

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
baseline hints are recovered by normal reconciliation. Delta eligibility and all
existing authority, retained-history, closure and final CAS validation still apply.

Large compatibility returns split retained Intent payloads into immutable private
record pages while decoding an older prepared snapshot. Exact Work hashing reads
those pages in original property and record order. Retained-history validation
hydrates only the matching original records; schema validation and index payload
projection consume bounded page groups in separate resumable steps. The final
staging cursor retains compact relationship context and output references rather
than complete Intent notes and lifecycle history. Owner-supplied display facts
remain required; the server does not derive source or provenance.
