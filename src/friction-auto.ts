// SPDX-License-Identifier: Apache-2.0
import { checkNeverRan } from './check-run-state.js';
import type { FrictionCapture } from './friction-types.js';
import { appendFriction, frictionId } from './friction.js';
import { digest } from './hash.js';
import type { WorkRecordTransaction } from './work-record-transaction.js';
import { pageHashes, pageSize } from './work-records.js';
import type { CheckRun, Lane } from './work-types.js';

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
  const infrastructure = checkNeverRan(run.status) || (run.status === 'failed' && !!run.error);
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
      // Each immutable page is validated once for this comparison, rather than
      // rereading/decompressing it for every unchanged row in the page.
      const hashes = pageHashes(tx.directory, index.pages[page]!);
      const priorHashes = before?.pages[page] ? pageHashes(previous!.directory, before.pages[page]!) : [];
      for (let i = page * pageSize; i < Math.min((page + 1) * pageSize, index.count); i++) {
        if (i < (before?.count ?? 0) && priorHashes[i % pageSize] === hashes[i % pageSize]) continue;
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
