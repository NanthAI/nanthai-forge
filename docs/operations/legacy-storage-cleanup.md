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
