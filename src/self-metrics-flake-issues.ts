// SPDX-License-Identifier: Apache-2.0
// Opt-in (`metrics --flake-issues`): name the existing Issue for each listed flaky file, or say none.
// One planning search per listed file, at most `flakeIssueLookups`; the default metrics read makes none.
import { z } from 'zod';
import { planningSearchTerms } from './planning-search.js';
import type { FlakeRow } from './self-metrics-flakes.js';
import type { MetricQuery } from './self-metrics-hosted-pages.js';
export const flakeIssueLookups = 10;
const result = z.object({
  items: z.array(z.object({ id: z.string(), title: z.string(), status: z.string(), body: z.string() })),
});
/** Mutates `rows[].issue`; returns the number of search calls made. */
export async function nameFlakeIssues(query: MetricQuery, rows: FlakeRow[]) {
  let calls = 0;
  for (const row of rows.slice(0, flakeIssueLookups)) {
    calls++;
    const raw = await query('projectHostedPlanningSearch:search', {
      ...planningSearchTerms(row.search),
      status: 'all',
      kind: 'issue',
      cursor: null,
      limit: 5,
    });
    const { items } = result.parse(typeof raw === 'string' ? JSON.parse(raw) : raw);
    const needle = row.search.toLowerCase();
    // Active Issues first: a closed one is history, not the place to add new evidence.
    const rank = (status: string) => (['closed', 'abandoned'].includes(status) ? 1 : 0);
    const named = items
      .filter(item => `${item.title}\n${item.body}`.toLowerCase().includes(needle))
      .sort((a, b) => rank(a.status) - rank(b.status))[0];
    row.issue = named
      ? { id: named.id, title: named.title, status: named.status }
      : items.length
        ? { possible: items.slice(0, 3).map(({ id, title }) => ({ id, title })) }
        : null;
  }
  return calls;
}
