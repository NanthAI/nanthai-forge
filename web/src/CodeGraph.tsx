// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState, useId } from 'react';
import { codeGraphLayout, codeGraphEdge } from './code-graph-layout';
import type { PointEdge, PointNode } from './graph-model';

/** A file graph: folder groups, explicit import edges, and keyboard-reachable source links. */
export function CodeGraph({
  nodes,
  edges,
  selected,
  select,
  open,
  minimumHeight = 480,
}: {
  nodes: readonly PointNode[];
  edges: readonly PointEdge[];
  selected: string;
  select: (path: string) => void;
  open?: (path: string) => void;
  minimumHeight?: number;
}) {
  const markerId = useId().replaceAll(':', '');
  const host = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(900);
  useEffect(() => {
    if (!host.current) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(host.current);
    return () => observer.disconnect();
  }, [nodes.length > 0]);
  const { panels, positions, cardWidth, height } = codeGraphLayout(nodes, width, minimumHeight);
  const nodeWidths = new Map(
    nodes.map(node => [
      node.id,
      node.weight === undefined
        ? cardWidth
        : cardWidth * (0.76 + Math.min(1, Math.log2(1 + node.weight) / 10) * 0.24),
    ]),
  );
  if (!nodes.length) return <p className="code-graph-empty">No files in this scope.</p>;
  return (
    <div ref={host} className="code-graph-canvas" tabIndex={0} aria-label="Source graph; scroll to explore">
      <svg
        width="100%"
        viewBox={`0 0 ${Math.max(280, width)} ${height}`}
        height={height}
        role="group"
        aria-label="File import graph"
      >
        <defs>
          <marker id={markerId} markerWidth="7" markerHeight="7" refX="7" refY="3.5" orient="auto">
            <path d="M0 0 L7 3.5 L0 7" fill="none" stroke="var(--fx-text-3)" />
          </marker>
        </defs>
        {panels.map(panel => (
          <g key={panel.folder}>
            <rect
              className="code-graph-area"
              x={panel.x}
              y={panel.y}
              width={panel.width}
              height={panel.height}
              rx={8}
            />
            <text className="code-graph-folder" x={panel.x + 14} y={panel.y + 21}>
              {panel.folder}
            </text>
          </g>
        ))}
        {edges.map(edge => {
          const a = positions.get(edge.from),
            b = positions.get(edge.to);
          if (!a || !b) return null;
          return (
            <path
              markerEnd={`url(#${markerId})`}
              className={`code-graph-edge ${edge.from === selected || edge.to === selected ? 'selected' : ''}`}
              key={`${edge.from}:${edge.to}`}
              d={codeGraphEdge(
                { ...a, width: nodeWidths.get(edge.from)! },
                { ...b, width: nodeWidths.get(edge.to)! },
                cardWidth,
              )}
            />
          );
        })}
        {nodes.map(node => {
          const point = positions.get(node.id)!;
          const nodeWidth = nodeWidths.get(node.id)!;
          return (
            <g
              key={node.id}
              data-node-id={node.id}
              className={`code-graph-node ${node.status ? `change-${node.status}` : ''} ${node.id === selected ? 'selected' : ''}`}
              data-weight={node.weight}
              transform={`translate(${point.x},${point.y})`}
              role="button"
              tabIndex={0}
              aria-label={`${node.label} · ${node.detail ?? node.id}${node.marker?.length ? ` · Also changed by ${node.marker.join(', ')}` : ''}`}
              aria-pressed={node.id === selected}
              onClick={() => select(node.id)}
              onDoubleClick={() => open?.(node.id)}
              onKeyDown={event => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  select(node.id);
                }
              }}
            >
              <title>
                {node.id}
                {node.detail ? ` · ${node.detail}` : ''}
                {node.marker?.length ? ` · Also changed by ${node.marker.join(', ')}` : ''}
              </title>
              <rect width={nodeWidth} height={42} rx={6} />
              {Boolean(node.marker?.length) && (
                <circle className="code-graph-marker" cx={nodeWidth - 10} cy={9} r={3.5}>
                  <title>Also changed by {node.marker!.join(', ')}</title>
                </circle>
              )}
              <text x={10} y={18}>
                {node.label.length > Math.floor((nodeWidth - 20) / 7.4)
                  ? '…' + node.label.slice(-Math.floor((nodeWidth - 20) / 7.4) + 1)
                  : node.label}
              </text>
              <text className="code-graph-path" x={10} y={32}>
                {(node.status ? (node.detail ?? '') : node.id).length > Math.floor((nodeWidth - 20) / 6.4)
                  ? '…' +
                    (node.status ? (node.detail ?? '') : node.id).slice(
                      -Math.floor((nodeWidth - 20) / 6.4) + 1,
                    )
                  : node.status
                    ? node.detail
                    : node.id}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
