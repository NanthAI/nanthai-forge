// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
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
  reason: z.string().optional(),
  arrivedAt: z.string(),
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
});
export const batchPrefixSchema = z.object({
  entryIds: z.array(id).min(1),
  viewId: id,
  head,
  runId: id,
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
  culpritId: id.optional(),
});
export type LandingEntry = z.infer<typeof landingEntrySchema>;
export type LandingBatch = z.infer<typeof landingBatchSchema>;
export type BatchPrefix = z.infer<typeof batchPrefixSchema>;
