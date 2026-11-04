// SPDX-License-Identifier: Apache-2.0
import { PeersCache } from './agent-peers-cache.js';
import type { EditTarget } from './agent-edit-target.js';
import { networkFetch, networkTimeout } from './network-fetch.js';
import { resolveAuthToken, deploymentUrl } from './auth-store.js';

type Evidence = {
  count: number | null;
  coverage: string;
  scope: string;
  unsavedEdits: string;
  items: { file: string; lanes: string[]; class: string; reason: string }[];
};
export type EditQuery = (name: string, args: Record<string, unknown>) => Promise<unknown>;
export const incompleteEdit = () => ({
  status: 'unavailable',
  coverage: 'hosted-incomplete',
  count: null,
  scope: 'saved-paths',
  unsavedEdits: 'unavailable',
  overlaps: [] as Evidence['items'],
  checked: 1,
});
/** A single authorized query: no probes, retries, subscriptions, writes or source downloads. */
export async function readHostedEditPeers(target: EditTarget, query?: EditQuery) {
  if (!query) {
    const { deadlineConvexClient } = await import('./network-convex-client.js');
    const { makeFunctionReference } = await import('convex/server');
    const url = deploymentUrl(target.url!);
    const token = resolveAuthToken(url);
    if (!token) throw new Error('Unavailable login');
    const client = deadlineConvexClient(
      url,
      {
        skipConvexDeploymentUrlCheck: true,
        logger: false,
        fetch: (input, init) =>
          networkFetch(input, { ...init, redirect: 'error', signal: networkTimeout(650) }, { retries: 0 }),
      },
      650,
    );
    client.setAuth(token);
    query = (name, args) => client.query(makeFunctionReference<'query'>(name), args);
  }
  const raw = await query('projectHostedOverlaps:read', {
    projectId: target.project,
    laneId: target.laneId,
    path: target.path,
    detail: true,
    items: 5,
  });
  const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const evidence = (value as { peerEvidence?: Evidence })?.peerEvidence;
  if (
    !evidence ||
    !Array.isArray(evidence.items) ||
    !['hosted', 'hosted-incomplete', 'unavailable'].includes(evidence.coverage) ||
    evidence.scope !== 'saved-paths' ||
    evidence.unsavedEdits !== 'unavailable' ||
    !evidence.items.every(
      item =>
        typeof item.file === 'string' &&
        Array.isArray(item.lanes) &&
        item.lanes.every(lane => typeof lane === 'string') &&
        typeof item.class === 'string',
    ) ||
    (evidence.count !== null && typeof evidence.count !== 'number')
  )
    throw new Error('Invalid evidence');
  return {
    status: evidence.items.length ? 'overlap' : 'allowed',
    coverage: evidence.coverage,
    count: evidence.count,
    scope: evidence.scope,
    unsavedEdits: evidence.unsavedEdits,
    overlaps: evidence.items.slice(0, 5),
    checked: 1,
  };
}
/** Reserve before IO, so a supervisor timeout is cached too. No cached evidence grants authority. */
export async function preEditHosted(target: EditTarget, session: string, query?: EditQuery) {
  const cache = new PeersCache(target.root);
  const key = `hosted-first-edit-v1:${target.url}:${target.project}:${target.laneId}:${session}:${target.path}`;
  if (cache.read(key)) return { ...incompleteEdit(), status: 'cached', checked: 0 };
  cache.write(key, { checked: true, coverage: 'hosted-incomplete' });
  try {
    const result = await readHostedEditPeers(target, query);
    cache.write(key, { checked: true, coverage: result.coverage });
    return result;
  } catch {
    return incompleteEdit();
  }
}
/** Names/paths are data, never peer-authored instructions; cap context regardless of server text. */
export function hostedEditContext(result: Awaited<ReturnType<typeof preEditHosted>>) {
  if (result.status === 'cached') return '';
  const clean = (s: string) =>
    String(s)
      .replace(/[\x00-\x1f\x7f]/g, ' ')
      .slice(0, 160);
  return (
    `Forge first-write: ${result.status}; coverage=${clean(result.coverage)}; saved paths only, unsaved edits unavailable; overlaps=${result.count ?? 'unknown'}.` +
    result.overlaps
      .map(item => `\n${clean(item.file)}: Lane ${clean(item.lanes.join(', '))} (${clean(item.class)}).`)
      .join('')
  );
}
