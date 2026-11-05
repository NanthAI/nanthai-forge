# Legacy storage cleanup order

This is a disposition and precondition guide, not permission to delete. New bytes already go to R2. P1 and B1.9 have separate approved scopes and evidence. Current scope lives on 13402039 (backup), 40dad5e0 (storage), 8678148e (R2 evidence), e542a26e (narrower follow-up) and 64d7192b (B1.9). See the [R2 backfill runbook](r2-backfill.md) for the existing evidence contract.

## Read-only inventory first

The historical inventory totals **2.50 GiB** of legacy file storage; a dashboard reading rounded it to **2.5 GB**. Approximately **1.93 GB** consists of retained R2 duplicates; the remainder is unclassified. These units/observations are distinct, not an exact subtraction. Reconcile current references and byte placement read-only before selecting any action. Keep raw inventory and backup evidence private. No broad sweep is authorized by an aggregate total.

## Required order

1. **Qualify backup (13402039).** The backup fix is closed: the manual file-inclusive backup succeeded with fully verified R2 ZIP bytes and the owner received the real failure alert. Keep its manifest, digest/source pins, snapshot-presence and recovery evidence. A pending, failed or database-only backup cannot stand in for this qualification. No index repair is implicit.
2. **P1 (40dad5e0 with 8678148e).** Audit the unclassified remainder first. Confirm the R2-only guard on 8678148e is landed. Preserve the owner-approved move scope; verify every retained R2 object by full digest against current data and keep the completed receipt. Recheck current access, runtime/source pins, queue/drain state, revision, byte placement and cost before a live step. The existing runbook requires current full-digest evidence and a qualifying backup; stale/missing evidence means stop and retain the copies. Seek the owner's exact approval for deletion scope; this page adds none.
3. **Authority/idle watch, then B1.9.** Keep the independent idle/authority watch evidence on 02bcad74 and 59bb75f3. Before the approved purge, confirm no writes to retired authority tables, the owner-approved backup gate (13402039 closed, a real alert received and one successful backup with verified R2 bytes; no two-weekly-backups wait), current recovery evidence and the agreed purge disposition. B1.9 removes the local owner HTTP server, native-owner recovery/reconnect and supervised owner release code. Standalone native agent commands remain pending their separate disposition (657d63ee). Keep narrower P2/P3 decisions separate: classify references and confirm their existing scope with e542a26e/40dad5e0 rather than treating P1 as approval for an orphan sweep.

## Failure and rollback

Keep the existing copies and receipts when a precondition fails; report the failing structured code and owning Issue. Use original operation IDs to reconcile unknown outcomes. After approved maintenance, clear maintenance mode and verify absence without printing values; measure idle usage and billed/byte-placement deltas before claiming completion.

The local pre-cutover snapshot is deleted **only after a good backup and B1.9 land, with owner approval**. Until then it remains the rollback point. There is no automatic undo for deleted fallback bytes, and no deletion command is included here. Raw evidence is private, held off-repo by the owner; ask before relying on it.

## Read-only audit and disposition planner

Build core with the pinned Node and lockfile, then use the installed Convex CLI's
sandboxed read-only inline queries. No backend deployment is needed. Output must
be private and outside the source tree:

```sh
nforge heavy node scripts/legacy-storage-audit.mjs inventory --deployment dev:NAME --with-r2-list --out /private/audit.json
# Continue that same pass after an interrupted metadata page:
nforge heavy node scripts/legacy-storage-audit.mjs inventory --deployment dev:NAME --with-r2-list --out /private/audit.json --resume
# Offline migration/deletion proposal; always dry-run, zero provider calls:
node scripts/legacy-storage-audit.mjs plan --out /private/audit.json --dry-run
```

The inventory discovers every deployment table, including retired tables, and
pages each plus `_storage` to completion. Each query reads at most 1,024 documents
or 4 MB and returns counts, serialized JSON sizes and reference pins. It checks
all nested fields and JSON-encoded source cursors for storage IDs, including
imports, artifacts, source tasks/steps and Work generation cursors. ID-length
candidates come from the complete storage inventory, avoiding normalization of
large Work/source strings without assuming an ID format. No per-file
Convex lookup or file download runs. Syntactically valid IDs are joined to the complete storage inventory; unmatched
strings remain unresolved candidates, not proven dangling references. Physical
file totals count each storage ID once; reference/document totals and table/project JSON sizes are separate.
Serialized JSON sizes exclude binary encoding and index overhead and are not
billed database storage. Unreferenced files retain content type, date and digest
for investigation; lack of references does not establish deletion permission.

`--with-r2-list` reads the four existing R2 settings through private captured
CLI config reads, retaining no credentials in evidence. One bounded LIST request
per R2 page checks content-addressed key presence and size; no per-file HEAD/GET
runs. A size match is audit evidence, not the full-digest purge prerequisite.
An omitted R2 listing leaves verification unknown. Inventory is a sequential
observation window, not an atomic deployment snapshot; every live cleanup must
recheck current references. Private state retains completed pages for continuation.

Before running, estimate document reads, bandwidth and marginal cost. The task's
operator budget stops before about $1 estimated usage or 50,000 metadata
calls; a stop retains partial evidence and cannot produce a completed plan.
There is no separate document or listing-page cap. Typical planning: 2 GB JSON reads, 4,500 query calls and
1,000 R2 LISTs is about $0.46 before included usage (Starter marginal rates:
$0.22/GB DB I/O, $2.20/million calls, $0.132/GB response egress;
R2 Standard LIST $4.50/million). Binary/index overhead and actual billed usage
must be reported separately. A completed report records observed pages,
documents, JSON/response bytes, R2 operations and the rate-based estimate.

Both commands are dry-run only. There is no `--execute` or `--apply`, no database
mutation and no maintenance-mode toggle. The plan groups physical files by
project, purpose, copy verification and proposed disposition. Owner approval,
current full-digest verification, qualifying backup and the existing runbook's
live checks remain required. Restore from the qualifying file-inclusive backup
retained with the audit to an approved fresh target with matching source/configuration
and retained R2 bytes; deleting fallback copies has no automatic undo.


## Full-content verification and orphan attribution

The dev-only `scripts/legacy-storage-verify.mjs` reads a completed audit and
verifies classes 1–3: committed object/backup duplicates, source cursors, and
unreferenced files with an R2 match. Class 4 (no R2 proof) is excluded. This
selection is evidence, not authorization to delete. The owner selected the frozen Phase 1 classes 1–3. Complete reference coverage
remains required. Legacy Convex cursor sections carry global IDs without an
ownership join, so project-scoped R2 keys cannot prove that missing historical
bodies have no cross-project references. The separately approved deleted-project
row removal below resolves those referencing records before a fresh full scan;
it never substitutes an assumption about the missing contents. Class 4 stays
retained. A different inventory does not expand the owner decision.

```sh
nforge heavy node scripts/legacy-storage-verify.mjs --deployment dev:NAME --audit /private/audit.json --out /private/verification.json
# Resume the same pinned audit and operation after interruption:
nforge heavy node scripts/legacy-storage-verify.mjs --deployment dev:NAME --audit /private/audit.json --out /private/verification.json --resume
nforge heavy node scripts/legacy-storage-attribute.mjs --deployment dev:NAME --audit /private/audit.json --out /private/attribution.json
```

Verification obtains current Convex metadata and download URLs in windows of 100,
then streams complete Convex and R2 bodies through SHA-256 with at most 32 files
in flight. Every referenced R2 destination is checked, including shared aliases.
Changed metadata, missing objects, size mismatches and digest mismatches exclude
the file with a structured code. URLs and credentials stay in memory; private
progress retains pins, outcomes, operation identity and byte/request counters.
Resume pins the audit by SHA-256 and repeats an interrupted window. Such a replay
can add downloads not included in the last saved counters; report their bound
separately. A completed read-only verification is never a deletion receipt.

Attribution pages every application table, joins full orphan digests to retained
history, and records creation-time distributions, dates, types and common sizes.
Digest prefix filtering only reduces query input size; the operator joins exact
full digests afterwards. History links do not prove ownership, and matching times
or sizes are circumstantial. This table-history command never downloads or deletes class 4.
Resume uses the same `--resume` form and pinned audit.

Neither command mutates rows, deletes files or toggles maintenance. A sequential
audit does not fence concurrent reference writes. The existing purge functions
still lack complete source/task/Work reference protection and joint handling of
the shared object/backup file. The approved pause driver below provides complete frozen coverage and joint
handling; missing recursive cursor-body coverage blocks it before any pause. Its accepted backend must be deployed and qualified before use. Never
substitute an unpaused read-only report for transactional reference protection. Retain compatibility read/field allowlist entries while
legacy files and their readers remain. The older-backend CLI `uploadUrl` /
`putConvexUpload` path remains tracked on Issue 8678148e.

## Approved dev write-pause preparation

The owner approved one dev-only pause of at most about 30 minutes, with reads
available, on Issue 40dad5e0. This does not approve starting it. Preparation must
land first, the dry run and pre-verification must finish with writes enabled,
and synthetic pause/resume rehearsal must pass. The lead then selects a quiet
window with no landings in flight, holds other builders and explicitly says
**go**. A builder must ask the lead with the estimated duration before starting.

`convex/server.ts` composes the ordinary public/internal mutation builders through
`convex/legacyStorageServer.ts`, which supplies the pause boundary, and the existing
finish read-model writer. The reviewed maintenance registrations also import
their builder from `./server`: they bypass the pause wrapper, retain read-model
maintenance and enforce the transaction fence in their handlers. When
`FORGE_LEGACY_STORAGE_PAUSE` is absent, the pause boundary performs one environment
lookup and adds zero database reads, database writes, RPCs or provider calls per
mutation. It invokes the existing handler synchronously, preserving its return
value, promise identity, error and throw timing without accessing context ports.
A valid
flag binds the selected `dev:` deployment URL, operation UUID, start and expiry;
it pauses database writes until expiry, never longer than 30 minutes. Read-only
mutations used for fresh GET signatures remain available through a context that
permits database/storage reads and refuses database writes, storage writes and
scheduling. Queries remain available. A single
transaction fence row is opened after setting the flags. Every destructive page
reads that row. Resume closes it before clearing flags, so an older transaction
conflicts and retries against the closed fence rather than committing after
writes resume. If the flag expires, the first ordinary resumed writer closes
the fence in its own transaction. With no flag, ordinary writes still add zero
DB calls. See Convex’s [transaction model](https://stack.convex.dev/how-convex-works). Queries
and byte reads remain available. New R2 write signatures are also paused.
Already-issued external PUT URLs cannot be revoked, but their database
publication is paused. The mechanical cleanup test rejects mutation-builder
imports that bypass this boundary. The two file-cleanup mutations, exact-manifest record-page mutation and begin/end
window controls are the only reviewed exceptions. Begin and deletion require the
matching active pause; end can revoke the original window after expiry.

Before the pause, `scripts/legacy-storage-bench.mjs` prepares the separately
approved deleted-project record manifest. It uses project-prefixed indexes where
available, serial pages within each table and four table streams. For tables
without such an index it pages and filters, returning only exact row hashes and
owner pins, never row values. It verifies all 58 approved table counts and JSON
bytes against the frozen candidate. Schema checks require one mandatory project
owner per child row; the project root is owned by its own ID. Every known missing
cursor's referring row must appear in that manifest. The generic project-removal
bug and legacy cross-project storage reader remain separate work.

After the lead's go, the driver removes only those exact approved record pins in
atomic pages of at most 1,000 rows and 2 MB of original JSON. Each page checks the
current project is deleted, the sole owning project, every full row hash and byte
count, and the qualifying backup. All child pages commit before the project root
is removed. No file or R2 deletion is part of a record page. Durable page receipts
use the same operation ID; before/after counts are recorded for every table.
Unknown cursor contents are never inferred or fabricated.

The same `scripts/legacy-storage-cleanup.mjs` session then migrates the verified
source cursors to `r2source:` references, reads the resulting rows and rehashes
their R2 bodies. It then scans every deployment application table in four
independent table streams, completing each table's pages in order. All-table
coverage during the pause protects unindexed source/task/Work references. Cursor
bodies can themselves contain Convex IDs or further `r2source:` references. A
read-only recursive closure pass streams and hashes every reachable cursor/section
body, inspects plain or gzip text across stream boundaries, and adds those nested
IDs to protected references. Class 4 bodies may be read for attribution but are
never migrated or deleted. Missing bodies fail coverage even when the referring
project is deleted; that status alone does not establish their contents.

The complete physical storage catalog must match the pinned audit both before
arming and within the pause. Frozen roots are walked again; immutable bodies can
reuse their prior full-hash inspections. New roots are read and verified. Any
missing body, changed catalog or incomplete closure stops before deletion. A
known incomplete preparation proof refuses apply before arming the single pause,
except when every missing root and referring row belongs to the exact separately
approved record-removal manifest. After that removal, a fresh frozen all-table
scan and recursive body closure must pass before **any file deletion**. A remaining
missing root stops the run and resumes writes.
Before each deletion page it re-HEADs every R2 key for current size and checksum. Deletion retains the six existing indexed reference probes, qualifies every
joint object/backup owner against current R2 pins, and rejects other references.
No derived-file deletion cascade runs. The existing purge functions and their
guards remain unchanged.

Each delete mutation handles at most 100 files, with four disjoint batches in
flight. A private original-request file precedes each mutation; a database page
receipt binds operation ID, part and request digest, so a lost reply replays
without repeating the deletion. A new request cannot reuse an existing part.
The frozen Phase 1 manifest and completed verification are required, and the
backup run is rechecked successful immediately before the deletion stage.

```sh
# Preparation only, writes enabled; metadata scan plus recursive body coverage:
nforge heavy node scripts/legacy-storage-closure.mjs --deployment dev:NAME --audit /private/audit.json --out /private/body-coverage.json
# Separately approved deleted-project row preparation:
nforge heavy node scripts/legacy-storage-bench.mjs --deployment dev:NAME --audit /private/audit.json --candidate /private/deleted-project-candidate.json --scan /private/body-coverage.json.scan/scan.json --body-coverage /private/body-coverage.json --out /private/bench-manifest.json
# Records exact scope, protected nested references, HEAD exclusions and coverage status:
nforge heavy node scripts/legacy-storage-cleanup.mjs dry-run --deployment dev:NAME --audit /private/audit.json --verification /private/verification.json --body-coverage /private/body-coverage.json --bench-manifest /private/bench-manifest.json --out /private/cleanup
# Only after the lead separately says go for the quiet window:
nforge heavy node scripts/legacy-storage-cleanup.mjs apply --deployment dev:NAME --audit /private/audit.json --verification /private/verification.json --body-coverage /private/body-coverage.json --bench-manifest /private/bench-manifest.json --out /private/cleanup --operation-id UUID --lead-go 'Exact lead go and quiet-window reference'
```

The closure command pages all application tables in four streams, with at most
eight streamed body reads in flight and Convex URL lookups batched by 100. It
retains private immutable inspection proofs for resumption; `--scan` can select
an already completed private preparation scan. An incomplete dry run can report
counts but cannot qualify apply. Record its unresolved roots on the Issue.

The driver removes `FORGE_LEGACY_STORAGE_PAUSE` and `FORGE_R2_MAINTENANCE` in its
failure/success unwind and verifies absence by names only, before returning an
error for investigation. SIGINT/SIGTERM and the 26-minute dispatch deadline initiate fence revocation and
resumption, reserving four minutes within the approved 30-minute window;
metadata/configuration CLI reads and operator CLI calls terminate a stalled child
after at most 90 seconds, so a hung provider does not hold the unwind indefinitely;
a hard process kill still requires immediate operator removal of both flags:
`node scripts/legacy-storage-cleanup.mjs resume-writes --deployment dev:NAME --out /private/cleanup`.
This recovery closes the original transaction fence, removes the flags and records
name-only absence. Keep the original private window receipt so its operation ID
can be recovered.
The private window receipt records start/end, duration, paused operations and
name-only absence. An existing window file prevents an automatic second pause.
An unknown page result is reconciled by replaying its exact original request;
an uncommitted page cannot delete outside a newly approved active window.
Any failure means resume writes first. Do not investigate while leaving flags
set, extend the deadline, start another window, or expand the approved classes.

The raw receipts and exact operational counts stay private and on the Issue,
not in this public runbook. File-inclusive backup 41887010710 remains the
rollback; restore is a separate approved operation. The lead owns deployment
qualification of the accepted backend before the quiet-window go.
