// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { hostedLaneSelectionSchema } from './hosted-lane.js';
import { saveExpectedSchema } from './hosted-save.js';

const target = {
  saveId: z.uuid().optional(),
  version: saveExpectedSchema.shape.version.optional(),
};

export const undoRequestSchema = z
  .object({
    kind: z.literal('undo'),
    laneId: z.uuid(),
    ...target,
    operationId: z.uuid(),
    holderSessionId: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    authorityEpoch: z.number().int().nonnegative(),
    expected: saveExpectedSchema.strict(),
  })
  .strict()
  .refine(request => request.saveId === undefined || request.version === undefined);

export const undoReceiptSchema = z
  .object({
    operationId: z.uuid(),
    at: z.iso.datetime(),
    lane: hostedLaneSelectionSchema,
    from: saveExpectedSchema.extend({ laneId: z.uuid() }).strict(),
    restored: z
      .object({
        head: saveExpectedSchema.shape.head,
        version: saveExpectedSchema.shape.version,
        saveId: z.uuid().optional(),
      })
      .strict(),
  })
  .strict();
