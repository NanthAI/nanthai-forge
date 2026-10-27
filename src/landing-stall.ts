// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
export const LANDING_STALL_MS = 15 * 60_000;
export const landingStallSchema = z.object({
  code: z.literal('LANDING_STALLED'),
  step: z.string(),
  missingOwner: z.string(),
  lastProgressAt: z.string(),
  alarmAt: z.string(),
  message: z.string(),
});
export type LandingStall = z.infer<typeof landingStallSchema>;
export function latestLandingProgress(times: (string | undefined)[]) {
  return times
    .filter((at): at is string => !!at && Number.isFinite(Date.parse(at)))
    .sort((left, right) => Date.parse(left) - Date.parse(right))
    .at(-1)!;
}
export function landingStall(step: string, missingOwner: string, lastProgressAt: string, now = Date.now()) {
  const deadline = Date.parse(lastProgressAt) + LANDING_STALL_MS;
  if (!Number.isFinite(deadline) || !Number.isFinite(now) || now < deadline) return undefined;
  return {
    code: 'LANDING_STALLED' as const,
    step,
    missingOwner,
    lastProgressAt,
    alarmAt: new Date(deadline).toISOString(),
    message: `No landing progress for 15 minutes at ${step}; missing progress from ${missingOwner}.`,
  };
}
