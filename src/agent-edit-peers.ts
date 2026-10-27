// SPDX-License-Identifier: Apache-2.0
import { readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { digest } from './hash.js';
import { invariant } from './errors.js';
import { safeRelative } from './safe-relative.js';
import { pathsOverlap } from './coordination-paths.js';
import { PeersCache } from './agent-peers-cache.js';
import { editRecordReader } from './agent-edit-records.js';
import type { Lane } from './work-types.js';
import type { OverlapAlert } from './agent-overlap-alerts.js';

export const editNoticeId = (lanes: string[], file: string) =>
  digest(JSON.stringify(['first-write', [...lanes].sort(), file]));
export const editClaimDirectory = (directory: string, path: string) =>
  join(directory, 'edit-claims', digest(path));

/** Selected header pages only: no checkpoints, Views, source scans, writer or network. */
export function readEditPeers(root: string, laneId: string, path: string) {
  root = realpathSync(root);
  invariant(safeRelative(path), 'UNSAFE_PATH', 'Use a Lane-relative edit path.');
  const directory = join(root, '.forge', 'work');
  const reader = editRecordReader(directory),
    manifest = reader.manifest;
  const cache = new PeersCache(root);
  const claims = new Set<string>();
  try {
    for (const name of readdirSync(editClaimDirectory(directory, path))) {
      if (/^[a-f0-9-]{36}\.json$/.test(name)) claims.add(name.slice(0, -5));
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  let found = false,
    head = '',
    complete = true,
    headersRead = 0,
    pagesRead = 0;
  const overlaps: OverlapAlert[] = [];
  for (const hash of manifest.collections.lanes?.pages ?? []) {
    pagesRead++;
    const page =
      cache.read<Lane[]>(`lane-fields-v1:${hash}`) ??
      reader.page(hash).map(id => {
        headersRead++;
        return reader.fragment(id).fields as Lane;
      });
    for (const peer of page) {
      if (peer.id === laneId) {
        found = true;
        head = peer.head;
        continue;
      }
      if (!['active', 'paused', 'ready'].includes(peer.state)) continue;
      const saved =
        peer.head === peer.base
          ? { paths: [] }
          : cache.read<{ paths: string[] }>(`peer-paths-v1:${peer.base}:${peer.head}`);
      if (!saved && peer.head !== peer.base) complete = false;
      if (
        !claims.has(peer.id) &&
        ![...(peer.scope?.paths ?? []), ...(saved?.paths ?? [])].some(item => pathsOverlap(item, path))
      )
        continue;
      const lanes = [laneId, peer.id].sort();
      overlaps.push({
        noticeId: editNoticeId(lanes, path),
        kind: 'overlap-notice',
        at: new Date().toISOString(),
        lanes,
        heads: [],
        file: path,
        regions: [],
        proposedOrder: lanes,
        text: `Overlap before first write: ${path}; Lane ${peer.id} (${peer.owner?.actor ?? peer.startedBy?.name ?? peer.name}). Acknowledge with peer-ack, or edit another path.`,
      });
    }
  }
  invariant(found, 'NOT_FOUND', 'Edit Lane not found.');
  return {
    head,
    coverage: complete ? ('local' as const) : ('local-incomplete' as const),
    overlaps,
    budget: { convexCalls: 0, documentsRead: 0, documentsWritten: 0, pagesRead, headersRead },
  };
}
