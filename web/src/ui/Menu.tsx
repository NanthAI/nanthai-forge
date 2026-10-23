// SPDX-License-Identifier: Apache-2.0
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import './menu.css';

const controls = 'button:not([disabled]),a[href],select:not([disabled]),input:not([disabled]),[tabindex="0"]';
/** Shared action popover. Portal content keeps nested dialogs independent of the menu. */
export function Menu({
  label,
  children,
  className = 'fx-btn fx-btn-ghost',
  ariaLabel,
}: {
  label: ReactNode;
  children: ReactNode;
  className?: string;
  ariaLabel?: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, right: 0 });
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const focusItems = () =>
    [...(panel.current?.querySelectorAll<HTMLElement>(controls) ?? [])].filter(
      item => item.getClientRects().length && !item.closest('[hidden]'),
    );
  const close = (focus = false) => {
    setOpen(false);
    if (focus) {
      let trigger: HTMLElement | null = button.current;
      while (trigger && !trigger.getClientRects().length) {
        const parent = trigger.closest('[role="menu"]');
        if (!parent) break;
        trigger = document.querySelector<HTMLElement>(`[aria-controls="${CSS.escape(parent.id)}"]`);
      }
      trigger?.focus();
    }
  };
  const show = (last = false) => {
    dispatchEvent(new CustomEvent('forge:menu', { detail: id }));
    const rect = button.current?.getBoundingClientRect();
    if (rect) setPosition({ top: rect.bottom + 4, right: Math.max(8, innerWidth - rect.right) });
    setOpen(true);
    requestAnimationFrame(() => {
      const bounds = panel.current?.getBoundingClientRect();
      if (rect && bounds)
        setPosition({
          top: Math.max(8, Math.min(rect.bottom + 4, innerHeight - bounds.height - 8)),
          right: Math.max(8, Math.min(innerWidth - rect.right, innerWidth - bounds.width - 8)),
        });
      const items = focusItems();
      (last ? items.at(-1) : items[0])?.focus();
    });
  };
  useEffect(() => {
    const other = (event: Event) => {
      if ((event as CustomEvent).detail !== id) setOpen(false);
    };
    addEventListener('forge:menu', other);
    return () => removeEventListener('forge:menu', other);
  }, [id]);
  useEffect(() => {
    if (!open) return;
    for (const item of panel.current?.querySelectorAll('button,a[href]') ?? [])
      if (!item.hasAttribute('role')) item.setAttribute('role', 'menuitem');
    const outside = (event: PointerEvent) => {
      const node = event.target as Node;
      if (!panel.current?.contains(node) && !button.current?.contains(node)) close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close(true);
      }
    };
    const scroll = () => close();
    addEventListener('pointerdown', outside);
    addEventListener('keydown', escape);
    addEventListener('resize', scroll);
    addEventListener('popstate', scroll);
    const scrolled = (event: Event) => {
      if (!(event.target instanceof Node) || !panel.current?.contains(event.target)) close();
    };
    addEventListener('scroll', scrolled, true);
    return () => {
      removeEventListener('pointerdown', outside);
      removeEventListener('keydown', escape);
      removeEventListener('resize', scroll);
      removeEventListener('popstate', scroll);
      removeEventListener('scroll', scrolled, true);
    };
  }, [open]);
  return (
    <>
      <button
        ref={button}
        type="button"
        className={className}
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => (open ? close() : show())}
        onKeyDown={event => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            show(event.key === 'ArrowUp');
          }
        }}
      >
        {label}
      </button>
      {typeof document !== 'undefined' &&
        createPortal(
          <div className="fx">
            <div
              ref={panel}
              id={id}
              role="menu"
              aria-label={ariaLabel ?? (typeof label === 'string' ? label : 'Actions')}
              className="fx-menu"
              hidden={!open}
              style={position}
              onClick={event => {
                const target = (event.target as HTMLElement).closest('button,a[href]');
                if (target && !target.hasAttribute('disabled') && !target.closest('[role="dialog"]'))
                  close(true);
              }}
              onKeyDown={event => {
                const items = focusItems();
                const index = items.indexOf(document.activeElement as HTMLElement);
                const next =
                  event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? items.length - 1
                      : event.key === 'ArrowDown'
                        ? (index + 1) % items.length
                        : event.key === 'ArrowUp'
                          ? (index - 1 + items.length) % items.length
                          : -1;
                if (next >= 0) {
                  event.preventDefault();
                  event.stopPropagation();
                  items[next]?.focus();
                }
                if (event.key === 'Tab') close(true);
              }}
            >
              {children}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
