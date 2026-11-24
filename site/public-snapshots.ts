// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { SiteEnv } from './env';
import { escapeHtml } from './public-meta';

export const HANDLE = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/;
export const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/;
const order = /^(active|stars|newest)$/;

export function snapshotAddress(path: string) {
  const relative = path.match(/^\/public\/v1\/((?:project|profile|explore)\/.+)\.json$/)?.[1];
  if (!relative) return null;
  const [kind, first, second, extra] = relative.split('/');
  if (kind === 'project' && first && HANDLE.test(first) && second && SLUG.test(second) && extra === undefined)
    return { key: `public-pages/v1/${relative}.json`, kind, first, second, limit: 64 * 1024 } as const;
  if (kind === 'profile' && first && HANDLE.test(first) && second === undefined)
    return { key: `public-pages/v1/${relative}.json`, kind, first, limit: 24 * 1024 } as const;
  if (kind === 'explore' && first && order.test(first) && second === undefined)
    return { key: `public-pages/v1/${relative}/1.json`, kind, first, limit: 16 * 1024 } as const;
  return null;
}

type Address = NonNullable<ReturnType<typeof snapshotAddress>>;
const record = (value: unknown) =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

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

function content(address: Address, data: Record<string, unknown>) {
  if (data.v !== 1) return null;
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
  if (!Array.isArray(rows) || rows.length > 50) return null;
  if (address.kind === 'profile' && data.handle !== address.first) return null;
  if (address.kind === 'explore' && (data.order !== address.first || !count(data.total))) return null;
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
  const object = await bucket.get(address.key);
  if (!object) return null;
  if (!count(object.size) || object.size > address.limit) throw new Error('Public snapshot is too large.');
  const json = await object.text();
  const data = record(JSON.parse(json));
  const html = data && content(address, data);
  if (!html) throw new Error('Public snapshot does not match its address.');
  return { data, json, html };
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
