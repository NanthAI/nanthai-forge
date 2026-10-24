// SPDX-License-Identifier: Apache-2.0
import { ForgeError } from './errors.js';
import type { WorkRecordTransaction } from './work-record-transaction.js';
import type { CheckRun, WorkView } from './work-types.js';
import type { WorkStore } from './work-store.js';

/** Candidate family order is retained Work order, matching the read model. */
export function runCandidateFamily(tx: WorkRecordTransaction, view: WorkView) {
  const key = (inputs: CheckRun['inputs']) => JSON.stringify(inputs.map(i => i.laneId).sort());
  return tx
    .all('views', view.intentId, 'intentId')
    .filter(candidate => key(candidate.inputs) === key(view.inputs));
}

/** Acceptance and family membership are revalidated under the cancellation write lock. */
function supersedingCandidate(tx: WorkRecordTransaction, run: CheckRun) {
  const view = tx.find('views', run.viewId)?.record;
  if (
    !view ||
    tx.all('channelMoves', view.id, 'viewId').some(move => move.status === 'accepted') ||
    tx.all('hostedChannelMoves', view.id, 'viewId').length
  )
    return;
  const candidates = runCandidateFamily(tx, view),
    latest = candidates.at(-1);
  // New requests retain an exact family cursor. Old runs require a strictly later
  // timestamp; unknown or tied timestamps cannot prove supersession after a request.
  const requestedAt = Date.parse(run.queuedAt ?? run.startedAt);
  const baseline =
    run.supersessionBaseline ??
    candidates.filter(candidate => Date.parse(candidate.at) <= requestedAt).at(-1)?.id;
  const afterRequest =
    run.supersessionBaseline !== undefined ||
    (Number.isFinite(requestedAt) && Date.parse(latest?.at ?? '') > requestedAt);
  if (
    afterRequest &&
    baseline &&
    candidates.some(candidate => candidate.id === baseline) &&
    latest &&
    latest.id !== baseline &&
    latest.id !== view.id
  )
    return latest;
}

/** First observed request wins, including when a controller is adopted or retried. */
function requestRunCancellation(
  store: WorkStore,
  id: string,
  cancellation: NonNullable<CheckRun['cancellation']>,
) {
  return store.locked(() => {
    const tx = store.records(),
      selected = tx.find('runs', id);
    if (!selected) return;
    const run = selected.record;
    if (['queued', 'preparing', 'running'].includes(run.status) && !run.cancelRequested) {
      if (cancellation.reason === 'superseded') {
        const latest = supersedingCandidate(tx, run);
        if (!latest) return run;
        cancellation = { ...cancellation, supersededBy: latest.id };
      }
      run.cancelRequested = true;
      run.cancellation = cancellation;
      tx.replace('runs', selected.position, run);
      store.commitRecords(tx);
    }
    return run;
  });
}

/** Use the same ordered Intent/Lane family as the Candidate read model. */
export function remoteCancellation(
  store: WorkStore,
  run: CheckRun,
  observation?: Pick<NonNullable<CheckRun['cancellation']>, 'reason' | 'signal'>,
) {
  try {
    const saved = store.select('runs', run.id);
    if (saved?.cancelRequested) {
      run.cancelRequested = true;
      run.cancellation = saved.cancellation;
      return true;
    }
    let cancellation: CheckRun['cancellation'];
    if (observation)
      cancellation = {
        ...observation,
        at: new Date().toISOString(),
        ...(observation.reason === 'queue'
          ? { actor: { kind: 'system', name: 'Forge check queue' } as const }
          : {}),
      };
    else {
      const tx = store.readRecords() ?? store.records();
      const latest = supersedingCandidate(tx, run);
      if (latest)
        cancellation = {
          reason: 'superseded',
          supersededBy: latest.id,
          at: new Date().toISOString(),
          actor: { kind: 'system', name: 'Forge check controller' },
        };
    }
    if (!cancellation) return false;
    const updated = requestRunCancellation(store, run.id, cancellation);
    run.cancelRequested = updated?.cancelRequested;
    run.cancellation = updated?.cancellation;
    return run.cancelRequested === true;
  } catch (error) {
    if (error instanceof ForgeError && error.code === 'SOURCE_CHANGED') return false;
    throw error;
  }
}

export function cancellationDetails(run: CheckRun) {
  return run.cancellation?.reason === 'superseded'
    ? ` Check cancelled-superseded by Candidate ${run.cancellation.supersededBy}; receipt retained. Queue a new run operation to check this Candidate again.`
    : '';
}
