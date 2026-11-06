// SPDX-License-Identifier: Apache-2.0
import { PeersCache } from './agent-peers-cache.js';
import type { EditTarget } from './agent-edit-target.js';
import { networkFetch, networkTimeout } from './network-fetch.js';
import { resolveAuthToken, deploymentUrl } from './auth-store.js';
import {
  boardEnvelope,
  boardNoticeLine,
  readBoardCursor,
  readBoardServerFeatures,
  type BoardNote,
} from './board-local.js';

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
  // Board notes and claims ride on this same query, once the server advertised the board (marker
  // written by Lane actions on change; the hook makes no capability read).
  const board = Boolean(target.url) && readBoardServerFeatures(target.project).includes('agent-board');
  const raw = await query('projectHostedOverlaps:read', {
    projectId: target.project,
    laneId: target.laneId,
    path: target.path,
    detail: true,
    items: 5,
    ...(board ? { board: { after: readBoardCursor(target.root, target.laneId) } } : {}),
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
    ...(board ? boardLines(target, (value as { board?: unknown }).board) : {}),
  };
}
const optionalString = (value: unknown) => value === undefined || typeof value === 'string';
const isNote = (value: unknown): value is BoardNote => {
  const note = value as Record<string, unknown> | null;
  return (
    !!note &&
    typeof note.id === 'string' &&
    typeof note.target === 'string' &&
    typeof note.text === 'string' &&
    typeof note.at === 'number' &&
    optionalString(note.author) &&
    optionalString(note.fromLaneId) &&
    optionalString(note.replyTo)
  );
};
/** Claims on the written path and unread notes for this Lane, as single quoted-data lines. Notes
 * advance the local board cursor, so the next Lane action does not repeat them. No schema library:
 * this runs on every first write. */
function boardLines(target: EditTarget, field: unknown): { board?: { claims: string[]; notices: string[] } } {
  const value = field as { messages?: unknown; more?: unknown; cursor?: unknown; claims?: unknown } | null;
  if (
    !value ||
    !Array.isArray(value.messages) ||
    !value.messages.every(isNote) ||
    typeof value.more !== 'number' ||
    typeof value.cursor !== 'number' ||
    !(value.claims === undefined || (Array.isArray(value.claims) && value.claims.every(isNote)))
  )
    return {};
  const claims = ((value.claims as BoardNote[] | undefined) ?? [])
    .slice(0, 2)
    .map(claim => `Claim on ${target.path}: ${boardNoticeLine(claim, target.laneId)}`);
  const notices = value.messages.length
    ? boardEnvelope(target.root, target.laneId, {
        messages: value.messages.slice(0, 2),
        more: value.more,
        cursor: value.cursor,
      }).notices
    : [];
  return claims.length || notices.length ? { board: { claims, notices } } : {};
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
  const board = 'board' in result ? result.board : undefined;
  return (
    `Forge first-write: ${result.status}; coverage=${clean(result.coverage)}; saved paths only, unsaved edits unavailable; overlaps=${result.count ?? 'unknown'}.` +
    result.overlaps
      .map(item => `\n${clean(item.file)}: Lane ${clean(item.lanes.join(', '))} (${clean(item.class)}).`)
      .join('') +
    // Board lines are already single quoted-data lines (claims and unread notes, ≤2 each).
    [...(board?.claims ?? []), ...(board?.notices ?? [])]
      .map(line => `\n${line.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 280)}`)
      .join('')
  );
}
