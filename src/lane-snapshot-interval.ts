// SPDX-License-Identifier: Apache-2.0
/** Minutes between timed snapshots of one Lane (project policy autoSnapshotIntervalMinutes, Issue
 * 7ac4e32f). Its own module so the policy schema and the snapshot contract share the numbers. */
export const SNAPSHOT_INTERVAL_MINUTES = { default: 10, min: 5, max: 1440 } as const;
