// SPDX-License-Identifier: Apache-2.0
import { blank, identifiers, joinPath, posixBasename, posixDirname, topLevel } from './module-graph-scan.js';
import { parseToml, tomlGet, tomlTable, type TomlTable, type TomlValue } from './toml-lite.js';
import {
  resolveRustLib,
  rustLibFacts,
  type RustLibCrate,
  type RustLibFacts,
} from './module-graph-rust-lib.js';
import type { ModuleContext } from './module-graph-types.js';

/** Rust module edges inside and across in-repository crates: `mod name;` builds the module tree
 * (next to a crate root or mod.rs, else in the parent's own folder), and every `crate::`, `$crate::`,
 * `self::`, `super::`, child-module or in-repository crate path (`use` or inline) is an edge to the
 * deepest module it names; a `{…}` group adds the modules it names below that one. `include!`,
 * `#[path]` and `mod name;` inside an inline module are `wide`. Test-target files belong to their
 * targets (`cargo test --test NAME`); library files narrow to unit tests and doctests
 * (src/module-graph-rust-lib.ts); other binary, bench and example code is built into every test
 * target, so reaching it makes the crate whole. */

/** `inline`: how many inline `mod name { … }` blocks enclose the path (their `super` is this file). */
type Chain = { segments: string[]; group: string[]; inline?: number };
export type RustFacts = RustLibFacts & { mods: string[]; chains: Chain[]; wide?: string };

export function rustFacts(_path: string, text: string): RustFacts {
  const code = blank(text, 'rust');
  const top = topLevel(code);
  const mods: string[] = [];
  let wide: string | undefined;
  for (const match of code.matchAll(/(?<![\w$])mod\s+([A-Za-z_]\w*)\s*;/g)) {
    if (top[match.index] === ' ') wide ??= `mod ${match[1]}; inside an inline module`;
    else mods.push(match[1]!);
  }
  if (/(?<![\w$])include!\s*\(/.test(code)) wide ??= 'include! of other source';
  if (/#\s*!?\[\s*path\b/.test(code)) wide ??= '#[path] module attribute';
  const chains: Chain[] = [];
  const blocks: [number, number][] = [];
  for (const match of code.matchAll(/(?<![\w$])mod\s+[A-Za-z_]\w*\s*\{/g)) {
    let depth = 0,
      close = match.index + match[0].length - 1;
    for (; close < code.length; close++) {
      if (code[close] === '{') depth++;
      else if (code[close] === '}' && --depth === 0) break;
    }
    blocks.push([match.index, close]);
  }
  const start = /(\$crate|(?<![\w$])[a-z_]\w*)\s*::/g;
  let end = 0;
  for (let match = start.exec(code); match; match = start.exec(code)) {
    if (match.index < end) continue;
    const segments = [match[1]!];
    let group: string[] = [];
    let at = match.index + match[0].length;
    for (;;) {
      const next = /^\s*(?:([A-Za-z_]\w*)|(\{))/.exec(code.slice(at, at + 200));
      if (!next) break;
      at += next[0].length;
      if (next[2]) {
        let depth = 1,
          close = at;
        while (close < code.length && depth) {
          if (code[close] === '{') depth++;
          else if (code[close] === '}') depth--;
          close++;
        }
        group = [...identifiers(code.slice(at, close))];
        at = close;
        break;
      }
      segments.push(next[1]!);
      const sep = /^\s*::/.exec(code.slice(at, at + 50));
      if (!sep) break;
      at += sep[0].length;
    }
    end = at;
    start.lastIndex = Math.max(start.lastIndex, at);
    const inline = blocks.filter(([from, to]) => match.index > from && match.index < to).length;
    chains.push({ segments, group, ...(inline ? { inline } : {}) });
  }
  return { mods, chains, ...rustLibFacts(code, text), ...(wide ? { wide } : {}) };
}

const tables = (value: TomlValue | undefined): TomlTable[] =>
  Array.isArray(value) ? value.map(tomlTable) : value ? [tomlTable(value)] : [];

type Crate = RustLibCrate & { lib: string; roots: Set<string>; tests: Map<string, string> };

function crateOf(manifest: string, toml: TomlTable, paths: Set<string>): Crate | null {
  const name = tomlGet(toml, 'package', 'name');
  if (typeof name !== 'string') return null;
  const dir = posixDirname(manifest);
  const at = (path: string) => joinPath(dir, path);
  const lib = tomlTable(toml.lib);
  const libRoot = at(typeof lib.path === 'string' ? lib.path : 'src/lib.rs');
  const roots = new Set([
    libRoot,
    at('src/main.rs'),
    at(
      typeof tomlGet(toml, 'package', 'build') === 'string'
        ? (tomlGet(toml, 'package', 'build') as string)
        : 'build.rs',
    ),
  ]);
  const tests = new Map<string, string>();
  const benches = new Set<string>();
  for (const path of paths) {
    if (!path.startsWith(dir ? `${dir}/` : '')) continue;
    const rest = dir ? path.slice(dir.length + 1) : path;
    const target = /^(src\/bin|tests|benches|examples)\/([^/]+?)(?:\.rs|\/main\.rs)$/.exec(rest);
    if (!target) continue;
    roots.add(path);
    if (target[1] === 'tests' && tomlGet(toml, 'package', 'autotests') !== false) tests.set(target[2]!, path);
    if (target[1] === 'benches') benches.add(path);
  }
  for (const kind of ['bin', 'test', 'bench', 'example'])
    for (const target of tables(toml[kind])) {
      const label = typeof target.name === 'string' ? target.name : undefined;
      const folder = { bin: 'src/bin', test: 'tests', bench: 'benches', example: 'examples' }[kind]!;
      const path =
        typeof target.path === 'string' ? at(target.path) : label ? at(`${folder}/${label}.rs`) : undefined;
      if (!path) continue;
      roots.add(path);
      if (kind === 'test' && label) tests.set(label, path);
      // `cargo test` builds a bench only when its target says `test = true`.
      if (kind === 'bench') benches[target.test === true ? 'delete' : 'add'](path);
    }
  return {
    dir,
    lib: (typeof lib.name === 'string' ? lib.name : name).replace(/-/g, '_'),
    libRoot,
    roots,
    tests,
    benches,
    procMacro: lib['proc-macro'] === true,
    libTest: lib.test !== false,
    libDoc: lib.doctest !== false,
  };
}

export function resolveRust(context: ModuleContext) {
  const files = [...context.facts].filter(([path]) => path.endsWith('.rs')) as [string, RustFacts][];
  if (!files.length) return;
  const crates: Crate[] = [];
  for (const path of context.paths) {
    if (posixBasename(path) !== 'Cargo.toml' || /(?:^|\/)(?:target|\.[^/]+)\//.test(path)) continue;
    try {
      const crate = crateOf(path, parseToml(context.read(path) ?? ''), context.paths);
      if (crate) crates.push(crate);
    } catch {
      // An unreadable manifest places no crate: its files stay whole below.
    }
  }
  crates.sort((a, b) => b.dir.length - a.dir.length);
  const crateFor = (path: string) => crates.find(crate => !crate.dir || path.startsWith(`${crate.dir}/`));
  const byLib = new Map(crates.map(crate => [crate.lib, crate]));
  const children = new Map<string, Map<string, string>>();
  const parent = new Map<string, string>();
  for (const [path, facts] of files) {
    const node = context.nodes.get(path)!;
    if (facts.wide) node.wide = facts.wide;
    const stem = posixBasename(path).replace(/\.rs$/, '');
    const owner = ['lib', 'main', 'mod'].includes(stem) || crateFor(path)?.roots.has(path);
    const base = owner ? posixDirname(path) : joinPath(posixDirname(path), stem);
    for (const name of facts.mods) {
      const child = [joinPath(base, `${name}.rs`), joinPath(base, name, 'mod.rs')].find(item =>
        context.nodes.has(item),
      );
      if (!child) {
        node.wide ??= `mod ${name}; has no file Forge read`;
        continue;
      }
      children.set(path, (children.get(path) ?? new Map()).set(name, child));
      parent.set(child, path);
    }
  }
  const rootOf = (path: string) => {
    const seen = new Set<string>();
    let at = path;
    while (parent.has(at) && !seen.has(at)) {
      seen.add(at);
      at = parent.get(at)!;
    }
    return at;
  };
  const named = (from: string, names: Set<string>) => {
    const found: string[] = [];
    const seen = new Set([from]);
    const queue = [from];
    for (let i = 0; i < queue.length; i++)
      for (const [name, child] of children.get(queue[i]!) ?? []) {
        if (names.has(name)) found.push(child);
        if (!seen.has(child)) {
          queue.push(child);
          seen.add(child);
        }
      }
    return found;
  };
  for (const crate of crates)
    for (const [name, root] of crate.tests) {
      if (!context.nodes.has(root)) continue;
      const queue = [root];
      const seen = new Set(queue);
      for (let i = 0; i < queue.length; i++) {
        const node = context.nodes.get(queue[i]!)!;
        node.units = [...new Set([...(node.units ?? []), name])];
        for (const child of children.get(queue[i]!)?.values() ?? [])
          if (!seen.has(child)) {
            queue.push(child);
            seen.add(child);
          }
      }
    }
  resolveRustLib(context, files, children, crateFor);
  for (const [path, facts] of files) {
    const node = context.nodes.get(path)!;
    for (const { segments, group, inline = 0 } of facts.chains) {
      const [first, ...rest] = segments;
      let module: string | undefined;
      if (first === 'crate' || first === '$crate') module = rootOf(path);
      else if (first === 'self') module = path;
      else if (first === 'super') {
        // Inside inline modules the first `super`s stay in this file.
        let up = 1;
        while (rest[0] === 'super') {
          up++;
          rest.shift();
        }
        module = path;
        for (let i = inline; i < up && module; i++) module = parent.get(module);
      } else if (children.get(path)?.has(first!)) module = children.get(path)!.get(first!);
      else if (byLib.has(first!)) module = byLib.get(first!)!.libRoot;
      if (!module || !context.nodes.has(module)) continue;
      let deepest: string = module;
      for (const segment of rest) {
        const next: string | undefined = children.get(deepest)?.get(segment);
        if (!next) break;
        deepest = next;
      }
      node.deps.push(deepest);
      if (group.length) node.deps.push(...named(deepest, new Set(group)));
    }
  }
}
