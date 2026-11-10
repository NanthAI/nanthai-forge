// SPDX-License-Identifier: Apache-2.0
import { digestChunks } from './state/hash.js';
import { moduleGraphLanguages, nonSourceDirPattern } from './ecosystems.js';
import { goFacts, resolveGo } from './module-graph-go.js';
import { jvmFacts, resolveJvm } from './module-graph-jvm.js';
import { pythonFacts, resolvePython } from './module-graph-python.js';
import { resolveRust, rustFacts } from './module-graph-rust.js';
import type { ModuleContext, ModuleGraph, ModuleLanguage, ModuleNode } from './module-graph-types.js';
export type { ModuleGraph, ModuleNode, ModuleLanguage } from './module-graph-types.js';

/** Module-level graph for Python, Go, Rust, Java and Kotlin: one node per source file (Go adds one
 * node per package folder), edges from static imports and name references, read lexically. It never
 * runs repository code. Anything Forge cannot read is never "no edge": a file with dynamic loading or
 * an unresolved local import depends on its whole package (`wide`), and a changed or reached file
 * whose users Forge cannot see makes its owning package whole (`whole`). It is a selector, not an
 * independence proof (AGENTS.md: a missing edge never proves independence). Bounds are the code
 * graph's (src/snapshot.ts DEFAULT_LIMITS): past them the graph is unknown and selection stays at
 * package level. */

/** Module-graph readers and the folders a build never compiles from or Forge never reads as module
 * code, from the ecosystem registry (src/ecosystems.ts). */
const LANGUAGES: [RegExp, ModuleLanguage][] = moduleGraphLanguages();
const SKIPPED = nonSourceDirPattern();
export const moduleLanguage = (path: string): ModuleLanguage | undefined =>
  SKIPPED.test(path) ? undefined : LANGUAGES.find(([pattern]) => pattern.test(path))?.[1];

/** The code graph's bounds (src/snapshot.ts DEFAULT_LIMITS; a test keeps them equal), copied so the
 * preflight and check runtimes do not load the snapshot module's dependencies. */
export const MODULE_GRAPH_LIMITS = {
  maxFiles: 5_000,
  maxFileBytes: 1024 * 1024,
  maxTotalBytes: 16 * 1024 * 1024,
};

type Facts = unknown;
const EXTRACT: Record<ModuleLanguage, (path: string, text: string) => Facts> = {
  python: pythonFacts,
  go: goFacts,
  rust: rustFacts,
  java: (path, text) => jvmFacts(path, text, 'java'),
  kotlin: (path, text) => jvmFacts(path, text, 'kotlin'),
};
/** Facts per file content: a save re-reads only the files whose blob changed. */
const factsCache = new Map<string, Facts>();
const FACTS_ENTRIES = 20_000;

export type ModuleSource = {
  /** Every file path of the head. */
  paths: Iterable<string>;
  /** A file's text (source or manifest), undefined when unreadable. */
  read: (path: string) => string | undefined;
  /** Content id per path (blob), when known: keys the facts and graph caches. */
  blobs?: ReadonlyMap<string, string> | undefined;
};

/** The module graph of one head. */
export function buildModuleGraph(source: ModuleSource): ModuleGraph {
  const paths = [...source.paths].sort();
  const code = paths.filter(path => moduleLanguage(path));
  if (!code.length) return { status: 'unknown', reason: 'no Python, Go, Rust, Java or Kotlin source' };
  if (code.length > MODULE_GRAPH_LIMITS.maxFiles)
    return {
      status: 'unknown',
      reason: `${code.length} source files exceed the module graph limit of ${MODULE_GRAPH_LIMITS.maxFiles}`,
    };
  const nodes = new Map<string, ModuleNode>();
  const facts = new Map<string, Facts>();
  let bytes = 0;
  for (const path of code) {
    const language = moduleLanguage(path)!;
    const blob = source.blobs?.get(path);
    const key = blob ? `${language}\0${blob}` : undefined;
    let found = key ? factsCache.get(key) : undefined;
    if (!found) {
      const text = source.read(path);
      if (text === undefined || text.length > MODULE_GRAPH_LIMITS.maxFileBytes) {
        const why = text === undefined ? 'unreadable' : 'larger than the module graph file limit';
        nodes.set(path, { path, language, deps: [], wide: why, whole: why });
        continue;
      }
      bytes += text.length;
      if (bytes > MODULE_GRAPH_LIMITS.maxTotalBytes)
        return {
          status: 'unknown',
          reason: `source bytes exceed the module graph limit of ${MODULE_GRAPH_LIMITS.maxTotalBytes}`,
        };
      found = EXTRACT[language](path, text);
      if (key) {
        if (factsCache.size >= FACTS_ENTRIES) factsCache.clear();
        factsCache.set(key, found);
      }
    }
    facts.set(path, found);
    nodes.set(path, { path, language, deps: [] });
  }
  const context: ModuleContext = { paths: new Set(paths), nodes, read: source.read, facts };
  resolvePython(context);
  resolveGo(context);
  resolveRust(context);
  resolveJvm(context);
  for (const node of nodes.values()) node.deps = [...new Set(node.deps)].filter(dep => dep !== node.path);
  return { status: 'available', nodes, files: code.length };
}

/** Cache key of one head: every module source and manifest path with its content id. */
export const moduleGraphKey = (files: Iterable<{ path: string; blob: string }>) =>
  digestChunks(
    (function* () {
      for (const file of files) yield `${file.path}\0${file.blob}\n`;
    })(),
  );
const graphs = new Map<string, ModuleGraph>();
const GRAPH_ENTRIES = 8;
/** The graph of one head, built once per key (process-local, like the package graph cache). */
export function moduleGraphFor(key: string | undefined, source: ModuleSource): ModuleGraph {
  const hit = key ? graphs.get(key) : undefined;
  if (hit) return hit;
  const graph = buildModuleGraph(source);
  if (key && graph.status === 'available') {
    graphs.set(key, graph);
    if (graphs.size > GRAPH_ENTRIES) graphs.delete(graphs.keys().next().value!);
  }
  return graph;
}

export { moduleReach, type ModuleReach } from './module-selection.js';
