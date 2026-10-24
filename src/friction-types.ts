// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
const id = z.uuid();
const text = z.string().trim().min(1);
export const frictionInputSchema = z.object({
  operationId: id.optional(),
  laneId: id.optional(),
  title: text,
  detail: text,
  area: text,
  cost: z
    .object({
      minutes: z.number().nonnegative().finite().optional(),
      retries: z.number().int().nonnegative().safe().optional(),
    })
    .optional(),
  workaround: z.string().optional(),
  evidence: z.array(z.string()).optional(),
});
export const frictionTriageSchema = z
  .object({
    operationId: id.optional(),
    frictionIds: z.array(id).min(1),
    status: z.enum(['fixed', 'planned', 'dropped', 'open']),
    reason: text.optional(),
    laneId: id.optional(),
  })
  .superRefine((command, context) => {
    if (command.status === 'dropped' && !command.reason)
      context.addIssue({
        code: 'custom',
        path: ['reason'],
        message: 'Give the reason for dropping this friction.',
      });
  });
export const frictionEventSchema = z.discriminatedUnion('kind', [
  z.object({
    id,
    kind: z.literal('count'),
    operationId: id,
    request: z.string(),
    at: z.string(),
    frictionId: id,
    count: z.number().int().positive().safe(),
    retries: z.number().int().nonnegative().safe(),
  }),
  frictionInputSchema.extend({
    id,
    kind: z.literal('capture'),
    operationId: id,
    request: z.string(),
    at: z.string(),
    count: z.number().int().positive().safe(),
    automatic: z.boolean().optional(),
  }),
  frictionTriageSchema.safeExtend({
    id,
    kind: z.literal('triage'),
    operationId: id,
    request: z.string(),
    at: z.string(),
  }),
  z.object({
    id,
    kind: z.literal('cite'),
    operationId: id,
    request: z.string(),
    at: z.string(),
    laneId: id,
    frictionIds: z.array(id),
  }),
]);
export type FrictionEvent = z.infer<typeof frictionEventSchema>;
export type FrictionCapture = Extract<FrictionEvent, { kind: 'capture' }>;
