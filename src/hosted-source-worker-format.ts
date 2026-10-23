// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { jobObject } from './hosted-source-job.js';
import { stateSchema } from './native-state-format.js';

export const workerObjectSchema = z
  .object({
    object: jobObject,
    recipe: jobObject.nullable(),
  })
  .strict();
/** Paged immutable inventory; logical content is never embedded in the job. */
export const workerPageSchema = z
  .object({
    schema: z.literal(1),
    kind: z.literal('forge-source-worker-page'),
    objects: z.array(workerObjectSchema).max(100),
    files: stateSchema.shape.files.max(100),
    next: jobObject.nullable(),
  })
  .strict();
export const workerInputSchema = z
  .object({
    schema: z.literal(1),
    kind: z.literal('forge-source-worker-state'),
    parents: stateSchema.shape.parents,
    message: z.string(),
    at: z.iso.datetime(),
    pages: jobObject,
  })
  .strict();
export type WorkerObject = z.infer<typeof workerObjectSchema>;
export type WorkerPin = z.infer<typeof jobObject>;

export const workerResultSchema = z
  .object({
    schema: z.literal(1),
    kind: z.literal('forge-source-worker-result'),
    input: jobObject,
    state: jobObject,
  })
  .strict();
