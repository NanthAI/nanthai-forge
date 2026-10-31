// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import type { MetricPeriod, MetricRecords } from './self-metrics-types.js';
import { ForgeError } from './errors.js';

const placementPage = z.object({
  count: z.number().int().nonnegative(),
  bytes: z.number().nonnegative(),
  isDone: z.boolean(),
  cursor: z.string(),
});
export type ConvexBytesWritten = { count: number; bytes: number };

/** Convex file-storage writes in the window: one call when there were none. */
export async function readPlacement(
  query: (name: string, args: Record<string, unknown>) => Promise<unknown>,
  period: MetricPeriod,
  records: MetricRecords,
) {
  const total = { count: 0, bytes: 0 };
  let cursor: string | null = null;
  try {
    do {
      const page = placementPage.parse(
        await query('projectBytePlacement:convexWritten', { from: period.from, to: period.to, cursor }),
      );
      total.count += page.count;
      total.bytes += page.bytes;
      cursor = page.isDone ? null : page.cursor;
    } while (cursor);
    records.placement = total;
  } catch (error) {
    records.gaps.push(
      `Bytes by location are unavailable (${error instanceof ForgeError ? error.code : 'projectBytePlacement:convexWritten failed'}).`,
    );
  }
}

/** Bytes go to R2; Convex file storage must receive none. Unknown stays null, never 0. */
export function calculatePlacementMetrics(records: MetricRecords) {
  const convexBytes = records.placement?.bytes ?? null;
  return {
    partial: !records.placement,
    gaps: [
      'Convex bytes count every Convex file-storage write on the deployment in the window; R2 holds every new byte.',
    ],
    convexBytes,
    convexObjects: records.placement?.count ?? null,
    warning: convexBytes
      ? `Convex file storage received ${convexBytes} bytes; bytes must go to R2 (docs/data-placement.md).`
      : null,
  };
}
