// SPDX-License-Identifier: Apache-2.0
import type { ChangeMapData } from '../../../src/change-map';
import type { PointNode } from '../graph-model';
export const MAP_GROUP_THRESHOLD = 50;
/** Collapse presentation only: every file remains available by expanding its directory. */
export function collapseChangeMap(
  data: ChangeMapData,
  expanded: ReadonlySet<string>,
  markers: ReadonlyMap<string, string[]>,
) {
  const grouped = data.nodes.filter(n => n.status !== 'unchanged').length > MAP_GROUP_THRESHOLD;
  const groups = new Map<string, string>();
  const nodes = new Map<string, PointNode>();
  const ids = new Map<string, string>();
  for (const node of data.nodes) {
    const folder = node.id.includes('/') ? node.id.split('/')[0]! : 'Root files';
    const id = grouped && !expanded.has(folder) ? `directory:${folder}` : node.id;
    ids.set(node.id, id);
    const peers = markers.get(node.id) ?? [];
    if (id !== node.id) {
      groups.set(id, folder);
      const previous = nodes.get(id);
      const count = (previous?.fileCount ?? 0) + 1;
      nodes.set(id, {
        id,
        label: `${folder === 'Root files' ? folder : folder + '/'} · ${count} ${count === 1 ? 'file' : 'files'}`,
        folder,
        fileCount: count,
        detail: 'Expand directory',
        status: 'directory',
        weight: (previous?.weight ?? 0) + node.add + node.del,
        marker: [...new Set([...(previous?.marker ?? []), ...peers])],
      });
    } else
      nodes.set(id, {
        ...node,
        detail:
          node.status === 'unchanged'
            ? 'Neighbour'
            : `${node.status} · ${node.approximate ? '≈' : ''}+${node.add} −${node.del}`,
        weight: node.add + node.del,
        marker: peers,
      });
  }
  const edges = new Map<string, { from: string; to: string }>();
  for (const edge of data.edges) {
    const from = ids.get(edge.from)!,
      to = ids.get(edge.to)!;
    if (from !== to) edges.set(JSON.stringify([from, to]), { from, to });
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()], groups };
}
