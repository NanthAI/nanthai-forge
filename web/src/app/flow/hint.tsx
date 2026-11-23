// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

/** A block's words: its head, the stop, why it is held and its person. */
export function blockLabel(
  block: { laneId: string; head: string | null; why: string | null; word: string; who: string | null },
  stop: string,
) {
  return [
    block.head ?? `Lane ${block.laneId.slice(0, 8)}`,
    stop,
    block.why ?? (block.word === stop ? null : block.word),
    block.who,
  ]
    .filter(Boolean)
    .join(' · ');
}

const EDGE = 4;

/** Where a block's hover stands inside the picture, from its measured size: above the block, flipped below it when there
 * is no room above, and never past the picture's sides or bottom. */
export function hintAt(
  p: { x: number; y: number },
  s: number,
  picture: { width: number; height: number },
  hint: { width: number; height: number },
) {
  const above = p.y - s - hint.height - 4;
  const top = above >= EDGE ? above : p.y + 10;
  return {
    left: Math.round(Math.max(EDGE, Math.min(p.x + 8, picture.width - hint.width - EDGE))),
    top: Math.round(Math.max(EDGE, Math.min(top, picture.height - hint.height - EDGE))),
  };
}

type Shown = { id: string; by: 'pointer' | 'focus' } | null;

/** The one hover of the Flow picture: drawn last in the picture, so it is above every block and label (the old hover was
 * part of its block and went behind later ones). It follows the pointer over a block, or keyboard focus on one, whichever
 * came last, by listening on the picture; no read, no timer. */
export function CubeHint({
  labels,
  blocks,
  size,
  width,
  height,
}: {
  labels: ReadonlyMap<string, string>;
  blocks: ReadonlyMap<string, { x: number; y: number }>;
  size: number;
  width: number;
  height: number;
}) {
  const layer = useRef<HTMLDivElement>(null);
  const text = useRef<HTMLSpanElement>(null);
  const [shown, setShown] = useState<Shown>(null);
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  useEffect(() => {
    const pic = layer.current?.parentElement;
    if (!pic) return;
    const idOf = (event: Event) =>
      (event.target as Element | null)?.closest?.('a.fv-cube')?.getAttribute('data-id') ?? null;
    const without = (by: 'pointer' | 'focus') => (now: Shown) => (now?.by === by ? null : now);
    const over = (event: Event) => {
      const id = idOf(event);
      setShown(id ? { id, by: 'pointer' } : without('pointer'));
    };
    const focus = (event: Event) => {
      const el = (event.target as Element | null)?.closest?.('a.fv-cube');
      const id = el?.matches(':focus-visible') ? el.getAttribute('data-id') : null;
      setShown(id ? { id, by: 'focus' } : without('focus'));
    };
    const leave = () => setShown(without('pointer'));
    const blur = () => setShown(without('focus'));
    pic.addEventListener('mouseover', over);
    pic.addEventListener('mouseleave', leave);
    pic.addEventListener('focusin', focus);
    pic.addEventListener('focusout', blur);
    return () => {
      pic.removeEventListener('mouseover', over);
      pic.removeEventListener('mouseleave', leave);
      pic.removeEventListener('focusin', focus);
      pic.removeEventListener('focusout', blur);
    };
  }, []);
  const label = shown ? labels.get(shown.id) : undefined;
  const p = shown ? blocks.get(shown.id) : undefined;
  // Placed from its own measured size before paint, so a long conflict sentence is never cut or pushed outside.
  useLayoutEffect(() => {
    const el = text.current;
    if (!el || !p) return setAt(null);
    setAt(hintAt(p, size, { width, height }, { width: el.offsetWidth, height: el.offsetHeight }));
  }, [label, p?.x, p?.y, size, width, height]);
  return (
    <div ref={layer} className="fv-hint-layer" aria-hidden="true">
      {label && p ? (
        <span
          ref={text}
          className="fv-hint"
          dir="auto"
          style={at ?? { left: 0, top: 0, visibility: 'hidden' }}
        >
          {label}
        </span>
      ) : null}
    </div>
  );
}
