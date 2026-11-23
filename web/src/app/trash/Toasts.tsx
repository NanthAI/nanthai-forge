// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// One toast at a time for the account's project pages (SPEC-01-trash): the words, at most one Undo, gone after 10
// seconds. A timer runs only while a toast is showing; an idle page has none.
import { useEffect, useState } from 'react';
import { hostedError } from '../../snapshot';

export type ToastWords = { words: string; undo?: () => Promise<unknown> | void; key: number };

export function useToast() {
  const [toast, setToast] = useState<ToastWords | null>(null);
  const show = (words: string, undo?: ToastWords['undo']) =>
    setToast({
      words,
      // A refused Undo (the project changed since) says so instead of vanishing (Item 966cb821 review).
      ...(undo
        ? {
            undo: async () => {
              try {
                await undo();
              } catch (failure) {
                show(hostedError(failure));
              }
            },
          }
        : {}),
      key: Date.now() + Math.random(),
    });
  return {
    toast,
    show,
    /** With a key, only that toast goes: a newer one (an Undo's refusal) stays. */
    clear: (key?: number) => setToast(now => (key === undefined || now?.key === key ? null : now)),
  };
}

export function Toasts({ toast, onGone }: { toast: ToastWords | null; onGone: (key?: number) => void }) {
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!toast || busy) return;
    const timer = setTimeout(onGone, 10_000);
    return () => clearTimeout(timer);
  }, [toast, busy, onGone]);
  if (!toast) return null;
  return (
    <div className="toasts" role="status">
      <div className="toast" key={toast.key}>
        <span dir="auto">{toast.words}</span>
        {toast.undo ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void Promise.resolve(toast.undo?.()).finally(() => {
                setBusy(false);
                onGone(toast.key);
              });
            }}
          >
            Undo
          </button>
        ) : null}
      </div>
    </div>
  );
}
