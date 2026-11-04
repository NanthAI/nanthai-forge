# Legacy storage cleanup order

This is a disposition and precondition guide, not permission to delete. New bytes already go to R2. The Phase 5 close left **P1 and B1.9 unrun**. Current scope lives on 13402039 (backup), 40dad5e0 (storage), 8678148e (R2 evidence), e542a26e (narrower follow-up) and 64d7192b (B1.9). See the [R2 backfill runbook](r2-backfill.md) for the existing evidence contract.

## Read-only inventory first

The historical inventory totals **2.50 GiB** of legacy file storage; a dashboard reading rounded it to **2.5 GB**. Approximately **1.93 GB** consists of retained R2 duplicates; the remainder is unclassified. These units/observations are distinct, not an exact subtraction. Reconcile current references and byte placement read-only before selecting any action. Keep raw inventory and backup evidence private. No broad sweep is authorized by an aggregate total.

## Required order

1. **Fix backup (13402039).** The weekly job failed on 2026-11-02 with `WORK_INDEX_UNAVAILABLE`; the last good backup at close was 2026-10-29. Diagnose current index coverage without automatically invoking repair. Qualify a completed, file-inclusive backup and retain its manifest, digest/source pins, snapshot-presence and recovery evidence. A pending, failed or database-only backup cannot stand in for the existing purge prerequisite.
2. **P1 (40dad5e0 with 8678148e).** Audit the unclassified remainder first. Confirm the R2-only guard on 8678148e is landed. Preserve the owner-approved move scope; verify every retained R2 object by full digest against current data and keep the completed receipt. Recheck current access, runtime/source pins, queue/drain state, revision, byte placement and cost before a live step. The existing runbook requires current full-digest evidence and a qualifying backup; stale/missing evidence means stop and retain the copies. Seek the owner's exact approval for deletion scope; this page adds none.
3. **Authority/idle watch, then B1.9.** Complete 02bcad74 and 59bb75f3 before 64d7192b. Confirm no writes to retired authority tables, the existing two-weekly-backup prerequisite, current recovery evidence and the agreed purge disposition. B1.9 includes the local owner HTTP server and native-owner code. Keep narrower P2/P3 decisions separate: classify references and confirm their existing scope with e542a26e/40dad5e0 rather than treating P1 as approval for an orphan sweep.

## Failure and rollback

Keep the existing copies and receipts when a precondition fails; report the failing structured code and owning Issue. Use original operation IDs to reconcile unknown outcomes. After approved maintenance, clear maintenance mode and verify absence without printing values; measure idle usage and billed/byte-placement deltas before claiming completion.

The local pre-cutover snapshot is deleted **only after a good backup and B1.9 land, with owner approval**. Until then it remains the rollback point. There is no automatic undo for deleted fallback bytes, and no deletion command is included here. Raw evidence is private, held off-repo by the owner; ask before relying on it.
