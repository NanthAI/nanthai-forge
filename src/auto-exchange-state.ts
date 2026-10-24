// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';

export const usageObservationSchema = z.object({
  kind: z.enum(['measured', 'estimated']),
  scope: z.literal('team'),
  subject: z.string().min(1),
  projectId: z.string(),
  deployment: z.string(),
  observedAt: z.number().finite(),
  totalUsd: z.number().finite().nonnegative(),
});
export type UsageObservation = z.infer<typeof usageObservationSchema>;
export const spendStatusSchema = z.object({
  availability: z.enum(['measured', 'estimated', 'unknown']),
  deltaUsd: z.number().nullable(),
  measuredTotalUsd: z.number().nullable(),
  estimatedTotalUsd: z.number().nullable(),
  windowStartedAt: z.number().nullable(),
  observedAt: z.number().nullable(),
  resumeAt: z.number().nullable(),
  paused: z.boolean(),
  reason: z.enum(['within-window', 'threshold-exceeded', 'unconfigured', 'unavailable', 'stale', 'reset']),
});
export type SpendStatus = z.infer<typeof spendStatusSchema>;
export const autoExchangeStateSchema = z.object({
  projectId: z.string(),
  deployment: z.string(),
  status: z.enum(['queued', 'pushing', 'retrying', 'paused', 'pushed', 'incomplete', 'failed']),
  at: z.number(),
  worker: z.object({ pid: z.number(), startTime: z.string() }).optional(),
  wakeEndpoint: z.string().optional(),
  operationId: z.string().optional(),
  handledSequence: z.number().optional(),
  code: z.string().optional(),
  nextAttemptAt: z.number().optional(),
  spend: spendStatusSchema.optional(),
  samples: z.array(usageObservationSchema).optional(),
  spendCheck: z.object({ command: z.string(), at: z.number() }).optional(),
});
export type AutoExchangeState = z.infer<typeof autoExchangeStateSchema>;
export const AUTO_EXCHANGE_UNDO =
  'Disable future automatic pushes with set-policy autoExchange.enabled:false. Published history is retained; undo source through a compensating Lane.';
export const AUTO_EXCHANGE_RESUME =
  'Resumes automatically when the rolling 24-hour window clears. Manual exchange push remains available. Restart owner activity after refreshing login or adapter configuration.';
