// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { authorshipFields, personStampValid } from './work-actor-types.js';
import { mainExpectationSchema } from './hosted-main.js';
import { sourceAuthoritySchema } from './hosted-source-authority.js';
import { hostedRecordSchema } from './hosted-records.js';
import { intentCreateSchema } from './work-intent-types.js';
import { isAgentSlug } from './agent-slug.js';

/** Display provenance is a client claim, never an access grant. */
export const sessionClaimSchema = z
  .object({
    app: z.string().min(1).max(80).optional(),
    identityFrom: z.enum(['app-thread', 'declared', 'process']).optional(),
  })
  .strict();
/** Device details are supplied by the authenticated credential, never a client claim. */
export const sessionMetadataSchema = sessionClaimSchema
  .extend({
    sessionId: z.string().regex(/^[0-9a-f]{64}$/),
    startedAt: z.number().nonnegative(),
    device: z
      .object({
        id: z.string(),
        code: z.string(),
        approvedAt: z.number(),
        owner: z.string(),
        name: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const hostedIntentInputSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('new'),
      outcome: intentCreateSchema.shape.outcome,
      constraints: intentCreateSchema.shape.constraints,
    })
    .strict(),
  z.object({ kind: z.literal('existing'), intentId: z.uuid() }).strict(),
  /** A planned Issue: the Intent shares the Issue's id, and a repeated start adds a Lane to it. */
  z
    .object({
      kind: z.literal('planned'),
      intentId: z.uuid(),
      outcome: intentCreateSchema.shape.outcome,
      constraints: intentCreateSchema.shape.constraints,
    })
    .strict(),
]);
export const hostedStartSchema = z
  .object({
    authorship: authorshipFields.authorship,
    agentClient: authorshipFields.agentClient,
    noticeVersion: z.literal(1).optional(),
    /** The client reads openLanes in the reply (capability openLanesVersion); never part of the payload hash. */
    openLanesVersion: z.literal(1).optional(),
    /** The calling agent session's slug (feature agent-slug, c29d0780); never part of the payload hash. */
    agent: z.string().refine(isAgentSlug, 'agent must be a Forge agent slug').optional(),
    session: sessionClaimSchema.optional(),
    holderSessionId: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    operationId: z.uuid(),
    authorityEpoch: sourceAuthoritySchema.shape.epoch,
    expectedMain: mainExpectationSchema,
    initialHead: mainExpectationSchema.shape.head.optional(),
    stackOn: z.uuid().optional(),
    stackEntry: z.uuid().optional(),
    intent: hostedIntentInputSchema,
  })
  .strict()
  .refine(
    value => personStampValid(value) && (value.authorship?.kind !== 'person' || value.agent === undefined),
    'A person stamp has no model or run.',
  );
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
    holder: hostedLaneSchema.shape.holder,
    ...authorshipFields,
    stack: hostedLaneSchema.shape.stack,
    earlyResolution: hostedLaneSchema.shape.earlyResolution,
    base: mainExpectationSchema,
    authority: sourceAuthoritySchema,
  })
  .strict()
  .refine(personStampValid, 'A person stamp has no model or run.');
export type HostedLaneSelection = z.infer<typeof hostedLaneSelectionSchema>;

export const hostedStartResultSchema = z
  .object({
    fixBrief: z.string().optional(),
    needsFix: z.array(z.record(z.string(), z.json())).optional(),
    schema: z.literal(1),
    operationId: z.uuid(),
    intentId: z.uuid(),
    lane: hostedLaneSelectionSchema.nullable(),
    at: z.iso.datetime(),
    /** Other open Lanes on the same Intent when this start ran, newest first (bounded). */
    openLanes: z
      .array(
        z
          .object({
            laneId: z.uuid(),
            /** Public handle, or null when the account has none. Never an account id or name. */
            owner: z.string().nullable(),
            yours: z.boolean(),
            lastActivityAt: z.iso.datetime(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();
