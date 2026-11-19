// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { decideInputSchema, decisionsInputSchema, decisionRecordSchema } from './decision-types.js';
import {
  frictionRef,
  frictionInputSchema,
  frictionEventSchema,
  frictionListSchema,
  hostedFrictionTriageSchema,
} from './friction-types.js';
export const hostedRecordCommands = {
  friction: frictionInputSchema.omit({ operationId: true }).strict(),
  'friction-list': frictionListSchema,
  // The Issue a planned record points at: a full id or a unique 8+ hex prefix, resolved by the CLI.
  // frictionRef is the same id-or-prefix rule as planning ids, from a module this file already loads.
  'friction-triage': hostedFrictionTriageSchema.extend({
    planningItemId: frictionRef.describe('Issue a planned record points at.').optional(),
    id: frictionRef.describe('Alias for planningItemId (Issue).').optional(),
    itemId: frictionRef.describe('Alias for planningItemId (Issue).').optional(),
  }),
  decide: decideInputSchema.omit({ operationId: true }).strict(),
  decisions: decisionsInputSchema.extend({ cursor: z.string().nullable().default(null) }).strict(),
};
export const hostedImportPageSchema = z
  .object({
    friction: z.array(frictionEventSchema).max(100).default([]),
    decisions: z.array(decisionRecordSchema).max(100).default([]),
  })
  .refine(page => page.friction.length + page.decisions.length <= 100);
