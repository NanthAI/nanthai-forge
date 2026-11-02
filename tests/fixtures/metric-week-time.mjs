// SPDX-License-Identifier: Apache-2.0
/** A closed-week boundary after a freshly created fixture's real birth time.
 * Fixed historical dates stop scheduling as soon as the real clock passes them. */
export function metricWeekFixtureAt() {
  const monday = new Date(Date.now() + 14 * 86400000);
  monday.setUTCHours(0, 0, 0, 0);
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  return monday.toISOString();
}
