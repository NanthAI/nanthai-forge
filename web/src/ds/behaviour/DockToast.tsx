// SPDX-License-Identifier: Apache-2.0
import { useEffect, useLayoutEffect, useState, type RefObject } from 'react';
import type { DockLayout } from './Dock';

export type DockMove = { id: string; title: string; previous: DockLayout; next: DockLayout };

export function DockToast({
  move,
  onExpire,
  onUndo,
  onReset,
}: {
  move: DockMove;
  onExpire: () => void;
  onUndo: () => void;
  onReset: () => void;
}) {
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (focused) return;
    const timer = setTimeout(onExpire, 10_000);
    return () => clearTimeout(timer);
  }, [focused, move, onExpire]);
  return (
    <div className="toasts">
      <div
        className="toast dock-toast"
        onFocus={() => setFocused(true)}
        onBlur={event => {
          if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
        }}
      >
        <span>Moved {move.title}.</span>
        <button type="button" onClick={onUndo}>
          Undo
        </button>
        <button type="button" onClick={onReset}>
          Reset layout
        </button>
      </div>
    </div>
  );
}

/** After Undo or Reset the grip may be in a different GridList, whose rows commit on a subsequent render. */
export function useDockGripFocus(root: RefObject<HTMLDivElement | null>) {
  const [request, setRequest] = useState<{ id: string }>();
  useLayoutEffect(() => {
    if (!request) return;
    const selector = `[data-focus-key="drag-${CSS.escape(request.id)}"]`;
    let attempts = 0;
    const focus = () => {
      const grips = root.current?.querySelectorAll<HTMLButtonElement>(selector);
      const visible = [...(grips ?? [])].find(grip => grip.getClientRects().length > 0);
      visible?.focus({ preventScroll: true });
      if (visible !== document.activeElement && ++attempts < 10) frame = requestAnimationFrame(focus);
    };
    let frame = requestAnimationFrame(focus);
    return () => cancelAnimationFrame(frame);
  }, [request, root]);
  return (id: string) => setRequest({ id });
}
