// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { isPlanningRef, planningIdHelp } from './planning-id.js';
const id = z.uuid();
/** A friction id as a caller types it: a complete UUID or a hex prefix of at least 8 characters,
 * resolved server-side by one indexed range read (same shape rule as planning ids). */
export const frictionRef = z
  .string()
  .refine(isPlanningRef, { message: `expected ${planningIdHelp}` })
  .transform(value => value.toLowerCase());
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
const triageObject = z.object({
  operationId: id.optional(),
  frictionIds: z.array(id).min(1),
  status: z.enum(['fixed', 'planned', 'dropped', 'open']),
  reason: text.optional(),
  laneId: id.optional(),
  /** The Issue a `planned` record points at (hosted triage: link to an Issue). */
  planningItemId: id.optional(),
});
export const frictionTriageSchema = triageObject.superRefine((command, context) => {
  if (command.status === 'dropped' && !command.reason)
    context.addIssue({
      code: 'custom',
      path: ['reason'],
      message: 'Give the reason for dropping this friction.',
    });
});
/** Hosted triage: a plain strict object (MCP extends it), at most 50 ids per call so the
 * mutation patches a bounded number of rows. `frictionTriageProblem` holds the cross-field rules. */
export const hostedFrictionTriageSchema = triageObject
  .omit({ operationId: true })
  .extend({ frictionIds: z.array(frictionRef).min(1).max(50) })
  .strict();
export function frictionTriageProblem(command: z.infer<typeof hostedFrictionTriageSchema>) {
  if (command.status === 'dropped' && !command.reason) return 'reason: give the reason for dismissing.';
  if (command.status === 'fixed' && !command.laneId) return 'laneId: name the Lane that fixed this friction.';
  if (command.status === 'planned' && !command.planningItemId && !command.reason)
    return 'planningItemId or reason: say where the planned fix lives.';
  return undefined;
}
export const frictionListStatuses = ['open', 'planned', 'fixed', 'dropped', 'all'] as const;
/** One bounded page of captured friction, newest first, with its current triage status. */
export const frictionListSchema = z
  .object({
    /** One friction by id or id prefix (8+ hex characters): one indexed read, no page scan. */
    id: frictionRef.optional(),
    status: z.enum(frictionListStatuses).default('open'),
    area: text.optional(),
    laneId: id.optional(),
    search: text.optional(),
    limit: z.number().int().min(1).max(100).default(50),
    cursor: z.string().nullable().default(null),
  })
  .strict();
export const frictionTriageState = z.object({
  status: z.enum(['fixed', 'planned', 'dropped', 'open']),
  reason: z.string().optional(),
  laneId: id.optional(),
  planningItemId: id.optional(),
  at: z.string(),
  by: z.string(),
});
export type FrictionTriageState = z.infer<typeof frictionTriageState>;
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
