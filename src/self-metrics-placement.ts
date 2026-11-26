// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { MetricRecords } from './self-metrics-types.js';

export type ConvexBytesWritten = { count: number; bytes: number };

/** Bytes go to R2; Convex file storage must receive none. Unknown stays null, never 0. */
export function calculatePlacementMetrics(records: MetricRecords) {
  const convexBytes = records.placement?.bytes ?? null;
  return {
    partial: !records.placement,
    gaps: [
      'Deployment-wide Convex file storage is measured by the internal placement audit. R2 holds new source bytes.',
    ],
    convexBytes,
    convexObjects: records.placement?.count ?? null,
    warning: convexBytes
      ? `Convex file storage received ${convexBytes} bytes; bytes must go to R2 (docs/data-placement.md).`
      : null,
  };
}
