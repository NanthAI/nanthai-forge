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

## Large pushes and long actions

A large backlog keeps the original push and nested source-return operation IDs,
checkpoint pins and hosted revision through every continuation. Native returns
with at least 100 journal revisions since their base use durable preparation even
when the base Work is small. Preparation saves replayed Work at complete event
boundaries and resumes from that validated revision. Validation, projection and
private index commits keep their existing shorter scheduling windows. A shared
four-minute outer window is checked after complete work units; it never cancels
or splits a transaction. Index rebuilds yield after committed batches, and
publication waiters yield without taking another worker's claim.

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
mutation. It reports completed exchange/export capture times, root source and
accepted main heads, exact Work revision/hash, manifest pin, complete-history state
and each check evidence path's included/unavailable status. Source/Work capture
time is separate from evidence sampling and successful completion time.

A successful local export is listed separately and **does not prove an off-machine
copy**. Only completed exchanges with complete retained history establish the
inventory's off-machine baseline. First-host current-source publication stays
incomplete until history upload and `completeHistory` validation succeed. Missing
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
checkout through the hosted save APIs. This is a source-client API; CLI and
browser editor wiring are separate. The operation retains its command, captured
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

These APIs compose saved hosted source without a local Work owner. They do not
add CLI commands or browser controls.

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
The provider contract currently has local fake coverage; these endpoints alone
do not start live Modal compute. Existing native check requests are unchanged.

- `projectHostedCheckDefinitions:configure({projectId,request})` takes an original
  `operationId`, `authorityEpoch`, `expected` digest (null to create), and `change`.
  For `kind:"definition"`, provide `checkId` and `command` using the local check
  fields: name, executable, args, environmentLabel and optional environment-name,
  credential-name, artifact-path, static/resource and declared-input settings.
  For `kind:"import"`, provide the existing `check` with its UUID, definition and
  timestamp. For `kind:"runner"`, provide `configuration` with `provider:"modal"`,
  `app`, `function`, `runtime`, `environmentFingerprint` and credential-use
  reference `{secretId,version,operation}`. No credential values are accepted.
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
runtime/source pins. H11 must verify the actual source/lockfile/selection bytes
and execute that exact manifest; client claims cannot call this internal boundary.

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
H11 owns real credential use, execution adoption/cancellation, ingress provisioning
and pending-work wakes. Nothing here deploys or provisions those integrations.

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
