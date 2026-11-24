// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi

import { HANDLE, SLUG, snapshotCount, snapshotRecord } from './public-snapshot-contract.js';

export const explorePageSize = 50;
export const explorePageBytes = 16 * 1024;
export const searchShardBytes = 64 * 1024;
export const explorePackPages = 8;
export const explorePackBytes = explorePackPages * explorePageBytes;

/** One physical object for eight consecutive logical URLs; the edge still caches each URL by itself. */
export function explorePackAddress(order: string, page: number) {
  const index = page - 1;
  return {
    key: `public-pages/v1/explore/${order}/pack/${Math.floor(index / explorePackPages) + 1}.bin`,
    range: { offset: (index % explorePackPages) * explorePageBytes, length: explorePageBytes },
  };
}

export type ExploreOrder = 'active' | 'stars' | 'newest';
export const searchShardPath = (number: number) => `search/${number}.json`;
export const explorePagePath = (order: string, page: number) =>
  `explore/${order}${page === 1 ? '' : `/${page}`}.json`;

/** Route and display fields, then the ranking signals (no project id or per-day history). */
export type SearchRow = [
  handle: string,
  slug: string,
  name: string,
  landings: number,
  timeToMain: number | null,
  passing: 0 | 1,
  stars: number,
  since: number,
];
export type SearchShard = {
  deployment: string;
  shard: number;
  total: number;
  start: number;
  more: boolean;
  projects: SearchRow[];
};

export function readSearchShard(value: unknown): SearchShard | null {
  const data = snapshotRecord(value);
  if (
    !data ||
    typeof data.deployment !== 'string' ||
    !snapshotCount(data.shard) ||
    data.shard === 0 ||
    !Array.isArray(data.projects) ||
    !validSlice({ total: data.total, start: data.start, more: data.more }, data.projects.length) ||
    (data.start === 0) !== (data.shard === 1)
  )
    return null;
  for (const row of data.projects) {
    if (
      !Array.isArray(row) ||
      row.length !== 8 ||
      typeof row[0] !== 'string' ||
      !HANDLE.test(row[0]) ||
      typeof row[1] !== 'string' ||
      !SLUG.test(row[1]) ||
      typeof row[2] !== 'string' ||
      !snapshotCount(row[3]) ||
      (row[4] !== null && !snapshotCount(row[4])) ||
      (row[5] !== 0 && row[5] !== 1) ||
      !snapshotCount(row[6]) ||
      !snapshotCount(row[7])
    )
      return null;
  }
  return data as unknown as SearchShard;
}

export function orderSearchRows(order: ExploreOrder, a: SearchRow, b: SearchRow) {
  if (order === 'stars') return b[6] - a[6] || b[7] - a[7];
  if (order === 'newest') return b[7] - a[7];
  const time = a[4] === null ? Number(b[4] !== null) : b[4] === null ? -1 : a[4] - b[4];
  return b[3] - a[3] || time || b[5] - a[5] || b[6] - a[6] || b[7] - a[7];
}

/** Fetch only canonical sequential shards. Fail rather than silently return partial results if the
 * index changes during the walk. No query or caller credentials are sent to the cached read API. */
export async function collectPublicSearch(deployment: string, read: (shard: number) => Promise<SearchShard>) {
  const projects: SearchRow[] = [];
  const keys = new Set<string>();
  let total: number | undefined;
  for (let number = 1; ; number++) {
    const page = await read(number);
    total ??= page.total;
    if (
      page.deployment !== deployment ||
      page.shard !== number ||
      page.total !== total ||
      page.start !== projects.length ||
      !validSlice(page, page.projects.length)
    )
      throw new Error('The public search index changed. Try again.');
    for (const row of page.projects) {
      const key = `${row[0]}/${row[1]}`;
      if (keys.has(key)) throw new Error('The public search index changed. Try again.');
      keys.add(key);
      projects.push(row);
    }
    if (!page.more) return projects;
  }
}

export function validSlice(page: { total: unknown; start: unknown; more: unknown }, count: number) {
  if (
    typeof page.start !== 'number' ||
    !Number.isSafeInteger(page.start) ||
    page.start < 0 ||
    typeof page.total !== 'number' ||
    !Number.isSafeInteger(page.total) ||
    page.total < page.start
  )
    return false;
  const end = page.start + count;
  return (
    end <= page.total &&
    page.more === end < page.total &&
    (count > 0 || (page.start === 0 && page.total === 0))
  );
}
