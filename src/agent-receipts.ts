// SPDX-License-Identifier: Apache-2.0
import type { CheckRun, Lane, WorkView, WorkData } from './work-types.js';
export const laneReceipt = (lane: Lane, path: string) => ({
  laneId: lane.id,
  ...(lane.stack ? { stack: lane.stack } : {}),
  ...(lane.after ? { after: lane.after } : {}),
  ...(lane.startedBy ? { startedBy: lane.startedBy } : {}),
  ...(lane.startedAt ? { startedAt: lane.startedAt } : {}),
  intentId: lane.intentId,
  base: lane.base,
  head: lane.head,
  state: lane.state,
  path,
});
export const viewReceipt = (view: WorkView) => ({
  viewId: view.id,
  intentId: view.intentId,
  base: view.base,
  ...(view.composedMain ? { composedMain: view.composedMain } : {}),
  head: view.head ?? null,
  status: view.status,
  inputs: view.inputs,
  dependencyCount: view.dependencies?.length ?? 0,
  ...(view.status === 'conflict'
    ? { conflicts: view.details.slice(0, 2048), conflictDetailsTruncated: view.details.length > 2048 }
    : {}),
  reviewDeferred: view.status === 'clean' || view.details.length > 2048,
});
export const runReceipt = (run: CheckRun) => ({
  ...(run.backend ? { backend: run.backend } : {}),
  operationId: run.id,
  runId: run.id,
  viewId: run.viewId,
  head: run.head,
  checkId: run.check.id,
  checkDefinition: run.check.definition,
  environmentFingerprint: run.environment.fingerprint,
  environmentMode: run.environment.mode ?? 'legacy',
  env: run.check.env ?? [],
  credentials: run.check.credentials ?? [],
  status: run.status,
  ...(run.interaction !== undefined ? { interaction: run.interaction } : {}),
  ...(run.checkSelection ? { checkSelection: run.checkSelection } : {}),
  ...(run.error ? { error: run.error } : {}),
  startedAt: run.startedAt,
  ...(run.queuedAt ? { queuedAt: run.queuedAt } : {}),
  ...(run.warnings?.length ? { warnings: run.warnings } : {}),
  endedAt: run.endedAt ?? null,
  exitCode: run.exitCode ?? null,
  signal: run.signal ?? null,
  cancelRequested: run.cancelRequested ?? false,
  ...(run.cancellation ? { cancellation: run.cancellation } : {}),
  coverage: 'Selected command outcome; external inputs and review coverage remain unknown.',
  reuse: 'disabled',
  humanReview: 'separate',
  ...(run.status === 'failed' ||
  run.status === 'interrupted' ||
  run.status === 'runner-unavailable' ||
  run.status === 'runner-budget-exhausted'
    ? { diagnostic: run.details.slice(0, 500), diagnosticTruncated: run.details.length > 500 }
    : {}),
  logs: { stdout: { offset: 0 }, stderr: { offset: 0 } },
});
export const acceptanceReceipt = (move: WorkData['channelMoves'][number]) => ({
  operationId: move.id,
  acceptanceId: move.id,
  channel: move.channel,
  viewId: move.viewId,
  head: move.head,
  previous: move.previous,
  status: move.status,
  provenance: move.provenance,
  ...(move.fastPath ? { fastPath: move.fastPath } : {}),
  ...(move.postAccept ? { postAccept: move.postAccept } : {}),
  ...(move.acceptedBy ? { acceptedBy: move.acceptedBy } : {}),
  ...(move.automatic ? { automatic: move.automatic } : {}),
});
