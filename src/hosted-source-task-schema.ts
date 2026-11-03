// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { jobHash, jobNumber } from './hosted-source-job.js';
import { workerObjectSchema } from './hosted-source-worker-format.js';
import { stateSchema } from './native-state-format.js';
import { treeRefSchema } from './byte-tree-format.js';
import { sourceValidation } from './hosted-source-validation.js';
import { invariant } from './errors.js';
import type { SourceTaskInput, SourceTaskProgress } from './hosted-source-fanout.js';
const file = stateSchema.shape.files.element;
const conflict = z
  .object({
    path: z.string(),
    reason: z.string().optional(),
    base: file.optional(),
    left: file.optional(),
    right: file.optional(),
  })
  .strict();
const calculation = z
  .object({
    key: z.string(),
    kind: z.enum(['merge', 'conflict', 'markers']),
    item: conflict,
    order: z.enum(['left-first', 'right-first']),
    channel: z.string(),
  })
  .strict();
export const sourceCalculationResultSchema = z
  .object({
    key: z.string(),
    blob: jobHash.nullable(),
    kind: z.enum(['text', 'binary']),
    resolutions: z.array(
      z.object({ path: z.string(), baseLine: jobNumber, resolved: z.literal('both-insertions') }).strict(),
    ),
    markers: z.boolean().optional(),
    reason: z.string().optional(),
  })
  .strict();
const hash = z
  .object({
    words: z.array(z.number().int().min(-2147483648).max(4294967295)).length(8),
    buffer: z.array(z.number().int().min(0).max(255)).length(64),
    length: jobNumber,
    pos: jobNumber.max(63),
  })
  .strict()
  .refine(v => v.length % 64 === v.pos);
export const sourceVerifyCursorSchema = z
  .object({
    ref: workerObjectSchema,
    pending: z.array(treeRefSchema),
    hash,
    length: jobNumber,
  })
  .strict()
  .refine(v => v.length === v.hash.length && v.length <= v.ref.object.size);
const refs = z.array(workerObjectSchema);
const inputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('verify'), refs }).strict(),
  z.object({ kind: z.literal('states'), refs, files: z.boolean() }).strict(),
  z.object({ kind: z.literal('markers'), refs: refs.length(1), request: calculation }).strict(),
  z.object({ kind: z.literal('calculate'), refs, requests: z.array(calculation) }).strict(),
]);
const progressSchema = z
  .object({
    index: jobNumber,
    verify: sourceVerifyCursorSchema.nullable(),
    states: z.array(
      z
        .object({
          id: jobHash,
          generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
          parents: z.array(jobHash),
          files: z.array(jobHash),
          error: z
            .enum([
              'SOURCE_UNAVAILABLE',
              'SOURCE_HASH_MISMATCH',
              'SOURCE_RECIPE_INVALID',
              'SOURCE_PAGE_INVALID',
              'INVALID_WORK_BACKUP',
              'INVALID_NATIVE_SOURCE',
              'SOURCE_WORKER_FAILED',
            ])
            .nullable(),
        })
        .strict(),
    ),
    calculations: z.array(sourceCalculationResultSchema).optional(),
    scan: z
      .object({ prefix: z.string().max(8), skip: z.boolean(), found: z.boolean() })
      .strict()
      .optional(),
  })
  .strict();
export function parseSourceTaskInput(value: unknown): SourceTaskInput {
  const input = sourceValidation('SOURCE_JOB_INVALID', () => inputSchema.parse(value));
  const available = new Set(input.refs.map(ref => ref.object.sha256));
  const requests =
    input.kind === 'markers' ? [input.request] : input.kind === 'calculate' ? input.requests : [];
  invariant(
    requests.every(request =>
      [request.item.base, request.item.left, request.item.right].every(
        file => !file || available.has(file.blob),
      ),
    ) &&
      (input.kind !== 'markers' || (input.request.kind === 'markers' && !!input.request.item.left)),
    'SOURCE_JOB_INVALID',
    'Source calculation descriptors are incomplete.',
  );
  return input as SourceTaskInput;
}
export function parseSourceTaskProgress(value: unknown): SourceTaskProgress {
  return sourceValidation('SOURCE_JOB_INVALID', () => progressSchema.parse(value)) as SourceTaskProgress;
}
export function validateSourceTaskProgress(input: SourceTaskInput, progress: SourceTaskProgress) {
  const end =
    input.kind === 'calculate' ? input.requests.length : input.kind === 'markers' ? 0 : input.refs.length;
  invariant(
    progress.index <= end && (input.kind !== 'states' || progress.states.length === progress.index),
    'SOURCE_JOB_INVALID',
    'Source task cursor is outside its retained input.',
  );
  if (progress.verify) {
    const ref = input.refs[progress.index];
    invariant(
      (input.kind === 'verify' || input.kind === 'markers') &&
        ref &&
        JSON.stringify(ref) === JSON.stringify(progress.verify.ref),
      'SOURCE_JOB_INVALID',
      'Source verification cursor selects another object.',
    );
  }
}
