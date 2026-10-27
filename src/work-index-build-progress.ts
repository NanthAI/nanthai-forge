// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
/** Fixed labels and committed counters only; never arbitrary record names or source data. */
export const indexBuildProgressSchema = z.object({
  phase: z.literal('index'),
  buildPhase: z.enum([
    'settings',
    'records',
    'parents',
    'summaries',
    'trees',
    'blobs',
    'journal',
    'cleanup',
    'done',
  ]),
  field: z
    .enum([
      'intents',
      'landingEntries',
      'landingBatches',
      'initiatives',
      'intentAliases',
      'automaticActions',
      'policyChanges',
      'lanes',
      'views',
      'checks',
      'runs',
      'planningItems',
      'planningComments',
      'channelMoves',
      'hostedChannelMoves',
      'hostedEvents',
      'other',
    ])
    .optional(),
  done: z.number().safe().nonnegative(),
  total: z.number().safe().nonnegative(),
  step: z.number().safe().nonnegative(),
});
export type IndexBuildProgress = z.infer<typeof indexBuildProgressSchema>;
export const hostIndexProgressSchema = indexBuildProgressSchema.extend({
  stepsPerSecond: z.number().nonnegative(),
});
