// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import type { WorkData } from './work-types.js';
import { convertWorkTo18 } from './work-intent-converter.js';
import { unifiedWorkSchema, type UnifiedWorkData } from './work-unified-types.js';
import { invariant } from './errors.js';

export const hostedIntentMigrationSchema = z.object({
  operationId: z.string().uuid(),
  revision: z.number().safe().nonnegative(),
  generationId: z.string().optional(),
});
export type HostedIntentMigration = z.infer<typeof hostedIntentMigrationSchema>;
/** Replay the original journal up to the cutover, then change representation once. */
export function migrateHostedIntents(data: WorkData, migration?: HostedIntentMigration): WorkData {
  if (!migration || data.revision < migration.revision || [16, 18, 20].includes(data.schema)) return data;
  invariant(
    data.revision === migration.revision,
    'INVALID_WORK_JOURNAL',
    'Intent migration revision is missing from journal coverage.',
  );
  return convertHostedIntents(data);
}
/** Convert validated hosted observations, including planning edits on an existing Intent UUID. */
export function convertHostedIntents(data: WorkData): WorkData {
  if ([16, 18, 20].includes(data.schema)) return data;
  const edits = new Set(
    data.planningItems
      .filter(
        item =>
          item.kind === 'issue' &&
          data.hostedEvents.some(
            event =>
              event.id === item.operationId &&
              event.command.action === 'put-planning-item' &&
              event.command.itemId === item.id,
          ),
      )
      .map(item => item.id),
  );
  const input = data.schema < 15 ? { ...data, schema: 15 as const } : data;
  const unified = convertWorkTo18(input, { sameIdentityEdits: edits });
  // Hosted actors are authenticated account IDs; local actor/session labels never grant rights.
  const creators = new Map<string, string>();
  for (const event of data.hostedEvents) {
    if (event.command.action === 'intent') creators.set(event.id, event.actor);
    else if (event.command.action === 'put-planning-item' && event.command.expectedVersion === 0) {
      const itemId = event.command.itemId;
      const id = unified.intentAliases.find(alias => alias.aliasId === itemId)?.intentId ?? itemId;
      if (!creators.has(id) && !data.intents.some(intent => intent.id === id)) creators.set(id, event.actor);
    }
  }
  for (const intent of unified.intents) {
    const actor = creators.get(intent.id);
    if (actor) intent.creatorAccountId = actor;
  }
  const placements = new Map<string, number>();
  for (const intent of unified.intents)
    for (const membership of intent.memberships)
      placements.set(
        membership.initiativeId,
        Math.max(placements.get(membership.initiativeId) ?? 0, membership.order + 1),
      );
  for (const initiative of unified.initiatives)
    initiative.nextMembershipOrder = placements.get(initiative.id) ?? 0;
  return unified as unknown as WorkData;
}
export function validateUnifiedHostedWork(data: WorkData): UnifiedWorkData {
  return unifiedWorkSchema.parse(data);
}
