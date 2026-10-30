// SPDX-License-Identifier: Apache-2.0
/** A single verified ancestry cut makes every older ancestor non-maximal.
 * Every loaded parent path must reach that frontier. Multiple unknown roots,
 * other known roots and cycles keep the full traversal. No hint proves closure. */
export function sourceAncestryCut(parents: Record<string, string[]>, pending: string[]): string | null {
  const frontier = [...new Set(pending)].filter(id => !parents[id]);
  const nodes = Object.keys(parents);
  if (frontier.length !== 1 || !nodes.length) return null;
  const boundary = frontier[0]!,
    remaining = new Map<string, number>(),
    children = new Map<string, string[]>();
  for (const id of nodes) {
    remaining.set(id, parents[id]!.length);
    for (const parent of parents[id]!) {
      const list = children.get(parent) ?? [];
      list.push(id);
      children.set(parent, list);
    }
  }
  const reached = new Set([boundary]),
    queue = [boundary];
  for (let index = 0; index < queue.length; index++)
    for (const child of children.get(queue[index]!) ?? []) {
      const count = remaining.get(child)! - 1;
      remaining.set(child, count);
      if (count === 0 && !reached.has(child)) {
        reached.add(child);
        queue.push(child);
      }
    }
  return nodes.every(id => reached.has(id)) ? boundary : null;
}
