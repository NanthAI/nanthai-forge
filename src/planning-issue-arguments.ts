// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { invariant } from './errors.js';
import { isPlanningRef, planningIdHelp } from './planning-id.js';

const ref = z.string().refine(isPlanningRef, `planningItemId: expected ${planningIdHelp}`);
/** Public Issue key, with the legacy spellings retained in help and MCP input schemas. */
export const planningIssueFields = {
  planningItemId: ref.describe('Issue key (canonical).').optional(),
  id: ref.describe('Alias for planningItemId.').optional(),
  itemId: ref.describe('Alias for planningItemId.').optional(),
};

/** Normalize before validation/journaling, preserving the released wire/journal keys. No I/O.
 * intentId always selects execution work and is never treated as an Issue alias. */
export function planningIssueArguments(action: string, input: Record<string, unknown>) {
  const target =
    action === 'planning'
      ? 'id'
      : ['put-planning-item', 'comment-planning-item'].includes(action)
        ? 'itemId'
        : ['start', 'lanes', 'friction-triage'].includes(action)
          ? 'planningItemId'
          : undefined;
  if (!target) return input;
  const keys = ['planningItemId', 'id', 'itemId'];
  const present = keys.filter(key => input[key] !== undefined);
  if (!present.length) return input;
  invariant(
    present.every(key => input[key] === input[present[0]!]),
    'BAD_ARGUMENT',
    `${action}: conflicting Issue keys. Use planningItemId with one Issue id; id and itemId are aliases. Use intentId for an execution Intent.`,
  );
  return {
    ...Object.fromEntries(Object.entries(input).filter(([key]) => !keys.includes(key))),
    [target]: input[present[0]!],
  };
}
