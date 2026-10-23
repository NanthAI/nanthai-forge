// SPDX-License-Identifier: Apache-2.0
import type { WorkData } from './work-types.js';
import type { HostedMainSummary } from './work-hosted-summary.js';
/** Build once from exact parent records; hosted reads use pair membership. */
export function hostedAncestry(
  data: WorkData,
  sourceParents: ReadonlyMap<string, readonly string[]>,
  selection?: { head?: string; defer?: boolean },
) {
  const cache = new Map<string, { seen: Set<string>; known: boolean }>();
  function ancestors(head: string) {
    const old = cache.get(head);
    if (old) return old;
    const pending = [head],
      seen = new Set<string>();
    let known = true;
    while (pending.length) {
      const current = pending.pop()!;
      if (seen.has(current)) continue;
      seen.add(current);
      const parents = sourceParents.get(current);
      if (parents === undefined) known = false;
      else pending.push(...parents);
    }
    const result = { seen, known };
    // Summary construction needs only one closure at a time. Do not retain
    // every historical closure (quadratic memory for a long linear history).
    cache.clear();
    cache.set(head, result);
    return result;
  }
  // Hosted main may select any retained local acceptance. Only positive pairs
  // are stored; completeness distinguishes a negative answer from unknown.
  const candidates = new Set([
    ...data.lanes.map(lane => lane.head),
    ...data.channelMoves.map(m => m.head),
    ...(data.hostedChannelMoves ?? []).map(m => m.head),
  ]);
  const heads = new Set([
    ...candidates,
    ...data.views.flatMap(v => (v.head ? [v.head] : [])),
    ...data.runs.map(r => r.head),
  ]);
  const pairs: { key: string; head: string; ancestor: string }[] = [],
    complete: { head: string }[] = [];
  for (const head of selection?.defer ? [] : selection?.head ? [selection.head] : heads) {
    const { seen, known } = ancestors(head);
    for (const ancestor of seen)
      if (candidates.has(ancestor)) pairs.push({ key: JSON.stringify([head, ancestor]), head, ancestor });
    if (known) complete.push({ head });
  }
  return {
    pairs,
    complete,
    lane(head: string, mainHead: string | null): HostedMainSummary {
      return {
        head: mainHead,
        included: !mainHead
          ? null
          : head === mainHead || ancestors(mainHead).seen.has(head)
            ? true
            : ancestors(mainHead).known
              ? false
              : null,
      };
    },
    main(head: string | undefined, mainHead: string | null): HostedMainSummary {
      return {
        head: mainHead,
        included:
          !mainHead || head === mainHead
            ? true
            : !head
              ? null
              : ancestors(head).seen.has(mainHead)
                ? true
                : ancestors(head).known
                  ? false
                  : null,
      };
    },
  };
}
