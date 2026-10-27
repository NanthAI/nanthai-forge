// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { digest } from './hash.js';
import { invariant } from './errors.js';
import { overlapAnswerId } from './agent-edit-notices.js';
import { readAgentTurn } from './agent-edit-context.js';
import { recordMetricObservation } from './self-metrics-observations.js';
import type { WorkStore } from './work-store.js';
import type { z } from 'zod';
import type { peerAckSchema } from './agent-coordination-journal.js';

/** Portable indexed Work note. Delivery alone never acknowledges an overlap. */
export function acknowledgeOverlap(
  store: WorkStore,
  command: z.infer<typeof peerAckSchema> & { operationId: string },
) {
  const path = join(store.directory, 'overlap-inbox', command.laneId, `${command.noticeId}.json`);
  let notice: { lanes: string[]; file: string };
  try {
    notice = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  invariant(notice.lanes.includes(command.laneId), 'BAD_ARGUMENT', 'Lane is not an overlap participant.');
  const id = overlapAnswerId(command.laneId, command.noticeId);
  const request = digest(JSON.stringify(command));
  const response = store.locked(
    () => {
      const tx = store.records(),
        lane = tx.fields('lanes', command.laneId)?.record;
      invariant(lane, 'NOT_FOUND', 'Lane not found.');
      const prior = tx.fieldFind('intents', lane.intentId, 'notes', id) as
        | {
            request: string;
            at: string;
            overlapAnswer: { deliveryId: string; disposition: 'acknowledged' | 'routed-around' };
          }
        | undefined;
      if (prior) {
        invariant(prior.request === request, 'WORK_OPERATION_CHANGED', 'Replay the original overlap answer.');
        return { revision: tx.revision, result: { status: 'recorded', acknowledgement: prior } };
      }
      const at = new Date().toISOString(),
        conversation = readAgentTurn(store.directory, lane.id);
      const note = {
        id,
        operationId: command.operationId,
        request,
        at,
        kind: 'decision' as const,
        text: `Overlap ${command.choice === 'split' ? 'routed around' : 'acknowledged'}: ${notice.file}. ${command.text ?? command.choice}`,
        overlapAnswer: {
          laneId: lane.id,
          noticeId: command.noticeId,
          deliveryId: `hook:${digest(JSON.stringify([lane.id, command.noticeId]))}`,
          disposition: command.choice === 'split' ? ('routed-around' as const) : ('acknowledged' as const),
        },
        ...(conversation ? { conversation } : {}),
      };
      tx.appendField('intents', lane.intentId, 'notes', note);
      return { revision: store.commitRecords(tx), result: { status: 'recorded', acknowledgement: note } };
    },
    { operation: 'acknowledge overlap' },
  );
  const note = response.result.acknowledgement;
  recordMetricObservation(store.directory, {
    type: 'overlap-answer',
    id: `answer:${id}`,
    at: note.at,
    laneId: command.laneId,
    noticeId: command.noticeId,
    deliveryId: note.overlapAnswer.deliveryId,
    disposition: note.overlapAnswer.disposition,
  });
  return response;
}
