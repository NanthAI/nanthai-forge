// SPDX-License-Identifier: Apache-2.0
import { CODE_FILE } from './contract-exports.js';
import { contractDelta, type ContractChange, type ContractSource } from './contract-deps.js';
import { STRUCTURAL_CONTRACT_FILE } from './contract-structural.js';
import {
  enclosingPackages,
  packageGraphFor,
  packageGraphKey,
  withDependents,
  type PackageGraph,
} from './package-graph.js';
import { packageKey } from './package-graph-types.js';

/** Package-level contract signal for code without import-precise facts. TS/JS keeps its import-level
 * rule (contract-deps). Python, Java, Rust and Go have export facts (contract-structural); every other
 * code file is "contract unknown": any change to it may change what other files use. A missing graph
 * edge never proves independence, so a file Forge cannot place in a package is unplaced and touches
 * everything. */
export const UNKNOWN_CONTRACT_FILE =
  /\.(?:cs|fs|fsx|vb|kt|kts|scala|sc|groovy|swift|m|mm|c|h|cc|cpp|cxx|hpp|hh|hxx|rb|php|dart|ex|exs|erl|hrl|hs|ml|mli|clj|cljs|lua|zig|nim|jl|r|R|pl|pm)$/;
/** Source files whose edits can use another package's contract. */
export const isContractSource = (path: string) =>
  CODE_FILE.test(path) || STRUCTURAL_CONTRACT_FILE.test(path) || UNKNOWN_CONTRACT_FILE.test(path);

type FileRef = { path: string; blob: string };
type Graph = Extract<PackageGraph, { status: 'available' }>;
/** Packages (keys) whose contract a change may alter, with one file per package as the example. */
export type PackageContracts = { packages: Map<string, string>; unplaced?: string };

/** The graph of one head's files, cached per head (src/package-graph.ts). */
export function contractGraph(source: ContractSource, files: FileRef[]): PackageGraph {
  const blobs = new Map(files.map(file => [file.path, file.blob]));
  return packageGraphFor(packageGraphKey(files), blobs.keys(), path => {
    const blob = blobs.get(path);
    return blob ? source.object(blob).toString('utf8') : undefined;
  });
}

/** Non-TS/JS packages whose contract changes between `before` and `after`. Reads only changed
 * Python/Java/Rust blobs (memoized per blob); unknown-language files cost a regex. */
export function packageContracts(
  source: ContractSource,
  before: FileRef[],
  after: FileRef[],
  graph: () => PackageGraph,
): PackageContracts {
  const old = new Map(before.map(file => [file.path, file.blob]));
  const signals = new Map<string, 'unknown' | 'changed'>();
  const structural: FileRef[][] = [[], []];
  for (const file of after)
    if (old.get(file.path) !== file.blob) {
      if (UNKNOWN_CONTRACT_FILE.test(file.path)) signals.set(file.path, 'unknown');
      else if (STRUCTURAL_CONTRACT_FILE.test(file.path)) structural[1]!.push(file);
    }
  const now = new Set(after.map(file => file.path));
  for (const file of before)
    if (!now.has(file.path)) {
      if (UNKNOWN_CONTRACT_FILE.test(file.path)) signals.set(file.path, 'unknown');
      else if (STRUCTURAL_CONTRACT_FILE.test(file.path)) structural[0]!.push(file);
    }
  if (structural[0]!.length || structural[1]!.length) {
    const paths = new Set([...structural[0]!, ...structural[1]!].map(file => file.path));
    const pick = (files: FileRef[]) => files.filter(file => paths.has(file.path));
    for (const change of contractDelta(source, pick(before), pick(after)))
      signals.set(change.file, 'changed');
  }
  const result: PackageContracts = { packages: new Map() };
  if (!signals.size) return result;
  const known = graph();
  for (const path of [...signals.keys()].sort()) {
    if (known.status !== 'available') {
      result.unplaced ??= path;
      continue;
    }
    // A Go test-only folder or `_test.go` file: nothing can import it.
    if (known.ecosystems.some(item => item.leafOwner?.(path))) continue;
    const owners = enclosingPackages(known, path);
    if (!owners.length) result.unplaced ??= path;
    for (const pkg of owners)
      if (!result.packages.has(packageKey(pkg))) result.packages.set(packageKey(pkg), path);
  }
  return result;
}

/** Why `theirs` (another Lane's changed paths) may use a contract `mine` changes: a source file in
 * a changed package or in a package that depends on one. Null when every such file is in an
 * unrelated package. */
export function packageContractHold(
  graphOf: () => PackageGraph,
  mine: PackageContracts,
  theirs: string[],
): string | null {
  if (!mine.unplaced && !mine.packages.size) return null;
  const sources = theirs.filter(isContractSource).sort();
  if (!sources.length) return null;
  const graph = graphOf();
  if (mine.unplaced || graph.status !== 'available')
    return `${mine.unplaced ?? [...mine.packages.values()][0]} has no package Forge can place (contract unknown), and ${sources[0]} changed too`;
  const available: Graph = graph;
  const reached = withDependents(available, mine.packages.keys());
  for (const path of sources) {
    const owners = enclosingPackages(available, path);
    if (!owners.length)
      return `${path} is outside every package, so it may use ${[...mine.packages.values()][0]}`;
    for (const pkg of owners) {
      const key = packageKey(pkg);
      if (!reached.has(key)) continue;
      const changed = mine.packages.get(key);
      if (changed) return `${path} is in package ${pkg.name}, whose contract ${changed} may change`;
      const via = [...mine.packages].find(([root]) => withDependents(available, [root]).has(key))!;
      return `${path} is in package ${pkg.name}, which depends on ${via[0].replace(/^[^:]*:/, '') || '.'}, whose contract ${via[1]} may change`;
    }
  }
  return null;
}

/** Why `lane`'s edits to non-TS/JS code may use a contract main changed after `pivot`, or null. Main's
 * changes are placed in main's own graph (a package main added is not one the Lane can use); the Lane's
 * edits and reverse dependencies in the Lane's graph. A body-only change in a language with export
 * facts (Python, Java, Rust, Go) signals nothing. Each graph is built at most once, and only when main
 * changed such a contract. TS/JS edits are matched by import (contract-deps), never here. */
export function laneNeedsContractSync(
  source: ContractSource,
  pivot: FileRef[],
  main: FileRef[],
  lane: FileRef[],
): { reason: string; changes: ContractChange[] } | null {
  let mainGraph: PackageGraph | undefined, laneGraph: PackageGraph | undefined;
  const mine = packageContracts(source, pivot, main, () => (mainGraph ??= contractGraph(source, main)));
  if (!mine.unplaced && !mine.packages.size) return null;
  const before = new Map(pivot.map(file => [file.path, file.blob]));
  const edited = lane
    .filter(file => before.get(file.path) !== file.blob && !CODE_FILE.test(file.path))
    .map(file => file.path);
  const reason = packageContractHold(() => (laneGraph ??= contractGraph(source, lane)), mine, edited);
  if (!reason) return null;
  const files = [...new Set([...(mine.unplaced ? [mine.unplaced] : []), ...mine.packages.values()])].sort();
  return {
    reason,
    changes: files.map(file => ({ file, export: '*', kind: 'changed' as const })),
  };
}
