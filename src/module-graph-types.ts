// SPDX-License-Identifier: Apache-2.0
/** Shared shapes of the module graph (src/module-graph.ts). */
export type ModuleLanguage = 'python' | 'go' | 'rust' | 'java' | 'kotlin';

export type ModuleNode = {
  /** A repository path, or `\0go:DIR` for a Go package folder. */
  path: string;
  language: ModuleLanguage;
  /** Nodes this one uses (imports, references): a change to a dep can change this node. */
  deps: string[];
  /** Why this file may use anything in its package (dynamic loading, an unresolved local import):
   * it is reached whenever any file of its package is. */
  wide?: string;
  /** Why reaching this file makes its owning package whole (its users are invisible to the graph, or
   * the package's test runner builds it into every test). */
  whole?: string;
  /** Test units this file belongs to, in its ecosystem's terms (a pytest file, a Go package folder, a
   * Cargo test target, a JVM test class). */
  units?: string[];
};

export type ModuleGraph =
  | { status: 'available'; nodes: Map<string, ModuleNode>; files: number }
  | { status: 'unknown'; reason: string };

/** What one language resolver reads and writes while a graph is built. */
export type ModuleContext = {
  paths: Set<string>;
  nodes: Map<string, ModuleNode>;
  /** Facts per source path, from that language's extractor. */
  facts: Map<string, unknown>;
  read: (path: string) => string | undefined;
};
