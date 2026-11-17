// SPDX-License-Identifier: Apache-2.0
// The rebuilt app's addresses (Item 84125787). One codec: every frame, link, key and palette entry builds its href here,
// and the parser is its exact inverse, so a deep link opened in a new tab lands on the same place.
//
// While the old screens and their sign-in still serve the existing addresses, the rebuilt app lives under ROOT ("/-").
// "-" can never be an account handle (src/readable-urls.ts), so no project address can collide with it. When the old
// shell is removed, ROOT becomes "" and "/-/*" redirects to "/:splat"; nothing else changes.
export const ROOT = '/-';

export const projectPlaces = ['needs', 'lanes', 'plan', 'code', 'stats', 'settings'] as const;
export type ProjectPlace = (typeof projectPlaces)[number];
export const accountPlaces = ['projects', 'billing', 'people', 'devices', 'data'] as const;
export type AccountPlace = (typeof accountPlaces)[number];

/** Sections of one place: the section strip. The first is the place itself (no path segment). */
export const placeSections: Record<ProjectPlace, readonly string[]> = {
  needs: ['', 'held', 'loose-ends'],
  lanes: ['', 'to-read', 'touching', 'sessions'],
  plan: ['', 'initiatives'],
  code: ['', 'files'],
  stats: [''],
  settings: ['', 'checks', 'secrets', 'project', 'you'],
};

export type AppRoute =
  | { frame: 'public'; page: 'signin' | 'passkey' | 'device' }
  | { frame: 'bare'; page: 'new' }
  | { frame: 'account'; place: AccountPlace }
  | {
      frame: 'project';
      handle: string;
      project: string;
      place: ProjectPlace;
      /** A section of the place (a strip entry), or '' for the place itself. */
      section: string;
      /** What the section shows: a Lane or Item id; for Code a landing's receipt id, or under files a path. */
      rest: string;
    }
  | { frame: 'missing'; path: string };

const placeSegment: Record<ProjectPlace, string> = {
  needs: '',
  lanes: 'lanes',
  plan: 'plan',
  code: 'code',
  stats: 'stats',
  settings: 'settings',
};
const accountSegment: Record<AccountPlace, string> = {
  projects: '',
  billing: 'billing',
  people: 'people',
  devices: 'devices',
  data: 'data',
};
const enc = (part: string) => encodeURIComponent(part);
const receiptShape = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const dec = (part: string) => {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
};

export function isAppPath(pathname: string) {
  return pathname === ROOT || pathname.startsWith(`${ROOT}/`);
}

export function hrefFor(route: AppRoute): string {
  switch (route.frame) {
    case 'public':
      return `${ROOT}/${route.page === 'passkey' ? 'signin/passkey' : route.page}`;
    case 'bare':
      return `${ROOT}/new`;
    case 'account':
      return [`${ROOT}/account`, accountSegment[route.place]].filter(Boolean).join('/');
    case 'project': {
      const parts = [ROOT, enc(route.handle), enc(route.project)];
      const place = placeSegment[route.place];
      // Needs me is the project's front page; its sections sit under needs-me/.
      if (place) parts.push(place);
      else if (route.section) parts.push('needs-me');
      if (route.section) parts.push(enc(route.section));
      // A detail (a Lane, an Item, a file) follows; detail ids never equal a section name.
      if (route.rest) parts.push(...route.rest.split('/').map(enc));
      return parts.join('/');
    }
    case 'missing':
      return route.path;
  }
}

export function parseAppPath(pathname: string): AppRoute {
  if (!isAppPath(pathname)) return { frame: 'missing', path: pathname };
  const parts = pathname.slice(ROOT.length).split('/').filter(Boolean).map(dec);
  const [first, second, ...more] = parts;
  if (!first || first === 'account') {
    const place = accountPlaces.find(name => accountSegment[name] === (second ?? ''));
    return place && more.length === 0 ? { frame: 'account', place } : { frame: 'missing', path: pathname };
  }
  if (first === 'signin' && !second) return { frame: 'public', page: 'signin' };
  if (first === 'signin' && second === 'passkey' && !more.length) return { frame: 'public', page: 'passkey' };
  if (first === 'device' && !second) return { frame: 'public', page: 'device' };
  if (first === 'new' && !second) return { frame: 'bare', page: 'new' };
  if (!second) return { frame: 'missing', path: pathname };
  const [segment = '', ...tail] = more;
  const place =
    segment === 'needs-me'
      ? 'needs'
      : projectPlaces.find(name => placeSegment[name] === segment && name !== 'needs');
  if (segment && !place) return { frame: 'missing', path: pathname };
  const resolved: ProjectPlace = place ?? 'needs';
  if (resolved === 'code') {
    // What landed, or one landing's receipt; files/… is a folder or a file. A bare path (an older link) is a file.
    if (tail[0] === 'files') return project(first, second, 'code', 'files', tail.slice(1).join('/'));
    if (tail.length === 1 && receiptShape.test(tail[0]!)) return project(first, second, 'code', '', tail[0]!);
    return project(first, second, 'code', tail.length ? 'files' : '', tail.join('/'));
  }
  const [maybeSection = '', ...detail] = tail;
  if (placeSections[resolved].includes(maybeSection))
    return project(first, second, resolved, maybeSection, detail.join('/'));
  // Needs me and Stats have no detail pages; anything else after them is not an address.
  if (resolved === 'needs' || resolved === 'stats') return { frame: 'missing', path: pathname };
  return project(first, second, resolved, '', tail.join('/'));
}

function project(handle: string, name: string, place: ProjectPlace, section: string, rest: string): AppRoute {
  return { frame: 'project', handle, project: name, place, section, rest };
}

/** The existing screen that still serves a place until its rebuilt screen lands (stage C). Never under ROOT. */
export function currentScreenHref(route: AppRoute): string | null {
  if (route.frame === 'account')
    return {
      projects: '/projects',
      billing: null,
      people: '/settings',
      devices: '/settings',
      data: '/settings',
    }[route.place];
  if (route.frame !== 'project') return null;
  const root = `/${enc(route.handle)}/${enc(route.project)}`;
  switch (route.place) {
    case 'needs':
      return route.section === 'held' ? `${root}/activity` : root;
    case 'lanes':
      return route.rest ? `${root}/lanes/${enc(route.rest)}` : `${root}/lanes`;
    case 'plan':
      return `${root}/planning`;
    case 'code':
      return route.section === 'files' && route.rest
        ? `${root}/code/${route.rest.split('/').map(enc).join('/')}`
        : `${root}/code`;
    case 'stats':
      return null;
    case 'settings':
      return `${root}/settings/${{ '': 'access', checks: 'checks', secrets: 'general', project: 'general', you: 'you' }[route.section] ?? 'general'}`;
  }
}
