// SPDX-License-Identifier: Apache-2.0
import type { CheckRun } from './work-types.js';
import type { LandingBatch, BatchPrefix } from './landing-batch-types.js';

/** Remote diagnosis checks all proper prefixes in one parallel round.
 * Local fallback halves the prefix interval and never lands an unchecked subset. */
export async function passingPrefix(
  prefixes: BatchPrefix[],
  mode: LandingBatch['mode'] | (() => LandingBatch['mode']),
  check: (prefix: BatchPrefix, parent?: BatchPrefix) => Promise<CheckRun['status']>,
): Promise<{
  passing?: BatchPrefix | undefined;
  failing?: BatchPrefix | undefined;
  /** Compatibility alias for the observed failing boundary prefix. */
  culprit?: BatchPrefix | undefined;
  stopped?: CheckRun['status'];
}> {
  if (!prefixes.length) return {};
  const full = prefixes.at(-1)!;
  const status = await check(full);
  if (status === 'passed') return { passing: full };
  if (status !== 'failed') return { stopped: status };
  // One evaluation observes each exact run once, including the failing boundary.
  const observed = new Map<BatchPrefix, CheckRun['status']>([[full, status]]);
  const probe = async (prefix: BatchPrefix, parent: BatchPrefix) => {
    const known = observed.get(prefix);
    if (known) return known;
    const status = await check(prefix, parent);
    observed.set(prefix, status);
    return status;
  };
  let index = -1;
  if ((typeof mode === 'function' ? mode() : mode) === 'parallel') {
    const outcomes = await Promise.all(prefixes.slice(0, -1).map(prefix => probe(prefix, full)));
    const stopped = outcomes.find(status => status !== 'passed' && status !== 'failed');
    if (stopped) return { stopped };
    index = outcomes.lastIndexOf('passed');
  } else {
    let low = 0,
      high = prefixes.length - 2,
      parent = full;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2),
        status = await probe(prefixes[mid]!, parent);
      parent = prefixes[mid]!;
      if (status !== 'passed' && status !== 'failed') return { stopped: status };
      if (status === 'passed') {
        index = mid;
        low = mid + 1;
      } else high = mid - 1;
    }
    // This is an observed failing combination. Halving does not establish
    // monotonicity, the longest pass, or a standalone/minimal failing Lane.
    const failing = prefixes[index + 1]!;
    const status = await probe(failing, full);
    if (status !== 'failed') return { stopped: status };
  }
  return { passing: prefixes[index], failing: prefixes[index + 1], culprit: prefixes[index + 1] };
}
