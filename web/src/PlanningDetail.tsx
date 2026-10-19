// SPDX-License-Identifier: Apache-2.0
import { useEffect, useEffectEvent, useRef, type ReactNode } from 'react';

/** A side panel on desktop and a full-screen sheet on phones. */
export function PlanningDetail({
  children,
  title,
  onClose,
}: {
  children: ReactNode;
  title: ReactNode;
  onClose: () => void;
}) {
  const panel = useRef<HTMLElement>(null);
  const close = useEffectEvent(onClose);
  useEffect(() => {
    const sheet = matchMedia('(max-width: 720px)');
    const node = panel.current!;
    const previousOverflow = document.body.style.overflow;
    const update = () => {
      node.setAttribute('role', sheet.matches ? 'dialog' : 'complementary');
      if (sheet.matches) {
        node.setAttribute('aria-modal', 'true');
        document.body.style.overflow = 'hidden';
        node.querySelector<HTMLButtonElement>('button')?.focus();
      } else {
        node.removeAttribute('aria-modal');
        document.body.style.overflow = previousOverflow;
      }
    };
    update();
    sheet.addEventListener('change', update);
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault();
        close();
      }
      if (event.key !== 'Tab' || !sheet.matches) return;
      const controls = [
        ...node.querySelectorAll<HTMLElement>(
          'button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary, [tabindex="0"]',
        ),
      ].filter(element => element.getClientRects().length);
      const first = controls[0],
        last = controls.at(-1);
      if (event.shiftKey && (document.activeElement === first || !node.contains(document.activeElement))) {
        event.preventDefault();
        last?.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last || !node.contains(document.activeElement))
      ) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener('keydown', keydown);
    return () => {
      sheet.removeEventListener('change', update);
      document.removeEventListener('keydown', keydown);
      document.body.style.overflow = previousOverflow;
    };
  }, []);
  return (
    <aside id="planning-detail" className="planning-detail fx-panel" aria-label="Planning item" ref={panel}>
      <div className="planning-detail-controls fx-panel-h">
        <button className="planning-detail-back" onClick={onClose}>
          ← Back
        </button>
        <h2>{title}</h2>
        <button
          className="fx-icon-btn planning-detail-close"
          aria-label="Close planning details"
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <div className="planning-detail-body">{children}</div>
    </aside>
  );
}
