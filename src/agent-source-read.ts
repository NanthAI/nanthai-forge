// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { agentStateDiffSchema } from './agent-review.js';
import { safeRelative } from './files.js';

const state = z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/);
export const agentDiffSchema = agentStateDiffSchema
  .partial({ from: true, to: true })
  .extend({
    laneId: z.string().uuid().optional(),
    expectedHead: state.optional(),
  })
  .strict()
  .refine(
    input =>
      input.laneId
        ? input.from === undefined && input.to === undefined
        : !!input.from && !!input.to && input.expectedHead === undefined,
    'Select laneId, or both from and to.',
  );
export const agentShowSchema = z
  .object({
    state: state.optional(),
    laneId: z.string().uuid().optional(),
    /** The Channel's current head, e.g. main. */
    channel: z.string().min(1).optional(),
    path: z.string().refine(safeRelative),
    force: z.boolean().default(false),
  })
  .strict()
  .refine(
    input => [input.state, input.laneId, input.channel].filter(Boolean).length === 1,
    'Select exactly one state, laneId or channel.',
  );

import { SHOW_MAX_BYTES } from './source-review-format.js';
export { SHOW_MAX_BYTES };
