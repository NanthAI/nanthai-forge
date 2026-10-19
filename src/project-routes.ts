// SPDX-License-Identifier: Apache-2.0
/** A reversible URL codec. Work UUIDs use 22 URL-safe characters; no lookup or truncation collisions. */
export function shortId(id: string, kind: string): string {
  if (!/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(id)) return id;
  const bytes = id
    .replaceAll('-', '')
    .match(/../g)!
    .map(byte => String.fromCharCode(parseInt(byte, 16)))
    .join('');
  return `${kind}-${btoa(bytes).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')}`;
}
export function longId(id: string): string {
  if (!/^[ilv]-[\w-]{22}$/.test(id)) return id;
  try {
    const hex = [...atob(id.slice(2).replaceAll('-', '+').replaceAll('_', '/') + '==')]
      .map(byte => byte.charCodeAt(0).toString(16).padStart(2, '0'))
      .join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  } catch {
    return id;
  }
}
export const slug = (name: string) =>
  name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'project';
let mode: 'local' | 'hosted' = 'local';
let localName = 'project';
const projects = new Map<string, { owner: string; name: string; slug: string }>();
const routeProjects = new Map<string, string>();
export function hostedProjectRoot(handle: string, projectSlug: string) {
  return `/${encodeURIComponent(handle)}/${encodeURIComponent(projectSlug)}`;
}
export function projectRouteIdentity(href: string) {
  const url = new URL(href),
    parts = segments(url);
  if (parts.length < 2 || reservedRoots.has(parts[0]!)) return null;
  return { handle: parts[0]!, slug: parts[1]! };
}
const reservedRoots = new Set(['assets', 'device', 'settings', 'local', 'api']);
export function routeMode(value: 'local' | 'hosted') {
  mode = value;
}
export function projectIdentity(
  id: string,
  owner: string,
  name: string,
  projectSlug = slug(name),
  alias?: { handle: string; slug: string },
) {
  projects.set(id, { owner, name, slug: projectSlug });
  routeProjects.set(hostedProjectRoot(owner, projectSlug).toLowerCase(), id);
  if (alias) routeProjects.set(hostedProjectRoot(alias.handle, alias.slug).toLowerCase(), id);
}
export function localIdentity(name: string) {
  localName = name;
}
const enc = encodeURIComponent;
const segments = (url: URL) => url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
const projectKeys = [
  'tab',
  'surface',
  'collection',
  'project',
  'projectTab',
  'intent',
  'lane',
  'review',
  'reviewView',
  'viewId',
  'workPage',
  'legacy',
  'classic',
  'intentTab',
  'projectHome',
  'settingsSection',
];
/** Presentation state for old and new callers. Never use this for authority or source pins. */
export function routeUrlState(href = typeof location === 'undefined' ? 'http://local/' : location.href): URL {
  const url = new URL(href),
    parts = segments(url),
    p = url.searchParams;
  const lineAnchor = /^#L([1-9]\d*)$/.exec(url.hash);
  if (lineAnchor) p.set('line', lineAnchor[1]!);
  if (url.pathname === '/settings') {
    if (!p.has('surface')) p.set('surface', 'account');
    url.pathname = '/';
    return url;
  }
  if (parts.length < 2 || ['assets', 'device', 'settings'].includes(parts[0]!)) return url;
  const original = new URLSearchParams(p);
  const [owner, project] = parts;
  const explicitDestination = original.has('tab') || original.has('projectTab');
  const section = explicitDestination ? undefined : parts[2];
  const id = explicitDestination ? undefined : parts[3];
  const tail = parts.slice(4);
  if (owner === 'local') {
    p.set(
      'tab',
      section === 'code'
        ? 'code'
        : section === 'settings'
          ? 'settings'
          : !section || section === 'activity'
            ? 'now'
            : 'intents',
    );
  } else {
    const projectId = project!.includes('~')
      ? project!.split('~').at(-1)!
      : routeProjects.get(hostedProjectRoot(owner!, project!).toLowerCase());
    if (!projectId) return url;
    p.set('project', projectId);
    p.set('surface', 'projects');
    p.set('collection', 'projects');
  }
  const sectionKey = owner === 'local' ? 'workPage' : 'projectTab';
  if (!section) p.set(sectionKey, owner === 'local' ? 'intents' : 'overview');
  if (section === 'activity') {
    p.set(sectionKey, 'coordination');
    p.set('activity', '1');
  }
  if (section === 'intents' || section === 'work') {
    p.set(sectionKey, owner === 'local' ? 'intents' : 'intent');
    if (id) p.set('intent', longId(id));
  }
  if (section === 'lanes') {
    p.set(sectionKey, 'lanes');
    if (id) p.set('lane', longId(id));
  }
  if (section === 'views') {
    p.set(sectionKey, id ? 'views' : owner === 'local' ? 'intents' : 'intent');
    if (id) p.set('viewId', longId(id));
  }
  if (section === 'review' && id) {
    p.set(sectionKey, 'intent');
    p.set('intentTab', 'delivery');
    p.set(owner === 'local' ? 'review' : 'reviewView', longId(id));
  }
  if (section === 'planning') p.set(sectionKey, 'planning');
  if (section === 'settings') {
    const settingsId =
      ({ project: 'general', sharing: 'general', settings: 'general' } as Record<string, string>)[id ?? ''] ??
      id ??
      'general';
    p.set(
      sectionKey,
      owner === 'local'
        ? settingsId
        : settingsId === 'general'
          ? 'settings'
          : settingsId === 'access'
            ? 'sharing'
            : settingsId,
    );
    p.set('settingsSection', settingsId);
  }
  if (section === 'code') {
    p.set(sectionKey, 'delivery');
    if (id) {
      p.set('file', [id, ...tail].join('/'));
      p.set('view', 'source');
    }
  }
  for (const [key, value] of original) p.set(key, value);
  url.pathname = '/';
  return url;
}
export function routeSearch() {
  return routeUrlState().search;
}
/** Canonicalize every legacy destination, retaining unrelated source pins, filters and drafts. */
export function cleanUrl(
  input: string | URL,
  base = typeof location === 'undefined' ? 'http://local/' : location.href,
  context?: {
    mode?: 'local' | 'hosted';
    localName?: string;
    project?: { id: string; owner: string; name: string; slug?: string };
  },
): string {
  if (context?.project)
    projectIdentity(context.project.id, context.project.owner, context.project.name, context.project.slug);
  const raw = new URL(input, base);
  if (
    raw.origin !== new URL(base).origin ||
    raw.pathname === '/device' ||
    raw.pathname.startsWith('/assets/')
  )
    return raw.href;
  const url = routeUrlState(raw.href),
    p = url.searchParams;
  if (p.has('codescape') || p.has('zone')) return raw.href;
  if (!p.has('viewId')) {
    if (p.get('workPage') === 'views') p.set('workPage', 'intents');
    if (p.get('projectTab') === 'views') p.set('projectTab', 'intent');
  }
  const project = p.get('project');
  if ((context?.mode ?? mode) === 'hosted' && !project) {
    if (projectRouteIdentity(raw.href)) return raw.pathname + raw.search + raw.hash;
    const surface = p.get('surface');
    if (surface === 'contact') return raw.href;
    url.pathname = surface === 'account' ? '/settings' : '/';
    for (const key of projectKeys) p.delete(key);
    return url.pathname + url.search + url.hash;
  }
  const known =
    context?.project?.id === project ? context.project : project ? projects.get(project) : undefined;
  // Unresolved legacy query links stay intact until the access-checked identity read completes.
  if (project && !known) return raw.pathname + raw.search + raw.hash;
  const root = project
    ? hostedProjectRoot(known!.owner, known!.slug ?? slug(known!.name))
    : `/local/${enc(context?.localName ?? localName)}`;
  const tab = p.get('tab'),
    section = p.get('projectTab');
  let path = '';
  const lane = p.get('lane') || (p.has('legacy') || p.get('view') === 'work' ? p.get('laneId') : null);
  const review = p.get('review') || p.get('reviewView');
  if (review) path = `/review/${enc(shortId(review, 'v'))}`;
  else if (lane && (tab === 'intents' || section === 'lanes' || p.has('legacy') || p.get('view') === 'work'))
    path = `/lanes/${enc(shortId(lane, 'l'))}`;
  else if (p.get('viewId')) path = `/views/${enc(shortId(p.get('viewId')!, 'v'))}`;
  else if (p.get('intent') && (tab === 'intents' || section === 'intent' || section === 'activity'))
    path = `/intents/${enc(shortId(p.get('intent')!, 'i'))}`;
  else if (p.get('activity') === '1' || section === 'coordination' || section === 'activity')
    path = '/activity';
  else if (
    tab === 'settings' ||
    [
      'sharing',
      'agents',
      'backups',
      'settings',
      'general',
      'autonomy',
      'checks',
      'access',
      'you',
      'appearance',
      'devices',
      'contributions',
      'transfer',
      'github',
    ].includes(section ?? '')
  )
    path = `/settings/${enc(p.get('settingsSection') || ({ sharing: 'general', settings: 'general' } as Record<string, string>)[section ?? ''] || section || 'general')}`;
  else if (
    tab === 'code' ||
    section === 'delivery' ||
    (!tab && !section && (p.has('file') || p.has('document') || (p.has('view') && p.get('view') !== 'work')))
  )
    path = '/code' + (p.get('file') ? '/' + p.get('file')!.split('/').map(enc).join('/') : '');
  else if (p.get('workPage') === 'lanes' || section === 'lanes') path = '/lanes';
  else if (p.get('workPage') === 'views' || section === 'views') path = '/views';
  else if (p.get('workPage') === 'planning' || section === 'planning') path = '/planning';
  else if (
    tab === 'intents' ||
    section === 'intent' ||
    p.get('view') === 'work' ||
    p.has('legacy') ||
    p.has('classic')
  )
    path = '/intents';
  for (const key of projectKeys) p.delete(key);
  if (path.startsWith('/lanes/') && p.get('laneId') === lane) p.delete('laneId');
  p.delete('activity');
  p.delete('settingsSection');
  if (path.startsWith('/code/')) p.delete('file');
  if (p.get('view') === 'work') p.delete('view');
  url.pathname = root + path;
  return url.pathname + url.search + url.hash;
}
/** A primary link must work in a new tab as well as through the in-place click handler. */
export function projectNavigationHref(
  tab: string,
  href = typeof location === 'undefined' ? 'http://local/' : location.href,
) {
  const url = routeUrlState(href);
  for (const key of [
    'intent',
    'lane',
    'review',
    'reviewView',
    'viewId',
    'workPage',
    'legacy',
    'classic',
    'intentTab',
    'activity',
  ])
    url.searchParams.delete(key);
  if (url.searchParams.has('project')) {
    url.searchParams.delete('tab');
    url.searchParams.set(
      'projectTab',
      (
        { now: 'overview', intents: 'intent', code: 'delivery', settings: 'sharing' } as Record<
          string,
          string
        >
      )[tab] ?? 'overview',
    );
  } else url.searchParams.set('tab', tab);
  return cleanUrl(url, href);
}

/** Install once, before React. Both old page controls and new links use the same canonical codec. */
export function installRoutes(hosted: boolean) {
  routeMode(hosted ? 'hosted' : 'local');
  for (const key of ['pushState', 'replaceState'] as const) {
    const original = history[key].bind(history);
    history[key] = (data, unused, url) => original(data, unused, url == null ? url : cleanUrl(String(url)));
  }
  history.replaceState(history.state, '', cleanUrl(location.href));
}
