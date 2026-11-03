// SPDX-License-Identifier: Apache-2.0
import { nextStateGeneration } from './state-generation.js';
import { invariant } from './errors.js';

/** Untrusted dependency hints only order the later byte-verification pages.
 * Never use this continuation graph to derive or commit a generation. */
export function orderStateGenerationDependencies(states: { head: string; parents: string[] }[]) {
  const pending = new Map(states.map(state => [state.head, state])),
    counts = new Map<string, number>(),
    children = new Map<string, string[]>(),
    ready: string[] = [];
  for (const state of pending.values()) {
    const parents = [...new Set(state.parents)].filter(head => pending.has(head));
    counts.set(state.head, parents.length);
    if (!parents.length) ready.push(state.head);
    for (const parent of parents) {
      const dependants = children.get(parent) ?? [];
      dependants.push(state.head);
      children.set(parent, dependants);
    }
  }
  for (let i = 0; i < ready.length; i++)
    for (const child of children.get(ready[i]!) ?? []) {
      const count = counts.get(child)! - 1;
      counts.set(child, count);
      if (!count) ready.push(child);
    }
  invariant(
    ready.length === pending.size,
    'SOURCE_CLOSURE_INVALID',
    'State generation dependencies contain a cycle.',
  );
  return ready;
}
/** Callers authenticate the State parent bytes and the external parent levels.
 * This is a finite page, not an ancestry cache or a client-supplied proof. */
export function deriveStateGenerationPage(
  states: { head: string; size: number; parents: string[] }[],
  known: ReadonlyMap<string, number>,
) {
  const levels = new Map(known),
    pending = new Map(states.map(state => [state.head, state]));
  const assigned: { head: string; size: number; generation: number }[] = [];
  for (let changed = true; changed;) {
    changed = false;
    for (const [head, state] of pending) {
      const generation = nextStateGeneration(state.parents, id => levels.get(id));
      if (generation === undefined) continue;
      levels.set(head, generation);
      pending.delete(head);
      changed = true;
      assigned.push({ head, size: state.size, generation });
    }
  }
  const missing = [
    ...new Set(
      [...pending.values()].flatMap(state => state.parents).filter(id => !levels.has(id) && !pending.has(id)),
    ),
  ];
  return { assigned, pending: [...pending.keys()], missing };
}
