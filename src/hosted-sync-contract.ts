// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { hostedLaneSelectionSchema } from './hosted-lane.js';
import { hostedLaneExpectationSchema } from './hosted-lane-checkout-marker.js';
export const applySchema = z
  .object({
    operationId: z.uuid(),
    url: z.url(),
    from: hostedLaneExpectationSchema.extend({ laneId: z.uuid() }).strict(),
    lane: hostedLaneSelectionSchema,
    status: z.enum(['merged', 'up-to-date', 'resolved']),
  })
  .strict();
