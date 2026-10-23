// SPDX-License-Identifier: Apache-2.0
import { useEffect, useMemo, useRef, useState } from 'react';
import { hashPoint, initialPoint, type PointEdge, type PointNode } from './graph-model';
import { Icon } from './WorkspaceUI';
type Position = { x: number; y: number; z: number };
const scenery = Array.from({ length: 64 }, (_, i) => ({ id: `point-${i}`, label: '' }));
const sceneryEdges = scenery.flatMap((a, i) =>
  scenery.slice(i + 1).flatMap(b => {
    const p = initialPoint(a.id),
      q = initialPoint(b.id);
    return Math.hypot(p.x - q.x, p.y - q.y) < 0.17 ? [{ from: a.id, to: b.id }] : [];
  }),
);
export function PointField({
  nodes = scenery,
  edges = sceneryEdges,
  selected = '',
  select,
  open,
  decorative = false,
}: {
  nodes?: PointNode[];
  edges?: PointEdge[];
  selected?: string;
  select?: (id: string) => void;
  open?: (id: string) => void;
  decorative?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null),
    canvas = useRef<HTMLCanvasElement>(null),
    buttons = useRef(new Map<string, HTMLButtonElement>());
  const positions = useRef(new Map<string, Position>()),
    drag = useRef<{ id?: string; x: number; y: number; moved: boolean } | null>(null);
  const camera = useRef({ x: 0, y: 0, zoom: 1 }),
    pointer = useRef({ x: 0, y: 0 }),
    phase = useRef(0);
  const [hovered, hover] = useState(''),
    [paused, pause] = useState(
      () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches,
    ),
    // Small graphs read better with names shown; large ones would be cluttered.
    [labels, showLabels] = useState(() => !decorative && nodes.length > 0 && nodes.length <= 24),
    [zoom, setZoom] = useState(1);
  /** Frame every point: centre their bounds and zoom so small graphs fill the field. */
  const fit = () => {
    const element = host.current;
    const points = nodes.map(node => positions.current.get(node.id) ?? initialPoint(node.id));
    if (!element || points.length === 0) return;
    const xs = points.map(p => p.x),
      ys = points.map(p => p.y);
    const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const value = Math.min(
      2.6,
      Math.max(0.3, Math.min(0.72 / Math.max(maxX - minX, 0.05), 0.72 / Math.max(maxY - minY, 0.05))),
    );
    camera.current = {
      x: -((minX + maxX) / 2 - 0.5) * element.clientWidth * value,
      y: -((minY + maxY) / 2 - 0.5) * element.clientHeight * value,
      zoom: value,
    };
    setZoom(value);
  };
  const fitted = useRef(0);
  useEffect(() => {
    if (decorative || nodes.length === 0 || fitted.current === nodes.length) return;
    fitted.current = nodes.length;
    fit();
    // Fit once per graph size; later user zooming is preserved.
  }, [nodes.length, decorative]);
  const focus = hovered || selected,
    active = nodes.find(node => node.id === hovered),
    live = useRef({ focus, paused });
  live.current = { focus, paused };
  const related = useMemo(
    () => new Set(edges.filter(e => e.from === focus || e.to === focus).flatMap(e => [e.from, e.to])),
    [edges, focus],
  );
  useEffect(() => {
    const query = matchMedia('(prefers-reduced-motion: reduce)');
    const change = () => pause(query.matches);
    query.addEventListener('change', change);
    return () => query.removeEventListener('change', change);
  }, []);
  useEffect(() => {
    const element = host.current,
      surface = canvas.current,
      context = surface?.getContext('2d');
    if (!element || !surface || !context) return;
    for (const node of nodes)
      if (!positions.current.has(node.id)) positions.current.set(node.id, initialPoint(node.id));
    for (const id of positions.current.keys())
      if (!nodes.some(node => node.id === id)) positions.current.delete(id);
    let width = 1,
      height = 1,
      frame = 0,
      visible = true,
      last = 0;
    let ink = '#8b96a5',
      accent = '#ff6b3d';
    const measure = () => {
      width = element.clientWidth;
      height = element.clientHeight;
      const ratio = Math.min(devicePixelRatio || 1, 2);
      surface.width = width * ratio;
      surface.height = height * ratio;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      const style = getComputedStyle(element);
      ink = style.getPropertyValue('--graph-edge').trim() || ink;
      accent = style.getPropertyValue('--graph-dot').trim() || accent;
    };
    const resize = new ResizeObserver(measure);
    resize.observe(element);
    const theme = new MutationObserver(measure);
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const intersection = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? false;
    });
    intersection.observe(element);
    measure();
    const draw = (now: number) => {
      frame = requestAnimationFrame(draw);
      if (!visible || document.hidden || now - last < 30) return;
      const elapsed = Math.min(50, now - last);
      last = now;
      if (!live.current.paused && !drag.current && !hovered) phase.current += elapsed * 0.0001;
      context.clearRect(0, 0, width, height);
      const points = new Map<string, { x: number; y: number; z: number }>();
      for (const node of nodes) {
        const p = positions.current.get(node.id)!;
        const wave = hashPoint(node.id) * 12,
          movement = drag.current?.id === node.id ? 0 : 1;
        const x =
          (p.x + Math.sin(phase.current + wave) * 0.015 * movement - 0.5) * width * camera.current.zoom +
          width / 2 +
          camera.current.x +
          pointer.current.x * p.z * 8;
        const y =
          (p.y + Math.cos(phase.current * 0.7 + wave) * 0.018 * movement - 0.5) *
            height *
            camera.current.zoom +
          height / 2 +
          camera.current.y +
          pointer.current.y * p.z * 8;
        points.set(node.id, { x, y, z: p.z });
        const button = buttons.current.get(node.id);
        if (button) button.style.transform = `translate(${x}px,${y}px)`;
      }
      const focusId = live.current.focus;
      for (const edge of edges) {
        const a = points.get(edge.from),
          b = points.get(edge.to);
        if (!a || !b) continue;
        const chosen = focusId && (edge.from === focusId || edge.to === focusId);
        context.strokeStyle = chosen ? accent : ink;
        context.globalAlpha = chosen ? 0.8 : focusId ? 0.13 : 0.3 + a.z * 0.16;
        context.lineWidth = chosen ? 1.25 : 0.65;
        context.beginPath();
        context.moveTo(a.x, a.y);
        context.lineTo(b.x, b.y);
        context.stroke();
        if (chosen) {
          const angle = Math.atan2(b.y - a.y, b.x - a.x),
            x = a.x + (b.x - a.x) * 0.72,
            y = a.y + (b.y - a.y) * 0.72;
          context.beginPath();
          context.moveTo(x - Math.cos(angle - 0.5) * 5, y - Math.sin(angle - 0.5) * 5);
          context.lineTo(x, y);
          context.lineTo(x - Math.cos(angle + 0.5) * 5, y - Math.sin(angle + 0.5) * 5);
          context.stroke();
        }
      }
      for (const node of nodes) {
        const p = points.get(node.id)!;
        context.fillStyle = accent;
        context.globalAlpha = node.id === focusId ? 1 : 0.3 + p.z * 0.55;
        context.beginPath();
        context.arc(p.x, p.y, node.id === focusId ? 4.5 : 1.5 + p.z * 1.7, 0, Math.PI * 2);
        context.fill();
        if (node.id === selected) {
          context.globalAlpha = 0.7;
          context.lineWidth = 1;
          context.strokeStyle = accent;
          context.beginPath();
          context.arc(p.x, p.y, 9, 0, Math.PI * 2);
          context.stroke();
        }
      }
      context.globalAlpha = 1;
    };
    frame = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      theme.disconnect();
      intersection.disconnect();
    };
  }, [nodes, edges, selected, hovered]);
  function changeZoom(value: number) {
    camera.current.zoom = Math.min(4, Math.max(0.3, value));
    setZoom(camera.current.zoom);
  }
  return (
    <div
      ref={host}
      className={`point-field ${decorative ? 'point-field-decorative' : ''}`}
      onPointerMove={event => {
        const rect = event.currentTarget.getBoundingClientRect();
        if (!live.current.paused && !hovered)
          pointer.current = {
            x: (event.clientX - rect.left) / rect.width - 0.5,
            y: (event.clientY - rect.top) / rect.height - 0.5,
          };
        if (!drag.current) return;
        const dx = event.clientX - drag.current.x,
          dy = event.clientY - drag.current.y;
        if (Math.abs(dx) + Math.abs(dy) > 2) drag.current.moved = true;
        if (drag.current.id) {
          const p = positions.current.get(drag.current.id);
          if (p) {
            p.x += dx / rect.width / camera.current.zoom;
            p.y += dy / rect.height / camera.current.zoom;
          }
        } else {
          camera.current.x += dx;
          camera.current.y += dy;
        }
        drag.current.x = event.clientX;
        drag.current.y = event.clientY;
      }}
      onPointerUp={event => {
        if (!drag.current) return;
        const { id, moved } = drag.current;
        drag.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId);
        if (id && !moved) select?.(id);
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
    >
      <canvas
        ref={canvas}
        aria-hidden="true"
        onPointerDown={event => {
          if (!decorative && event.button === 0) {
            drag.current = { x: event.clientX, y: event.clientY, moved: false };
            host.current?.setPointerCapture(event.pointerId);
          }
        }}
      />
      {!decorative && (
        <>
          <div className="point-controls" aria-label="Graph controls">
            <button aria-label="Zoom out" onClick={() => changeZoom(zoom / 1.25)}>
              −
            </button>
            <button onClick={fit}>Fit</button>
            <button aria-label="Zoom in" onClick={() => changeZoom(zoom * 1.25)}>
              +
            </button>
            <span>{Math.round(zoom * 100)}%</span>
            <button aria-pressed={paused} onClick={() => pause(!paused)}>
              {paused ? 'Resume motion' : 'Pause motion'}
            </button>
            <button aria-pressed={labels} onClick={() => showLabels(!labels)}>
              Labels
            </button>
            {selected && open && <button onClick={() => open(selected)}>Open selected file</button>}
          </div>
          <div className="point-nodes" aria-label="Graph files">
            {nodes.map(node => (
              <button
                key={node.id}
                ref={element => {
                  if (element) buttons.current.set(node.id, element);
                  else buttons.current.delete(node.id);
                }}
                className={`point-node ${node.id === selected ? 'is-selected' : ''} ${related.has(node.id) ? 'is-related' : ''}`}
                aria-label={`Inspect ${node.detail ?? node.label}`}
                aria-pressed={node.id === selected}
                onPointerEnter={() => hover(node.id)}
                onPointerLeave={() => {
                  if (!drag.current) hover('');
                }}
                onFocus={() => hover(node.id)}
                onBlur={() => hover('')}
                onPointerDown={event => {
                  if (event.button !== 0) return;
                  event.preventDefault();
                  event.stopPropagation();
                  drag.current = { id: node.id, x: event.clientX, y: event.clientY, moved: false };
                  host.current?.setPointerCapture(event.pointerId);
                }}
                onClick={event => {
                  if (event.detail === 0) select?.(node.id);
                }}
                onDoubleClick={() => open?.(node.id)}
              >
                <span
                  className={
                    labels || node.id === selected || node.id === hovered
                      ? 'point-label visible'
                      : 'point-label'
                  }
                >
                  {node.label}
                </span>
              </button>
            ))}
          </div>
          {active && (
            <div className="point-preview" role="status">
              <Icon name="code" />
              <div>
                <strong>{active.label}</strong>
                <span>{active.detail}</span>
                {active.bytes !== undefined && (
                  <small>
                    {active.bytes.toLocaleString()} bytes ·{' '}
                    {edges.filter(e => e.from === active.id || e.to === active.id).length} loaded
                    relationships
                  </small>
                )}
                <small>Select to inspect · drag to arrange</small>
              </div>
            </div>
          )}
          <div className="point-hint">Drag the field to explore. Select a point to inspect its source.</div>
        </>
      )}
    </div>
  );
}
