// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { mainExpectationSchema } from './hosted-main.js';
import { sourceAuthoritySchema } from './hosted-source-authority.js';
import { hostedRecordSchema } from './hosted-records.js';
import { intentCreateSchema } from './work-intent-types.js';

export const hostedIntentInputSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('new'),
      outcome: intentCreateSchema.shape.outcome,
      constraints: intentCreateSchema.shape.constraints,
    })
    .strict(),
  z.object({ kind: z.literal('existing'), intentId: z.uuid() }).strict(),
]);
export const hostedStartSchema = z
  .object({
    operationId: z.uuid(),
    authorityEpoch: sourceAuthoritySchema.shape.epoch,
    expectedMain: mainExpectationSchema,
    initialHead: mainExpectationSchema.shape.head.optional(),
    stackOn: z.uuid().optional(),
    stackEntry: z.uuid().optional(),
    intent: hostedIntentInputSchema,
  })
  .strict();
export const hostedIntentSchema = hostedRecordSchema.options[0];
export const hostedLaneSchema = hostedRecordSchema.options[1];
/** A source pin is independent of uploaded backups and display generations. */
export const hostedLaneSelectionSchema = z
  .object({
    schema: z.literal(2),
    projectId: z.string().min(1),
    laneId: z.uuid(),
    intentId: z.uuid(),
    head: hostedLaneSchema.shape.head,
    version: hostedLaneSchema.shape.version,
    sourceVersion: hostedLaneSchema.shape.sourceVersion,
    lifecycleVersion: hostedLaneSchema.shape.lifecycleVersion,
    state: hostedLaneSchema.shape.state,
    stack: hostedLaneSchema.shape.stack,
    base: mainExpectationSchema,
    authority: sourceAuthoritySchema,
  })
  .strict();
export type HostedStart = z.infer<typeof hostedStartSchema>;
export type HostedLaneSelection = z.infer<typeof hostedLaneSelectionSchema>;

export const hostedStartResultSchema = z
  .object({
    schema: z.literal(1),
    operationId: z.uuid(),
    intentId: z.uuid(),
    lane: hostedLaneSelectionSchema.nullable(),
    at: z.iso.datetime(),
  })
  .strict();
export type HostedStartResult = z.infer<typeof hostedStartResultSchema>;
