// SPDX-License-Identifier: Apache-2.0
import type { ModuleGraph, ModuleLanguage } from './module-graph-types.js';
import { packageKey, type Ecosystem, type GraphPackage } from './package-graph-types.js';

/** Module-level narrowing of the package selection (src/package-graph.ts): a changed package whose
 * changes the module graph (src/module-graph.ts) fully reads runs only the test units that reach
 * them, instead of all of its tests. Pure and runtime-neutral (no Node APIs): the package graph that
 * imports it also runs in the hosted reducer. */

type Available = Extract<ModuleGraph, { status: 'available' }>;

const dependents = new WeakMap<Available, Map<string, string[]>>();
function reverse(graph: Available) {
  let map = dependents.get(graph);
  if (!map) {
    map = new Map();
    for (const node of graph.nodes.values())
      for (const dep of node.deps) {
        const list = map.get(dep);
        if (list) list.push(node.path);
        else map.set(dep, [node.path]);
      }
    dependents.set(graph, map);
  }
  return map;
}

export type ModuleReach = {
  /** Every node whose behavior a change can reach: the changed files and their transitive users. */
  reached: Set<string>;
  /** Changed paths with no module facts (not code Forge reads, deleted, unreadable). */
  unknown: string[];
};

/** reach(changed): the reverse import closure. `packagesOf` names the package keys owning a path; a
 * `wide` file joins as soon as anything in one of its packages is reached. */
export function moduleReach(
  graph: Available,
  changed: Iterable<string>,
  packagesOf: (path: string) => string[],
): ModuleReach {
  const users = reverse(graph);
  const wide = new Map<string, string[]>();
  for (const node of graph.nodes.values())
    if (node.wide)
      for (const key of packagesOf(node.path)) wide.set(key, [...(wide.get(key) ?? []), node.path]);
  const reached = new Set<string>();
  const unknown: string[] = [];
  const marked = new Set<string>();
  const queue: string[] = [];
  const visit = (path: string) => {
    if (reached.has(path)) return;
    reached.add(path);
    queue.push(path);
  };
  for (const path of changed) {
    if (graph.nodes.has(path)) visit(path);
    else unknown.push(path);
  }
  for (let at = 0; at < queue.length; at++) {
    const path = queue[at]!;
    for (const user of users.get(path) ?? []) visit(user);
    if (path.startsWith('\0')) continue;
    for (const key of packagesOf(path))
      if (!marked.has(key)) {
        marked.add(key);
        for (const item of wide.get(key) ?? []) visit(item);
      }
  }
  return { reached, unknown };
}

const LANGUAGES: Partial<Record<Ecosystem, ModuleLanguage[]>> = {
  python: ['python'],
  go: ['go'],
  cargo: ['rust'],
  gradle: ['java', 'kotlin'],
  maven: ['java', 'kotlin'],
};

/** Whether the module graph can narrow this ecosystem's packages. */
export const moduleEcosystem = (ecosystem: Ecosystem) => !!LANGUAGES[ecosystem];

export type ModuleNarrowing = {
  /** Package key → the test units that reach the change (may be empty: no test reaches it). */
  units: Map<string, string[]>;
  /** Package key → why it stays whole, for changed packages that could not be narrowed. */
  whole: Map<string, string>;
};

/** For each changed package (`owners`), the test units that reach its changes, or why it stays
 * whole: a changed path without module facts or in another language, a reached file marked
 * `whole`, or a package that also depends on another changed package. */
export function moduleNarrowing(
  modules: ModuleGraph | undefined,
  changed: string[],
  owners: Map<string, GraphPackage>,
  ownersOf: (path: string) => GraphPackage[],
  dependsOnOther: (key: string) => boolean,
): ModuleNarrowing {
  const result: ModuleNarrowing = { units: new Map(), whole: new Map() };
  if (modules?.status !== 'available') return result;
  const reach = moduleReach(modules, changed, path => ownersOf(path).map(packageKey));
  const unknown = new Set(reach.unknown);
  const owned = new Map<string, string[]>();
  for (const path of reach.reached) {
    if (path.startsWith('\0')) continue;
    for (const pkg of ownersOf(path))
      owned.set(packageKey(pkg), [...(owned.get(packageKey(pkg)) ?? []), path]);
  }
  for (const [key, pkg] of owners) {
    const languages = LANGUAGES[pkg.ecosystem];
    if (!languages || pkg.leaf) continue;
    const mine = changed.filter(path => ownersOf(path).some(owner => packageKey(owner) === key));
    const blocked =
      mine.find(path => unknown.has(path)) ??
      mine.find(path => !languages.includes(modules.nodes.get(path)!.language));
    if (blocked) {
      result.whole.set(key, `${blocked} has no ${languages.join('/')} module facts`);
      continue;
    }
    if (dependsOnOther(key)) {
      result.whole.set(key, 'it depends on another changed package');
      continue;
    }
    const units = new Set<string>();
    let whole: string | undefined;
    for (const path of owned.get(key) ?? []) {
      const node = modules.nodes.get(path)!;
      if (!languages.includes(node.language)) continue;
      if (node.whole) {
        whole = `${path}: ${node.whole}`;
        break;
      }
      for (const unit of node.units ?? []) units.add(unit);
    }
    if (whole) result.whole.set(key, whole);
    else result.units.set(key, [...units].sort());
  }
  return result;
}
