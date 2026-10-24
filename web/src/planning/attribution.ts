// SPDX-License-Identifier: Apache-2.0
import type { PlanningItem } from '../../../src/work-planning-types';
export type AttributedPlanningItem = PlanningItem & { actorDisplayName?: string };
/** Account ids and comment labels do not identify the author of a planning write. */
export function planningActor(
  operationId: string,
  events: readonly { id: string; actorDisplayName?: string }[],
) {
  return events.find(event => event.id === operationId)?.actorDisplayName;
}
