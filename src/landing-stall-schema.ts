// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { z } from 'zod';
import type { LandingStall } from './landing-stall.js';

/** Kept apart from landing-stall.ts: the turn-end hook reads that module's constants and must not load zod. */
export const landingStallSchema = z.object({
  code: z.literal('LANDING_STALLED'),
  step: z.string(),
  missingOwner: z.string(),
  lastProgressAt: z.string(),
  alarmAt: z.string(),
  message: z.string(),
  owner: z
    .object({
      finishWake: z.enum(['none', 'pending', 'inProgress', 'success', 'failed', 'canceled']),
      compose: z.enum(['none', 'ready', 'submitted', 'terminal']),
      cohortStep: z.enum(['retry', 'upload', 'submitted', 'terminal']).optional(),
    })
    .strict()
    .optional(),
}) satisfies z.ZodType<LandingStall>;
