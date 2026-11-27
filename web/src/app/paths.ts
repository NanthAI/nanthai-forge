// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// The rebuilt app's addresses (Item 84125787). One codec: every frame, link, key and palette entry builds its href here,
// and the parser is its exact inverse, so a deep link opened in a new tab lands on the same place.
//
// The app is served at the site root (Item b0704959): `/<handle>/<slug>` is both the project's page and the address
// `nforge clone` and bindings store. Its first segments never collide with a handle: every app place and static root
// is in src/readable-urls.ts reservedHandles. The app lived under "/-" before the switch; the cached public read
// (site/public-read.ts) answers every "/-/*" address with a 301 to its root form forever, because mails,
// CLI output and board text carry those links. ROOT stays a name
// so the server's links (src/project-routes.ts APP_ROOT) are pinned to it (tests/approval-links.test.mjs).
export const ROOT = '';

/** src/readable-urls.ts reservedHandles, copied because this module imports nothing (scripts load it as is): app
 * pages, old addresses old-address.ts resolves before the app renders, server and static roots. A first segment here
 * that is not one of the app's pages is no address; tests/app-shell-routes.test.mjs keeps the two lists equal. */
const reserved = new Set([
  'local',
  'settings',
  'projects',
  'api',
  'new',
  'login',
  'logout',
  'import',
  'imports',
  'assets',
  'auth',
  'worker',
  'github',
  'device',
  'approve',
  'explore',
  'agents',
  'account',
  'contact',
  'signin',
  'signup',
  'public',
  'terms',
  'privacy',
  'docs',
]);

export const projectPlaces = ['needs', 'lanes', 'plan', 'code', 'stats', 'settings'] as const;
export type ProjectPlace = (typeof projectPlaces)[number];
export const accountPlaces = ['projects', 'billing', 'people', 'devices', 'data'] as const;
export type AccountPlace = (typeof accountPlaces)[number];

/** Pages of a place. Its first page has no path segment. */
export const placeSections: Record<ProjectPlace, readonly string[]> = {
  needs: [''],
  lanes: ['', 'history', 'touching', 'sessions'],
  plan: [''],
  code: ['files', 'history'],
  stats: [''],
  settings: ['', 'checks', 'secrets', 'mirror', 'agents', 'project', 'you'],
};

export type AppRoute =
  | { frame: 'public'; page: 'signin' | 'passkey' | 'device' | 'terms' | 'privacy' }
  /** An old /approve?project=…&submission=|lane=… link (Item 0a99ab23): looked up once, then replaced by its Lane page. */
  | { frame: 'public'; page: 'approve' }
  | { frame: 'bare'; page: 'new' | 'import' }
  /** Public discovery (Item 8947a779): readable signed out, served from the cached public read. */
  | { frame: 'discover'; page: 'explore' }
  | { frame: 'discover'; page: 'profile'; handle: string }
  | { frame: 'account'; place: AccountPlace }
  | {
      frame: 'project';
      handle: string;
      project: string;
      place: ProjectPlace;
      /** A page of the place, or '' for its first page. */
      section: string;
      /** What the section shows: a Lane or Item id; for Code a landing's receipt id or red/<sequence> (one main
       * red), or under files a path. */
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

/** First path segments the site serves itself, never the app: the built documentation, its assets, and "-" (the
 * cached public read at /-/public/v1/ and the 301 from every earlier /-/ address). */
const siteRoots = new Set(['docs', 'assets', '-']);

/** Whether the app serves this address. `/` is the static public page (web/index.html); a first segment with a dot
 * is a file (llms.txt, favicon.svg); handles and slugs never contain one. */
export function isAppPath(pathname: string) {
  const first = pathname.split('/')[1] ?? '';
  return (
    pathname.startsWith('/') && first !== '' && !first.includes('.') && !siteRoots.has(first.toLowerCase())
  );
}

/** An address from when the app lived under "/-" (before Item b0704959) as its address now, else null. The bare "/-"
 * was the account home; the cached public read keeps its data under /-/public/v1/ and answers the same 301 (site/public-read.ts). */
export function earlierAppPath(pathname: string) {
  const rest = /^\/+-(?=\/|$)(.*)$/.exec(pathname)?.[1];
  if (rest === undefined || /^\/+public\/v1\//.test(rest)) return null;
  // One leading "/" only: "/-//host" or "/-/\\host" must stay on this site, never become "//host".
  return /^[/\\]*$/.test(rest) ? '/account' : rest.replace(/^[/\\]+/, '/');
}

/** The CDN can forward `//account` while the browser keeps its doubled slash; the app reads it as `/account`. */
export function normalizeAccountPathname(pathname: string) {
  return pathname.replace(/^\/{2,}(?=account(?:\/|$))/, '/');
}

export function deleteRequestHref(requestId: string) {
  const search = new URLSearchParams({ request: requestId });
  return `${hrefFor({ frame: 'account', place: 'projects' })}?${search}`;
}

/** The sign-in page, keeping where to return. */
export function signInHref(next?: string) {
  const search = new URLSearchParams();
  if (next) search.set('next', next);
  const query = search.toString();
  return hrefFor({ frame: 'public', page: 'signin' }) + (query ? `?${query}` : '');
}

export function hrefFor(route: AppRoute): string {
  switch (route.frame) {
    case 'public':
      return `${ROOT}/${route.page === 'passkey' ? 'signin/passkey' : route.page}`;
    case 'bare':
      return route.page === 'import' ? `${ROOT}/new/import` : `${ROOT}/new`;
    case 'discover':
      return route.page === 'explore' ? `${ROOT}/explore` : `${ROOT}/${enc(route.handle)}`;
    case 'account':
      return [`${ROOT}/account`, accountSegment[route.place]].filter(Boolean).join('/');
    case 'project': {
      const parts = [ROOT, enc(route.handle), enc(route.project)];
      const place = placeSegment[route.place];
      if (place) parts.push(place);
      if (route.section) parts.push(enc(route.section));
      // A detail (a Lane, an Item, a file) follows; detail ids never equal a section name.
      if (route.rest) parts.push(...route.rest.split('/').map(enc));
      return parts.join('/');
    }
    case 'missing':
      return route.path;
  }
}

export function needsSectionHref(handle: string, project: string, section: 'fyi' | 'loose-ends') {
  return `${hrefFor({ frame: 'project', handle, project, place: 'needs', section: '', rest: '' })}?view=needs#${section}`;
}

/** Discovery links keep the public front page when the visitor signs in. The ordinary root still opens Needs me. */
export function publicProjectHref(handle: string, project: string) {
  return `${hrefFor({ frame: 'project', handle, project, place: 'needs', section: '', rest: '' })}?view=public`;
}

/** `view=public` keeps the front page after sign-in; `view=needs` (an approval link, Item 0a99ab23) asks for the
 * owner's Needs me, so a signed-out reader signs in first. */
export function isPublicProjectView(route: AppRoute, signedIn: boolean, view: string | null) {
  if (route.frame !== 'project') return false;
  if (route.place === 'code') return !signedIn;
  return (
    route.place === 'needs' &&
    !route.section &&
    !route.rest &&
    (signedIn ? view === 'public' : view !== 'needs')
  );
}

export function parseAppPath(pathname: string): AppRoute {
  if (!isAppPath(pathname)) return { frame: 'missing', path: pathname };
  const parts = pathname.split('/').filter(Boolean).map(dec);
  const [first, second, ...more] = parts;
  if (first === 'account') {
    const place = accountPlaces.find(name => accountSegment[name] === (second ?? ''));
    return place && more.length === 0 ? { frame: 'account', place } : { frame: 'missing', path: pathname };
  }
  if (first === 'signin' && !second) return { frame: 'public', page: 'signin' };
  if (first === 'signin' && second === 'passkey' && !more.length) return { frame: 'public', page: 'passkey' };
  if (first === 'device' && !second) return { frame: 'public', page: 'device' };
  if (first === 'approve' && !second) return { frame: 'public', page: 'approve' };
  if ((first === 'terms' || first === 'privacy') && !second) return { frame: 'public', page: first };
  if (first === 'new' && !second) return { frame: 'bare', page: 'new' };
  if (first === 'new' && second === 'import' && !more.length) return { frame: 'bare', page: 'import' };
  if (first === 'explore')
    return second ? { frame: 'missing', path: pathname } : { frame: 'discover', page: 'explore' };
  // An old address (`/projects`, `/settings`, `/local/…`) is resolved before the app renders (old-address.ts); any
  // other reserved first segment is never a handle.
  // Handles are lower case: /Account or /DOCS is a reserved place in another case, never a person; '-' is never one.
  if (!first || first === '-' || reserved.has(first.toLowerCase()))
    return { frame: 'missing', path: pathname };
  if (!second) return { frame: 'discover', page: 'profile', handle: first };
  const [segment = '', ...tail] = more;
  const place =
    segment === 'needs-me'
      ? 'needs'
      : projectPlaces.find(name => placeSegment[name] === segment && name !== 'needs');
  if (segment && !place) return { frame: 'missing', path: pathname };
  const resolved: ProjectPlace = place ?? 'needs';
  if (resolved === 'code') {
    // Files is the ordinary entry. A receipt keeps its short URL, and older bare file paths still open.
    if (tail.length === 1 && tail[0] === 'history') return project(first, second, 'code', 'history', '');
    if (tail[0] === 'files') return project(first, second, 'code', 'files', tail.slice(1).join('/'));
    if (tail.length === 1 && receiptShape.test(tail[0]!)) return project(first, second, 'code', '', tail[0]!);
    // One main red (ae068e0c): red/<audit event sequence>, the view a Main broke row's Why opens. An old bare file
    // link to a file at red/<digits> opens this view instead; file links have used files/ since that form.
    if (tail.length === 2 && tail[0] === 'red' && /^\d{1,15}$/.test(tail[1]!))
      return project(first, second, 'code', '', `red/${tail[1]}`);
    return project(first, second, 'code', 'files', tail.join('/'));
  }
  const [named = '', ...detail] = tail;
  // History replaced To read (Item c613e6bc): the old address opens History, and the screen corrects the address.
  const maybeSection = resolved === 'lanes' && named === 'to-read' ? 'history' : named;
  if (placeSections[resolved].includes(maybeSection))
    return project(first, second, resolved, maybeSection, detail.join('/'));
  // Needs me and Stats have no detail pages; anything else after them is not an address.
  if (resolved === 'needs' || resolved === 'stats') return { frame: 'missing', path: pathname };
  return project(first, second, resolved, '', tail.join('/'));
}

function project(handle: string, name: string, place: ProjectPlace, section: string, rest: string): AppRoute {
  return { frame: 'project', handle, project: name, place, section, rest };
}
