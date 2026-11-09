// SPDX-License-Identifier: Apache-2.0
import { identity } from './hash.js';
import { positionIn } from './structural-positions.js';
import { scanElixir } from './structural-scan-elixir.js';
import { scanPhp } from './structural-scan-php.js';
import { scanRuby } from './structural-scan-ruby.js';
import type { DeclarationScan } from './structural-scan-types.js';
import type { GraphPack, Snapshot, SymbolNode } from './types.js';

/** No Lezer grammar is bundled for Ruby, PHP or Elixir, so declarations and imports come from small
 * scanners over the source with comments and literals masked (as for C#). They read declaration
 * headers and import lines only, never evaluate anything, and skip a file whose blocks do not balance
 * (`<LANGUAGE>_SYNTAX`). An import resolves to a captured file it names by path, else to the files
 * that declare the module, class or namespace it names. */
export const SCANNED_PROVIDERS = [
  {
    language: 'ruby',
    parser: 'forge-ruby-declaration-scanner',
    version: '1',
    relationships: ['declarations', 'captured-require-paths'],
  },
  {
    language: 'php',
    parser: 'forge-php-declaration-scanner',
    version: '1',
    relationships: ['declarations', 'captured-namespace-uses', 'captured-include-paths'],
  },
  {
    language: 'elixir',
    parser: 'forge-elixir-declaration-scanner',
    version: '1',
    relationships: ['declarations', 'captured-module-aliases'],
  },
] as const;
export type ScannedLanguage = (typeof SCANNED_PROVIDERS)[number]['language'];
export const SCANNED_LANGUAGES: ReadonlySet<string> = new Set(SCANNED_PROVIDERS.map(item => item.language));
const SCANNERS: Record<ScannedLanguage, (text: string, file: string) => DeclarationScan> = {
  ruby: scanRuby,
  php: scanPhp,
  elixir: text => scanElixir(text),
};
const MAX_IMPORT_EDGES = 64;

/** Declarations and import edges for the captured Ruby, PHP and Elixir files. */
export function scannedAnalysis(
  files: { file: string; text: string; language: ScannedLanguage }[],
  snapshot: Snapshot,
): Pick<GraphPack, 'nodes' | 'imports' | 'issues'> {
  const nodes: SymbolNode[] = [],
    imports: GraphPack['imports'] = [],
    issues: GraphPack['issues'] = [];
  if (!files.length) return { nodes, imports, issues };
  const digests = new Map(snapshot.source.files.map(file => [file.path, file.digest]));
  const scans = files.map(item => ({ ...item, scan: SCANNERS[item.language](item.text, item.file) }));
  /** Captured files by name, for suffix uses. */
  const byName = new Map<string, string[]>();
  for (const path of snapshot.content.keys()) {
    const name = path.slice(path.lastIndexOf('/') + 1);
    byName.set(name, [...(byName.get(name) ?? []), path]);
  }
  const bySuffix = (suffix: string) =>
    (byName.get(suffix.slice(suffix.lastIndexOf('/') + 1)) ?? []).filter(
      path => path === suffix || path.endsWith(`/${suffix}`),
    );
  /** Declaring files by `language:name`, so a Ruby constant never resolves to a PHP class. */
  const declaring = new Map<string, string[]>();
  for (const { file, language, scan } of scans)
    if (scan.ok)
      for (const name of new Set(scan.provides))
        declaring.set(`${language}:${name}`, [...(declaring.get(`${language}:${name}`) ?? []), file]);
  for (const { file, text, language, scan } of scans) {
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
    for (const item of scan.symbols)
      nodes.push({
        id: `symbol:${identity([snapshot.source.id, file, item.from, language, item.kind])}`,
        name: item.name,
        kind: item.kind,
        exported: item.exported,
        locator: locator(item.from, item.to),
      });
    for (const use of scan.uses) {
      const byPath = use.paths?.find(path => path !== file && snapshot.content.has(path));
      const targets = (
        byPath
          ? [byPath]
          : use.suffix
            ? bySuffix(use.suffix)
            : use.paths
              ? []
              : [...new Set(declaring.get(`${language}:${use.specifier}`) ?? [])]
      )
        .filter(path => path !== file)
        .sort();
      if (targets.length > MAX_IMPORT_EDGES)
        issues.push({ file, code: `${language.toUpperCase()}_IMPORT_EDGES_TRUNCATED`, offset: use.from });
      for (const target of targets.slice(0, MAX_IMPORT_EDGES))
        imports.push({
          from: file,
          specifier: use.specifier,
          target,
          resolution: 'resolved',
          locator: locator(use.from, use.to),
        });
      if (!targets.length)
        imports.push({
          from: file,
          specifier: use.specifier,
          target: null,
          resolution: 'external',
          locator: locator(use.from, use.to),
        });
    }
  }
  return { nodes, imports, issues };
}
