// SPDX-License-Identifier: Apache-2.0
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Glyph, type GlyphName } from './Glyph';

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select,textarea,summary,[tabindex]:not([tabindex="-1"])';

/**
 * A panel from the right over the current page (full screen on phones). Escape and the backdrop
 * close it, focus stays inside while open and returns to the opener afterwards.
 */
export function Sheet({
  title,
  glyph,
  context,
  onClose,
  children,
  width = 600,
  compact = false,
}: {
  title: ReactNode;
  glyph?: GlyphName;
  context?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  width?: number;
  compact?: boolean;
}) {
  const id = useId();
  const panel = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close.current();
        return;
      }
      if (event.key !== 'Tab' || !panel.current) return;
      const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        item => item.offsetParent !== null,
      );
      if (!items.length) return;
      const first = items[0]!,
        last = items.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    addEventListener('keydown', key, true);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      removeEventListener('keydown', key, true);
      document.body.style.overflow = overflow;
      opener?.focus?.();
    };
  }, []);
  return createPortal(
    <div className="fx fx-sheet-root">
      <div className="fx-sheet-backdrop" onClick={onClose} />
      <aside
        ref={panel}
        className={`fx-sheet${compact ? ' fx-dialog' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
        style={{ ['--fx-sheet-w' as string]: `${width}px` }}
      >
        <header className="fx-sheet-h">
          {glyph && <Glyph name={glyph} size={16} />}
          <div className="fx-sheet-title">
            <h2 id={id}>{title}</h2>
            {context && <div className="fx-sheet-ctx">{context}</div>}
          </div>
          <button type="button" className="fx-icon-btn fx-sheet-x" aria-label="Close" onClick={onClose}>
            <Glyph name="close" size={14} />
          </button>
        </header>
        <div className="fx-sheet-b">{children}</div>
      </aside>
    </div>,
    document.body,
  );
}
