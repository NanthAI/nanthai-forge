// SPDX-License-Identifier: Apache-2.0
import { identity } from './hash.js';
import { positionIn } from './structural-positions.js';
import { scanCsharp } from './structural-csharp-scan.js';
import type { GraphPack, Snapshot, SymbolNode } from './types.js';

/** No Lezer grammar exists for C#, so declarations and `using` directives come from a small
 * scanner over the source with comments, strings and preprocessor lines masked. It reads only
 * type, namespace and member headers (never method bodies) and never runs project code. */
export const CSHARP_PROVIDER = {
  language: 'csharp',
  parser: 'forge-csharp-declaration-scanner',
  version: '1',
  relationships: ['declarations', 'captured-namespace-usings'],
};
const MAX_USING_EDGES = 64;

/** Declarations and namespace `using` edges for the captured C# files. */
export function csharpAnalysis(
  files: { file: string; text: string }[],
  snapshot: Snapshot,
): Pick<GraphPack, 'nodes' | 'imports' | 'issues'> {
  const nodes: SymbolNode[] = [],
    imports: GraphPack['imports'] = [],
    issues: GraphPack['issues'] = [];
  if (!files.length) return { nodes, imports, issues };
  const digests = new Map(snapshot.source.files.map(file => [file.path, file.digest]));
  const scans = files.map(({ file, text }) => ({ file, text, scan: scanCsharp(text) }));
  const declaring = new Map<string, string[]>();
  for (const { file, scan } of scans)
    for (const name of new Set(scan.namespaces)) declaring.set(name, [...(declaring.get(name) ?? []), file]);
  for (const { file, text, scan } of scans) {
    if (!scan.ok) {
      issues.push({ file, code: 'CSHARP_SYNTAX', offset: 0 });
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
        id: `symbol:${identity([snapshot.source.id, file, item.from, 'csharp', item.kind])}`,
        name: item.name,
        kind: item.kind,
        exported: item.exported,
        locator: locator(item.from, item.to),
      });
    for (const use of scan.usings) {
      const parts = use.specifier.split('.');
      // `using static N.Type;` and `using A = N.Type;` name a type: its namespace is the prefix.
      const candidates =
        use.target === 'type' ? [use.specifier, parts.slice(0, -1).join('.')] : [use.specifier];
      const hit = candidates.map(name => declaring.get(name)).find(Boolean) ?? [];
      const targets = [...new Set(hit)].filter(path => path !== file).sort();
      if (targets.length > MAX_USING_EDGES)
        issues.push({ file, code: 'CSHARP_USING_EDGES_TRUNCATED', offset: use.from });
      for (const target of targets.slice(0, MAX_USING_EDGES))
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
