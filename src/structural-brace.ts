// SPDX-License-Identifier: Apache-2.0
import { identity } from './hash.js';
import { positionIn } from './structural-positions.js';
import { scanBraces, type BraceLanguage } from './structural-brace-scan.js';
import type { GraphPack, Snapshot, SymbolNode } from './types.js';

/** Swift, Kotlin and Dart code-map providers: declarations from a header scanner
 * (src/structural-brace-scan.ts) and import edges between captured files. Swift `import M` reaches
 * the SwiftPM target folder `Sources/M/`; Kotlin `import a.b.C` reaches the files of package `a.b`
 * that declare `C` (else the whole package); Dart `import 'x.dart'` reaches that file and
 * `package:p/x.dart` the captured `p/lib/x.dart` (or `lib/x.dart`). */
export const BRACE_PROVIDERS = [
  {
    language: 'swift',
    parser: 'forge-swift-declaration-scanner',
    version: '1',
    relationships: ['declarations', 'captured-swiftpm-target-imports'],
  },
  {
    language: 'kotlin',
    parser: 'forge-kotlin-declaration-scanner',
    version: '1',
    relationships: ['declarations', 'captured-package-imports'],
  },
  {
    language: 'dart',
    parser: 'forge-dart-declaration-scanner',
    version: '1',
    relationships: ['declarations', 'captured-relative-and-package-imports'],
  },
];
export const isBraceLanguage = (language: string | undefined): language is BraceLanguage =>
  language === 'swift' || language === 'kotlin' || language === 'dart';
const MAX_IMPORT_EDGES = 64;
const dirOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
function join(base: string, relative: string): string | null {
  const parts = base ? base.split('/') : [];
  for (const part of relative.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.join('/');
}

/** Declarations and import edges for the captured Swift, Kotlin and Dart files. */
export function braceAnalysis(
  files: { file: string; text: string; language: BraceLanguage }[],
  snapshot: Snapshot,
): Pick<GraphPack, 'nodes' | 'imports' | 'issues'> {
  const nodes: SymbolNode[] = [],
    imports: GraphPack['imports'] = [],
    issues: GraphPack['issues'] = [];
  if (!files.length) return { nodes, imports, issues };
  const digests = new Map(snapshot.source.files.map(file => [file.path, file.digest]));
  const scans = files.map(item => ({ ...item, scan: scanBraces(item.text, item.language) }));
  // One pass per index: SwiftPM target folders, Kotlin packages and the top-level names they declare.
  const swiftTargets = new Map<string, string[]>();
  const kotlinPackages = new Map<string, string[]>();
  const kotlinNames = new Map<string, string[]>();
  const dartFiles = new Set<string>();
  const dartLibs = new Map<string, string[]>();
  const add = (map: Map<string, string[]>, key: string, file: string) =>
    (map.get(key) ?? map.set(key, []).get(key)!).push(file);
  for (const { file, language, scan } of scans) {
    if (language === 'swift') {
      const target = /(?:^|\/)Sources\/([^/]+)\/(?:.*\/)?[^/]+$/.exec(file)?.[1];
      if (target) add(swiftTargets, target, file);
    } else if (language === 'dart') {
      dartFiles.add(file);
      const lib = file.startsWith('lib/') ? 0 : file.lastIndexOf('/lib/') + 1;
      if (lib > 0 || file.startsWith('lib/')) add(dartLibs, file.slice(lib), file);
    } else if (scan.ok) {
      add(kotlinPackages, scan.packageName, file);
      for (const name of new Set(scan.symbols.map(symbol => symbol.name)))
        add(kotlinNames, `${scan.packageName}\0${name}`, file);
    }
  }
  const targets = (item: (typeof scans)[number], specifier: string): string[] => {
    if (item.language === 'swift') return swiftTargets.get(specifier.split('.')[0]!) ?? [];
    if (item.language === 'kotlin') {
      const whole = kotlinPackages.get(specifier);
      if (whole) return whole;
      const cut = specifier.lastIndexOf('.');
      const owner = specifier.slice(0, Math.max(0, cut));
      return kotlinNames.get(`${owner}\0${specifier.slice(cut + 1)}`) ?? kotlinPackages.get(owner) ?? [];
    }
    if (specifier.startsWith('dart:')) return [];
    const pkg = /^package:([\w]+)\/(.+)$/.exec(specifier);
    if (pkg) {
      const tail = `lib/${pkg[2]}`;
      const found = dartLibs.get(tail) ?? [];
      const named = found.filter(path => path === tail || path.endsWith(`/${pkg[1]}/${tail}`));
      return named.length ? named : found.slice(0, 1);
    }
    if (/^[a-z]+:/.test(specifier)) return [];
    const path = join(dirOf(item.file), specifier);
    return path !== null && dartFiles.has(path) ? [path] : [];
  };
  for (const item of scans) {
    const { file, text, language, scan } = item;
    if (!scan.ok) {
      issues.push({ file, code: `${language.toUpperCase()}_SYNTAX`, offset: 0 });
      continue;
    }
    const position = positionIn(text);
    const locator = (from: number, to: number) => ({
      file,
      digest: digests.get(file)!,
      start: position(from),
      end: position(to),
    });
    for (const symbol of scan.symbols)
      nodes.push({
        id: `symbol:${identity([snapshot.source.id, file, symbol.from, language, symbol.kind])}`,
        name: symbol.name,
        kind: symbol.kind,
        exported: symbol.exported,
        locator: locator(symbol.from, symbol.to),
      });
    for (const use of scan.imports) {
      const found = [...new Set(targets(item, use.specifier))].filter(path => path !== file).sort();
      if (found.length > MAX_IMPORT_EDGES)
        issues.push({ file, code: `${language.toUpperCase()}_IMPORT_EDGES_TRUNCATED`, offset: use.from });
      for (const target of found.slice(0, MAX_IMPORT_EDGES))
        imports.push({
          from: file,
          specifier: use.specifier,
          target,
          resolution: 'resolved',
          locator: locator(use.from, use.to),
        });
      if (!found.length)
        imports.push({
          from: file,
          specifier: use.specifier,
          target: null,
          resolution: language === 'dart' && !/^[a-z]+:/.test(use.specifier) ? 'unresolved' : 'external',
          locator: locator(use.from, use.to),
        });
    }
  }
  return { nodes, imports, issues };
}
