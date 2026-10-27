// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { finishChild } from './finish-child.js';
import { ForgeError, invariant } from './errors.js';
import { metricOperationId } from './self-metrics-journal.js';
import { NativeSource } from './native-source.js';
import type { WorkService } from './work.js';
import type { AgentAction } from './agent-workflow-schema.js';
import type { WorkView } from './work-types.js';

/** Retry metadata contention only. Source/check errors retain their meaning. */
export async function retryRunPublication<T>(publish: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await publish();
    } catch (error) {
      if (!(error instanceof ForgeError) || error.code !== 'WORK_STALE' || attempt === 3) throw error;
    }
  }
}

/** A Lane run checks its saved head on a pinned main, without a prior finish.
 * Published composition/run identities survive retries even if main moves. */
export async function prepareLaneRun(work: WorkService, command: Extract<AgentAction, { action: 'run' }>) {
  if (!work.store.native || command.viewId || !command.laneId) return command;
  const store = work.store,
    operationId = command.operationId ?? randomUUID(),
    composeId = finishChild(operationId, 'lane-run-compose'),
    original = store.select('runs', operationId);
  metricOperationId(operationId);
  if (original) {
    invariant(
      original.inputs.some(pin => pin.laneId === command.laneId),
      'WORK_OPERATION_CHANGED',
      'Reconcile the original Lane run.',
    );
    return { ...command, operationId, viewId: original.viewId };
  }
  const composed = await retryRunPublication(async () => {
    const tx = store.readRecords(),
      retained = tx?.all('views', composeId, 'operation')[0];
    if (retained) return retained;
    const lane = store.select('lanes', command.laneId!, 'id', true);
    invariant(lane, 'NOT_FOUND', 'Lane not found.');
    const moves = tx?.all('channelMoves', 'main', 'channel') ?? store.load().channelMoves;
    const main = moves.filter(move => move.channel === 'main' && move.status === 'accepted').at(-1);
    // Preserve the existing Lane shorthand when its latest clean Candidate
    // still contains the saved head and current main. Explicit Candidate runs
    // retain their original revision preconditions.
    const views = tx?.all('views', lane.intentId, 'intentId') ?? store.load().views;
    const latest = views
      .filter(view => view.status === 'clean' && view.head && view.inputs.some(pin => pin.laneId === lane.id))
      .at(-1);
    if (
      latest?.head &&
      latest.inputs.some(pin => pin.laneId === lane.id && pin.head === lane.head) &&
      (!main || new NativeSource(store.root).contains(latest.head, main.head))
    )
      return latest;
    const dependencies = [...(store.select('intents', lane.intentId)?.dependencies ?? [])];
    if (main && !dependencies.some(pin => pin.kind === 'view' && pin.viewId === main.viewId))
      dependencies.push({ kind: 'view', viewId: main.viewId, head: main.head });
    return (
      await work.dispatch(
        {
          action: 'compose',
          operationId: composeId,
          intentId: lane.intentId,
          inputs: [{ laneId: lane.id, head: lane.head }],
          dependencies,
        },
        store.revision(),
        { compact: true, reconcileComposition: true },
      )
    ).result as WorkView;
  });
  invariant(
    composed.status === 'clean' && composed.head,
    'VIEW_STALE',
    composed.details || 'Lane conflicts with pinned main.',
  );
  return { ...command, operationId, viewId: composed.id };
}
