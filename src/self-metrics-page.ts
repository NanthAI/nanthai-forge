// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { invariant } from './errors.js';
import type { MetricPeriod } from './self-metrics-types.js';
import type { MetricsSurface } from './self-metrics-surface.js';

export const METRICS_PAGE_MAX = 200;
/** Optional on every metrics surface. Without them the report is returned whole, as before. */
export const metricPagingFields = {
  /** Row-list entries per page (waste, landings by path, authority-lag rows). */
  limit: z.number().int().min(1).max(METRICS_PAGE_MAX).optional(),
  /** `page.nextCursor` of the previous page of the same window. */
  cursor: z.string().min(1).max(200).optional(),
};
const encode = (offset: number, period: MetricPeriod) =>
  btoa(JSON.stringify({ o: offset, f: period.from, t: period.to }));
function decode(cursor: string, period: MetricPeriod) {
  let value: { o?: unknown; f?: unknown; t?: unknown } = {};
  try {
    value = JSON.parse(atob(cursor));
  } catch {
    /* falls through to the typed refusal */
  }
  invariant(
    Number.isInteger(value.o) && (value.o as number) >= 0 && value.f === period.from && value.t === period.to,
    'BAD_ARGUMENT',
    'The metrics cursor does not belong to this window. Use page.nextCursor with the same from and to.',
  );
  return value.o as number;
}
/** Every `rows` list in the report, wherever it nests, as [owner, key] pairs. */
function rowLists(value: unknown, found: Record<string, unknown>[] = []) {
  if (Array.isArray(value)) value.forEach(item => rowLists(item, found));
  else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (key === 'rows' && Array.isArray(child)) found.push(value as Record<string, unknown>);
      else rowLists(child, found);
    }
  }
  return found;
}
/** Page the window's row lists by one shared offset. Totals and counts stay whole on every page;
 * the per-day sections keep their counts but not their rows (one-day windows return them).
 * The report is recomputed for each page: paging bounds the reply, not the hosted read. */
export function pageMetrics(
  surface: MetricsSurface,
  period: MetricPeriod,
  paging: { limit?: number | undefined; cursor?: string | undefined },
) {
  if (paging.limit === undefined && paging.cursor === undefined) return surface;
  invariant(
    paging.limit !== undefined,
    'BAD_ARGUMENT',
    'A metrics cursor needs the limit of its first page.',
  );
  const offset = paging.cursor ? decode(paging.cursor, period) : 0;
  const page = structuredClone(surface) as MetricsSurface;
  let longest = 0;
  for (const day of page.days)
    for (const owner of rowLists(day.metrics)) {
      owner.rowsOmitted = (owner.rows as unknown[]).length;
      owner.rows = [];
    }
  for (const owner of rowLists(page.totals)) {
    const rows = owner.rows as unknown[];
    longest = Math.max(longest, rows.length);
    owner.rows = rows.slice(offset, offset + paging.limit);
    owner.rowsTotal = rows.length;
  }
  return {
    ...page,
    page: {
      limit: paging.limit,
      offset,
      rowsTotal: longest,
      nextCursor: offset + paging.limit < longest ? encode(offset + paging.limit, period) : null,
    },
  };
}
