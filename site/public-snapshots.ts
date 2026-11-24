// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { SiteEnv } from './env';
import { escapeHtml } from './public-meta';
import { publicSitemapBytes, publicSitemapKey, sitemapXml } from '../src/public-sitemap';
import {
  explorePageSize,
  explorePageBytes,
  explorePackAddress,
  explorePackBytes,
  searchShardBytes,
  validSlice,
  readSearchShard,
} from '../src/public-explore-pages';
import {
  HANDLE,
  SLUG,
  snapshotCount as count,
  snapshotFence,
  snapshotRecord as record,
} from '../src/public-snapshot-contract';

const order = /^(active|stars|newest)$/;

export function snapshotAddress(path: string) {
  if (path === '/public/v1/sitemap.xml')
    return { key: publicSitemapKey, kind: 'sitemap', limit: publicSitemapBytes } as const;
  const relative = path.match(/^\/public\/v1\/((?:project|profile|explore|search)\/.+)\.json$/)?.[1];
  if (!relative) return null;
  const [kind, first, second, extra] = relative.split('/');
  if (kind === 'project' && first && HANDLE.test(first) && second && SLUG.test(second) && extra === undefined)
    return { key: `public-pages/v1/${relative}.json`, kind, first, second, limit: 64 * 1024 } as const;
  if (kind === 'profile' && first && HANDLE.test(first) && second === undefined)
    return { key: `public-pages/v1/${relative}.json`, kind, first, limit: 24 * 1024 } as const;
  if (
    kind === 'search' &&
    first &&
    /^[1-9][0-9]*$/.test(first) &&
    Number.isSafeInteger(Number(first)) &&
    second === undefined
  )
    return {
      key: `public-pages/v1/${relative}.json`,
      kind,
      shard: Number(first),
      limit: searchShardBytes,
    } as const;
  if (kind === 'explore' && first && order.test(first) && extra === undefined) {
    const page = second === undefined ? 1 : Number(second);
    if (second !== undefined && (!Number.isSafeInteger(page) || page < 2 || String(page) !== second))
      return null;
    return {
      ...explorePackAddress(first, page),
      kind,
      first,
      page,
      limit: explorePageBytes,
    } as const;
  }
  return null;
}

type Address = NonNullable<ReturnType<typeof snapshotAddress>>;
/** The static representation only consumes redacted facts. Every string from the snapshot is escaped;
 * links are composed from validated handles/slugs, never copied from stored HTML or URLs. */
function project(value: unknown) {
  const row = record(value);
  if (
    !row ||
    typeof row.handle !== 'string' ||
    !HANDLE.test(row.handle) ||
    typeof row.slug !== 'string' ||
    !SLUG.test(row.slug) ||
    typeof row.name !== 'string'
  )
    return null;
  return { handle: row.handle, slug: row.slug, name: row.name };
}

function deploymentOrigin(value: unknown) {
  const url = typeof value === 'string' && URL.parse(value);
  return (
    url &&
    url.origin === value &&
    (url.protocol === 'https:' ||
      (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
  );
}

function content(address: Address, data: Record<string, unknown>) {
  if (address.kind === 'sitemap') {
    const rows = data.projects;
    if (
      !Array.isArray(rows) ||
      !rows.every(
        row =>
          Array.isArray(row) &&
          row.length === 2 &&
          typeof row[0] === 'string' &&
          HANDLE.test(row[0]) &&
          typeof row[1] === 'string' &&
          SLUG.test(row[1]),
      )
    )
      return null;
    return '';
  }
  if (address.kind === 'search') {
    const shard = readSearchShard(data);
    return shard?.shard === address.shard && deploymentOrigin(shard.deployment) ? '' : null;
  }
  if (address.kind === 'project') {
    const row = project(data.project);
    const activity = record(data.activity);
    const lanes = record(data.lanes);
    const plan = record(data.plan);
    if (
      !row ||
      row.handle !== address.first ||
      row.slug !== address.second ||
      !count(data.stars) ||
      !activity ||
      !count(activity.landings) ||
      (activity.main !== 'passing' && activity.main !== 'unchecked') ||
      !lanes ||
      !count(lanes.open) ||
      !plan ||
      typeof plan.shown !== 'boolean'
    )
      return null;
    const main = activity.main === 'passing' ? 'Main is passing.' : 'Main is not checked.';
    return `<h1>${row.handle}/${escapeHtml(row.name)}</h1><p>${main} ${activity.landings} landings this week; ${lanes.open} open Lanes.</p><a href="/${row.handle}/${row.slug}/code">Code</a>`;
  }
  const rows = data.projects;
  if (!Array.isArray(rows) || rows.length > explorePageSize) return null;
  if (address.kind === 'profile' && data.handle !== address.first) return null;
  if (address.kind === 'explore') {
    if (
      data.order !== address.first ||
      data.page !== address.page ||
      (data.start === 0) !== (address.page === 1) ||
      data.search !== true ||
      !validSlice({ total: data.total, start: data.start, more: data.more }, rows.length) ||
      !deploymentOrigin(data.deployment)
    )
      return null;
  }
  const title = address.kind === 'profile' ? `@${address.first}` : 'Explore public projects';
  const links = [];
  for (const value of rows) {
    const row = project(value);
    if (!row || (address.kind === 'profile' && row.handle !== address.first)) return null;
    links.push(`<li><a href="/${row.handle}/${row.slug}">${row.handle}/${escapeHtml(row.name)}</a></li>`);
  }
  return `<h1>${title}</h1><ul>${links.join('')}</ul>`;
}

export async function readSnapshot(bucket: NonNullable<SiteEnv['PUBLIC_PAGES']>, address: Address) {
  const range = address.kind === 'explore' ? address.range : undefined;
  const object = await bucket.get(address.key, range ? { range } : undefined);
  if (!object) return null;
  let json: string;
  if (range) {
    // R2 reports the whole object size plus the range it actually returned. Never consume a full pack.
    if (
      object.size !== explorePackBytes ||
      object.range?.offset !== range.offset ||
      object.range?.length !== range.length
    )
      throw new Error('Invalid public snapshot range.');
    const frame = await object.arrayBuffer();
    if (frame.byteLength !== range.length) throw new Error('Incomplete public snapshot frame.');
    json = new TextDecoder('utf-8', { fatal: true }).decode(frame).trimEnd();
  } else {
    if (!count(object.size) || object.size > address.limit) throw new Error('Public snapshot is too large.');
    json = await object.text();
  }
  const data = record(JSON.parse(json));
  const fence = data && snapshotFence(data);
  if (!data || !fence) throw new Error('Public snapshot has no visibility fence.');
  if (fence.state === 'hidden') return null;
  const html = content(address, data);
  if (html === null) throw new Error('Public snapshot does not match its address or visibility fence.');
  return { data, json, html };
}

export async function readSitemap(bucket: NonNullable<SiteEnv['PUBLIC_PAGES']>, origin: string) {
  const snapshot = await readSnapshot(bucket, {
    key: publicSitemapKey,
    kind: 'sitemap',
    limit: publicSitemapBytes,
  });
  if (!snapshot) return null;
  return sitemapXml(
    origin,
    (snapshot.data.projects as [string, string][]).map(([handle, slug]) => ({ handle, slug })),
  );
}

/** No executable inline script, and no new CSP exception. React takes over the root; the separately inert
 * document payload lets it use the exact page data without a second request. */
export function withSnapshot(shell: string, path: string, snapshot: { json: string; html: string } | null) {
  return shell.replace(
    '<div id="root"></div>',
    () =>
      `<div id="root">${snapshot ? `<main class="pubwide" id="main">${snapshot.html}</main>` : ''}</div>` +
      `<template id="forge-public-snapshot" data-path="${escapeHtml(path)}">${escapeHtml(snapshot?.json ?? 'null')}</template>`,
  );
}
