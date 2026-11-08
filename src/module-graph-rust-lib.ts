// SPDX-License-Identifier: Apache-2.0
import { identifiers } from './module-graph-scan.js';
import { RUST_DOC_UNIT, RUST_LIB_UNIT, type ModuleContext } from './module-graph-types.js';

/** Rust library code in the module graph (src/module-graph-rust.ts). Cargo builds a crate's library
 * into its own unit-test harness (`cargo test --lib FILTER`), its doctests (`--doc`) and, as a
 * dependency, every integration target, bin, bench and example. A library file reached by a change
 * therefore runs: the unit tests of the library modules that reach it (unit `:lib:a::b`, a test-name
 * filter), all doctests of the crate when it has any (unit `:doc`; doc comments are not read for
 * edges), and the integration targets whose files reach it (already edges). Anything outside a test
 * target or the library tree (bin, example, build script) stays whole (benches are not built by
 * `cargo test`: they have no unit), and so does a library
 * file that acts without being named or a proc-macro library.
 *
 * Rust uses code without naming its file: trait and inherent `impl`s apply wherever the type or trait
 * is in play, and `macro_rules!` macros are used by name. A file defining either is a dependency of
 * every file of its crate that names one of the crate's own types, traits or macros in the impl
 * header or the macro name (over-selecting, never missing). */

export type RustLibFacts = {
  /** Identifiers in the headers of `impl` blocks and the names of `macro_rules!` macros. */
  acts: string[];
  /** Names of structs, enums, unions, traits, type aliases and macros defined in the file. */
  declares: string[];
  tokens: string[];
  /** Test machinery in the file: a test attribute (`#[test]`, `#[tokio::test]`, `#[rstest]`,
   * `#[cfg(test)]`) or a test-generating macro call. */
  tests?: true;
  /** `macro_rules!` macros whose body defines tests: a file calling one has tests too. */
  testMacros?: string[];
  doc?: true;
  /** Why the file acts without being named at all (symbols, linker sections, registries). */
  hazard?: string;
};

const IMPL_KEYWORDS = new Set([
  'impl',
  'for',
  'where',
  'dyn',
  'mut',
  'const',
  'unsafe',
  'fn',
  'Self',
  'self',
]);
const HAZARD =
  /#\s*!?\[\s*(?:unsafe\s*\(\s*)?(?:no_mangle|export_name|link_section|used|global_allocator|panic_handler|ctor|dtor|distributed_slice|linkme)\b|\binventory\s*::\s*(?:submit|collect)|\bextern\s*(?:"[^"]*")?\s*\{/;
const TEST_WORD = '\\w*(?:test|quickcheck|proptest)\\w*';
const TEST_ATTRIBUTE = new RegExp(
  `#\\s*\\[\\s*(?:cfg(?:_attr)?\\s*\\(\\s*(?:all\\s*\\(\\s*)?test\\b|(?:\\w+\\s*::\\s*)*${TEST_WORD}\\s*(?:\\]|\\(|=))`,
  'i',
);
const TEST_MACRO_CALL = new RegExp(`(?<![\\w$])${TEST_WORD}\\s*!`, 'i');
const DOC_TEST = /^[ \t]*(?:\/\/[/!]|\*)[ \t]*`{3}|#\s*!?\[\s*(?:cfg_attr\s*\([^\]]*)?doc\s*=/m;

/** The library-related facts of one file; `code` is its source with comments and strings blanked. */
export function rustLibFacts(code: string, raw: string): RustLibFacts {
  const acts = new Set<string>();
  for (const match of code.matchAll(/(?<![\w$])impl\b([^{;]*)/g))
    for (const name of identifiers(match[1]!)) if (!IMPL_KEYWORDS.has(name)) acts.add(name);
  const declares = new Set<string>();
  for (const match of code.matchAll(/(?<![\w$])(?:struct|enum|union|trait|type)\s+([A-Za-z_]\w*)/g))
    declares.add(match[1]!);
  const testMacros: string[] = [];
  for (const match of code.matchAll(/(?<![\w$])macro_rules\s*!\s*([A-Za-z_]\w*)/g)) {
    declares.add(match[1]!);
    acts.add(match[1]!);
    const open = /[{([]/.exec(code.slice(match.index + match[0].length));
    if (!open) continue;
    const from = match.index + match[0].length + open.index;
    const pair = { '{': '}', '(': ')', '[': ']' }[open[0] as '{'];
    let depth = 0,
      end = from;
    for (; end < code.length; end++) {
      if (code[end] === open[0]) depth++;
      else if (code[end] === pair && --depth === 0) break;
    }
    if (TEST_ATTRIBUTE.test(code.slice(from, end))) testMacros.push(match[1]!);
  }
  const hazard = HAZARD.exec(code)?.[0].replace(/\s+/g, ' ');
  return {
    acts: [...acts],
    declares: [...declares],
    tokens: [...identifiers(code)],
    ...(TEST_ATTRIBUTE.test(code) || TEST_MACRO_CALL.test(code) ? { tests: true as const } : {}),
    ...(testMacros.length ? { testMacros } : {}),
    ...(DOC_TEST.test(raw) ? { doc: true as const } : {}),
    ...(hazard ? { hazard } : {}),
  };
}

/** What the library logic needs to know of a crate (src/module-graph-rust.ts `Crate`). */
export type RustLibCrate = {
  dir: string;
  libRoot: string;
  /** Bench target roots `cargo test` does not build (no `test = true`). */
  benches: Set<string>;
  procMacro: boolean;
  /** `[lib] test = false` / `doctest = false` switch the harnesses off. */
  libTest: boolean;
  libDoc: boolean;
};

const WHOLE_OUTSIDE = 'outside every Cargo package Forge read';
const WHOLE_BUILT =
  'binary, example or build-script code: Cargo builds it into every integration test target of the crate';

/** Sets `units` or `whole` on every Rust file that is not in an integration test target, and adds the
 * implicit-use edges. `children` is the `mod name;` tree, `crateFor` the owning crate of a path. */
export function resolveRustLib(
  context: ModuleContext,
  files: [string, RustLibFacts][],
  children: Map<string, Map<string, string>>,
  crateFor: (path: string) => RustLibCrate | undefined,
) {
  // Library module trees: file → module path (`a::b`; the root is empty).
  const trees = new Map<RustLibCrate, Map<string, string>>();
  // One pass over the files: `crateFor` scans every crate, so it is not called per crate.
  const byCrate = new Map<RustLibCrate, [string, RustLibFacts][]>();
  for (const file of files) {
    const crate = crateFor(file[0]);
    if (crate) (byCrate.get(crate) ?? byCrate.set(crate, []).get(crate)!).push(file);
    else context.nodes.get(file[0])!.whole = WHOLE_OUTSIDE;
  }
  for (const crate of byCrate.keys()) {
    if (!context.nodes.has(crate.libRoot)) continue;
    const tree = new Map([[crate.libRoot, '']]);
    const queue = [crate.libRoot];
    for (let i = 0; i < queue.length; i++)
      for (const [name, child] of children.get(queue[i]!) ?? []) {
        if (tree.has(child)) continue;
        const parent = tree.get(queue[i]!)!;
        tree.set(child, parent ? `${parent}::${name}` : name);
        queue.push(child);
      }
    trees.set(crate, tree);
  }
  const facts = new Map(files);
  for (const [crate, members] of byCrate) {
    const declared = new Set(members.flatMap(([, item]) => item.declares));
    const actors = new Map<string, string[]>();
    for (const [path, item] of members)
      for (const name of item.acts)
        if (declared.has(name)) (actors.get(name) ?? actors.set(name, []).get(name)!).push(path);
    for (const [path, item] of members)
      for (const token of item.tokens)
        for (const actor of actors.get(token) ?? [])
          if (actor !== path) context.nodes.get(path)!.deps.push(actor);
    const tree = trees.get(crate);
    const benched = new Set(crate.benches);
    for (const path of benched) for (const child of children.get(path)?.values() ?? []) benched.add(child);
    const generators = new Set(members.flatMap(([, item]) => item.testMacros ?? []));
    const docs = crate.libDoc && !!tree && [...tree.keys()].some(path => facts.get(path)?.doc);
    for (const [path, item] of members) {
      const node = context.nodes.get(path)!;
      if (node.units) continue;
      const module = tree?.get(path);
      if (benched.has(path)) node.units = [];
      else if (module === undefined) node.whole = WHOLE_BUILT;
      else if (crate.procMacro)
        node.whole = 'proc-macro library: its macros act in files that never name its path';
      else if (item.hazard) node.whole = `${item.hazard} acts without being named`;
      else
        node.units = [
          ...((item.tests || item.tokens.some(token => generators.has(token))) && crate.libTest
            ? [`${RUST_LIB_UNIT}${module}`]
            : []),
          ...(docs ? [RUST_DOC_UNIT] : []),
        ];
    }
  }
}
