// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { hrefFor } from '../../web/src/app/paths.ts';
import { ShotError } from './options.mjs';

const projectPlaces = {
  now: 'needs',
  intents: 'plan',
  planning: 'plan',
  initiative: 'plan',
  lanes: 'lanes',
  lane: 'lanes',
  code: 'code',
  stats: 'stats',
  settings: 'settings',
};
const settingsSections = { access: '', checks: 'checks', github: 'mirror' };

export function passkeyDestination(base, project, page, { diffFile, intentLayout } = {}) {
  const [kind, id] = page.split(':');
  const url = route => new URL(hrefFor(route), base);
  if (kind === 'device') return url({ frame: 'public', page: 'device' }).href;
  if (kind === 'home' || page === 'settings:devices')
    return url({ frame: 'account', place: kind === 'home' ? 'projects' : 'devices' }).href;
  const place = projectPlaces[kind];
  if (!place || (kind === 'settings' && id && !Object.hasOwn(settingsSections, id)))
    throw new ShotError('The requested page is not one of the rebuilt screens.');
  const target = url({
    frame: 'project',
    handle: project.handle,
    project: project.slug,
    place,
    section: kind === 'code' ? 'files' : kind === 'settings' ? (settingsSections[id] ?? '') : '',
    rest: (kind === 'code' ? diffFile : kind === 'settings' ? undefined : id) ?? '',
  });
  if (kind === 'intents' && intentLayout === 'board') target.searchParams.set('view', 'board');
  return target.href;
}

/** The rebuilt Lane page opens a file before fetching its body. The summary is the real user entry point. */
export function passkeyLaneFile(page, file) {
  const summaries = page.locator('.lr-file details > summary');
  return file ? summaries.filter({ has: page.getByTitle(file, { exact: true }) }) : summaries.first();
}
