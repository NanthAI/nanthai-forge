// SPDX-License-Identifier: Apache-2.0
// One toast at a time for the account's project pages (SPEC-01-trash): the words, at most one Undo, gone after 10
// seconds. A timer runs only while a toast is showing; an idle page has none.
import { useEffect, useState } from 'react';

export type ToastWords = { words: string; undo?: () => Promise<unknown> | void; key: number };

export function useToast() {
  const [toast, setToast] = useState<ToastWords | null>(null);
  return {
    toast,
    show: (words: string, undo?: ToastWords['undo']) =>
      setToast({ words, ...(undo ? { undo } : {}), key: Date.now() + Math.random() }),
    clear: () => setToast(null),
  };
}

export function Toasts({ toast, onGone }: { toast: ToastWords | null; onGone: () => void }) {
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
                onGone();
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
