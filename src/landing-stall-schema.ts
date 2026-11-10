// SPDX-License-Identifier: Apache-2.0
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
}) satisfies z.ZodType<LandingStall>;
