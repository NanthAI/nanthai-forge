// SPDX-License-Identifier: Apache-2.0
import { frictionId, appendFriction } from './friction.js';
import { pageSize } from './work-records.js';
import { digest } from './hash.js';
import type { FrictionCapture } from './friction-types.js';
import type { CheckRun, Lane } from './work-types.js';
import type { WorkRecordTransaction } from './work-record-transaction.js';
import type { WorkStore } from './work-store.js';

type Occurrence = {
  operationId: string;
  category: string;
  title: string;
  area: string;
  detail: string;
  laneId?: string | undefined;
  count?: number;
  retries?: number;
  evidence?: string[];
  at?: string;
};
export function automaticFriction(input: Occurrence): FrictionCapture {
  const { category, retries, ...fields } = input;
  const id = frictionId(`${input.operationId}:${category}`);
  return {
    ...fields,
    id,
    kind: 'capture',
    automatic: true,
    count: input.count ?? 1,
    at: input.at ?? new Date().toISOString(),
    request: digest(id),
    ...(retries === undefined ? {} : { cost: { retries } }),
  };
}
function appendAutomatic(tx: WorkRecordTransaction, event: FrictionCapture) {
  const old = tx.find('frictionEvents', event.id)?.record;
  if (!old) return appendFriction(tx, event);
  if (old.kind !== 'capture') return;
  const count = event.count,
    retries = event.cost?.retries ?? 0;
  if (count <= old.count && retries <= (old.cost?.retries ?? 0)) return;
  const id = frictionId(`count:${event.id}:${count}:${retries}`);
  appendFriction(tx, {
    id,
    kind: 'count',
    operationId: event.operationId,
    frictionId: event.id,
    count,
    retries,
    request: digest(id),
    at: event.at,
  });
}
function runOccurrence(run: CheckRun): Occurrence | undefined {
  const interrupted = run.status === 'interrupted';
  const infrastructure =
    run.status === 'runner-unavailable' ||
    run.status === 'runner-budget-exhausted' ||
    (run.status === 'failed' && !!run.error);
  if (!interrupted && !infrastructure) return;
  return {
    operationId: run.id,
    category: interrupted ? 'check-interrupted' : 'check-infrastructure',
    title: interrupted ? 'Check interrupted' : 'Check infrastructure failed',
    area: 'checks',
    detail: `Check ended with ${run.status}${run.error ? ` (${run.error.code})` : ''}.`,
    evidence: [run.id],
    at: run.endedAt ?? run.startedAt,
  };
}
function syncOccurrence(lane: Lane): Occurrence | undefined {
  const pending = lane.pendingMerge;
  if (!pending) return;
  return {
    operationId: pending.operation.id,
    category: 'sync-conflict',
    title: 'Sync conflict',
    area: 'sync',
    detail: `Sync from ${pending.channel} has ${pending.conflicts.length} conflicting path(s).`,
    laneId: lane.id,
    evidence: [pending.operation.id, ...pending.conflicts.map(file => file.path)],
  };
}
/** Called inside the existing Work transaction: the source result and its friction commit together. */
export function captureTransactionFriction(tx: WorkRecordTransaction, previous?: WorkRecordTransaction) {
  for (const name of ['runs', 'lanes', 'landingBatches'] as const) {
    const index = tx.manifest.collections[name];
    if (!index) continue;
    const before = previous?.manifest.collections[name];
    for (let page = 0; page < index.pages.length; page++) {
      if (index.pages[page] === before?.pages[page]) continue;
      for (let i = page * pageSize; i < Math.min((page + 1) * pageSize, index.count); i++) {
        if (i < (before?.count ?? 0) && previous!.versionAt(name, i) === tx.versionAt(name, i)) continue;
        let input: Occurrence | undefined;
        if (name === 'runs') {
          // Status and error are header fields. Cost summaries own full run-page hydration;
          // capture needs only the first input of a newly changed reportable run.
          input = runOccurrence(tx.fieldsAt('runs', i).record);
          if (input) {
            const first = tx.fieldAt('runs', i, 'inputs', 0) as CheckRun['inputs'][number] | undefined;
            if (first) input.laneId = first.laneId;
          }
        }
        if (name === 'lanes') input = syncOccurrence(tx.fieldsAt('lanes', i).record);
        if (name === 'landingBatches') {
          const batch = tx.at('landingBatches', i);
          if (batch.status === 'superseded')
            input = {
              operationId: batch.id,
              category: 'landing-bounce',
              title: 'Landing bounced',
              area: 'landing',
              detail: 'Landing batch was superseded and needs a fresh candidate.',
              evidence: [batch.id],
              at: batch.arrivedAt,
            };
        }
        if (input) appendAutomatic(tx, automaticFriction(input));
      }
    }
  }
}
/** Diagnostics cannot turn an already-applied source operation into a failure. */
export function captureAutomatic(store: WorkStore, input: Occurrence) {
  try {
    return store.locked(
      () => {
        const tx = store.records(),
          event = automaticFriction(input);
        const count = tx.manifest.collections.frictionEvents?.count ?? 0;
        appendAutomatic(tx, event);
        if (count !== tx.manifest.collections.frictionEvents?.count) store.commitRecords(tx);
      },
      { waitMs: 0 },
    );
  } catch {
    process.stderr.write(
      `Friction capture unavailable for operation ${input.operationId}; its original outcome is unchanged.\n`,
    );
  }
}
export function frictionReceipt(
  store: WorkStore,
  command: { action: string; operationId?: string | undefined; laneId?: string | undefined },
  result: unknown,
) {
  const receipt = result as {
    attempts?: { error?: { code: string }; status?: string }[];
    entries?: { operationId: string; code?: string; status: string; retries?: number }[];
    code?: string;
    status?: string;
    terminal?: boolean;
  };
  if (command.action === 'sync' && receipt.status === 'conflict' && command.operationId)
    captureAutomatic(store, {
      operationId: command.operationId,
      category: 'sync-conflict',
      title: 'Sync conflict',
      area: 'sync',
      detail: 'Sync requires conflict resolution.',
      laneId: command.laneId,
      evidence: [command.operationId],
    });
  const bounces =
    receipt.attempts?.filter(attempt =>
      ['CHANNEL_CHANGED', 'CONTRACT_RESYNC_REQUIRED'].includes(attempt.error?.code ?? ''),
    ).length ?? 0;
  const landBounces = receipt.entries?.filter(entry => (entry.retries ?? 0) > 0) ?? [];
  for (const entry of landBounces)
    captureAutomatic(store, {
      operationId: entry.operationId,
      category: 'landing-bounce',
      title: 'Landing bounced',
      area: 'landing',
      detail: 'The saved-head landing needed a new attempt after main moved.',
      count: entry.retries!,
      retries: entry.retries!,
      evidence: [entry.operationId],
    });
  const exhausted = ['WORK_BUSY', 'WORK_STALE'].includes(receipt.code ?? '');
  const entries =
    receipt.entries?.filter(entry => ['WORK_BUSY', 'WORK_STALE'].includes(entry.code ?? '')) ?? [];
  if (
    receipt.terminal !== false &&
    command.operationId &&
    (bounces || exhausted || receipt.status === 'retry-exhausted')
  )
    captureAutomatic(store, {
      operationId: command.operationId,
      category: bounces || receipt.status === 'retry-exhausted' ? 'landing-bounce' : 'work-retries',
      title: bounces || receipt.status === 'retry-exhausted' ? 'Landing bounced' : 'Work retries exhausted',
      area: bounces || receipt.status === 'retry-exhausted' ? 'landing' : 'workflow',
      detail: 'The operation needed a retry or exhausted its retry window.',
      laneId: command.laneId,
      count: Math.max(1, bounces),
      retries: Math.max(1, bounces),
      evidence: [command.operationId],
    });
  for (const entry of entries)
    captureAutomatic(store, {
      operationId: entry.operationId,
      category: 'work-retries',
      title: 'Work retries exhausted',
      area: 'workflow',
      detail: `Landing stopped with ${entry.code}.`,
      evidence: [entry.operationId],
    });
  let batchBounced = false;
  if (['finish', 'land'].includes(command.action)) {
    const operations = new Set([
      command.operationId,
      ...(receipt.entries ?? []).map(entry => entry.operationId),
    ]);
    const tx = store.readRecords();
    for (let i = 0; i < (tx?.manifest.collections.landingBatches?.count ?? 0); i++) {
      const batch = tx!.at('landingBatches', i);
      if (batch.status === 'superseded' && batch.entryIds.some(id => operations.has(id))) {
        batchBounced = true;
        break;
      }
    }
  }
  return ['finish', 'land'].includes(command.action) &&
    (bounces ||
      batchBounced ||
      landBounces.length ||
      exhausted ||
      entries.length ||
      receipt.status === 'retry-exhausted')
    ? {
        frictionHint:
          'Hit workflow friction? Add detail with nforge agent ROOT friction; nforge improve ROOT groups reports.',
      }
    : {};
}

/** Preserve the existing driver's retry evidence in its receipt, without altering landing behavior. */
export function landFrictionCounts(
  entries: { single?: { attempt: number }; result?: Record<string, unknown> }[],
) {
  for (const entry of entries)
    if (entry.result && entry.single?.attempt) entry.result.retries = entry.single.attempt;
}
