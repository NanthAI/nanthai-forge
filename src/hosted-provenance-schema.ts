// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { hostedRecordSchema } from './hosted-records.js';
import { safeRelative } from './safe-relative.js';
import { composeLaneSchema } from './hosted-compose.js';
import { saveObjectSchema } from './hosted-save.js';
export const hostedProvenanceSchema = z
  .object({
    candidateId: z.uuid(),
    file: z.string().refine(safeRelative).optional(),
    lines: z.boolean().default(false),
    cursor: z.string().optional(),
  })
  .strict();
export const provenanceHistoryCursor = z
  .object({ index: z.number().int().nonnegative(), cursor: z.string().nullable() })
  .strict();
export const provenanceHistoryRequest = z
  .object({
    candidateId: z.uuid(),
    lanes: z.array(composeLaneSchema).max(100),
    cursor: provenanceHistoryCursor.nullable(),
  })
  .strict();
export const provenanceFrameSchema = z
  .object({
    candidateId: z.uuid(),
    head: saveObjectSchema.shape.sha256,
    kind: z.enum(['inputs', 'dependencies']),
    page: saveObjectSchema,
    index: z.number().int().nonnegative(),
    history: provenanceHistoryCursor.nullable(),
  })
  .strict();
export const provenanceCursorSchema = z
  .object({
    selection: z.string(),
    base: saveObjectSchema.shape.sha256,
    head: saveObjectSchema.shape.sha256,
    fileIndex: z.number().int().nonnegative(),
    frames: z.array(provenanceFrameSchema),
    seen: z.array(z.uuid()),
  })
  .strict();
const laneHistoryValue = z.object({
  id: z.uuid(),
  version: z.number().int().nonnegative(),
  at: z.string(),
  intentId: z.uuid(),
  actor: z.string().nullable().optional(),
  head: saveObjectSchema.shape.sha256,
  sourceVersion: z.number().int().nonnegative(),
  base: z.object({ head: saveObjectSchema.shape.sha256 }),
});
const historyOperation = z.object({
  kind: z.enum(['checkpoint', 'sync']),
  actor: z.string().nullable().optional(),
  operationId: z.uuid(),
  message: z.string(),
});
export const provenanceHistoryReply = z.object({
  candidate: hostedRecordSchema.options[3],
  histories: z.array(
    z.object({
      selected: laneHistoryValue,
      previous: laneHistoryValue.nullable(),
      versions: z.array(z.object({ lane: laneHistoryValue, operation: historyOperation.nullable() })),
      complete: z.boolean(),
    }),
  ),
  why: z.array(
    z.object({
      intentId: z.uuid(),
      outcome: z.string().nullable(),
      constraints: z.string().nullable(),
      notes: z.array(z.unknown()),
      notesMore: z.boolean(),
      scope: z.string(),
    }),
  ),
  nextCursor: provenanceHistoryCursor.nullable(),
});
