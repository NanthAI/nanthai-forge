import { handoffSchema, handoffReadSchema } from './agent-handoff-types.js';
import { frictionInputSchema, frictionTriageSchema } from './friction-types.js';
import { landSchema } from './land-schema.js';
import { peerAckSchema } from './agent-coordination-journal.js';
// SPDX-License-Identifier: Apache-2.0
import { viewReadSchemas } from './view-reads.js';
import { policyWriteSchema } from './autonomy-policy.js';
import { briefInputSchema } from './agent-brief-types.js';
import { guidanceInputSchema } from './agent-guidance.js';
import { z } from 'zod';
import { peersInputSchema, peersScopeSchema } from './agent-peers.js';
import { afterSchema } from './work-types.js';
import { dependencySchema, invariantPinSchema, defineCheckCommandSchema } from './work-types.js';
import { agentReviewSchema } from './agent-review.js';
import { agentDiffSchema, agentShowSchema } from './agent-source-read.js';
import { cleanSchema } from './agent-clean.js';
import { reportedTokensSchema } from './making-of.js';
const id = z.string().uuid(),
  oid = z.string().regex(/^[0-9a-f]{40,64}$/);
// Omitted pins are resolved by AgentWorkflow before any request identity is hashed.
const operationId = id.optional();
const lockWait = { lockWaitMs: z.number().int().nonnegative().safe().optional() };
const attribution = {
  actor: z.string().min(1).max(200).optional(),
  tool: z.string().min(1).max(120).optional(),
};
const acceptPin = z.object({
  channel: z.string().trim().min(1).default('main'),
  expectedPrevious: oid.nullable().optional(),
  invariant: invariantPinSchema.optional(),
});
export const agentActionSchema = z.discriminatedUnion('action', [
  ...viewReadSchemas,
  frictionInputSchema.extend({ action: z.literal('friction') }),
  frictionTriageSchema.safeExtend({ action: z.literal('friction-triage') }),
  z.object({ action: z.literal('improve') }),
  landSchema,
  handoffSchema,
  handoffReadSchema,
  peerAckSchema,
  peersInputSchema.extend({ action: z.literal('peers') }),
  z.object({
    action: z.literal('take'),
    laneId: id,
    operationId,
    takeover: z.boolean().default(false),
    ...attribution,
  }),
  z.object({
    action: z.literal('link'),
    laneId: id.optional(),
    viewId: id.optional(),
    save: oid.optional(),
    path: z.string().min(1).optional(),
    line: z.number().int().positive().safe().optional(),
  }),
  z.object({ action: z.literal('tests'), laneId: id }),
  z.object({ action: z.literal('policy') }),
  z.object({ action: z.literal('land-ready') }),
  z.object({ action: z.literal('undo-revert'), operationId: id, acceptanceId: id }),
  policyWriteSchema,
  z.object({
    action: z.literal('undo-sync'),
    operationId,
    laneId: id,
    syncOperationId: id,
    force: z.boolean().default(false),
  }),
  briefInputSchema.extend({ action: z.literal('brief') }),
  guidanceInputSchema.extend({ action: z.literal('guidance') }),
  z.object({
    action: z.literal('start'),
    stackOn: id.optional(),
    frictionIds: z.array(id).optional(),
    scope: peersScopeSchema.optional(),
    waitMs: z.number().int().nonnegative().safe().optional(),
    ...lockWait,
    intentId: id.optional(),
    after: afterSchema.optional(),
    ...attribution,
    operationId,
    outcome: z.string().trim().min(1).max(500),
    constraints: z.string().max(4000).default(''),
    name: z.string().trim().min(1).max(120).optional(),
    assignment: z.string().max(200).default(''),
    target: z.string().max(200).default(''),
    channel: z.string().trim().min(1).nullable().optional(),
  }),
  z.object({
    action: z.literal('checkpoint'),
    detail: z.boolean().optional(),
    scope: peersScopeSchema.optional(),
    waitMs: z.number().int().nonnegative().safe().optional(),
    ...lockWait,
    ...attribution,
    operationId,
    laneId: id,
    expectedHead: oid.optional(),
    expectedTree: oid.optional(),
    message: z.string().trim().min(1).max(500),
  }),
  z.object({
    action: z.literal('finish'),
    preview: z.literal('skip').optional(),
    wait: z.boolean().optional(),
    frictionIds: z.array(id).optional(),
    scope: peersScopeSchema.optional(),
    priority: z.enum(['urgent', 'normal']).optional(),
    ...lockWait,
    with: z.array(id).optional(),
    withInputs: z.array(z.object({ laneId: id, head: oid })).optional(),
    after: afterSchema.optional(),
    ...attribution,
    operationId,
    laneId: id,
    expectedHead: oid.optional(),
    expectedTree: oid.optional(),
    message: z.string().trim().min(1).max(500),
    dependencies: z.array(dependencySchema).default([]),
    checkId: id.optional(),
    expectedDefinition: oid.optional(),
    expectedEnvironment: oid.optional(),
    accept: z.union([z.literal(true), acceptPin]).optional(),
    /** Retries after a Channel move; the initial attempt does not count. */
    maxRetries: z.number().int().nonnegative().safe().optional(),
    /** Optional bounded observation; replay this operation to resume finish. */
    waitMs: z.number().int().min(0).max(60000).optional(),
    /** Keep the input Lanes and Intent open after acceptance. */
    keepOpen: z.boolean().optional(),
  }),
  z.object({
    action: z.literal('sync'),
    ontoMain: z.boolean().optional(),
    detail: z.boolean().optional(),
    scope: peersScopeSchema.optional(),
    waitMs: z.number().int().nonnegative().safe().optional(),
    ...lockWait,
    ...attribution,
    operationId,
    laneId: id,
    expectedHead: oid.optional(),
    channel: z.string().trim().min(1).default('main'),
  }),
  z.object({
    action: z.literal('compose'),
    ...lockWait,
    operationId: id,
    intentId: id,
    inputs: z.array(z.object({ laneId: id, head: oid })).max(8),
    dependencies: z.array(dependencySchema).optional(),
  }),
  defineCheckCommandSchema,
  z.object({
    action: z.literal('run'),
    ...lockWait,
    operationId,
    /** Either viewId, or laneId (that Lane's latest clean View). */
    viewId: id.optional(),
    laneId: id.optional(),
    expectedHead: oid.optional(),
    checkId: id.optional(),
    expectedDefinition: oid.optional(),
    expectedEnvironment: oid.optional(),
    wait: z.boolean().default(true),
  }),
  z.object({
    action: z.literal('observe'),
    operationId: id,
    waitMs: z.number().int().min(0).max(60000).default(0),
  }),
  z.object({
    action: z.literal('log'),
    shard: z.union([z.number().int().nonnegative(), z.literal('static')]).optional(),
    attempt: z.number().int().positive().optional(),
    operationId: id,
    stream: z.enum(['stdout', 'stderr']).default('stdout'),
    offset: z.number().int().nonnegative().default(0),
    bytes: z.number().int().min(1).max(65536).default(4096),
    /** Read the last `tail` bytes of the stream instead of a page. */
    tail: z.number().int().min(1).max(65536).optional(),
  }),
  z.object({ action: z.literal('cancel'), operationId: id, ...attribution, reason: z.string().optional() }),
  z.object({
    action: z.literal('accept'),
    ...lockWait,
    ...attribution,
    operationId,
    viewId: id,
    expectedHead: oid.optional(),
    channel: z.string().trim().min(1).default('main'),
    expectedPrevious: oid.nullable().optional(),
    invariant: invariantPinSchema.optional(),
    keepOpen: z.boolean().optional(),
  }),
  z.object({
    action: z.literal('abandon'),
    operationId,
    laneId: id.optional(),
    intentId: id.optional(),
    reason: z.string().trim().min(1),
    expectedHead: oid.optional(),
    saveFirst: z.boolean().default(false),
    cascade: z.boolean().default(false),
    ...attribution,
  }),
  z.object({
    action: z.literal('complete'),
    ...attribution,
    laneId: id.optional(),
    intentId: id.optional(),
  }),
  z.object({
    action: z.literal('reopen'),
    ...attribution,
    laneId: id.optional(),
    intentId: id.optional(),
  }),
  z.object({ action: z.literal('complete-merged'), channel: z.string().trim().min(1).default('main') }),
  z.object({
    action: z.literal('status'),
    laneId: id.optional(),
    detail: z.boolean().optional(),
    intentId: id.optional(),
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(100).default(5),
  }),
  z.object({ action: z.literal('making-of'), intentId: id }),
  z
    .object({
      action: z.literal('report'),
      operationId,
      laneId: id,
      actor: attribution.actor,
      sessionId: z.string().min(1).max(200).optional(),
      harness: z.string().min(1).max(120).optional(),
      model: z.string().min(1).max(200).optional(),
      tokens: reportedTokensSchema.optional(),
    })
    .refine(report => report.harness || report.model || report.tokens, 'Report harness, model or tokens.'),
  z.object({
    action: z.literal('records'),
    collection: z.string().min(1),
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().positive().default(50),
    /** Lane `state` or Intent/View/Run `status` equals this value. */
    state: z.string().min(1).optional(),
    status: z.string().min(1).optional(),
    /** Lanes only: whether the head is already contained in an accepted Channel head. */
    merged: z.boolean().optional(),
  }),
  agentReviewSchema.extend({ action: z.literal('review') }),
  agentDiffSchema.safeExtend({ action: z.literal('diff') }),
  agentShowSchema.safeExtend({ action: z.literal('show') }),
  cleanSchema,
]);
export type AgentAction = z.infer<typeof agentActionSchema>;
type Action<K extends AgentAction['action']> = Extract<AgentAction, { action: K }>;
/** Commands after optional pins are resolved; strict requests pass through unchanged. */
export type StartAction = Action<'start'> & { operationId: string };
export type CheckpointAction = Action<'checkpoint'> & { operationId: string; expectedHead: string };
export type SyncAction = Action<'sync'> & { operationId: string; expectedHead: string };
export type RunAction = Action<'run'> & {
  viewId: string;
  operationId: string;
  expectedHead: string;
  checkId: string;
};
export type FinishAction = Omit<Action<'finish'>, 'accept'> & {
  operationId: string;
  expectedHead: string;
  checkId: string;
  expectedDefinition: string;
  accept?: {
    channel: string;
    expectedPrevious: string | null;
    invariant?: z.infer<typeof invariantPinSchema>;
  };
};
