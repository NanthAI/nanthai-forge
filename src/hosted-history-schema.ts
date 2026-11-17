// SPDX-License-Identifier: Apache-2.0
// Shared validation stays separate from the Git readers so CLI/MCP help never loads them.
import { z } from 'zod';
import { safeRelative } from './safe-relative.js';

export const hostedHistorySchema = z
  .object({
    action: z.literal('history').optional(),
    op: z.enum(['status', 'log', 'blame', 'show', 'limit', 'retry']).default('status'),
    /** Full or abbreviated hex commit id; default: the newest stored main commit. */
    commit: z
      .string()
      .regex(/^[0-9a-f]{4,40}$/)
      .optional(),
    path: z.string().refine(safeRelative).optional(),
    limit: z.number().int().min(1).max(1000).default(50),
    skip: z.number().int().min(0).default(0),
    start: z.number().int().positive().optional(),
    end: z.number().int().positive().optional(),
    bytes: z.number().int().min(0).optional(),
    force: z.boolean().default(false),
    /** Accepted for symmetry with show; history is per project, not per Lane. */
    laneId: z.uuid().optional(),
  })
  .strict()
  .refine(input => !['blame', 'show'].includes(input.op) || input.path, 'blame and show need path.')
  .refine(input => input.op !== 'limit' || input.bytes !== undefined, 'limit needs bytes.')
  .refine(input => input.end === undefined || (input.start ?? 1) <= input.end, 'start must not exceed end.');
