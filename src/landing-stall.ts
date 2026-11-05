// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
export const LANDING_STALL_MS = 15 * 60_000;
/** Metric 5.3: a pending landing with no progress for this long is dropped unless it gets an outcome. */
export const LANDING_DROP_MS = 60 * 60_000;
/** Incident c329d191: every progress event of a running check patched its bound
 * landing row, and a train-wide publish lost every OCC retry to those writes.
 * Non-terminal progress reaches the queue at most once per this window; the
 * terminal result always does. Far inside the stall window, so no false stall. */
export const CHECK_PROGRESS_WAKE_MS = 60_000;
/** True when a running check's progress was retained recently enough to skip one. */
export function progressWakeDue(ciProgressAt: string | undefined, now: number) {
  return !ciProgressAt || now - Date.parse(ciProgressAt) >= CHECK_PROGRESS_WAKE_MS;
}
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
