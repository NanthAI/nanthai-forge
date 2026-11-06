// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
/** Consecutive pending resumes at one cursor before the build fails (B-N15). One budget for
 * the server cap and the progress line. */
export const indexPendingResumeLimit = 5;
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
  filesDone: z.number().safe().nonnegative().optional(),
  filesTotal: z.number().safe().nonnegative().optional(),
  filesTotalComplete: z.boolean().optional(),
  /** Pending resumes already spent at this cursor; present only while a read fault is retried. */
  retries: z.number().int().nonnegative().max(indexPendingResumeLimit).optional(),
  step: z.number().safe().nonnegative(),
});
export type IndexBuildProgress = z.infer<typeof indexBuildProgressSchema>;
export const hostIndexProgressSchema = indexBuildProgressSchema.extend({
  stepsPerSecond: z.number().nonnegative(),
  filesPerMinute: z.number().nonnegative().optional(),
});
