// SPDX-License-Identifier: Apache-2.0
import type { Conversation } from './agent-edit-context.js';
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { decideInputSchema, decisionRecordSchema, type DecisionRecord } from './decision-types.js';
import { digest } from './hash.js';
import { invariant } from './errors.js';
import { localActor } from './work-actor.js';
import type { WorkStore } from './work-store.js';

type StoreAccess = Pick<
  WorkStore,
  'commitRecords' | 'load' | 'locked' | 'readRecords' | 'records' | 'select'
>;

export function decisionRecords(store: StoreAccess): DecisionRecord[] {
  const tx = store.readRecords();
  return tx
    ? Array.from({ length: tx.manifest.collections.decisions?.count ?? 0 }, (_, i) => tx.at('decisions', i))
    : (store.load().decisions ?? []);
}
export function recordDecision(
  store: StoreAccess,
  input: z.infer<typeof decideInputSchema>,
  context?: Conversation,
) {
  const prior = input.operationId ? store.select('decisions', input.operationId) : undefined;
  const conversation = input.conversation ?? (prior ? prior.conversation : context);
  const command = decideInputSchema.parse({
    ...input,
    operationId: input.operationId ?? randomUUID(),
    ...(conversation ? { conversation } : {}),
  });
  const request = digest(JSON.stringify(command));
  return store.locked(
    () => {
      const tx = store.records();
      const old = tx.find('decisions', command.operationId!)?.record;
      if (old) {
        invariant(old.request === request, 'WORK_OPERATION_CHANGED', 'Replay the original decision inputs.');
        return { revision: tx.revision, result: old };
      }
      if (command.target.kind === 'intent')
        invariant(tx.find('intents', command.target.intentId), 'NOT_FOUND', 'Intent not found.');
      for (const id of [
        command.supersedes,
        command.overrides?.kind === 'decision' ? command.overrides.decisionId : undefined,
      ])
        if (id) invariant(tx.find('decisions', id), 'NOT_FOUND', 'Earlier decision not found.');
      const at = new Date().toISOString();
      const record = decisionRecordSchema.parse({
        ...command,
        schema: 1,
        kind: 'decision',
        id: command.operationId,
        request,
        at,
        decidedAt: command.decidedAt ?? at,
        actor: localActor('agent', command.actor, command.tool),
        requester: localActor('agent'),
        overrides:
          command.overrides ??
          (command.supersedes ? { kind: 'decision', decisionId: command.supersedes } : undefined),
      });
      tx.append('decisions', record);
      return { revision: store.commitRecords(tx), result: record };
    },
    { operation: 'record decision' },
  );
}
