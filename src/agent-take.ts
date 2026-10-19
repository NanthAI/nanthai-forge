// SPDX-License-Identifier: Apache-2.0
import { CoordinationJournal } from './agent-coordination-journal.js';
import { laneFinishes } from './agent-finish-journal.js';
import { localActor } from './work-actor.js';
import { localBrief } from './agent-brief-local.js';
import { laneOwnership } from './agent-ownership.js';
import { ensureLaneDirectory } from './agent-lane-directory.js';
import { digest } from './hash.js';
import { invariant } from './errors.js';
import { PRESENCE } from './presence.js';
import type { WorkStore } from './work-store.js';

export function agentTake(
  store: WorkStore,
  command: {
    laneId: string;
    operationId?: string | undefined;
    takeover: boolean;
    actor?: string | undefined;
    tool?: string | undefined;
  },
) {
  const actor = localActor('agent', command.actor, command.tool).name;
  const request = digest(JSON.stringify(command));
  const journal = new CoordinationJournal(store);
  return store.laneLocked(
    command.laneId,
    () => {
      const response = store.locked(() => {
        const tx = store.records(),
          lane = tx.find('lanes', command.laneId)?.record;
        invariant(lane, 'NOT_FOUND', 'Lane not found.');
        journal.handoverReplay(command.operationId!, request, lane.id);
        const retained = lane.handovers?.find(item => item.operationId === command.operationId);
        const replay = !!retained;
        invariant(
          replay || !['completed', 'abandoned'].includes(lane.state),
          'LANE_CLOSED',
          'Take an open Lane.',
        );
        if (retained)
          invariant(
            retained.request === request,
            'WORK_OPERATION_CHANGED',
            'This take operation has different inputs.',
          );
        const ownership = laneOwnership(store, lane);
        if (!replay && ownership && ownership.actor !== actor && !command.takeover)
          return {
            revision: tx.revision,
            result: {
              operationId: command.operationId,
              laneId: lane.id,
              status: 'ownership',
              ownership,
              next: 'Repeat take with takeover:true to take this Lane.',
            },
          };
        const now = Date.now();
        const views = tx
          .all('views', lane.intentId, 'intentId')
          .filter(view => view.inputs.some(input => input.laneId === lane.id));
        const runs = views
          .flatMap(view => tx.all('runs', view.id, 'viewId'))
          .sort((a, b) => Date.parse(a.queuedAt ?? a.startedAt) - Date.parse(b.queuedAt ?? b.startedAt));
        const superseded: string[] = [...(retained?.superseded ?? [])];
        if (!replay) {
          for (const view of views)
            for (const run of runs.filter(run => run.viewId === view.id)) {
              const pin = view.inputs.find(input => input.laneId === lane.id)!;
              if (
                run.status === 'queued' &&
                !run.cancelRequested &&
                pin.head !== lane.head &&
                now - Date.parse(run.queuedAt ?? run.startedAt) > PRESENCE.workingMs
              ) {
                tx.patchFields('runs', run.id, { cancelRequested: true });
                superseded.push(run.id);
              }
            }
          tx.replace('lanes', tx.positions('lanes', lane.id)[0]!, {
            ...lane,
            handovers: [
              ...(lane.handovers ?? []),
              {
                operationId: command.operationId!,
                request,
                actor,
                ...(ownership ? { from: ownership.actor } : {}),
                at: new Date(now).toISOString(),
                superseded,
                head: lane.head,
              },
            ],
            owner: { actor, at: new Date(now).toISOString(), operationId: command.operationId!, request },
          });
          store.commitRecords(tx);
        }
        const handover = retained ?? {
          operationId: command.operationId!,
          request,
          actor,
          ...(ownership ? { from: ownership.actor } : {}),
          at: new Date(now).toISOString(),
          superseded,
          head: lane.head,
        };
        journal.handover({ ...handover, laneId: lane.id, intentId: lane.intentId });
        return {
          revision: tx.revision,
          result: {
            operationId: command.operationId,
            laneId: lane.id,
            status: 'taken',
            path: store.path(lane.id),
            head: lane.head,
            ownership: replay ? ownership : { actor, state: 'working' },
            superseded,
            lastCheck: runs.at(-1) ?? null,
            pending: {
              source: lane.pending ?? lane.pendingSync ?? null,
              merge: lane.pendingMerge ?? null,
              after: lane.after ?? null,
              finishes: laneFinishes(store, lane.id),
            },
            undo: `take ${JSON.stringify({ laneId: lane.id, actor: retained?.from ?? ownership?.actor ?? actor, takeover: true })} returns ownership; cancelled stale checks can be queued again.`,
          },
        };
      });
      if (response.result.status === 'taken') {
        ensureLaneDirectory(store, command.laneId);
        return {
          ...response,
          result: {
            ...response.result,
            ...journal.context(command.laneId),
            brief: localBrief(store, {
              situation: 'take-handoff',
              laneId: command.laneId,
              messageId: command.operationId,
            }),
          },
        };
      }
      return response;
    },
    { operation: 'take' },
  );
}
