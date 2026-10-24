// SPDX-License-Identifier: Apache-2.0
import { CoordinationJournal } from './agent-coordination-journal.js';
import { digest } from './hash.js';
import { invariant } from './errors.js';
import { localActor } from './work-actor.js';
import { deliveryHandoffSchema, latestHandoff, type handoffSchema } from './agent-handoff-types.js';
import type { z } from 'zod';
import type { WorkStore } from './work-store.js';
type Command = z.infer<typeof handoffSchema> & { operationId: string };

/** Check receipts are linked only when their Candidate includes this exact saved Lane head.
 * A combined Candidate's head remains separate; self-reports never become check evidence. */
export function recordHandoff(store: WorkStore, command: Command) {
  return store.locked(
    () => {
      const tx = store.records(),
        lane = tx.fields('lanes', command.laneId)?.record;
      invariant(lane, 'NOT_FOUND', 'Lane not found.');
      const intent = tx.find('intents', lane.intentId)?.record;
      invariant(intent, 'NOT_FOUND', 'Intent not found.');
      const request = digest(JSON.stringify(command));
      const prior = intent.notes.find(note => note.handoff?.operationId === command.operationId)?.handoff;
      if (prior) {
        invariant(prior.request === request, 'WORK_OPERATION_CHANGED', 'Replay the original handoff inputs.');
        return { revision: tx.revision, result: { status: 'recorded', handoff: prior } };
      }
      if (command.repairs?.length) {
        const notices = new CoordinationJournal(store).context().notices;
        invariant(
          command.repairs.every(id => notices.some(notice => notice.noticeId === id)),
          'NOT_FOUND',
          'Select retained conflict notice IDs from the ownership/brief context.',
        );
      }
      const views = tx
        .all('views', lane.intentId, 'intentId')
        .filter(view => view.inputs.some(input => input.laneId === lane.id && input.head === lane.head));
      const recordedChecks = views.flatMap(view =>
        tx.all('runs', view.id, 'viewId').map(run => ({
          source: 'forge-recorded' as const,
          operationId: run.id,
          viewId: run.viewId,
          head: run.head,
          laneHead: lane.head,
          checkId: run.check.id,
          definition: run.check.definition,
          status: run.status,
          exitCode: run.exitCode ?? null,
          startedAt: run.startedAt,
          endedAt: run.endedAt ?? null,
        })),
      );
      const { action: _action, ...payload } = command;
      void _action;
      const at = new Date().toISOString();
      const parent = lane.stack ? tx.fields('lanes', lane.stack.laneId)?.record : undefined;
      const parentHandoff = parent
        ? latestHandoff(tx.find('intents', parent.intentId)?.record.notes ?? [], parent.id)
        : null;
      const handoff = deliveryHandoffSchema.parse({
        ...(lane.stack ? { parentHandoff } : {}),
        ...payload,
        schema: 1,
        request,
        head: lane.head,
        intentId: lane.intentId,
        at,
        actor: localActor('agent').name,
        tests: (command.tests ?? []).map(test => ({ ...test, source: 'self-reported' })),
        recordedChecks,
      });
      tx.appendField('intents', lane.intentId, 'notes', {
        text: command.summary,
        kind: 'comment',
        at,
        handoff,
      });
      return { revision: store.commitRecords(tx), result: { status: 'recorded', handoff } };
    },
    { operation: 'record handoff' },
  );
}

export function readHandoff(store: WorkStore, laneId: string) {
  return store.observing(() => {
    const tx = store.readRecords(),
      data = tx ? undefined : store.load(),
      lane = tx?.fields('lanes', laneId)?.record ?? data?.lanes.find(lane => lane.id === laneId);
    invariant(lane, 'NOT_FOUND', 'Lane not found.');
    const intent =
      tx?.find('intents', lane.intentId)?.record ?? data?.intents.find(intent => intent.id === lane.intentId);
    invariant(intent, 'NOT_FOUND', 'Intent not found.');
    return {
      revision: tx?.revision ?? data!.revision,
      result: {
        laneId,
        handoff: latestHandoff(intent.notes, laneId),
        ...(lane.stack
          ? {
              parentHandoff: (() => {
                const parent =
                  tx?.fields('lanes', lane.stack.laneId)?.record ??
                  data?.lanes.find(item => item.id === lane.stack!.laneId);
                const notes = parent
                  ? ((
                      tx?.find('intents', parent.intentId)?.record ??
                      data?.intents.find(item => item.id === parent.intentId)
                    )?.notes ?? [])
                  : [];
                return parent ? latestHandoff(notes, parent.id) : null;
              })(),
            }
          : {}),
      },
    };
  });
}
