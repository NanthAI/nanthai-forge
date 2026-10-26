// SPDX-License-Identifier: Apache-2.0
import { existsSync, readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { digest } from './hash.js';
import { canonicalPayload } from './hosted-source-operation.js';
import { hostedAcceptanceSchema, EMPTY_COMPLETION_ROOT, completionPageRoot } from './hosted-acceptance.js';
import { validateComposePage } from './hosted-compose.js';
import { invariant } from './errors.js';
import { hostedRecoveryRows } from './recovery-hosted-read.js';
import type { NativeSource } from './native-source.js';
import type { HostedRecovery } from './recovery-hosted-protocol.js';
import type { HostedMainV2 } from './hosted-main.js';

export const recoveryIndexPath = (directory: string, table: string, id: string) =>
  join(directory, digest(canonicalPayload([table, id])));

/** Validate H14 deltas and completion ledgers against the selected Channel,
 * without rewriting progress, replaying an acceptance or materializing completions. */
export function validateRecoveryAcceptances(directory: string, main: HostedMainV2) {
  const read = (table: string, id: string) => {
    const path = recoveryIndexPath(directory, table, id);
    invariant(
      existsSync(path),
      'INVALID_WORK_BACKUP',
      'A selected hosted acceptance or completion receipt is missing.',
    );
    return JSON.parse(readFileSync(path, 'utf8'));
  };
  let current = {
    snapshot: main.snapshotId,
    receipt: main.receipt.id,
    head: main.head,
    revision: main.sourceRevision,
  };
  while (existsSync(recoveryIndexPath(directory, 'snapshot', current.snapshot))) {
    const delta = read('snapshot', current.snapshot);
    const row = read('acceptance', delta.receiptId);
    const receipt = hostedAcceptanceSchema.parse(JSON.parse(row.value));
    invariant(
      receipt.projectId === main.projectId &&
        receipt.id === current.receipt &&
        receipt.candidate.head === current.head &&
        receipt.snapshot.id === current.snapshot &&
        receipt.snapshot.revision === current.revision &&
        delta.head === current.head &&
        delta.sourceRevision === current.revision &&
        delta.previousId === receipt.snapshot.previousId &&
        row.sequence === current.revision &&
        row.submissionId === receipt.submissionId &&
        row.attemptId === receipt.attemptId,
      'INVALID_WORK_BACKUP',
      'Hosted acceptance snapshot lineage differs from its exact receipt.',
    );
    const plan = read('completion', receipt.id);
    invariant(
      plan.root === receipt.completion.root &&
        plan.inputPages === receipt.completion.pages &&
        plan.lanes === receipt.completion.lanes &&
        plan.inputsNext === null &&
        plan.dependenciesNext === null &&
        plan.submissionId === receipt.submissionId &&
        plan.attemptId === receipt.attemptId &&
        Number.isSafeInteger(plan.appliedPage) &&
        plan.appliedPage >= 0 &&
        plan.appliedPage <= plan.inputPages &&
        Number.isSafeInteger(plan.appliedEntry) &&
        plan.appliedEntry >= 0,
      'INVALID_WORK_BACKUP',
      'Hosted completion progress differs from its accepted ledger.',
    );
    let root = EMPTY_COMPLETION_ROOT,
      lanes = 0;
    for (const kind of ['inputs', 'dependencies'] as const) {
      for (let index = 0; index < (kind === 'inputs' ? plan.inputPages : plan.dependencyPages); index++) {
        const page = read('completion-page', canonicalPayload([receipt.id, kind, index]));
        const value = validateComposePage(JSON.parse(page.value));
        root = completionPageRoot(root, kind, index, value);
        invariant(
          digest(canonicalPayload(value)) === page.digest && root === page.root,
          'INVALID_WORK_BACKUP',
          'Hosted completion page differs from its original root.',
        );
        if (kind === 'inputs') {
          lanes += value.entries.length;
          if (index === plan.appliedPage)
            invariant(
              value.entries.length === 0 ? plan.appliedEntry === 0 : plan.appliedEntry < value.entries.length,
              'INVALID_WORK_BACKUP',
              'Hosted completion entry cursor is invalid.',
            );
        }
      }
    }
    invariant(
      root === plan.root &&
        lanes === plan.lanes &&
        (plan.appliedPage !== plan.inputPages || plan.appliedEntry === 0),
      'INVALID_WORK_BACKUP',
      'Hosted completion page coverage is incomplete.',
    );
    invariant(current.revision > 0, 'INVALID_WORK_BACKUP', 'Hosted acceptance revision must advance.');
    current = {
      snapshot: receipt.snapshot.previousId,
      receipt: receipt.previous.receiptId,
      head: receipt.previous.head,
      revision: current.revision - 1,
    };
  }
  invariant(
    !existsSync(recoveryIndexPath(directory, 'acceptance', current.receipt)),
    'INVALID_WORK_BACKUP',
    'An intermediate hosted acceptance snapshot delta is unavailable.',
  );
  // A server receipt must have a delta; stopping at a seed snapshot is valid.
  invariant(
    main.receipt.kind !== 'server' || current.receipt !== main.receipt.id,
    'INVALID_WORK_BACKUP',
    'The selected hosted-only acceptance delta is unavailable.',
  );
}

/** Scratch lookups are rebuilt from the durable page chain on every validation.
 * No table is assembled in memory, and disposable indexes need no per-row fsync. */
export function validateRecoveryTables(directory: string, source: NativeSource, recovery: HostedRecovery) {
  const index = mkdtempSync(join(directory, 'hosted-index-'));
  const put = (table: string, id: string, row: unknown) =>
    writeFileSync(recoveryIndexPath(index, table, id), JSON.stringify(row), { flag: 'wx', mode: 0o600 });
  try {
    for (const row of hostedRecoveryRows(source, recovery, 'projectHostedRecordBodies'))
      put('body', String(row._id), row);
    for (const [table, alias, field] of [
      ['projectHostedAcceptanceSnapshots', 'snapshot', 'snapshotId'],
      ['projectHostedAcceptances', 'acceptance', 'receiptId'],
      ['projectHostedAcceptancePlans', 'completion', 'receiptId'],
    ] as const)
      for (const row of hostedRecoveryRows(source, recovery, table)) put(alias, String(row[field]), row);
    for (const row of hostedRecoveryRows(source, recovery, 'projectHostedAcceptancePages'))
      put('completion-page', canonicalPayload([row.receiptId, row.kind, row.index]), row);
    for (const row of hostedRecoveryRows(source, recovery, 'projectHostedRecords')) {
      const path = recoveryIndexPath(index, 'body', String(row.bodyId));
      invariant(existsSync(path), 'INVALID_WORK_BACKUP', 'An exact hosted record body is unavailable.');
      const body = JSON.parse(readFileSync(path, 'utf8'));
      invariant(
        digest(body.value) === row.digest && Buffer.byteLength(body.value) === row.bytes,
        'INVALID_WORK_BACKUP',
        'Hosted record body differs from its exact version.',
      );
    }
    validateRecoveryAcceptances(index, recovery.main);
  } finally {
    rmSync(index, { recursive: true, force: true });
  }
}
