// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { decideInputSchema, decisionsInputSchema, decisionRecordSchema } from './decision-types.js';
import {
  frictionInputSchema,
  frictionEventSchema,
  frictionListSchema,
  hostedFrictionTriageSchema,
} from './friction-types.js';
export const hostedRecordCommands = {
  friction: frictionInputSchema.omit({ operationId: true }).strict(),
  'friction-list': frictionListSchema,
  'friction-triage': hostedFrictionTriageSchema,
  decide: decideInputSchema.omit({ operationId: true }).strict(),
  decisions: decisionsInputSchema.extend({ cursor: z.string().nullable().default(null) }).strict(),
};
export const hostedImportPageSchema = z
  .object({
    friction: z.array(frictionEventSchema).max(100).default([]),
    decisions: z.array(decisionRecordSchema).max(100).default([]),
  })
  .refine(page => page.friction.length + page.decisions.length <= 100);
