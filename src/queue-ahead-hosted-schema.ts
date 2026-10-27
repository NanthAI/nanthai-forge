// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { QUEUE_AHEAD_LIMIT } from './queue-ahead-preview.js';
const object = z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().nonnegative() });
export const queueAheadSelectionSchema = z.object({
  main: object.shape.sha256,
  mine: object.shape.sha256,
  ahead: z
    .array(
      z.object({
        id: z.uuid(),
        head: object.shape.sha256,
        inputs: object,
        status: z.enum(['queued', 'checking', 'ready']),
      }),
    )
    .max(QUEUE_AHEAD_LIMIT),
  more: z.boolean(),
});
export type QueueAheadSelection = z.infer<typeof queueAheadSelectionSchema>;
