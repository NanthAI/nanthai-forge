// SPDX-License-Identifier: Apache-2.0
import { validStateGeneration } from './state/generation.js';

/** Generation-ordered paint, with one colour per selected tip. A shared base
 * paints its parents stale. Once at most one non-stale colour remains, no new
 * pairwise base is possible. Subset-common or multiple bases retain BFS and
 * recursive virtual-base ancestry. No numeric floor may discard an independent
 * lower-generation base. All levels come from authenticated descriptors. */
export function sourceGenerationWalk(
  parents: Record<string, string[]>,
  generations: Record<string, number>,
  roots: string[],
): { frontier: string[]; cuts?: string[]; metadata?: boolean } | null {
  const tips = [...new Set(roots)];
  if (tips.length < 2 || !acyclic(parents)) return null;
  for (const [id, edges] of Object.entries(parents))
    if (
      validStateGeneration(generations[id]) &&
      edges.some(
        parent => validStateGeneration(generations[parent]) && generations[parent]! >= generations[id]!,
      )
    )
      return null;
  const all = (1n << BigInt(tips.length)) - 1n,
    stale = all + 1n;
  const flags = new Map<string, bigint>(),
    pending = new Set<string>(),
    unknown = new Set<string>();
  const versions = new Map<string, number>(),
    colours = new Map<bigint, number>();
  const queue = generationQueue(),
    bases: string[] = [];
  let activeColours = 0,
    common = 0;
  const count = (paint: bigint, delta: number) => {
    if (paint === all) common += delta;
    if (paint & stale) return;
    for (let bits = paint; bits; bits &= bits - 1n) {
      const bit = bits & -bits,
        before = colours.get(bit) ?? 0,
        after = before + delta;
      colours.set(bit, after);
      if (!before && after) activeColours++;
      if (before && !after) activeColours--;
    }
  };
  const add = (id: string, paint: bigint) => {
    const before = flags.get(id) ?? 0n,
      after = before | paint;
    if (pending.has(id) && before === after) return;
    if (pending.has(id)) count(before, -1);
    flags.set(id, after);
    pending.add(id);
    count(after, 1);
    const generation = generations[id];
    if (!validStateGeneration(generation)) unknown.add(id);
    const version = (versions.get(id) ?? 0) + 1;
    versions.set(id, version);
    queue.push({ id, version, generation: generation ?? 0, common: after === all });
  };
  tips.forEach((id, i) => add(id, 1n << BigInt(i)));
  while (pending.size) {
    // Side exhaustion needs no parent metadata: stale nodes are dominated,
    // and the last private side cannot form a new pair. Retain the base's
    // verified edges: older common side edges still need domination proof.
    if (!common && activeColours <= 1 && bases.length === 1) return { frontier: [], cuts: [...pending] };
    if (unknown.size) return { frontier: [...unknown], metadata: true };
    let entry = queue.pop();
    while (entry && (!pending.has(entry.id) || versions.get(entry.id) !== entry.version)) entry = queue.pop();
    if (!entry) return null;
    const id = entry.id,
      edges = parents[id],
      paint = flags.get(id)!;
    if (!edges)
      return {
        frontier: [...pending].filter(
          next =>
            !parents[next] &&
            generations[next] === generations[id] &&
            (paint !== all || flags.get(next) === all),
        ),
      };
    if (
      edges.some(
        parent => validStateGeneration(generations[parent]) && generations[parent]! >= generations[id]!,
      )
    )
      return null;
    pending.delete(id);
    count(paint, -1);
    let inherited = paint;
    if (!(paint & stale) && (paint & (paint - 1n)) !== 0n) {
      if (paint !== all) return null;
      bases.push(id);
      if (bases.length > 1) return null;
      inherited |= stale;
    }
    for (const parent of edges) add(parent, inherited);
  }
  return { frontier: [] };
}

/** A resumed cursor may contain speculative verified edges below the stopping
 * frontier. Preserve cycle conservatism for all of those already loaded bytes. */
function acyclic(parents: Record<string, string[]>): boolean {
  const children = new Map<string, number>(),
    nodes = new Set(Object.keys(parents));
  for (const edges of Object.values(parents))
    for (const parent of new Set(edges)) {
      nodes.add(parent);
      children.set(parent, (children.get(parent) ?? 0) + 1);
    }
  const ready = [...nodes].filter(id => !children.get(id));
  for (let i = 0; i < ready.length; i++)
    for (const parent of new Set(parents[ready[i]!] ?? [])) {
      const count = children.get(parent)! - 1;
      children.set(parent, count);
      if (!count) ready.push(parent);
    }
  return ready.length === nodes.size;
}

type GenerationEntry = { id: string; generation: number; common: boolean; version: number };
/** Entries are versioned when paint changes, so a newly common equal-level node
 * overtakes private work without a whole-frontier sort on every visited State. */
function generationQueue() {
  const heap: GenerationEntry[] = [];
  const first = (a: GenerationEntry, b: GenerationEntry) =>
    a.generation > b.generation ||
    (a.generation === b.generation &&
      (Number(a.common) > Number(b.common) || (a.common === b.common && a.id < b.id)));
  return {
    push(value: GenerationEntry) {
      heap.push(value);
      let i = heap.length - 1;
      while (i > 0) {
        const parent = (i - 1) >> 1;
        if (!first(heap[i]!, heap[parent]!)) break;
        [heap[i], heap[parent]] = [heap[parent]!, heap[i]!];
        i = parent;
      }
    },
    pop(): GenerationEntry | undefined {
      const result = heap[0],
        last = heap.pop();
      if (heap.length && last) {
        heap[0] = last;
        let i = 0;
        for (;;) {
          const left = 2 * i + 1,
            right = left + 1;
          let best = i;
          if (left < heap.length && first(heap[left]!, heap[best]!)) best = left;
          if (right < heap.length && first(heap[right]!, heap[best]!)) best = right;
          if (best === i) break;
          [heap[i], heap[best]] = [heap[best]!, heap[i]!];
          i = best;
        }
      }
      return result;
    },
  };
}
