// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import {
  explorePageBytes,
  explorePageSize,
  searchShardBytes,
  orderSearchRows,
  type ExploreOrder,
  type SearchRow,
} from '../src/public-explore-pages';
import { invariant } from '../src/errors';

type Listed = {
  handle: string;
  slug: string;
  name: string;
  since: number;
  stars: number;
  landings: number;
  main: 'passing' | 'unchecked';
  timeToMain?: number;
};
const encoder = new TextEncoder();
const bytes = (value: unknown) => encoder.encode(JSON.stringify(value)).length;
const fence = {
  v: 1,
  state: 'public',
  generation: Number.MAX_SAFE_INTEGER,
  asOf: Number.MAX_SAFE_INTEGER,
  contentHash: '0'.repeat(64),
};

export function directoryDisplayName(name: string) {
  const cap = 80;
  if (encoder.encode(name).length <= cap) return name;
  let remaining = cap - encoder.encode('…').length;
  let prefix = '';
  for (const character of name) {
    remaining -= encoder.encode(character).length;
    if (remaining < 0) break;
    prefix += character;
  }
  return `${prefix}…`;
}

/** Reserve the complete wire envelope (including max-width generation/timestamp) before each page.
 * The row payload is serialized once per order, so partitioning is O(rows + pages), not O(n²). */
function partition<Row>(
  rows: Row[],
  budget: number,
  maxRows: number,
  location: 'page' | 'shard',
  header: Record<string, unknown>,
  first?: Record<string, unknown>,
) {
  const total = rows.length;
  const pages: (Record<string, unknown> & {
    projects: Row[];
    start: number;
    total: number;
    more: boolean;
  })[] = [];
  const create = (start: number) => ({
    ...header,
    ...(start === 0 ? first : undefined),
    [location]: pages.length + 1,
    total,
    start,
    more: false,
    projects: [] as Row[],
  });
  let page = create(0);
  let size = bytes({ ...page, ...fence });
  for (const [index, row] of rows.entries()) {
    const length = bytes(row);
    if (size + length + Number(page.projects.length > 0) > budget || page.projects.length === maxRows) {
      invariant(page.projects.length, 'BAD_ARGUMENT', 'A public directory row exceeds the page budget.');
      page.more = true;
      pages.push(page);
      page = create(index);
      size = bytes({ ...page, ...fence });
    }
    size += length + Number(page.projects.length > 0);
    invariant(size <= budget, 'BAD_ARGUMENT', 'A public directory row exceeds the page budget.');
    page.projects.push(row);
  }
  pages.push(page);
  return pages;
}

/** One redacted source set supplies all orders and the compact search index. Never hash the clock
 * into data: a rebuild with unchanged figures must be a no-op at the storage boundary. */
export function buildPublicDirectory<Row extends Listed>(rows: Row[], deployment: string) {
  const rank = rows.map(input => {
    const name = directoryDisplayName(input.name);
    const project = { ...input, name };
    const search: SearchRow = [
      project.handle,
      project.slug,
      name === project.slug ? '' : name,
      project.landings,
      project.timeToMain ?? null,
      Number(project.main === 'passing') as 0 | 1,
      project.stars,
      project.since,
    ];
    return { project, search, key: `${project.handle}/${project.slug}` };
  });
  rank.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const index = partition(
    rank.map(row => row.search),
    searchShardBytes,
    Infinity,
    'shard',
    { deployment },
  );
  const active = rank.filter(row => row.project.landings > 0).length;
  const orders = (['active', 'stars', 'newest'] as const).map((order: ExploreOrder) => ({
    order,
    pages: partition(
      [...rank].sort((a, b) => orderSearchRows(order, a.search, b.search)).map(row => row.project),
      explorePageBytes,
      explorePageSize,
      'page',
      { order, deployment, search: true, starLookup: true },
      { active },
    ),
  }));
  const sitemap = { projects: rank.map(({ project: { handle, slug } }) => [handle, slug]) };
  return { orders, index, sitemap };
}
