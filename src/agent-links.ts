// SPDX-License-Identifier: Apache-2.0
import { makeFunctionReference } from 'convex/server';
import { coordinationClient } from './coordination-client.js';
import { cleanUrl } from './project-routes.js';
import { basename } from 'node:path';
import { readHostState } from './host-binding.js';
import { safeRelative } from './safe-relative.js';
import { invariant } from './errors.js';
import type { WorkStore } from './work-store.js';

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
/** Read-only: does not restore a Lane, checkpoint, index, or enqueue hosted work. */
export async function agentLinks(store: WorkStore, input: LinkInput) {
  invariant(
    [input.laneId, input.viewId, input.save].filter(Boolean).length === 1,
    'BAD_ARGUMENT',
    'Select one laneId, viewId or save.',
  );
  invariant(!input.path || safeRelative(input.path), 'UNSAFE_PATH', 'Use a relative source path.');
  invariant(!input.line || !!input.path, 'BAD_ARGUMENT', 'A line requires a file path.');
  const lane = input.laneId ? store.select('lanes', input.laneId, 'id', true) : undefined;
  const view = input.viewId ? store.select('views', input.viewId) : undefined;
  const head = input.save ?? lane?.head ?? view?.head;
  invariant(head, 'NOT_FOUND', 'Lane or clean View not found.');
  const binding = readHostState(store).binding;
  let owner: string | undefined;
  let hostedSlug: string | undefined;
  let hostedName = binding?.name;
  if (binding) {
    const parts = new URL(binding.projectUrl).pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (
      parts.length >= 2 &&
      parts[0] !== 'projects' &&
      !parts[1]!.includes('~') &&
      !process.env.FORGE_AUTH_TOKEN
    ) {
      owner = parts[0];
      hostedSlug = parts[1];
    } else {
      const project = await coordinationClient(binding.deployment, process.env.FORGE_AUTH_TOKEN).query(
        makeFunctionReference<
          'query',
          { projectId: string },
          { handle: string; slug: string; name: string } | null
        >('urlProjects:resolve'),
        { projectId: binding.projectId },
      );
      invariant(project, 'HOST_IDENTITY_REQUIRED', 'Hosted project identity is unavailable.');
      owner = project.handle;
      hostedSlug = project.slug;
      hostedName = project.name;
    }
  }
  return {
    ...input,
    head,
    ...buildAgentLinks({
      ...input,
      head,
      name: basename(store.root),
      ...(binding
        ? {
            projectUrl: binding.projectUrl,
            projectId: binding.projectId,
            name: hostedName ?? binding.name,
            ...(owner ? { owner } : {}),
            ...(hostedSlug ? { slug: hostedSlug } : {}),
          }
        : {}),
    }),
  };
}
