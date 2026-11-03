// SPDX-License-Identifier: Apache-2.0
/** Prove a cut relative to the selected roots, regardless of prefetch order.
 * Reduce their frontier in descendant-first order. A singleton frontier is on
 * every verified parent path; nothing below it can be a maximal merge base.
 * Unknown/closed roots and cycles cannot be retired to manufacture a cut. */
export function sourceAncestryCut(
  parents: Record<string, string[]>,
  pending: string[],
  roots?: string[],
): string | null {
  const selectedRoots = roots ?? Object.keys(parents);
  if (!selectedRoots.length || !Object.keys(parents).length) return null;
  const reachable = new Set<string>(),
    children = new Map<string, number>(),
    queue = [...new Set(selectedRoots)];
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i]!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    for (const parent of new Set(parents[id] ?? [])) {
      children.set(parent, (children.get(parent) ?? 0) + 1);
      if (!reachable.has(parent)) queue.push(parent);
    }
  }
  const frontier = new Set(selectedRoots),
    ready = [...reachable].filter(id => !children.get(id));
  // Finish the topological proof before accepting any boundary. A prefetched
  // cycle below an otherwise common frontier must keep conservative traversal.
  for (let i = 0; i < ready.length; i++) {
    for (const parent of new Set(parents[ready[i]!] ?? [])) {
      const count = children.get(parent)! - 1;
      children.set(parent, count);
      if (!count) ready.push(parent);
    }
  }
  if (ready.length !== reachable.size) return null;
  // Legacy callers select every loaded node; the explicit roots used by source
  // composition also permit a selected tip to be the cut.
  const cut = () => {
    if (frontier.size !== 1) return null;
    const id = frontier.values().next().value!;
    return (roots && parents[id]) || pending.includes(id) ? id : null;
  };
  if (roots && cut()) return cut();
  for (let i = 0; i < ready.length; i++) {
    const id = ready[i]!,
      edges = parents[id];
    if (!frontier.has(id) || !edges?.length) continue;
    frontier.delete(id);
    for (const parent of edges) frontier.add(parent);
    const boundary = cut();
    if (boundary) return boundary;
  }
  return null;
}

/** Read only the shallowest unresolved depth from the selected roots.
 * Breadth-first distances use authenticated edges, never derived hints. Keeping
 * a whole depth (in pending order) lets the caller apply its existing object and
 * byte windows without letting deeper history overtake an unresolved branch. */
export function sourceAncestryFrontier(
  parents: Record<string, string[]>,
  pending: string[],
  roots: string[],
): string[] {
  const distances = new Map<string, number>(),
    queue = [...new Set(roots)];
  for (const root of queue) distances.set(root, 0);
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i]!;
    for (const parent of parents[id] ?? []) {
      if (distances.has(parent)) continue;
      distances.set(parent, distances.get(id)! + 1);
      queue.push(parent);
    }
  }
  // Preserve orphaned legacy frontier entries conservatively, after all
  // reachable work. An orphan cannot establish a selected-root cut.
  const depth = pending.reduce((min, id) => Math.min(min, distances.get(id) ?? Infinity), Infinity);
  return pending.filter(id => (distances.get(id) ?? Infinity) === depth);
}
