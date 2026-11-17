// SPDX-License-Identifier: Apache-2.0
/** Hour buckets for the person-order rows (convex/accountProjectOrder.ts), kept apart so the live-line store can use
 * them without importing the order writers. */
export const HOUR_MS = 3_600_000;
export const activityHour = (at: number) => Math.floor(at / HOUR_MS);
/** The hour to record for a landing at `at`, or null when the summary already holds that bucket or a later one. */
export function nextActivityHour(value: { hour?: number }, at: number): number | null {
  const hour = activityHour(at);
  return value.hour !== undefined && value.hour >= hour ? null : hour;
}
