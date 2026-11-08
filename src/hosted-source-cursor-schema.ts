// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { jobHash, jobNumber, jobObject } from './hosted-source-job.js';
import { workerObjectSchema, workerInputSchema } from './hosted-source-worker-format.js';
import { stateSchema } from './native-state-format.js';
import { saveChangeSchema, saveInputSchema } from './hosted-save.js';
import { composeEntrySchema, composeInputSchema } from './hosted-compose.js';
import { batchDroppedSchema, HOSTED_BATCH_MEMBERS } from './hosted-landing-batch.js';
import { syncInputSchema } from './hosted-sync.js';
import { sourceCalculationResultSchema, sourceVerifyCursorSchema } from './hosted-source-task-schema.js';
import { sourceValidation } from './hosted-source-validation.js';
import { invariant } from './errors.js';
import type { SourceStepCursor } from './hosted-source-step.js';
const plan = z.discriminatedUnion('kind', [
  saveInputSchema,
  workerInputSchema,
  composeInputSchema,
  syncInputSchema,
]);
export function parseSourcePlan(value: unknown) {
  return sourceValidation('SOURCE_JOB_INVALID', () => plan.parse(value));
}
const cursorSchema = z
  .object({
    input: jobObject,
    plan: z.unknown(),
    phase: z.enum(['input', 'save', 'inventory', 'closure', 'selection', 'graph', 'compute', 'done']),
    next: jobObject.nullable(),
    pages: jobNumber,
    count: jobNumber,
    lastPath: z.string().nullable(),
    files: stateSchema.shape.files,
    changes: z.array(saveChangeSchema),
    inventory: z.record(jobHash, workerObjectSchema),
    queue: z.array(jobHash),
    queueIndex: jobNumber,
    states: z.array(jobHash),
    seen: z.record(jobHash, z.boolean()),
    parents: z.record(jobHash, z.array(jobHash)),
    ancestryBoundary: jobHash.optional(),
    ancestryCuts: z.array(jobHash).optional(),
    generations: z.record(jobHash, z.number().int().positive().max(Number.MAX_SAFE_INTEGER)).optional(),
    generationFallback: z.boolean().optional(),
    ancestryFailures: z
      .record(
        jobHash,
        z.enum([
          'SOURCE_UNAVAILABLE',
          'SOURCE_HASH_MISMATCH',
          'SOURCE_RECIPE_INVALID',
          'SOURCE_PAGE_INVALID',
          'INVALID_WORK_BACKUP',
          'INVALID_NATIVE_SOURCE',
          'SOURCE_WORKER_FAILED',
        ]),
      )
      .optional(),
    resolutionRoots: z.tuple([jobHash, jobHash]).optional(),
    resolveRightProbed: z.boolean().optional(),
    verify: sourceVerifyCursorSchema.nullable(),
    selections: z.array(composeEntrySchema),
    head: jobHash.nullable(),
    index: jobNumber,
    output: jobObject.nullable(),
    changed: z.boolean(),
    calculations: z.record(z.string(), sourceCalculationResultSchema).optional(),
    batchDropped: batchDroppedSchema.optional(),
    batchMerged: z.array(z.uuid()).max(HOSTED_BATCH_MEMBERS).optional(),
    composeBases: z
      .array(
        z.tuple([z.string(), stateSchema.shape.files.element.pick({ blob: true, mode: true }).nullable()]),
      )
      .optional(),
  })
  .strict();
/** Every durable cursor field must parse back: a field missing here fails the next step of any
 * job that set it with SOURCE_JOB_INVALID (Issue 3439ae76: `batchMerged` made every batch compose
 * that spanned two steps fail). Only the reply-only `syncDelta` is never saved. */
type UnparsedCursorField = Exclude<keyof SourceStepCursor, keyof z.infer<typeof cursorSchema> | 'syncDelta'>;
export const cursorFieldsParsed: [UnparsedCursorField] extends [never] ? true : UnparsedCursorField = true;
export function parseSourceCursor(value: unknown): SourceStepCursor {
  const cursor = sourceValidation('SOURCE_JOB_INVALID', () => cursorSchema.parse(value));
  invariant(
    cursor.queueIndex <= cursor.queue.length &&
      (cursor.phase !== 'compute' || cursor.index <= cursor.selections.length),
    'SOURCE_JOB_INVALID',
    'Source cursor is outside its retained input.',
  );
  if (cursor.phase !== 'input') parseSourcePlan(cursor.plan);
  return cursor as SourceStepCursor;
}
