import { ErrorToast } from './ui/Toast';
// SPDX-License-Identifier: Apache-2.0
import { DetailPanel } from './DetailPanel';
import type { SourceRequest, ImportEdge, Page, ReferenceEdge, SymbolNode } from './api';
import { PointField } from './PointField';
import { importEdges } from './graph-model';
type Props = {
  file: string;
  imports: Page<ImportEdge>;
  select: (file: string) => void;
  direction?: 'imports' | 'importers';
  request?: SourceRequest;
  source?: (file: string, line: number) => void;
};
export function ImportMap({ file, imports, select, direction = 'imports' }: Props) {
  const edges = importEdges(imports.results),
    names = [...new Set([file, ...edges.flatMap(edge => [edge.from, edge.to])])];
  const external = imports.results.filter(edge => edge.resolution !== 'resolved');
  return (
    <section
      className="repository-graph"
      aria-label={direction === 'importers' ? 'Direct importers map' : 'Import map'}
    >
      <div className="pane-heading">
        <h2>{direction === 'importers' ? 'Direct importers' : 'Source relationships'}</h2>
      </div>
      <PointField
        nodes={names.map(id => ({ id, label: id.split('/').at(-1)!, detail: id }))}
        edges={edges}
        selected={file}
        select={select}
      />
      <div className="graph-status">{edges.length} loaded relationships · partial coverage</div>
      <DetailPanel className="graph-coverage" title={<>Relationship details</>}>
        {!edges.length && <p>No resolved relationships in this page. Runtime effects remain unknown.</p>}
        <ul>
          {imports.results.map((edge, i) => (
            <li key={i}>
              {edge.target ? (
                <button
                  title={`${direction === 'importers' ? edge.from : edge.target}:${edge.locator.start.line}`}
                  onClick={() => select(direction === 'importers' ? edge.from : edge.target!)}
                >
                  {direction === 'importers' ? edge.from : edge.target}
                </button>
              ) : (
                <code>{edge.specifier}</code>
              )}
              :{edge.locator.start.line} · {edge.resolution}
            </li>
          ))}
        </ul>
        {imports.truncated && (
          <p>
            This page contains {imports.results.length} of {imports.total} recorded edges.
          </p>
        )}
        {external.length > 0 && <p>{external.length} external or unresolved imports in this page.</p>}
      </DetailPanel>
    </section>
  );
}
export function ReferenceMap({
  symbol,
  references,
  sourceId,
  analysisId,
  source,
}: {
  symbol: SymbolNode;
  references: Page<ReferenceEdge>;
  sourceId: string;
  analysisId: string;
  source: (file: string, line: number) => void;
}) {
  if (
    references.sourceId !== sourceId ||
    references.analysisId !== analysisId ||
    references.freshness !== 'current' ||
    references.results.some(edge => edge.target !== symbol.id)
  )
    return (
      <section className="map-pane" aria-label="Identifier reference map">
        <ErrorToast read>
          Reference data does not match this selected declaration, source and analysis.
        </ErrorToast>
      </section>
    );
  const groups = new Map<string, ReferenceEdge[]>();
  for (const edge of references.results) {
    const group = groups.get(edge.locator.file);
    if (group) group.push(edge);
    else groups.set(edge.locator.file, [edge]);
  }
  const nodes = [
    { id: symbol.id, label: symbol.name, detail: symbol.locator.file },
    ...[...groups].map(([file, edges]) => ({
      id: file,
      label: file.split('/').at(-1)!,
      detail: `${file} · ${edges.length} references`,
    })),
  ];
  return (
    <section className="repository-graph" aria-label="Identifier reference map">
      <div className="pane-heading">
        <h2>References to {symbol.name}</h2>
      </div>
      <PointField
        nodes={nodes}
        edges={[...groups.keys()].map(from => ({ from, to: symbol.id }))}
        selected={symbol.id}
        select={id =>
          id === symbol.id
            ? source(symbol.locator.file, symbol.locator.start.line)
            : source(id, groups.get(id)![0]!.locator.start.line)
        }
      />
      <div className="graph-status">
        {references.results.length} of {references.total} recorded references · partial coverage
      </div>
      <DetailPanel className="graph-coverage" title={<>Locations & provenance</>}>
        <p>
          Compiler-resolved identifier references, not a complete call graph or impact analysis. Runtime
          effects remain unknown.
        </p>
        <ul>
          {references.results.map((edge, i) => (
            <li key={i}>
              <button onClick={() => source(edge.locator.file, edge.locator.start.line)}>
                {edge.locator.file}:{edge.locator.start.line}
              </button>
            </li>
          ))}
        </ul>
        <p>
          Source <code>{references.sourceId}</code>
          <br />
          Analysis <code>{references.analysisId}</code>
        </p>
        {references.limitations.map(text => (
          <p key={text}>{text}</p>
        ))}
      </DetailPanel>
    </section>
  );
}
