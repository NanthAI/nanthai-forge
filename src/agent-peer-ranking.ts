// SPDX-License-Identifier: Apache-2.0
import { normalizeCoordinationPath } from './coordination-paths.js';
import { changedPaths } from './agent-sync.js';
import type { PeersSource } from './agent-peers-source.js';
import type { PeersCache } from './agent-peers-cache.js';
import type { RegionSummary } from './agent-region-summary.js';
import type { Lane } from './work-types.js';

export type SavedPeerPaths = { paths: string[]; at: string };

const prefixes = (path: string) => {
  const parts = normalizeCoordinationPath(path).split('/');
  return parts.map((_, index) => parts.slice(0, index + 1).join('/'));
};
/** Saved manifests and existing region summaries only: no live scans, blob reads
 * or persistent writes. A directory claim matches both ancestors and children. */
export function rankPeerLanes(source: PeersSource, cache: PeersCache, scope: string[], peers: Lane[]) {
  const exact = new Map<string, Set<string>>(),
    descendants = new Map<string, Map<string, Set<string>>>(),
    recent = new Map<string, string>();
  let incomplete = false;
  const add = (index: Map<string, Set<string>>, path: string, id: string) => {
    if (!index.has(path)) index.set(path, new Set());
    index.get(path)!.add(id);
  };
  for (const peer of peers) {
    let paths = peer.scope?.paths ?? [];
    try {
      const indexed = cache.read<SavedPeerPaths>(`peer-paths-v1:${peer.base}:${peer.head}`);
      const saved = indexed ? undefined : cache.read<RegionSummary>(`regions-v1:${peer.base}:${peer.head}`);
      paths = [
        ...paths,
        ...(indexed
          ? indexed.paths
          : saved
            ? saved.files.map(file => file.path)
            : peer.base === peer.head
              ? []
              : changedPaths(source.state(peer.base).files, source.state(peer.head).files)),
      ];
      recent.set(
        peer.id,
        peer.head === peer.base ? (peer.startedAt ?? '') : (indexed?.at ?? source.state(peer.head).at),
      );
    } catch {
      incomplete = true;
    }
    for (const path of new Set(paths.map(normalizeCoordinationPath))) {
      add(exact, path, peer.id);
      for (const prefix of prefixes(path)) {
        if (!descendants.has(prefix)) descendants.set(prefix, new Map());
        add(descendants.get(prefix)!, peer.id, path);
      }
    }
  }
  const matched = new Map<string, Set<string>>();
  for (const path of new Set(scope.map(normalizeCoordinationPath))) {
    for (const [id, paths] of descendants.get(path) ?? [])
      for (const sharedPath of paths) add(matched, id, sharedPath);
    for (const prefix of prefixes(path)) for (const id of exact.get(prefix) ?? []) add(matched, id, path);
  }
  const shared = new Map([...matched].map(([id, paths]) => [id, paths.size]));
  const ranked = [...peers].sort(
    (a, b) =>
      (shared.get(b.id) ?? 0) - (shared.get(a.id) ?? 0) ||
      (recent.get(b.id) ?? '').localeCompare(recent.get(a.id) ?? '') ||
      a.id.localeCompare(b.id),
  );
  return { ranked, shared, incomplete };
}
