// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { snapshotRecord } from '../src/public-snapshot-contract';

const utf8 = new TextEncoder();
type Data = Record<string, unknown>;

/** Keep factual summary fields and fit the ordered prefixes (the suffix for oldest-first days).
 * The test is against the stored envelope, not a character count or a projection before fencing. */
export function fitPublicEntity(input: {
  kind: 'profile' | 'project';
  data: Data;
  limit: number;
  generation: number;
  asOf: number;
}) {
  const { kind, limit, generation, asOf } = input;
  const data = { ...input.data };
  const fence = { v: 1, state: 'public', generation, asOf, contentHash: '0'.repeat(64) };
  const fits = () => utf8.encode(JSON.stringify({ ...data, ...fence })).length <= limit;
  const buckets: { parent: Data; field: string; items: unknown[]; newestLast: boolean; max: number }[] = [];
  const bucket = (parent: Data, field: string, max = Infinity, newestLast = false) => {
    const items = parent[field];
    if (Array.isArray(items)) buckets.push({ parent, field, items, newestLast, max });
  };
  const child = (parent: Data, field: string) => {
    const value = snapshotRecord(parent[field]);
    return value ? ((parent[field] = { ...value }) as Data) : {};
  };
  if (kind === 'profile') {
    bucket(data, 'projects', 50);
    const contributions = child(data, 'contributions');
    bucket(contributions, 'latest');
    bucket(contributions, 'days', Infinity, true);
    bucket(contributions, 'projects');
    bucket(child(contributions, 'agents'), 'rows');
  } else {
    const plan = child(data, 'plan');
    bucket(plan, 'next');
    bucket(plan, 'initiatives');
    bucket(child(data, 'lanes'), 'titles');
  }
  if (fits() && buckets.every(({ items, max }) => items.length <= max)) return data;
  let left = buckets.reduce((count, { parent, field, items }) => {
    parent[field] = [];
    return count + items.length;
  }, 0);
  data.moreCount = left;
  if (!fits()) return null;
  for (const { parent, field, items, newestLast, max } of buckets) {
    const ranked =
      kind === 'profile' && parent === data && field === 'projects'
        ? items
            .map((item, index) => ({ index, since: Number(snapshotRecord(item)?.since ?? 0) }))
            .sort((a, b) => b.since - a.since || a.index - b.index)
        : null;
    const keep = (count: number) => {
      parent[field] = ranked
        ? ranked
            .slice(0, count)
            .sort((a, b) => a.index - b.index)
            .map(({ index }) => items[index])
        : newestLast
          ? items.slice(items.length - count)
          : items.slice(0, count);
      data.moreCount = left - count;
    };
    let lower = 0;
    let upper = Math.min(max, items.length);
    while (lower < upper) {
      const candidate = Math.ceil((lower + upper) / 2);
      keep(candidate);
      if (fits()) lower = candidate;
      else upper = candidate - 1;
    }
    keep(lower);
    left -= lower;
  }
  if (!left) delete data.moreCount;
  return data;
}
