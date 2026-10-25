// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { landingRuntimeSchema } from './landing-environment-schema.js';
import { checkEnvironmentSchema } from './check-environment-schema.js';
const id = z.uuid(),
  head = z.string().regex(/^[a-f0-9]{64}$/);
export const landingEntrySchema = z.object({
  id,
  request: head,
  channel: z.string(),
  viewId: id,
  head,
  checkId: id,
  definition: head,
  environment: head,
  environmentSnapshot: checkEnvironmentSchema.optional(),
  runtimeSnapshot: landingRuntimeSchema.optional(),
  reason: z.string().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
  infrastructureRetries: z.array(z.object({ at: z.string(), code: z.string(), runId: id })).optional(),
  runtimeRepins: z
    .array(
      z.object({
        at: z.string(),
        fields: z.array(z.string()),
        previousEnvironment: head,
        environment: head,
        previousRuntime: landingRuntimeSchema,
        runtime: landingRuntimeSchema,
      }),
    )
    .optional(),
  preview: z.literal('skip').optional(),
  previewDiagnostic: z
    .object({
      main: z.string().optional(),
      key: z.string().optional(),
      errors: z.array(z.string()),
      laneId: id,
      head,
    })
    .optional(),
  arrivedAt: z.string(),
  firstSelectedAt: z.string().optional(),
  terminalAt: z.string().optional(),
  priority: z.enum(['urgent', 'normal']).default('normal'),
  submitter: z.string(),
  keepOpen: z.boolean(),
  status: z.enum([
    'queued',
    'checking',
    'accepted',
    'conflict',
    'failed',
    'cancelled',
    'interrupted',
    'awaiting-review',
  ]),
  batchId: id.optional(),
  runId: id.optional(),
  conflictViewId: id.optional(),
  acceptanceId: id.optional(),
  /** Accepted main head that already contained this entry; no acceptance was recorded. */
  alreadyOnMain: head.optional(),
});
export const batchPrefixSchema = z.object({
  entryIds: z.array(id).min(1),
  viewId: id,
  head,
  runId: id,
});
/** A diagnostic attempt is one exact prefix check, never a proof of minimal blame. */
export const landingDiagnosisNodeSchema = batchPrefixSchema.extend({
  id,
  inputs: z.array(z.object({ laneId: id, head: z.string().regex(/^[a-f0-9]{40,64}$/) })),
  parentId: id.optional(),
  base: head,
  previous: head.nullable(),
  checkId: id,
  definition: head,
  environment: head,
  status: z.enum([
    'reserved',
    'queued',
    'preparing',
    'running',
    'passed',
    'failed',
    'cancelled',
    'interrupted',
    'runner-unavailable',
    'runner-budget-exhausted',
  ]),
  cause: z.enum(['check-failed', 'pending-infra', 'infra', 'unknown-outcome', 'cancelled']).optional(),
  /** The original run owns exact inputs, dependencies, plan, logs and physical executions. */
  selection: z.object({
    runId: id,
    known: z.boolean(),
    scope: z.enum(['docs', 'interaction', 'scoped', 'full', 'partial']).optional(),
    tests: z.array(z.string()).optional(),
    plan: z.string().optional(),
  }),
});
export const landingBatchSchema = z.object({
  id,
  channel: z.string(),
  environment: checkEnvironmentSchema.optional(),
  base: head,
  previous: head.nullable(),
  arrivedAt: z.string(),
  entryIds: z.array(id).min(1).max(8),
  /** Speculative stack: this batch's base is the projected head of the parent batch. */
  parentId: id.optional(),
  mode: z.enum(['parallel', 'halving']),
  status: z.enum(['composing', 'checking', 'completed', 'superseded']),
  prefixes: z.array(batchPrefixSchema),
  conflicts: z.array(z.object({ entryId: id, viewId: id })),
  acceptanceId: id.optional(),
  /** Legacy boundary entry, not a minimal-culprit claim. */
  culpritId: id.optional(),
  diagnosis: z
    .object({
      version: z.literal(1),
      strategy: z.literal('prefix'),
      minimization: z.literal('incomplete'),
      nodes: z.array(landingDiagnosisNodeSchema),
    })
    .optional(),
  /** Optional restart cursor; canonical Candidates/runs/Channel receipts remain authoritative. */
  settlement: z
    .object({
      cancelledAt: z.number().int().min(-1),
      passingViewId: id.optional(),
      culpritViewId: id.optional(),
      failingViewId: id.optional(),
      stopped: z
        .enum(['failed', 'cancelled', 'interrupted', 'runner-unavailable', 'runner-budget-exhausted'])
        .optional(),
    })
    .optional(),
});
export type LandingEntry = z.infer<typeof landingEntrySchema>;
export type LandingBatch = z.infer<typeof landingBatchSchema>;
export type BatchPrefix = z.infer<typeof batchPrefixSchema>;
