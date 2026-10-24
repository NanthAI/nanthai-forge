import { useToast } from '../ui/Toast';
// SPDX-License-Identifier: Apache-2.0
import { useUnsavedInput } from '../ui/NavigationGuard';
import { useId, useState, useSyncExternalStore } from 'react';
import { Button } from '../ui/primitives';

/** Inline reply under a decision. The draft survives failed sends; Escape closes without losing it. */
export function ReplyBox({
  to,
  primary,
  busy,
  send,
}: {
  to: string;
  /** `rec` when replying is the expected answer; `ghost` beside one-click choices. */
  primary: boolean | 'rec' | 'ghost';
  busy: boolean;
  send: (text: string) => Promise<boolean>;
}) {
  const toast = useToast();
  const entries = useSyncExternalStore(toast.subscribe, toast.snapshot, toast.snapshot);
  const [errorId, setErrorId] = useState('');
  const failed = entries.some(entry => entry.id === errorId);
  const [open, setOpen] = useState(false),
    [text, setText] = useState('');
  useUnsavedInput(Boolean(text.trim()), () => setText(''));
  const id = useId();
  if (!open)
    return (
      <Button
        size="sm"
        variant={primary === true ? 'primary' : primary || 'secondary'}
        icon={primary === 'ghost' ? undefined : 'message'}
        onClick={() => setOpen(true)}
      >
        {primary === 'ghost' ? 'Reply…' : 'Reply'}
      </Button>
    );
  const submit = async () => {
    if (!text.trim() || busy) return;
    try {
      if (await send(text.trim())) {
        setText('');
        setOpen(false);
      } else setErrorId(toast.snapshot().find(entry => entry.tone === 'error')?.id ?? '');
    } catch {
      setErrorId(toast.show({ message: 'Could not send this reply.' }));
    }
  };
  return (
    <form
      className="fx-reply"
      onSubmit={event => {
        event.preventDefault();
        void submit();
      }}
    >
      <label htmlFor={id} className="fx-sr">
        Reply to {to}
      </label>
      <textarea
        id={id}
        aria-invalid={failed || undefined}
        aria-describedby={failed ? errorId : undefined}
        className="fx-input"
        rows={3}
        value={text}
        autoFocus
        maxLength={4000}
        placeholder={`Reply to ${to}…`}
        onChange={event => setText(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Escape') setOpen(false);
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void submit();
        }}
      />
      <div className="fx-reply-actions">
        <span className="fx-faint">Sends a message to {to} and marks this as answered.</span>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" type="submit" disabled={busy || !text.trim()}>
          {busy ? 'Sending…' : 'Send'}
        </Button>
      </div>
    </form>
  );
}
