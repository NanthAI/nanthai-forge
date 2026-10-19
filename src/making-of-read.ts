// SPDX-License-Identifier: Apache-2.0
import { readHostState, updateHostState } from './host-binding.js';
import { localActor } from './work-actor.js';
import { invariant } from './errors.js';
import { deriveMakingOf, type MakingOfInput } from './making-of.js';
import type { WorkStore } from './work-store.js';
import type { AgentAction } from './agent-workflow-schema.js';

type Report = Extract<AgentAction, { action: 'report' }> & { operationId: string };

/** Reads retained Work and local presence only; it never recovers runs or writes. */
export function readMakingOf(store: WorkStore, intentId: string) {
  const tx = store.readRecords();
  let revision: number, records: Omit<MakingOfInput, 'presence' | 'reports'> | undefined;
  if (tx) {
    revision = tx.revision;
    const intent = tx.find('intents', intentId)?.record;
    if (intent) {
      const views = tx.all('views', intentId, 'intentId');
      records = {
        intent,
        lanes: tx.all('lanes', intentId, 'intentId'),
        views,
        runs: views.flatMap(view => tx.all('runs', view.id, 'viewId')),
        moves: views.flatMap(view => tx.all('channelMoves', view.id, 'viewId')),
      };
    }
  } else {
    const data = store.load(),
      intent = data.intents.find(item => item.id === intentId);
    revision = data.revision;
    if (intent) {
      const views = data.views.filter(view => view.intentId === intentId),
        ids = new Set(views.map(view => view.id));
      records = {
        intent,
        lanes: data.lanes.filter(lane => lane.intentId === intentId),
        views,
        runs: data.runs.filter(run => ids.has(run.viewId)),
        moves: data.channelMoves.filter(move => ids.has(move.viewId)),
      };
    }
  }
  invariant(records, 'NOT_FOUND', 'Intent not found.');
  const lanes = new Set(records.lanes.map(lane => lane.id)),
    host = readHostState(store),
    related = (row: { laneId: string; intentId: string }) =>
      row.intentId === intentId || lanes.has(row.laneId);
  return {
    revision,
    result: deriveMakingOf({
      ...records,
      presence: Object.values(host.presence ?? {}).filter(row => related(row.context)),
      reports: Object.values(host.selfReports ?? {})
        .filter(related)
        .map(({ operations, ...report }) => (void operations, report)),
    }),
  };
}

/** Replaces this Lane session's advisory totals. Replaying any applied operation returns the current report unchanged. */
export function reportUsage(store: WorkStore, command: Report) {
  const lane = store.select('lanes', command.laneId, 'id', true);
  invariant(lane, 'NOT_FOUND', 'Lane not found.');
  const name =
      command.actor ??
      process.env.FORGE_AGENT_NAME ??
      process.env.FORGE_ACTOR ??
      lane.startedBy?.name ??
      localActor('agent').name,
    key = JSON.stringify([lane.id, name, command.sessionId ?? '']);
  const report = updateHostState(store, state => {
    const reports = (state.selfReports ??= {}),
      previous = reports[key];
    // Any earlier operation for this session is a replay: never let it overwrite newer totals.
    if (previous?.operations.includes(command.operationId)) return previous;
    return (reports[key] = {
      ...previous,
      operations: [...(previous?.operations ?? []), command.operationId],
      laneId: lane.id,
      intentId: lane.intentId,
      name,
      ...(command.sessionId ? { sessionId: command.sessionId } : {}),
      ...(command.harness ? { harness: command.harness } : {}),
      ...(command.model ? { model: command.model } : {}),
      ...(command.tokens ? { tokens: command.tokens } : {}),
      reportedAt: new Date().toISOString(),
    });
  });
  return { revision: store.revision(), result: { status: 'reported', report } };
}
