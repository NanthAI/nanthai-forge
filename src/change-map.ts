// SPDX-License-Identifier: Apache-2.0
import { codeImports } from './code-imports.js';
import type { ReviewPath } from './native-source-review.js';
import { contextualHunks } from './review-hunks.js';

export type ChangeMapNode = {
  id: string;
  label: string;
  status: ReviewPath['status'];
  add: number;
  del: number;
  approximate: boolean;
};
export type ChangeMapData = {
  base: string;
  head: string;
  nodes: ChangeMapNode[];
  edges: { from: string; to: string }[];
};

/** Uses Code's static import parser on immutable bytes. Includes deleted-file relationships. */
export async function readChangeMap(
  base: string,
  head: string,
  paths: ReviewPath[],
  read: (ids: string[]) => Promise<Buffer[]>,
): Promise<ChangeMapData> {
  const touched = new Set(paths.filter(p => p.status !== 'unchanged').map(p => p.path));
  if (!touched.size) return { base, head, nodes: [], edges: [] };
  const names = new Set(paths.map(p => p.path));
  const edges = new Map<string, { from: string; to: string }>();
  const nodes: ChangeMapNode[] = [];
  // Transport batches bound resident source bytes; no file is excluded by this scheduling choice.
  for (let offset = 0; offset < paths.length; offset += 32) {
    const batch = paths.slice(offset, offset + 32);
    const ids = [
      ...new Set(
        batch.flatMap(p =>
          /\.[cm]?[jt]sx?$/.test(p.path) || touched.has(p.path)
            ? [p.before?.blob, p.after?.blob].filter((id): id is string => Boolean(id))
            : [],
        ),
      ),
    ];
    const values = await read(ids);
    const bytes = new Map(ids.map((id, i) => [id, values[i]!]));
    for (const file of batch) {
      const a = file.before ? bytes.get(file.before.blob) : undefined;
      const b = file.after ? bytes.get(file.after.blob) : undefined;
      if (/\.[cm]?[jt]sx?$/.test(file.path))
        for (const content of new Set([a, b]))
          if (content)
            for (const edge of codeImports(file.path, content.toString('utf8'), names))
              if (touched.has(edge.from) || touched.has(edge.to)) edges.set(JSON.stringify(edge), edge);
      let add = 0,
        del = 0,
        approximate = false;
      if (touched.has(file.path)) {
        const comparison = contextualHunks(a ?? Buffer.alloc(0), b ?? Buffer.alloc(0), 0);
        approximate = comparison.truncated;
        for (const hunk of comparison.hunks)
          for (const line of hunk.lines) {
            if (line.kind === 'added') add++;
            if (line.kind === 'removed') del++;
          }
      }
      if (!approximate) {
        if (!file.before && b?.at(-1) === 10) add = Math.max(0, add - 1);
        if (!file.after && a?.at(-1) === 10) del = Math.max(0, del - 1);
      }
      nodes.push({
        id: file.path,
        label: file.path.split('/').at(-1)!,
        status: file.status,
        add,
        del,
        approximate,
      });
    }
  }
  const visible = new Set([...touched, ...[...edges.values()].flatMap(e => [e.from, e.to])]);
  return { base, head, nodes: nodes.filter(n => visible.has(n.id)), edges: [...edges.values()] };
}
