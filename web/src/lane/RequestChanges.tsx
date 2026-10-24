import { ErrorToast } from '../ui/Toast';
import { useDraft } from './draft';
// SPDX-License-Identifier: Apache-2.0
import { useState } from 'react';
import { Button } from '../ui/primitives';
/** A review records feedback; it does not add a new acceptance gate. */
export function RequestChanges({
  send,
  disabled = false,
  draftKey,
}: {
  send: (text: string) => Promise<unknown>;
  disabled?: boolean;
  draftKey: string;
}) {
  const [open, setOpen] = useState(false),
    [text, setText] = useDraft(`review:${draftKey}`),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [sent, setSent] = useState('');
  return (
    <div className="fx-review-request">
      {sent ? (
        <p role="status">{sent}</p>
      ) : !open ? (
        <Button disabled={disabled} onClick={() => setOpen(true)}>
          Ask for changes
        </Button>
      ) : (
        <form
          onSubmit={event => {
            event.preventDefault();
            setBusy(true);
            setError('');
            void send(text)
              .then(
                result => {
                  setText('');
                  setSent(typeof result === 'string' ? result : 'Changes requested · sent.');
                },
                e => setError((e as Error).message),
              )
              .finally(() => setBusy(false));
          }}
        >
          <label>
            What needs to change?
            <textarea
              autoFocus
              value={text}
              disabled={busy}
              onChange={event => setText(event.target.value)}
            />
          </label>
          <div className="fx-review-secondary">
            <Button type="submit" disabled={busy || !text.trim()}>
              {busy ? 'Sending…' : 'Send request'}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setOpen(false)}>
              Not now
            </Button>
          </div>
          <ErrorToast error={error} />
        </form>
      )}
    </div>
  );
}
