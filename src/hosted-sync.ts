// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { earlyResolutionSchema, predecessorPinSchema } from './early-resolution.js';
import {
  saveObjectSchema as object,
  saveWorkerObjectSchema as source,
  saveExpectedSchema,
  keepPathsSchema,
} from './hosted-save.js';
import { hostedLaneSelectionSchema } from './hosted-lane.js';
import { hostedRecordSchema } from './hosted-records.js';
import { docsMergeSchema, docsResolutionSchema } from './docs-resolution.js';
export const SYNC_ALGORITHM = 'forge-native-sync-v1';
export const resolutionSchema = hostedRecordSchema.options[1].shape.resolution.unwrap();
const common = {
  operationId: z.uuid(),
  authorityEpoch: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  message: z.string(),
};
const lane = { laneId: z.uuid(), expected: saveExpectedSchema };
export const revertTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('receipt'), receiptId: z.uuid() }).strict(),
  z.object({ kind: z.literal('submission'), submissionId: z.uuid() }).strict(),
]);
export const revertRequestSchema = z
  .object({ ...common, kind: z.literal('revert'), target: revertTargetSchema })
  .strict();
export const syncRequestSchema = z.discriminatedUnion('kind', [
  revertRequestSchema,
  z
    .object({
      ...common,
      ...lane,
      kind: z.literal('sync'),
      ontoMain: z.boolean().optional(),
      /** Automatic restack onto the stack parent's newest saved head (Issue f61e9339): a conflict
       * changes nothing (no resolution Lane) and is marked so it is not retried for that head. */
      cleanOnly: z.literal(true).optional(),
      /** Stack this unstacked Lane on an open peer Lane's pending head (D2, Issue 1eb42254; feature
       * sync-stack-on): the peer must have a live landing, which this Lane's landing then waits for. */
      stackOn: z.uuid().optional(),
      predecessor: predecessorPinSchema.optional(),
      target: z.discriminatedUnion('kind', [
        z
          .object({ kind: z.literal('main'), head: object.shape.sha256, receiptId: z.string().min(1) })
          .strict(),
        z.object({ kind: z.literal('candidate'), candidateId: z.uuid(), head: object.shape.sha256 }).strict(),
      ]),
    })
    .strict(),
  z
    .object({
      ...common,
      kind: z.literal('resolution'),
      candidateId: z.uuid(),
      conflicts: object,
      /** The caller's conflicted Lane (contract feature resolution-origin); completed when the resolution lands. */
      originLaneId: z.uuid().optional(),
    })
    .strict(),
  z
    .object({
      ...common,
      ...lane,
      kind: z.literal('resolve'),
      /** Conflict paths whose unchanged side (no markers) is kept explicitly (Issue 113bc7b3). */
      keep: keepPathsSchema.optional(),
    })
    .strict(),
]);
export const syncWorkSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('revert'), receiptId: z.uuid(), previous: source, accepted: source }).strict(),
  z
    .object({
      mode: z.literal('sync'),
      left: source,
      right: source,
      stackBase: source.optional(),
      stackAfter: hostedLaneSelectionSchema.shape.stack,
      earlyResolution: earlyResolutionSchema.optional(),
    })
    .strict(),
  z.object({ mode: z.literal('resolution'), candidateId: z.uuid(), conflicts: object }).strict(),
  z
    .object({
      mode: z.literal('resolve'),
      left: source,
      resolution: resolutionSchema,
      keep: keepPathsSchema.optional(),
    })
    .strict(),
]);
export const syncInputSchema = z
  .object({
    schema: z.literal(1),
    kind: z.literal('forge-hosted-sync-input'),
    algorithm: z.literal(SYNC_ALGORITHM),
    work: syncWorkSchema,
    message: z.string(),
    at: z.iso.datetime(),
  })
  .strict();
export const syncOutputSchema = z
  .object({
    schema: z.literal(1),
    kind: z.literal('forge-hosted-sync-result'),
    input: object,
    algorithm: z.literal(SYNC_ALGORITHM),
    result: z.discriminatedUnion('status', [
      z.object({ status: z.literal('merged'), state: object, docs: docsMergeSchema.optional() }).strict(),
      z.object({ status: z.literal('up-to-date'), state: object }).strict(),
      z.object({ status: z.literal('resolved'), state: object, resolution: resolutionSchema }).strict(),
      z
        .object({
          status: z.literal('conflict'),
          state: object,
          left: object.shape.sha256,
          right: object.shape.sha256,
          conflicts: object,
        })
        .strict(),
    ]),
  })
  .strict();
export type SyncRequest = z.infer<typeof syncRequestSchema>;

/** Public source result. Local installation and landing remain independent outcomes. */
export const syncResultSchema = z
  .object({
    schema: z.literal(1),
    operationId: z.uuid(),
    status: z.enum(['up-to-date', 'merged', 'conflict', 'resolved']),
    lane: hostedLaneSelectionSchema,
    from: saveExpectedSchema
      .omit({ lifecycleVersion: true })
      .extend({ laneId: z.uuid() })
      .strict()
      .nullable(),
    resolution: resolutionSchema.nullable(),
    /** Markdown-only conflicts this sync merged with the docs rule, and how to undo that. */
    docsResolution: docsResolutionSchema.optional(),
    at: z.iso.datetime(),
  })
  .strict();
export type SyncResult = z.infer<typeof syncResultSchema>;
