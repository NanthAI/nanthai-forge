// SPDX-License-Identifier: Apache-2.0
import { blank, identifiers, posixBasename, topLevel } from './module-graph-scan.js';
import type { ModuleContext } from './module-graph-types.js';

/** Java and Kotlin module edges by package and name: a file uses another file when it can see that
 * file's package (its own package, which needs no import, a package it imports from, or one it names
 * as a qualified `a.b.Name`) and its text names one of that file's top-level declarations (Kotlin's
 * file facade `FooKt` and `@file:JvmName` included). Names are matched as words, so a common name
 * over-selects; it never under-selects. An import naming a declaration Forge did not find uses the
 * whole imported package. Reflection by name (Class.forName, ServiceLoader, loadClass) and process
 * spawning are `wide`; package-info.java and top-level Kotlin `operator fun`s act without being named,
 * so reaching one makes its package whole. Test units are test classes under `src/test/` (Gradle
 * `--tests`, Maven `-Dtest`); a test file in another source set (`src/jvmTest`, `src/androidTest`)
 * runs under another task, so reaching one keeps its project whole. */

export type JvmFacts = {
  pkg: string;
  names: string[];
  classes: string[];
  imports: { path: string; star: boolean }[];
  qualified: string[];
  tokens: string[];
  test: boolean;
  wide?: string;
  hub?: string;
};

const DYNAMIC =
  /\b(?:Class\s*\.\s*forName|ServiceLoader|loadClass|ProcessBuilder|getRuntime\s*\(\s*\)\s*\.\s*exec)\b/;
const KOTLIN_DECL =
  /^[ \t]*(?:@[\w.]+(?:\([^)\n]*\))?\s+)*((?:(?:public|private|internal|protected|open|abstract|sealed|data|inline|value|enum|annotation|expect|actual|external|const|lateinit|suspend|tailrec|operator|infix|fun)\s+)*)(class|interface|object|fun|val|var|typealias)\s+(?:<[^>\n]*>\s*)?(?:[\w.]+(?:<[^>\n]*>)?\??\.)?`?(\w+)`?/gm;
const JAVA_DECL =
  /^[ \t]*(?:@[\w.]+(?:\([^)\n]*\))?\s+)*(?:(?:public|protected|private|abstract|final|static|sealed|non-sealed|strictfp)\s+)*(class|interface|enum|record|@interface)\s+(\w+)/gm;
const TEST_MARK =
  /@(?:Test|ParameterizedTest|TestFactory|RepeatedTest|TestTemplate)\b|\bextends\s+TestCase\b/;

export function jvmFacts(path: string, text: string, language: 'java' | 'kotlin'): JvmFacts {
  const code = blank(text, language);
  const top = topLevel(code, true);
  const pkg = /^\s*package\s+([\w.]+)/m.exec(code)?.[1] ?? '';
  const imports: JvmFacts['imports'] = [];
  for (const match of code.matchAll(/^\s*import\s+(?:static\s+)?([\w.]+)(\s*\.\s*\*)?/gm))
    imports.push({ path: match[1]!, star: !!match[2] });
  const names: string[] = [];
  const classes: string[] = [];
  let hub: string | undefined;
  if (language === 'kotlin') {
    for (const match of top.matchAll(KOTLIN_DECL)) {
      if (/\bprivate\b/.test(match[1]!)) continue;
      names.push(match[3]!);
      if (/class|object/.test(match[2]!)) classes.push(match[3]!);
      if (/\boperator\b/.test(match[1]!)) hub ??= `top-level operator fun ${match[3]}`;
    }
    const facade = /@file\s*:\s*JvmName\s*\(\s*"(\w+)"/.exec(text)?.[1];
    names.push(facade ?? `${posixBasename(path).replace(/\.kt$/, '')}Kt`);
  } else
    for (const match of top.matchAll(JAVA_DECL)) {
      names.push(match[2]!);
      classes.push(match[2]!);
    }
  if (language === 'java' && posixBasename(path) === 'package-info.java') hub = 'package-info.java';
  const qualified = [...new Set(code.match(/\b[a-z_]\w*(?:\s*\.\s*\w+)+/g) ?? [])].map(item =>
    item.replace(/\s+/g, ''),
  );
  const dynamic = DYNAMIC.exec(code);
  return {
    pkg,
    names: [...new Set(names)],
    classes,
    imports,
    qualified,
    tokens: [...identifiers(code)],
    test: TEST_MARK.test(code) || /(?:Test|Tests|IT|Spec)\.(?:kt|java)$/.test(path),
    ...(dynamic ? { wide: `loads or runs code by name (${dynamic[0].replace(/\s+/g, '')})` } : {}),
    ...(hub ? { hub } : {}),
  };
}

/** The source set of a JVM path: `test` for `src/test/`, another name for other test sets. */
const sourceSet = (path: string) => /(?:^|\/)src\/([^/]+)\//.exec(path)?.[1];

export function resolveJvm(context: ModuleContext) {
  const files = [...context.facts].filter(([path]) => /\.(?:java|kt)$/.test(path)) as [string, JvmFacts][];
  if (!files.length) return;
  const declared = new Map<string, Map<string, string[]>>();
  const members = new Map<string, string[]>();
  for (const [path, facts] of files) {
    members.set(facts.pkg, [...(members.get(facts.pkg) ?? []), path]);
    const names = declared.get(facts.pkg) ?? new Map<string, string[]>();
    for (const name of facts.names) names.set(name, [...(names.get(name) ?? []), path]);
    declared.set(facts.pkg, names);
  }
  /** The longest known package that `dotted` starts with, and the name after it. */
  const split = (dotted: string) => {
    const parts = dotted.split('.');
    for (let i = parts.length - 1; i > 0; i--) {
      const pkg = parts.slice(0, i).join('.');
      if (members.has(pkg)) return { pkg, name: parts[i]! };
    }
    return members.has(dotted) ? { pkg: dotted, name: undefined } : undefined;
  };
  for (const [path, facts] of files) {
    const node = context.nodes.get(path)!;
    if (facts.wide) node.wide = facts.wide;
    if (facts.hub) node.whole = `${facts.hub} acts without being named`;
    const set = sourceSet(path);
    if (set && set !== 'main' && /test/i.test(set) && set !== 'test')
      node.whole = `test source set src/${set} runs under its own task`;
    else if (set === 'test' && facts.test && facts.classes.length)
      node.units = facts.classes.map(name => (facts.pkg ? `${facts.pkg}.${name}` : name));
    const visible = new Set([facts.pkg]);
    for (const item of facts.imports) {
      const found = split(item.path);
      if (!found) continue;
      visible.add(found.pkg);
      if (item.star || !found.name) continue;
      if (!declared.get(found.pkg)?.has(found.name)) node.deps.push(...members.get(found.pkg)!);
    }
    for (const dotted of facts.qualified) {
      const found = split(dotted);
      if (found) visible.add(found.pkg);
    }
    const tokens = new Set(facts.tokens);
    for (const pkg of visible)
      for (const [name, owners] of declared.get(pkg) ?? []) if (tokens.has(name)) node.deps.push(...owners);
  }
}
