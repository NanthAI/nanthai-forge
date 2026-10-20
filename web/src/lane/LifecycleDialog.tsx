// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef } from 'react';
import { Sheet } from '../ui/Sheet';
import { Button } from '../ui/primitives';
import './owner-lifecycle.css';
export function LifecycleDialog({
  action,
  collection,
  reason,
  setReason,
  saveFirst,
  setSaveFirst,
  cascade,
  setCascade,
  busy,
  submit,
  close,
}: {
  action: 'complete' | 'abandon';
  collection: 'intents' | 'lanes' | 'planning';
  reason: string;
  setReason: (value: string) => void;
  saveFirst: boolean;
  setSaveFirst: (value: boolean) => void;
  cascade: boolean;
  setCascade: (value: boolean) => void;
  busy: boolean;
  submit: () => void;
  close: () => void;
}) {
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const frame = requestAnimationFrame(() => field.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <Sheet
      compact
      width={420}
      title={action === 'complete' ? 'Mark complete' : 'Abandon work'}
      onClose={close}
    >
      <form
        className="fx-lifecycle-form"
        onSubmit={event => {
          event.preventDefault();
          submit();
        }}
      >
        <label>
          Reason{action === 'complete' ? ' (optional)' : ''}
          <textarea
            ref={field}
            value={reason}
            onChange={event => setReason(event.target.value)}
            disabled={busy}
            rows={3}
          />
        </label>
        {action === 'abandon' && collection !== 'planning' && (
          <>
            <label>
              <input
                type="checkbox"
                checked={saveFirst}
                onChange={event => setSaveFirst(event.target.checked)}
                disabled={busy}
              />{' '}
              Save unsaved edits first
            </label>
            {collection === 'intents' && (
              <label>
                <input
                  type="checkbox"
                  checked={cascade}
                  onChange={event => setCascade(event.target.checked)}
                  disabled={busy}
                />{' '}
                Abandon open Lanes too
              </label>
            )}
          </>
        )}
        <div>
          <Button
            variant={action === 'complete' ? 'primary' : 'danger'}
            type="submit"
            disabled={busy || (action === 'abandon' && !reason.trim())}
          >
            {busy ? 'Requesting…' : action === 'complete' ? 'Mark complete' : 'Abandon'}
          </Button>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
        </div>
      </form>
    </Sheet>
  );
}
