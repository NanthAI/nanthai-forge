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
    ready = [...frontier].filter(id => !children.get(id));
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
    if (!edges?.length) continue;
    frontier.delete(id);
    for (const parent of new Set(edges)) {
      frontier.add(parent);
      const count = children.get(parent)! - 1;
      children.set(parent, count);
      if (!count) ready.push(parent);
    }
    const boundary = cut();
    if (boundary) return boundary;
  }
  return null;
}

/** Prefer unresolved branches above a known common ancestor before its older
 * history. This is scheduling only: deferred IDs stay pending, and are read if
 * no other frontier remains. In particular it proves no recursive merge base. */
export function sourceAncestryFrontier(
  parents: Record<string, string[]>,
  pending: string[],
  roots: string[],
): string[] {
  const selectedRoots = [...new Set(roots)];
  // Coverage scheduling is bounded by the normal metadata object window. A
  // larger selection keeps ordinary traversal and the linear verified proof.
  if (!selectedRoots.length || selectedRoots.length > 100) return pending;
  const coverage = new Map<string, number>();
  for (const root of selectedRoots) {
    const seen = new Set<string>(),
      queue = [root];
    for (let i = 0; i < queue.length; i++) {
      const id = queue[i]!;
      if (seen.has(id)) continue;
      seen.add(id);
      coverage.set(id, (coverage.get(id) ?? 0) + 1);
      queue.push(...(parents[id] ?? []));
    }
  }
  const deferred = new Set<string>(),
    queue = [...coverage].filter(([, count]) => count === selectedRoots.length).map(([id]) => id);
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i]!;
    if (deferred.has(id)) continue;
    deferred.add(id);
    queue.push(...(parents[id] ?? []));
  }
  const nearer = pending.filter(id => !deferred.has(id));
  return nearer.length ? nearer : pending;
}
