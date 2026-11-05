// SPDX-License-Identifier: Apache-2.0
import type { PlanningItem } from '../../../src/work-planning-types';
/** `actorDisplayName` is the author's Forge handle: hosted reads name people only by handle. */
export type AttributedPlanningItem = PlanningItem & { actorDisplayName?: string };
/** Comment labels do not identify the author of a planning write; the event's actor handle does. */
export function planningActor(operationId: string, events: readonly { id: string; actor?: unknown }[]) {
  const actor = events.find(event => event.id === operationId)?.actor;
  return typeof actor === 'string' && actor ? actor : undefined;
}
