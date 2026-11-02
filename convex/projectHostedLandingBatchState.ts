// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { batchFailureSchema, batchMemberDetailSchema } from '../src/hosted-batch-diagnosis';
import { hostedLandingAttemptSchema } from '../src/hosted-landing';
import { HOSTED_BATCH_MEMBERS } from '../src/hosted-landing-batch';
import { invariant } from '../src/errors';

export type BatchIdentity = { projectId: Id<'hostedProjects'>; batchId: string };
export const batchSchema = z
  .object({
    id: z.uuid(),
    leaderId: z.uuid().optional(),
    at: z.iso.datetime(),
    composeOperationId: z.uuid(),
    checkOperationId: z.uuid(),
    /** `split`: retired into parallel halves; `failed`: platform retries exhausted. */
    phase: z.enum(['composing', 'checking', 'fallback', 'landed', 'superseded', 'split', 'failed']),
    /** A half of this earlier cohort, after its shared check failed. */
    parentId: z.uuid().optional(),
    /** Every member passed its own admission check. */
    admitted: z.boolean().optional(),
    predecessor: z.object({ submissionId: z.uuid(), head: z.string(), receiptId: z.uuid() }).optional(),
    platformRetries: z.number().int().nonnegative().optional(),
    members: z.array(hostedLandingAttemptSchema).min(1).max(HOSTED_BATCH_MEMBERS),
    memberDetails: z.array(batchMemberDetailSchema).max(HOSTED_BATCH_MEMBERS).optional(),
    failure: batchFailureSchema.optional(),
    transition: z.object({ code: z.string(), message: z.string() }).strict().optional(),
    uploadIndex: z.number().int().nonnegative(),
    uploads: z
      .array(z.object({ pin: z.object({ sha256: z.string(), size: z.number() }), value: z.string() }))
      .max(3)
      .optional(),
    runId: z.uuid().optional(),
    included: z.array(z.uuid()).max(HOSTED_BATCH_MEMBERS).optional(),
  })
  .strict();
export type LandingBatch = z.infer<typeof batchSchema>;
export const batchRow = (ctx: QueryCtx | MutationCtx, input: BatchIdentity) =>
  ctx.db
    .query('projectHostedLandingBatches')
    .withIndex('by_project_and_batch', q => q.eq('projectId', input.projectId).eq('batchId', input.batchId))
    .unique();
export async function loadBatch(ctx: QueryCtx | MutationCtx, input: BatchIdentity) {
  const row = await batchRow(ctx, input);
  invariant(row, 'SOURCE_UNAVAILABLE', 'The retained landing batch is unavailable.');
  return { row, batch: batchSchema.parse(JSON.parse(row.value)) };
}
