// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { z } from 'zod';
import { hostedLaneSelectionSchema } from './hosted-lane.js';
import { saveExpectedSchema } from './hosted-save.js';

const target = {
  saveId: z.uuid().optional(),
  version: saveExpectedSchema.shape.version.optional(),
};

const undoInput = z
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
  .strict();

export const undoRequestSchema = undoInput.refine(
  request => request.saveId === undefined || request.version === undefined,
);

/** Only a retained save or the exact stopped point of a completed browser return. */
export const browserUndoRequestSchema = undoInput
  .omit({ holderSessionId: true })
  .extend({ returnOperationId: z.uuid().optional() })
  .refine(request =>
    request.saveId !== undefined
      ? request.version === undefined && request.returnOperationId === undefined
      : request.version !== undefined && request.returnOperationId !== undefined,
  );

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
