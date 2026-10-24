// SPDX-License-Identifier: Apache-2.0
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icons';

/** A focused task or reference panel. Children stay mounted to preserve drafts. */
export function DetailPanel({
  title,
  children,
  className = '',
  open: controlled,
  onChange,
  initial = false,
  ...attributes
}: {
  title: ReactNode;
  children: ReactNode;
  className?: string;
  open?: boolean;
  initial?: boolean;
  onChange?: (open: boolean) => void;
  'aria-label'?: string;
  id?: string;
}) {
  const [expanded, setExpanded] = useState(initial),
    open = controlled ?? expanded;
  const anchor = useRef<HTMLDivElement>(null),
    dialog = useRef<HTMLDialogElement>(null),
    trigger = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const id = useId(),
    change = (value: boolean) => {
      setExpanded(value);
      onChange?.(value);
    };
  const changeRef = useRef(change);
  changeRef.current = change;
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const sync = () => {
      if (open && !anchor.current?.closest('[hidden]')) {
        if (!element.open) {
          returnFocus.current = document.activeElement as HTMLElement | null;
          element.showModal();
        }
      } else if (element.open) {
        element.close();
        if (open) changeRef.current(false);
      }
    };
    sync();
    const observer = new MutationObserver(sync);
    for (let parent = anchor.current?.parentElement; parent; parent = parent.parentElement)
      observer.observe(parent, { attributes: true, attributeFilter: ['hidden'] });
    return () => observer.disconnect();
  }, [open]);
  // Portals must retain their original form owner, including native validation.
  useEffect(() => {
    const form = anchor.current?.closest('form');
    if (!form || !dialog.current) return;
    if (!form.id) form.id = `${id}-form`;
    for (const control of dialog.current.querySelectorAll<
      HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement
    >('input,select,textarea,button')) {
      if (!control.closest('form') && !control.hasAttribute('form')) control.setAttribute('form', form.id);
    }
  });
  const close = () => {
    dialog.current?.close();
    change(false);
    const target = returnFocus.current;
    if (target?.isConnected && target.getClientRects().length) target.focus();
    else trigger.current?.focus();
  };
  const content = (
    <dialog
      id={id}
      ref={dialog}
      className="detail-panel"
      aria-labelledby={`${id}-title`}
      onCancel={event => {
        event.preventDefault();
        close();
      }}
      onSubmit={event => event.stopPropagation()}
      onInvalidCapture={() => {
        if (!dialog.current?.open && !anchor.current?.closest('[hidden]')) {
          returnFocus.current = document.activeElement as HTMLElement | null;
          dialog.current?.showModal();
          change(true);
        }
      }}
    >
      <header className="detail-panel-heading">
        <h2 id={`${id}-title`}>{title}</h2>
        <button type="button" aria-label="Close panel" onClick={close}>
          <Icon name="close" />
        </button>
      </header>
      <div className="panel-content">{children}</div>
    </dialog>
  );
  return (
    <div ref={anchor} className={`action-panel ${className}`} {...attributes}>
      <button
        ref={trigger}
        type="button"
        className="panel-trigger"
        aria-haspopup="dialog"
        aria-controls={id}
        onClick={event => {
          event.currentTarget.focus();
          change(true);
        }}
      >
        {title}
        <Icon name="arrow" />
      </button>
      {typeof document !== 'undefined' ? createPortal(content, document.body) : content}
    </div>
  );
}
