// SPDX-License-Identifier: Apache-2.0
// Old addresses (Item d61f36fe): every address the old site served and a person or an agent may still hold, mapped to
// its place in the app. Pure, and built from paths.ts (the app is at the root since Item b0704959; "/-/…" is the
// 301 in site/public-read.ts). A plain path maps with no read. An address that names only ids (`?project=<id>`, `/decisions/<id>`,
// `/review/<id>`) needs one access-checked read (convex/urlLegacy.ts): the page that renders it is OldAddress.tsx.
import { longId } from '../../../src/project-routes';
import { reservedHandles } from '../../../src/readable-urls';
import { hrefFor, type AppRoute } from './paths';

type Dest = { place: Extract<AppRoute, { frame: 'project' }>['place']; section: string; rest: string };
type Ref = { projectId: string } | { handle: string; slug: string };
export type Find = { kind: 'decision' | 'review'; id: string };
export type OldAddress =
  /** Go to `to` (the address without its #hash). */
  | { kind: 'go'; to: string }
  /** Ask the server where `find` (or the project) lives, then go there; `dest` is where the project's own page is,
   * `search` what the new address keeps of the old query. */
  | { kind: 'look'; ref: Ref; find?: Find; dest: Dest; search?: string };

const front: Dest = { place: 'needs', section: '', rest: '' };
const plan = (rest = ''): Dest => ({ place: 'plan', section: '', rest });
const lanes = (rest = ''): Dest => ({ place: 'lanes', section: '', rest });
const projectHref = (handle: string, slug: string, dest: Dest) =>
  hrefFor({ frame: 'project', handle, project: slug, ...dest });

const page = (section: string): Dest => ({ place: 'settings', section, rest: '' });

/** Where an old settings section opens. `account`: the old per-project Devices list is the account's. Contributions
 * (offered work) is dropped with its screen and rebuilt with the fork work (Item d1303286); Lanes is where offered
 * work is reviewed. */
const settings: Record<string, Dest | 'account'> = {
  access: page(''),
  checks: page('checks'),
  autonomy: page('checks'),
  secrets: page('secrets'),
  you: page('you'),
  appearance: page('you'),
  github: page('mirror'),
  general: page('project'),
  sharing: page('project'),
  settings: page('project'),
  project: page('project'),
  backups: page('project'),
  transfer: page('project'),
  agents: page('agents'),
  contributions: lanes(),
  devices: 'account',
};

/** An old `?projectTab=` or `?settingsSection=` page that settles settings. */
const settingsTabs = Object.keys(settings);

type Pick = { dest: Dest; find?: Find; search?: string };

/** An old exact-State pin (`?head=<64 hex>`) is the rebuilt Code place's `?at=`. */
const pin = (value: string | null) => (value && /^[a-f0-9]{64}$/.test(value) ? `?at=${value}` : '');

/** Where the query of an old `?project=<id>` link points inside the project (the old codec: shell/route.ts,
 * src/project-routes.ts cleanUrl). Ids in the query are long already; longId leaves those alone. */
function fromQuery(p: URLSearchParams): Pick {
  const tab = p.get('tab');
  const section = p.get('projectTab');
  const review = p.get('review') || p.get('reviewView');
  const decision = p.get('decision');
  const lane = p.get('lane');
  const settingsId = p.get('settingsSection') || section || '';
  if (review) return { dest: front, find: { kind: 'review', id: longId(review) } };
  if (section === 'decisions' || p.get('workPage') === 'decisions')
    return { dest: plan(), ...(decision && { find: { kind: 'decision' as const, id: longId(decision) } }) };
  if (lane) return { dest: lanes(longId(lane)) };
  if (p.get('viewId')) return { dest: plan() };
  if (p.get('intent') && (tab === 'intents' || section === 'intent' || section === 'activity'))
    return { dest: plan(longId(p.get('intent')!)) };
  if (p.get('planningItem')) return { dest: plan(p.get('planningItem')!) };
  if (p.get('activity') === '1' || section === 'coordination' || section === 'activity')
    return { dest: { place: 'needs', section: 'held', rest: '' } };
  if (tab === 'settings' || settingsTabs.includes(section ?? '')) {
    const home = settings[settingsId];
    // The old devices list is the account's: the project's settings open instead.
    return { dest: home && home !== 'account' ? home : page('') };
  }
  // The dropped code map (`view=map`) opens the Code place.
  if (p.get('view') === 'map') return { dest: { place: 'code', section: '', rest: '' } };
  if (tab === 'code' || section === 'delivery' || (!tab && !section && p.has('file'))) {
    const file = p.get('file');
    return file
      ? { dest: { place: 'code', section: 'files', rest: file }, search: pin(p.get('head')) }
      : { dest: { place: 'code', section: '', rest: '' } };
  }
  if (p.get('workPage') === 'lanes' || section === 'lanes') return { dest: lanes() };
  if (
    p.get('workPage') === 'planning' ||
    p.get('workPage') === 'views' ||
    section === 'planning' ||
    section === 'views'
  )
    return { dest: plan() };
  if (tab === 'intents' || section === 'intent') return { dest: plan() };
  return { dest: front };
}

const dec = (part: string) => {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
};

/**
 * What an old address maps to, or null when it is not an old address (the new app's own, or one that keeps its shape:
 * `/<handle>/<project>`, `.../lanes/<uuid>`, `.../code/...`).
 */
export function oldAddress(pathname: string, search: string): OldAddress | null {
  const parts = pathname.split('/').filter(Boolean).map(dec);
  const params = new URLSearchParams(search);
  const [first = '', second = '', section = '', id = '', ...tail] = parts;
  if (first === '-') return null;
  if (parts.length <= 1 && (first === '' || first === 'projects' || first === 'settings')) {
    // Explore an import, followed imports, source zones and the code map are dropped (Item f2ee8381): Explore covers
    // discovery. Contact (an upstream request) is dropped with contributions and opens the account home.
    if (params.has('codescape') || params.has('zone'))
      return { kind: 'go', to: hrefFor({ frame: 'discover', page: 'explore' }) };
    const projectId = params.get('project');
    if (projectId) {
      const picked = fromQuery(params);
      return {
        kind: 'look',
        ref: { projectId },
        dest: picked.dest,
        ...(picked.find && { find: picked.find }),
        ...(picked.search && { search: picked.search }),
      };
    }
    if (first === '') return null;
    // The old Home keeps its search (a delete-request link carries `request=` and `auth=`).
    const account = first === 'settings' || params.get('surface') === 'account' ? 'people' : 'projects';
    const tail = first === 'projects' && account === 'projects' ? search : '';
    return { kind: 'go', to: hrefFor({ frame: 'account', place: account }) + tail };
  }
  if (parts.length < 3 || reservedHandles.has(first)) return null;
  // An address that is already the new one (`.../settings/you`) is not an old address: no redirect to itself.
  const to = (dest: Dest): OldAddress | null => {
    const href = projectHref(first, second, dest);
    return href === pathname ? null : { kind: 'go', to: href };
  };
  switch (section) {
    case 'activity':
      return to({ place: 'needs', section: 'held', rest: '' });
    case 'intents':
    case 'work':
      return to(plan(id ? longId(id) : ''));
    case 'planning':
      return to(plan(params.get('planningItem') ?? ''));
    case 'views':
      return to(plan());
    case 'decisions':
    case 'review': {
      if (!id) return section === 'decisions' ? to(plan()) : null;
      const find: Find = { kind: section === 'decisions' ? 'decision' : 'review', id: longId(id) };
      return { kind: 'look', ref: { handle: first, slug: second }, find, dest: front };
    }
    case 'code': {
      // `.../code/<path>?head=<State>` keeps its exact State as the rebuilt `?at=`.
      const at = pin(params.get('head'));
      if (!at || !id) return null;
      return {
        kind: 'go',
        to:
          projectHref(first, second, { place: 'code', section: 'files', rest: [id, ...tail].join('/') }) + at,
      };
    }
    case 'lanes':
      // A short id (`l-…`, from the old codec) is not an id the rebuilt Lane page reads.
      return id && longId(id) !== id ? to(lanes([longId(id), ...tail].join('/'))) : null;
    case 'settings': {
      // The old settings screen let `?settingsSection=` override the page in the path.
      const key = params.get('settingsSection') || id;
      const home = key ? settings[key] : undefined;
      if (home === 'account') return { kind: 'go', to: hrefFor({ frame: 'account', place: 'devices' }) };
      return home ? to(home) : null;
    }
    default:
      return null;
  }
}

/** Where a resolved `look` goes: the Lane or Item the server found, else the project's own page. */
export function lookHref(
  look: Extract<OldAddress, { kind: 'look' }>,
  found: { handle: string; slug: string; to: { place: 'lanes' | 'plan'; id: string } | null },
) {
  const dest: Dest = found.to ? { place: found.to.place, section: '', rest: found.to.id } : look.dest;
  return projectHref(found.handle, found.slug, dest) + (look.search ?? '');
}
