// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { z } from 'zod';
import { authorshipFields, personStampValid } from './work-actor-types.js';
import { mainExpectationSchema } from './hosted-main.js';
import { sourceAuthoritySchema } from './hosted-source-authority.js';
import { hostedRecordSchema } from './hosted-records.js';
import { intentCreateSchema } from './work-intent-types.js';
import { isAgentSlug } from './agent-slug.js';
import { safeRelative } from './safe-relative.js';

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

/** Local Forge hook state, reported by the client as display metadata. */
export const agentHooksSchema = z.enum(['configured', 'off', 'unavailable']);
export type AgentHooks = z.infer<typeof agentHooksSchema>;

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
    planningItemIdVersion: z.literal(1).optional(),
    /** The client reads openLanes in the reply (capability openLanesVersion); 2 adds each Lane's `resolves`
     * (feature start-open-lanes-resolves) and 3 returns a title for an Intent-id-only start. Never hashed. */
    openLanesVersion: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
    /** The learned guard-set revision the client caches (feature preflight-guard-set, 13ea93bf); the
     * reply carries `guardSet` only when the server's differs. Never part of the payload hash. */
    guardRevision: z.string().max(16).optional(),
    /** The calling agent session's slug (feature agent-slug, c29d0780); never part of the payload hash. */
    agent: z.string().refine(isAgentSlug, 'agent must be a Forge agent slug').optional(),
    hooks: agentHooksSchema.optional(),
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
/** A holder change's reason is stored in the protected Lane record and shown to members; capped (SI-04). */
export const HOLDER_REASON_MAX = 280;
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

type OpenLane = { laneId: string; resolves?: string | undefined };
/** The start hint for replaced Lanes (Item d9e1ac62): an open resolution Lane listed beside the open Lane it resolves.
 * Advice only: nothing is abandoned, and it is built from the reply's own list (no read). */
export function replacedOpenLanes(openLanes: readonly OpenLane[] | undefined) {
  const open = new Set((openLanes ?? []).map(lane => lane.laneId));
  return (openLanes ?? []).flatMap(lane =>
    lane.resolves && lane.resolves !== lane.laneId && open.has(lane.resolves)
      ? [
          {
            laneId: lane.resolves,
            replacedBy: lane.laneId,
            note: `Lane ${lane.resolves} continues in its resolution Lane ${lane.laneId}. Once its work is confirmed there, abandon it.`,
            next: `nforge agent ROOT abandon ${JSON.stringify({ laneId: lane.resolves, reason: `Replaced by Lane ${lane.laneId}` })}`,
          },
        ]
      : [],
  );
}

/** A test file a learned preflight guard set may name (Item 13ea93bf). */
export const guardFileName = z
  .string()
  .max(300)
  .regex(/^[\w.@+\-/]+$/)
  .refine(safeRelative);
/** What a Lane start reply may carry when the caller sent another guardRevision: the window's p, C,
 * r inputs and the files that could join. The CLI picks the set with its own seconds and budget. */
export const guardCandidatesSchema = z
  .object({
    rev: z.string().max(16),
    outcomes: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    /** Median builder seconds a failed landing in the window cost (submit to verdict). */
    C: z.number().nonnegative(),
    /** Local preflight runs per landing, from the failed Lanes that reported them (at least 1). */
    r: z.number().min(1),
    runnerMinutes: z.number().nonnegative().nullable(),
    files: z
      .array(
        z
          .object({
            file: guardFileName,
            failures: z.number().int().positive(),
            /** Median seconds the check spent on the file, when it reported one. */
            checkSeconds: z.number().nonnegative().nullable(),
          })
          .strict(),
      )
      .max(20),
  })
  .strict();
export type GuardCandidates = z.infer<typeof guardCandidatesSchema>;
export const hostedStartResultSchema = z
  .object({
    fixBrief: z.string().optional(),
    needsFix: z.array(z.record(z.string(), z.json())).optional(),
    schema: z.literal(1),
    operationId: z.uuid(),
    intentId: z.uuid(),
    planningItemId: z.uuid().optional(),
    lane: hostedLaneSelectionSchema.nullable(),
    at: z.iso.datetime(),
    /** Reply-only placement hint for starts that already read the existing Intent by id. */
    laneTitle: intentCreateSchema.shape.outcome.optional(),
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
            /** A resolution Lane: the conflicted Lane it continues (openLanesVersion 2 only). */
            resolves: z.uuid().optional(),
          })
          .strict(),
      )
      .optional(),
    /** The learned preflight guard-set candidates, when the caller sent another guardRevision. */
    // A hint: a malformed one is dropped, never fails the start.
    guardSet: guardCandidatesSchema.optional().catch(undefined),
  })
  .strict();
