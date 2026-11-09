// SPDX-License-Identifier: Apache-2.0
// Client-side package-level facts for cross-file advisory overlap notes on code without import-level
// facts (Issue a6566fbe). Parsing and manifests only: repository code never runs. The server matches
// the facts (hosted-overlap-symbol-notes) inside the existing overlap read.
import { CODE_FILE, diffExports } from './contract-exports.js';
import { STRUCTURAL_CONTRACT_FILE, structuralExports } from './contract-structural.js';
import { UNKNOWN_CONTRACT_FILE } from './contract-packages.js';
import { enclosingPackages, type PackageGraph } from './package-graph.js';
import { packageKey } from './package-graph-types.js';
import type { SymbolLinks } from './hosted-overlap-evidence.js';
import { MAX_SYMBOL_LINKS, type SymbolBudget } from './hosted-overlap-symbols.js';

/** Wire prefix of a package fact. `exports`: `pkg:ECOSYSTEM:DIR#NAME` (a changed exported name, or `*`
 * when the package's contract may have changed without a name); `refs`: `pkg:ECOSYSTEM:DIR#*` for the
 * package a changed file belongs to and every package it depends on. */
export const PACKAGE_FACT = 'pkg:';

/** Source files whose edits are matched by package: code the TS/JS import scanner does not read. */
export const packageFactFile = (path: string) =>
  !CODE_FILE.test(path) && (STRUCTURAL_CONTRACT_FILE.test(path) || UNKNOWN_CONTRACT_FILE.test(path));

export type PackageLinkContext = {
  /** The Lane checkout's package graph, built at most once per save. */
  graph: () => PackageGraph;
  budget: SymbolBudget;
};
type Text = { text: string | undefined; key: string };

/** Package facts for one changed non-TS/JS file. `before` null is a new file; `before.text` undefined means
 * its base bytes could not be read: the file's contract then reads as changed, never as unchanged. Missing facts (no readable
 * graph, a file in no package, too many dependencies) are `unavailable`, never "no link". */
export function packageSymbolLinks(
  path: string,
  before: Text | null,
  after: Text,
  context: PackageLinkContext,
): SymbolLinks {
  const result = context.budget.run((): SymbolLinks => {
    const graph = context.graph();
    if (graph.status !== 'available') return { unavailable: true };
    const owners = enclosingPackages(graph, path);
    if (!owners.length) return { unavailable: true };
    // A Go test-only folder or `_test.go` file: nothing can import it, so it exports nothing.
    const leaf = graph.ecosystems.some(item => item.leafOwner?.(path));
    let names: string[] | '*' = [];
    if (!leaf) {
      names = '*';
      const old =
        before === null
          ? new Map()
          : before.text === undefined
            ? undefined
            : structuralExports(path, before.text, before.key);
      if (STRUCTURAL_CONTRACT_FILE.test(path) && old && after.text !== undefined) {
        const now = structuralExports(path, after.text, after.key);
        if (now) names = diffExports(path, old, now).map(change => change.export);
      }
    }
    const exports = new Set<string>();
    for (const owner of owners)
      for (const name of names.length > MAX_SYMBOL_LINKS / owners.length ? ['*'] : names)
        exports.add(`${PACKAGE_FACT}${packageKey(owner)}#${name}`);
    const byKey = new Map(graph.packages.map(pkg => [packageKey(pkg), pkg]));
    const reached = new Set(owners.map(packageKey)),
      queue = [...reached];
    while (queue.length)
      for (const key of byKey.get(queue.shift()!)?.dependsOn ?? [])
        if (!reached.has(key)) {
          reached.add(key);
          queue.push(key);
        }
    const refs = [...reached].sort().map(key => `${PACKAGE_FACT}${key}#*`);
    const out = { exports: [...exports].sort(), refs };
    if (
      out.exports.length > MAX_SYMBOL_LINKS ||
      refs.length > MAX_SYMBOL_LINKS ||
      out.exports.some(item => item.length > 200) ||
      refs.some(item => item.length > 300)
    )
      return { unavailable: true };
    return out;
  });
  return result ?? { unavailable: true };
}
