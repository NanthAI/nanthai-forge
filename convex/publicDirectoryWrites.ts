// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import {
  explorePackAddress,
  explorePackBytes,
  explorePackPages,
  explorePagePath,
  searchShardBytes,
  searchShardPath,
  type ExploreOrder,
} from '../src/public-explore-pages';
import type { buildPublicDirectory } from './publicDirectoryProjection';
import { publishSnapshotBatch } from './publicSnapshotStorage';
import type { R2Config } from './r2';
import { publicSitemapBytes, publicSitemapKey } from '../src/public-sitemap';

type Directory = ReturnType<typeof buildPublicDirectory>;
type Lengths = Partial<Record<ExploreOrder | 'search', number>>;
const cachePath = (path: string) => `/-/public/v1/${path}`;

/** Reserve the greatest physical ordinal before writes. Later jobs overwrite abandoned packs and
 * shards with retained tombstones. Purge every logical key of a rewritten pack, even unused slots. */
export function directoryWritePlan(directory: Directory, reserved: Lengths) {
  const lengths: Required<Lengths> = { active: 0, stars: 0, newest: 0, search: 0 };
  const packs = directory.orders.flatMap(({ order, pages }) => {
    lengths[order] = Math.max(Math.ceil(pages.length / explorePackPages), reserved[order] ?? 0);
    return Array.from({ length: lengths[order] }, (_, index) => {
      const first = index * explorePackPages;
      const { key } = explorePackAddress(order, first + 1);
      const cachePaths = Array.from({ length: explorePackPages }, (_, i) =>
        cachePath(explorePagePath(order, first + i + 1)),
      );
      if (order === 'active' && index === 0) cachePaths.push('/explore');
      return {
        scope: order,
        address: { key, limit: explorePackBytes, packed: true as const },
        cachePaths,
        frames: pages.slice(first, first + explorePackPages),
      };
    });
  });
  lengths.search = Math.max(directory.index.length, reserved.search ?? 0);
  const shards = Array.from({ length: lengths.search }, (_, index) => {
    const path = searchShardPath(index + 1);
    return {
      scope: 'search' as const,
      address: { key: `public-pages/v1/${path}`, limit: searchShardBytes },
      cachePaths: [cachePath(path)],
      data: directory.index[index],
    };
  });
  const sitemap = {
    scope: 'sitemap' as const,
    address: { key: publicSitemapKey, limit: publicSitemapBytes },
    cachePaths: ['/sitemap.xml'],
    data: directory.sitemap,
  };
  return { lengths, entries: [...packs, ...shards, sitemap] };
}

/** One authority check per batch after observing R2 ETags. A new revocation generation rewrites
 * surviving keys too: an older in-flight rebuild could have ranked the removed project on any page. */
export async function writeDirectoryBatch(
  config: R2Config,
  entries: ReturnType<typeof directoryWritePlan>['entries'],
  generation: number,
  asOf: number,
  isCurrent: () => Promise<boolean>,
  putAttempt?: (order: ExploreOrder | 'search' | 'sitemap') => void,
  revision = asOf,
) {
  return publishSnapshotBatch(
    config,
    entries.map(entry => entry.address),
    async () => {
      if (!(await isCurrent())) return null;
      return entries.map(entry => {
        if ('frames' in entry && entry.frames.length)
          return { state: 'public', generation, asOf, frames: entry.frames, tailRevision: revision };
        if ('data' in entry && entry.data)
          return { state: 'public', generation, asOf, data: entry.data, tailRevision: revision };
        return { state: 'hidden', generation, at: asOf, tailRevision: revision };
      });
    },
    index => putAttempt?.(entries[index]!.scope),
  );
}
