// SPDX-License-Identifier: Apache-2.0
import { invariant } from './errors.js';
import { noteId } from './work-intent-converter.js';
import { workSchema, type WorkData } from './work-types.js';
import { isUnifiedWork, unifiedWorkSchema } from './work-unified-types.js';

type Raw = Record<string, unknown>;
type Conversation = { id: string; kind: string; index?: number; itemId?: string };
export type IntentAlias = { aliasId: string; intentId: string };

/**
 * Complete schema-16 fields on an Intent written by an execution writer (start, import, notes).
 * Deterministic and idempotent; legacy `ready` becomes active because Ready is derived attention.
 */
export function unifyIntent<T>(value: T): T {
  const intent = { ...(value as Raw) },
    notes = Array.isArray(intent.notes) ? intent.notes : [];
  intent.title ??= intent.outcome;
  intent.description ??= '';
  if (intent.status === 'ready') intent.status = 'active';
  for (const key of ['memberships', 'relatedIntentIds', 'historyRefs', 'conversation'])
    intent[key] = Array.isArray(intent[key]) ? [...(intent[key] as unknown[])] : [];
  const conversation = intent.conversation as Conversation[];
  for (let index = 0; index < notes.length; index++)
    if (!conversation.some(entry => entry.kind === 'note' && entry.index === index))
      conversation.push({ id: noteId(String(intent.id), index), kind: 'note', index });
  return intent as T;
}
export const noteConversation = (intentId: string, index: number) => ({
  id: noteId(intentId, index),
  kind: 'note' as const,
  index,
});

/** Execution paths need the pin captured by an Intent's first Lane; planned Intents have none yet. */
export function executionBase(intent: { base?: string }): string {
  invariant(
    typeof intent.base === 'string',
    'INTENT_NOT_STARTED',
    'This planned Intent has no source pin yet. Start its first Lane with `nforge agent ROOT start` and its intentId.',
  );
  return intent.base;
}

/** An Issue ID folded into an execution Intent keeps resolving to that Intent. */
export const resolveIntentId = (aliases: readonly IntentAlias[] | undefined, id: string) =>
  aliases?.find(alias => alias.aliasId === id)?.intentId ?? id;

/** Presentation only: never persist. Abandoned appears under Done; Planned has no retained Lane. */
export function intentState(status: string, laneCount: number) {
  if (status === 'proposed') return 'Proposed';
  if (status === 'completed' || status === 'abandoned') return 'Done';
  return laneCount === 0 ? 'Planned' : 'In motion';
}

/** Hosted readers accept unified formats; preserve every retained record on push. */
export function hostedPushWork(data: WorkData): WorkData {
  // Late optional collections must use the journal parser's root field order.
  // Keep every original value/body; only the new portable snapshot is ordered.
  const shape = isUnifiedWork(data) ? unifiedWorkSchema.shape : workSchema.shape;
  return {
    ...Object.fromEntries(
      Object.keys(shape)
        .filter(key => Object.hasOwn(data, key))
        .map(key => [key, (data as unknown as Raw)[key]]),
    ),
    ...data,
  } as WorkData;
}
