// SPDX-License-Identifier: Apache-2.0
import { invariant } from './errors.js';
import { cleanUrl } from './project-routes.js';

export type LinkInput = {
  laneId?: string | undefined;
  viewId?: string | undefined;
  save?: string | undefined;
  path?: string | undefined;
  line?: number | undefined;
};
export function buildAgentLinks(
  input: LinkInput & {
    head: string;
    projectUrl?: string;
    projectId?: string;
    owner?: string;
    slug?: string;
    name: string;
  },
) {
  const make = (base: string) => {
    const url = new URL(base);
    url.pathname = '/';
    url.search = '';
    const params = url.searchParams;
    params.set('project', input.projectId!);
    if (input.path || input.save || input.laneId) {
      params.set('projectTab', 'delivery');
      if (input.path) {
        params.set('file', input.path);
        params.set('view', 'source');
      }
      params.set('head', input.head);
    } else if (input.viewId) params.set('viewId', input.viewId);
    if (input.line) {
      params.set('line', String(input.line));
      if (!url.hash) url.hash = 'L' + input.line;
    }
    const parts = new URL(base).pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const owner =
      input.owner ?? (parts[1] && !parts[1].includes('~') && parts[0] !== 'projects' ? parts[0] : undefined);
    invariant(
      owner && input.projectId,
      'HOST_IDENTITY_REQUIRED',
      'Read the hosted project owner before building its URL.',
    );
    const slug = input.slug ?? (parts[1] && !parts[1].includes('~') ? parts[1] : undefined);
    invariant(slug, 'HOST_IDENTITY_REQUIRED', 'Read the hosted project slug before building its URL.');
    const project = { id: input.projectId, owner, name: input.name, slug };
    return new URL(cleanUrl(url, base, { mode: 'hosted', project }), base).href;
  };
  const hosted = input.projectUrl ? make(input.projectUrl) : null;
  return { hosted, preferred: hosted, pinned: !!hosted || !!input.viewId || !!input.save };
}
