// SPDX-License-Identifier: Apache-2.0
import type { LandingEntry } from './landing-batch-types.js';
/** Ordering only: after two entries, each later entry yields one position to
 * another submitter in the same priority class. No quota or admission denial. */
export function orderLandingEntries(entries: LandingEntry[]) {
  const rank = { urgent: 0, normal: 1 };
  const result = [...entries].sort(
    (a, b) => rank[a.priority] - rank[b.priority] || a.arrivedAt.localeCompare(b.arrivedAt),
  );
  const counts = new Map<string, number>();
  for (let index = 0; index < result.length; index++) {
    const current = result[index]!,
      key = `${current.priority}:${current.submitter}`;
    if ((counts.get(key) ?? 0) >= 2) {
      const next = result.findIndex(
        (entry, position) =>
          position > index && entry.priority === current.priority && entry.submitter !== current.submitter,
      );
      if (next >= 0) {
        const [other] = result.splice(next, 1);
        result.splice(index, 0, other!);
        const otherKey = `${other!.priority}:${other!.submitter}`;
        counts.set(otherKey, (counts.get(otherKey) ?? 0) + 1);
        index++;
      }
    }
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return result;
}
