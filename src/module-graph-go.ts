// SPDX-License-Identifier: Apache-2.0
import { blank, joinPath, posixBasename, posixDirname } from './module-graph-scan.js';
import type { ModuleContext, ModuleNode } from './module-graph-types.js';

/** Go module edges at package-folder granularity, the unit Go compiles and tests: each folder with
 * non-test files is a node `\0go:DIR` that uses all of them, and every file in the folder (tests
 * included) uses it. An import path resolves through the repository's go.mod module paths (longest
 * match). Build tags are ignored, so tagged files add edges, never remove them. A file that runs
 * other programs or loads plugins (os/exec, plugin) is `wide`, and so is an in-repository import that
 * names no package folder. Test units are folders with `_test.go` files: `go test ./DIR`. */

export type GoFacts = { pkg: string; imports: string[]; wide?: string };
const DYNAMIC = new Set(['os/exec', 'plugin']);

export const goPackageNode = (dir: string) => `\0go:${dir}`;

export function goFacts(_path: string, text: string): GoFacts {
  const code = blank(text, 'go', true);
  const pkg = /^\s*package\s+(\w+)/m.exec(code)?.[1] ?? '';
  // Imports precede every other declaration.
  const header = code.slice(0, /^\s*(?:func|type|var|const)\b/m.exec(code)?.index ?? code.length);
  const imports: string[] = [];
  for (const block of header.matchAll(/\bimport\s*\(([^)]*)\)/g))
    for (const spec of block[1]!.matchAll(/["`]([^"`\n]+)["`]/g)) imports.push(spec[1]!);
  for (const single of header.matchAll(/\bimport\s+(?:[\w.]+\s+)?["`]([^"`\n]+)["`]/g))
    imports.push(single[1]!);
  const dynamic = imports.find(path => DYNAMIC.has(path));
  return { pkg, imports, ...(dynamic ? { wide: `runs or loads other code (${dynamic})` } : {}) };
}

export function resolveGo(context: ModuleContext) {
  const files = [...context.facts].filter(([path]) => path.endsWith('.go')) as [string, GoFacts][];
  if (!files.length) return;
  const modules: { dir: string; path: string }[] = [];
  for (const path of context.paths)
    if (posixBasename(path) === 'go.mod' && !/(?:^|\/)(?:vendor|testdata|\.[^/]+)\//.test(path)) {
      const module = /^\s*module\s+"?([^\s"]+)"?/m.exec(context.read(path) ?? '')?.[1];
      if (module) modules.push({ dir: posixDirname(path), path: module });
    }
  modules.sort((a, b) => b.path.length - a.path.length);
  const isTest = (path: string) => path.endsWith('_test.go');
  const members = new Map<string, string[]>();
  for (const [path, facts] of files)
    if (!isTest(path) && !facts.pkg.endsWith('_test')) {
      const dir = posixDirname(path);
      members.set(dir, [...(members.get(dir) ?? []), path]);
    }
  for (const [dir, list] of members) {
    const node: ModuleNode = { path: goPackageNode(dir), language: 'go', deps: list };
    context.nodes.set(node.path, node);
  }
  for (const [path, facts] of files) {
    const node = context.nodes.get(path)!;
    const dir = posixDirname(path);
    if (facts.wide) node.wide = facts.wide;
    if (members.has(dir)) node.deps.push(goPackageNode(dir));
    if (isTest(path)) node.units = [dir];
    for (const spec of facts.imports) {
      const module = modules.find(item => spec === item.path || spec.startsWith(`${item.path}/`));
      if (!module) continue;
      const target = joinPath(module.dir, spec.slice(module.path.length + 1));
      if (members.has(target)) node.deps.push(goPackageNode(target));
      else node.wide ??= `in-repository import ${spec} names no package folder Forge read`;
    }
  }
}
