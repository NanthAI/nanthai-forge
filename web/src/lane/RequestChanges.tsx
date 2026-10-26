// SPDX-License-Identifier: Apache-2.0
import { useState } from 'react';
import { ErrorToast } from '../ui/Toast';
import { useDraft } from './draft';
import { Button } from '../ui/primitives';
export type ReviewRecipient = {
  id: string;
  name: string;
  agent?: string;
  state?: string;
  automatic?: boolean;
};
/** Feedback is advisory; it never adds an acceptance gate. */
export function RequestChanges({
  send,
  disabled = false,
  draftKey,
  recipients = [],
  onOpen,
  initialOpen = false,
  initialSent,
  onSent,
}: {
  send: (text: string, laneId?: string) => Promise<unknown>;
  disabled?: boolean;
  draftKey: string;
  recipients?: ReviewRecipient[];
  onOpen?: (open: boolean) => void;
  onSent?: () => void;
  initialOpen?: boolean;
  initialSent?: { text: string; to: string };
}) {
  const [open, setOpen] = useState(initialOpen),
    [text, setText] = useDraft(`review:${draftKey}`),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [sent, setSent] = useState(initialSent),
    [laneId, setLaneId] = useState(recipients[0]?.id ?? '');
  const recipient = recipients.find(item => item.id === laneId);
  const toggle = (value: boolean) => {
    setOpen(value);
    onOpen?.(value);
  };
  if (sent)
    return (
      <div className="fx-sent" role="status">
        <b>Changes requested</b>
        <blockquote>{sent.text}</blockquote>
        <div className="fx-sent-meta">sent to {sent.to}</div>
      </div>
    );
  return (
    <div className="fx-review-request">
      {!open ? (
        <Button disabled={disabled} onClick={() => toggle(true)}>
          Ask for changes
        </Button>
      ) : (
        <form
          onSubmit={event => {
            event.preventDefault();
            setBusy(true);
            setError('');
            void send(text, laneId || undefined)
              .then(
                () => {
                  setSent({ text, to: recipient?.agent ?? recipient?.name ?? 'Lane conversation' });
                  onSent?.();
                  setText('');
                  toggle(false);
                },
                e => setError((e as Error).message),
              )
              .finally(() => setBusy(false));
          }}
        >
          <label className="fx-field-label">
            Ask for changes
            <textarea
              className="fx-input"
              aria-label="What should change?"
              placeholder="What should change?"
              autoFocus
              value={text}
              disabled={busy}
              onChange={event => setText(event.target.value)}
            />
          </label>
          {recipients.length > 0 && (
            <label className="fx-sent-meta">
              to{' '}
              <select
                aria-label="Recipient Lane"
                className="fx-input"
                value={laneId}
                onChange={event => setLaneId(event.target.value)}
                disabled={busy}
              >
                {recipients.map(item => (
                  <option key={item.id} value={item.id}>
                    {item.agent ? `${item.agent} (${item.name})` : item.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="fx-review-secondary">
            <Button type="submit" variant="primary" disabled={busy || disabled || !text.trim()}>
              {busy ? 'Sending…' : `Send to ${recipient?.agent ?? recipient?.name ?? 'Lane'}`}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => toggle(false)}>
              Not now
            </Button>
          </div>
          <p className="fx-decide-after">Draft kept</p>
          <ErrorToast error={error} />
        </form>
      )}
    </div>
  );
}
