// SPDX-License-Identifier: Apache-2.0
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  frictionInputSchema,
  frictionTriageSchema,
  type FrictionCapture,
  type FrictionEvent,
} from './friction-types.js';
import { digest } from './hash.js';
import { invariant } from './errors.js';
import type { WorkStore } from './work-store.js';
import type { WorkRecordTransaction } from './work-record-transaction.js';

export function frictionId(key: string) {
  const bytes = createHash('sha256').update(`forge-friction:${key}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 15) | 80;
  bytes[8] = (bytes[8]! & 63) | 128;
  const h = bytes.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
export function frictionEvents(store: WorkStore): FrictionEvent[] {
  const tx = store.readRecords();
  if (tx)
    return Array.from({ length: tx.manifest.collections.frictionEvents?.count ?? 0 }, (_, i) =>
      tx.at('frictionEvents', i),
    );
  return store.load().frictionEvents ?? [];
}
export function validateFrictionIds(tx: WorkRecordTransaction, ids: string[]) {
  for (const id of ids)
    invariant(
      tx.find('frictionEvents', id)?.record.kind === 'capture',
      'NOT_FOUND',
      'Friction record not found.',
    );
}
export function appendFriction(tx: WorkRecordTransaction, event: FrictionEvent) {
  const old = tx.find('frictionEvents', event.id)?.record;
  if (old) {
    invariant(
      old.request === event.request,
      'WORK_OPERATION_CHANGED',
      'Replay the original friction request.',
    );
    return old;
  }
  tx.append('frictionEvents', event);
  return event;
}
export function captureFriction(store: WorkStore, input: z.infer<typeof frictionInputSchema>) {
  const operationId = input.operationId ?? randomUUID(),
    command = frictionInputSchema.parse({ ...input, operationId });
  return store.locked(() => {
    const tx = store.records();
    const event: FrictionCapture = {
      ...command,
      operationId,
      id: operationId,
      kind: 'capture',
      request: digest(JSON.stringify({ ...command, operationId })),
      at: new Date().toISOString(),
      count: 1,
    };
    const old = tx.find('frictionEvents', event.id)?.record;
    if (!old && command.laneId) invariant(tx.find('lanes', command.laneId), 'NOT_FOUND', 'Lane not found.');
    const result = appendFriction(tx, event);
    return { revision: old ? tx.revision : store.commitRecords(tx), result };
  });
}
export function triageFriction(store: WorkStore, input: z.infer<typeof frictionTriageSchema>) {
  const operationId = input.operationId ?? randomUUID(),
    command = frictionTriageSchema.parse({ ...input, operationId });
  invariant(
    command.status !== 'fixed' || command.laneId,
    'BAD_ARGUMENT',
    'Name the Lane that fixed this friction.',
  );
  return store.locked(() => {
    const tx = store.records(),
      old = tx.find('frictionEvents', operationId)?.record;
    if (!old) {
      validateFrictionIds(tx, command.frictionIds);
      if (command.laneId) invariant(tx.find('lanes', command.laneId), 'NOT_FOUND', 'Lane not found.');
    }
    const result = appendFriction(tx, {
      ...command,
      operationId,
      id: operationId,
      kind: 'triage',
      request: digest(JSON.stringify({ ...command, operationId })),
      at: new Date().toISOString(),
    });
    return { revision: old ? tx.revision : store.commitRecords(tx), result };
  });
}
export function citeFriction(tx: WorkRecordTransaction, laneId: string, ids: string[], operationId: string) {
  if (!ids.length) return;
  validateFrictionIds(tx, ids);
  appendFriction(tx, {
    id: frictionId(`cite:${operationId}`),
    kind: 'cite',
    operationId,
    laneId,
    frictionIds: ids,
    request: digest(JSON.stringify([laneId, ids])),
    at: new Date().toISOString(),
  });
}
