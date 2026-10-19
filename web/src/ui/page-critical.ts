// SPDX-License-Identifier: Apache-2.0
import { useEffect } from 'react';
type Sample = {
  firstContent: number;
  complete?: number;
  queries: Record<string, number>;
  required?: string[];
};
declare global {
  interface Window {
    __forgeCritical?: Record<string, Sample>;
  }
}
/** QA-only first-result marker. It never reads values, persists data, or watches presence ticks. */
export function usePageCritical(page: string, ready: Record<string, boolean>) {
  useEffect(() => {
    if (!(import.meta.env.DEV || import.meta.env.VITE_FORGE_PERF === '1')) return;
    const samples = (window.__forgeCritical ??= {});
    const sample = (samples[page] ??= { firstContent: performance.now(), queries: {} });
    sample.required = [...new Set([...(sample.required ?? []), ...Object.keys(ready)])];
    for (const [query, delivered] of Object.entries(ready)) {
      if (delivered && sample.queries[query] === undefined) sample.queries[query] = performance.now();
      else if (!delivered && sample.complete === undefined) delete sample.queries[query];
    }
    const required =
      page === 'Lane'
        ? [
            'intents',
            'lanes',
            'views',
            'runs',
            'selectedLane',
            'selectedIntent',
            'scopedViews',
            'scopedRuns',
            'conversation',
            'sourceIndex',
            'sourceDiff',
            'viewLinks',
          ]
        : sample.required;
    const allRequired = [...new Set([...required, ...sample.required])];
    if (
      sample.complete === undefined &&
      allRequired.length &&
      allRequired.every(query => sample.queries[query] !== undefined)
    ) {
      sample.complete = performance.now();
      performance.mark(`forge:${page}:critical-complete`);
    }
  });
}
